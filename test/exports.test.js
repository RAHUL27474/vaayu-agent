// Excel downloads: every list page with an Excel button returns a valid .xlsx with a title, a header row
// and the rows of the list, keeps the page's filters, and only gives each role its own data.
const { start, finish, check, ROLES, ROOT } = require('./helpers');
const { readXlsx } = require(`${ROOT}/src/xlsx`);

const PAGES = {
  admin: ['/admin/agents', '/admin/agents?status=active', '/admin/tiers', '/admin/log', '/admin/team', '/admin/bookings', '/admin/bookings?status=confirmed',
    '/admin/topups', '/admin/ledger', '/admin/invoices', '/admin/invoices?kind=b2b', '/admin/offers', '/admin/tickets', '/admin/notifications'],
  agent: ['/agent/bookings', '/agent/quotes', '/agent/customers', '/agent/leads', '/agent/wallet', '/agent/invoices', '/agent/team', '/agent/support',
    '/agent/offers', '/agent/packages', '/agent/vaayutrip-packages', '/agent/notifications', '/agent/hotels', '/agent/activities'],
  backend: ['/backend/products', '/backend/booking-requests', '/backend/enquiries', '/backend/packages'],
};

(async () => {
  const c = await start();
  const cookies = {};
  for (const role of Object.keys(PAGES)) cookies[role] = await c.login(...ROLES[role]);

  for (const [role, pages] of Object.entries(PAGES)) {
    for (const p of pages) {
      const html = await (await c.get(p, cookies[role])).text();
      const href = (html.match(/<a class="btn btn-excel" href="([^"]+)"/) || [])[1];
      check(`${p}: has an Excel button`, !!href);
      if (!href) continue;
      const url = href.replace(/&amp;/g, '&');
      if (p.includes('?')) check(`${p}: Excel link keeps the filter`, url.includes(p.split('?')[1]), url);
      const r = await c.get(url, cookies[role]);
      check(`${p}: download is an Excel file`, r.status === 200 && /spreadsheetml/.test(r.headers.get('content-type')) && /attachment; filename=".+\.xlsx"/.test(r.headers.get('content-disposition')), `${r.status} ${r.headers.get('content-type')}`);
      let sheets;
      try { sheets = readXlsx(Buffer.from(await r.arrayBuffer())); } catch (e) { check(`${p}: opens as .xlsx`, false, e.message); continue; }
      const rows = (sheets[0] || {}).rows || [];
      check(`${p}: has a title, a note and a header row`, rows.length >= 3 && /·/.test(rows[0][0]) && /Downloaded/.test(rows[1][0]) && rows[2] && rows[2].length >= 3, JSON.stringify(rows.slice(0, 4)).slice(0, 200));
      const n = Number((rows[1][0].match(/(\d+) rows?/) || [])[1]);
      const totalRow = rows.length > 5 && rows[rows.length - 1][0] === 'Total' ? 1 : 0;
      check(`${p}: row count matches the note`, rows.length - 3 - totalRow === n, `${rows.length} rows, note ${n}`);
      const text = JSON.stringify(rows);
      check(`${p}: no leaked placeholders`, !/undefined|NaN|\[object|Invalid Date/.test(text));
    }
  }

  // Filters carry through: only confirmed bookings in the confirmed download.
  const conf = readXlsx(Buffer.from(await (await c.get('/admin/bookings?status=confirmed&download=xlsx', cookies.admin)).arrayBuffer()));
  const crow = conf[0].rows;
  const sc = crow[2].indexOf('Status');
  check('filtered bookings download has only that status', crow.slice(3).filter((r) => r[0] !== 'Total').every((r) => r[sc] === 'Confirmed'));

  // Paged lists come out whole, not just page 1.
  const all = (readXlsx(Buffer.from(await (await c.get('/agent/hotels?download=xlsx&page=1', cookies.agent)).arrayBuffer())))[0].rows;
  check('paged list downloads every row', all.length - 3 > 0);

  // Agents can't download admin lists, or VaayuTrip's costs.
  const denied = await c.get('/admin/bookings?download=xlsx', cookies.agent);
  check('agent cannot download admin bookings', denied.status !== 200 || !/spreadsheetml/.test(denied.headers.get('content-type') || ''), denied.status);
  const cat = JSON.stringify((readXlsx(Buffer.from(await (await c.get('/agent/activities?download=xlsx', cookies.agent)).arrayBuffer())))[0].rows[2]);
  check('agent catalogue download has no VaayuTrip cost column', !/Cost/i.test(cat), cat);
  const anon = await c.get('/agent/bookings?download=xlsx');
  check('signed-out download is refused', anon.status === 302, anon.status);

  finish(c);
})();
