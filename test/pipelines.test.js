// Routes no other suite reaches, and what each agency staff role (owner, sales, accounts) can and cannot do.
const { start, finish, check, db, ROLES } = require('./helpers');

const one = (sql, ...p) => db.prepare(sql).get(...p);

(async () => {
  const c = await start();
  const owner = await c.login(...ROLES.agent);
  const backend = await c.login(...ROLES.backend);
  const admin = await c.login(...ROLES.admin);
  const sky = await one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");
  const loc = (r) => r.headers.get('location') || '';
  // A failed login still sets a session cookie, so check the portal actually opens.
  const canLogin = async (email, pw) => (await c.get('/agent', await c.login(email, pw))).status === 200;

  // ---------- public pages ----------
  for (const p of ['/terms', '/privacy']) check(`${p} opens`, (await c.get(p)).status === 200);
  const svg = await c.get('/cover/Bali.svg');
  check('cover placeholder is an SVG', svg.status === 200 && /svg/.test(svg.headers.get('content-type') || ''));
  check('cover placeholder escapes its text', !(await (await c.get('/cover/%3Cscript%3E.svg')).text()).includes('<script>'));

  // ---------- quotes: removing a line ----------
  const act = await one("SELECT id FROM products WHERE kind = 'activity' AND status = 'published' ORDER BY id LIMIT 1");
  const qid = Number(loc(await c.post('/agent/quotes', owner, { title: 'Pipeline trip' })).match(/(\d+)$/)[1]);
  await c.post(`/agent/activities/${act.id}/quote`, owner, { quote_id: String(qid) });
  const item = await one('SELECT id FROM quote_items WHERE quote_id = ?', qid);
  await c.post(`/agent/quotes/${qid}/items/${item.id}/delete`, owner, {});
  check('a line can be removed from a quote', !(await one('SELECT 1 FROM quote_items WHERE id = ?', item.id)));
  const other = await one('SELECT q.id, i.id AS item FROM quotes q JOIN quote_items i ON i.quote_id = q.id WHERE q.agency_id != ? LIMIT 1', sky.id);
  if (other) {
    await c.post(`/agent/quotes/${qid}/items/${other.item}/delete`, owner, {});
    check("another agency's quote line cannot be removed through your quote", !!(await one('SELECT 1 FROM quote_items WHERE id = ?', other.item)));
  }

  // ---------- wallet alert ----------
  await c.post('/agent/wallet/alert', owner, { low_balance_alert: '25000' });
  check('low-balance alert is saved', Number((await one('SELECT low_balance_alert FROM agencies WHERE id = ?', sky.id)).low_balance_alert) === 25000);
  await c.post('/agent/wallet/alert', owner, { low_balance_alert: '-5' });
  check('a negative alert switches it off', Number((await one('SELECT low_balance_alert FROM agencies WHERE id = ?', sky.id)).low_balance_alert) === 0);

  // ---------- team: roles and passwords ----------
  await c.post('/agent/team', owner, { name: 'Sam Sales', email: 'sam.pipe@skyline.com', role: 'sales', password: 'sales12345' });
  await c.post('/agent/team', owner, { name: 'Asha Accounts', email: 'asha.pipe@skyline.com', role: 'accounts', password: 'accts12345' });
  const sam = await one("SELECT id FROM users WHERE email = 'sam.pipe@skyline.com'");
  await c.post(`/agent/team/${sam.id}/password`, owner, { password: 'short' });
  check('a short staff password is refused', await canLogin('sam.pipe@skyline.com', 'sales12345'));
  await c.post(`/agent/team/${sam.id}/password`, owner, { password: 'newsales123' });
  const sales = await c.login('sam.pipe@skyline.com', 'newsales123');
  check('owner sets a new staff password', !!sales && (await c.get('/agent', sales)).status === 200);
  const accounts = await c.login('asha.pipe@skyline.com', 'accts12345');
  check('a staff member cannot reset passwords', loc(await c.post(`/agent/team/${sam.id}/password`, sales, { password: 'hijack1234' })) === '/agent'
    && !(await canLogin('sam.pipe@skyline.com', 'hijack1234')));

  // Sales: builds quotes, no money pages.
  check('sales can open inventory and quotes', (await c.get('/agent/hotels', sales)).status === 200 && (await c.get('/agent/quotes', sales)).status === 200);
  check('sales cannot open wallet, settings, team or API', (await Promise.all(['/agent/wallet', '/agent/settings', '/agent/team', '/agent/api', '/agent/reports'].map((p) => c.get(p, sales)))).every((r) => r.status === 302));
  const sq = Number(loc(await c.post('/agent/quotes', sales, { title: 'Sales quote' })).match(/(\d+)$/)?.[1] || 0);
  check('sales can create a quote', sq > 0);

  // Accounts: sees quotes, pays and invoices, does not build or change them.
  const qPage = await (await c.get(`/agent/quotes/${qid}`, accounts)).text();
  check('accounts can view a quote', qPage.includes('Pipeline trip'));
  check('accounts see no edit controls on a quote', !qPage.includes(`/agent/quotes/${qid}/duplicate`) && !qPage.includes('Save details') && !qPage.includes('Add your own service') && !qPage.includes('Delete quote'));
  check('accounts see no "New blank quote" button', !(await (await c.get('/agent/quotes', accounts)).text()).includes('New blank quote'));
  const before = await one('SELECT COUNT(*) AS n FROM quotes WHERE agency_id = ?', sky.id);
  await c.post('/agent/quotes', accounts, { title: 'Accounts quote' });
  check('accounts cannot create a quote', (await one('SELECT COUNT(*) AS n FROM quotes WHERE agency_id = ?', sky.id)).n === before.n);
  await c.post(`/agent/quotes/${qid}`, accounts, { title: 'Renamed by accounts' });
  check('accounts cannot change quote details', (await one('SELECT title FROM quotes WHERE id = ?', qid)).title === 'Pipeline trip');
  await c.post(`/agent/activities/${act.id}/quote`, accounts, { quote_id: String(qid) });
  await c.post(`/agent/quotes/${qid}/items/custom`, accounts, { title: 'Sneaky', price: '1', qty: '1' });
  check('accounts cannot add lines', !(await one('SELECT 1 FROM quote_items WHERE quote_id = ?', qid)));
  await c.post(`/agent/quotes/${qid}/delete`, accounts, {});
  check('accounts cannot delete a quote', !!(await one('SELECT 1 FROM quotes WHERE id = ?', qid)));
  check('accounts cannot reach /agent/quotesX-style paths', loc(await c.get('/agent/quotesx', accounts)) === '/agent');
  // ...but can pay for one.
  await c.post(`/agent/activities/${act.id}/quote`, owner, { quote_id: String(qid) });
  await c.post(`/agent/quotes/${qid}/book`, accounts, {});
  check('accounts can pay for a quote', !!(await one('SELECT 1 FROM bookings WHERE quote_id = ?', qid)));
  check('accounts can open wallet, invoices and bookings', (await Promise.all(['/agent/wallet', '/agent/invoices', '/agent/bookings'].map((p) => c.get(p, accounts)))).every((r) => r.status === 200));
  check('accounts cannot open inventory or leads', (await Promise.all(['/agent/hotels', '/agent/leads', '/agent/packages'].map((p) => c.get(p, accounts)))).every((r) => r.status === 302));

  // ---------- support tickets ----------
  await c.post('/agent/support', owner, { subject: 'Pipeline help', body: 'Need help with voucher' });
  const t = await one("SELECT * FROM tickets WHERE subject = 'Pipeline help'");
  check('agent opens their ticket', t && (await (await c.get(`/agent/support/${t.id}`, owner)).text()).includes('Need help with voucher'));
  check('admin opens tickets list and the ticket', (await c.get('/admin/tickets', admin)).status === 200 && (await (await c.get(`/admin/tickets/${t.id}`, admin)).text()).includes('Pipeline help'));
  const otherAgent = await c.login(...ROLES.agent2);
  check("another agency cannot open the ticket", (await c.get(`/agent/support/${t.id}`, otherAgent)).status === 404);

  // ---------- admin invoice page ----------
  const inv = await one('SELECT id FROM invoices ORDER BY id DESC LIMIT 1');
  check('admin opens an invoice', (await c.get(`/admin/invoices/${inv.id}`, admin)).status === 200);

  // ---------- backend: new forms, CSV template, VaayuTrip packages ----------
  check('backend opens the new-product and new-package forms', (await c.get('/backend/products/new', backend)).status === 200 && (await c.get('/backend/packages/new', backend)).status === 200);
  const tpl = await c.get('/backend/import/template.csv', backend);
  check('import template downloads as CSV', tpl.status === 200 && /csv/.test(tpl.headers.get('content-type') || '') && (await tpl.text()).split('\n')[0].includes(','));
  const vp = await one('SELECT * FROM packages WHERE agency_id IS NULL ORDER BY id LIMIT 1');
  if (vp) {
    const form = await (await c.get(`/backend/packages/${vp.id}/edit`, backend)).text();
    const fields = new URLSearchParams();
    const attr = (tag, a) => (tag.match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1];
    const dec = (v) => String(v || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const named = (n) => n && !n.includes('__i__');
    const formHtml = form.slice(form.indexOf(`action="/backend/packages/${vp.id}"`));
    for (const [tag] of formHtml.matchAll(/<input\b[^>]*>/g)) {
      const n = attr(tag, 'name'); const type = attr(tag, 'type') || 'text';
      if (!named(n) || type === 'file' || ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag))) continue;
      fields.append(n, dec(attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : '')));
    }
    for (const m of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const n = attr(m[1], 'name'); if (!named(n)) continue;
      const opt = m[2].match(/<option\b[^>]*\sselected\b[^>]*>/) || m[2].match(/<option\b[^>]*>/);
      if (opt) fields.append(n, dec(attr(opt[0], 'value')));
    }
    for (const m of formHtml.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) { const n = attr(m[1], 'name'); if (named(n)) fields.append(n, dec(m[2])); }
    fields.set('title', `${vp.title} (edited)`);
    const r = await c.post(`/backend/packages/${vp.id}`, backend, fields);
    check('backend saves a VaayuTrip package', r.status === 302 && (await one('SELECT title FROM packages WHERE id = ?', vp.id)).title.endsWith('(edited)'), loc(r));
    await c.post(`/backend/packages/${vp.id}/departures`, backend, { dates: '2027-03-01, 2027-03-15', seats: '20' });
    const dep = await one("SELECT id FROM package_departures WHERE package_id = ? AND depart_on = '2027-03-01'", vp.id);
    await c.post(`/backend/packages/${vp.id}/departures/${dep.id}/delete`, backend, {});
    check('backend removes a departure', !(await one('SELECT 1 FROM package_departures WHERE id = ?', dep.id)) && !!(await one("SELECT 1 FROM package_departures WHERE package_id = ? AND depart_on = '2027-03-15'", vp.id)));
    check('agents cannot edit VaayuTrip packages', (await c.post(`/backend/packages/${vp.id}/delete`, owner, {})).status !== 302 || !!(await one('SELECT 1 FROM packages WHERE id = ?', vp.id)));
    await c.post(`/backend/packages/${vp.id}/delete`, backend, {});
    check('backend deletes a VaayuTrip package', !(await one('SELECT 1 FROM packages WHERE id = ?', vp.id)));
  }

  // ---------- sessions and codes ----------
  check('verify-email resend needs a login', loc(await c.post('/verify-email/resend', '', {})) === '/login');
  check('2-step resend without a pending login goes to login', loc(await c.post('/login/2step/resend', '', {})) === '/login');
  const r = await c.post('/logout', owner, {});
  const after = (r.headers.getSetCookie() || []).join(';');
  check('logout ends the session', loc(r) === '/login' && (await c.get('/agent', after.split(';')[0])).status === 302);

  finish(c);
})();
