// Business rules: KYC documents, the pending-agency lockdown, VaayuTrip margins, rate card import.
const fs = require('fs');
const { start, finish, check, db, ROLES } = require('./helpers');

const one = (sql, ...p) => db.prepare(sql).get(...p);
const PDF = '%PDF-1.4\n%test\n';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077053e0000000c4944415408d763f8ffff3f0005fe02fea7d6a5d50000000049454e44ae426082', 'hex');
// A PNG header claiming 20,000 × 20,000 pixels (400 MP): enough for the size check, no pixel data needed.
const HUGE_PNG = (() => { const b = Buffer.from(PNG); b.writeUInt32BE(20000, 16); b.writeUInt32BE(20000, 20); return b; })();

function signupForm(email, files, extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agency: `Agency ${email}`, name: 'Test Person', email, phone: '+91 90000 11111', city: 'Pune', country: 'India', gstin: '27AABCT1234M1Z5', password: 'secret123', ...extra })) fd.append(k, v);
  for (const [field, [data, type, name]] of Object.entries(files)) fd.append(field, new Blob([data], { type }), name);
  return fd;
}
const pdf = [PDF, 'application/pdf', 'doc.pdf'];
const png = [PNG, 'image/png', 'me.png'];

(async () => {
  const c = await start();
  const admin = await c.login(...ROLES.admin);
  const backend = await c.login(...ROLES.backend);

  // ---------- KYC at sign-up ----------
  const kycCount = () => fs.readdirSync(`${process.env.DATA_DIR}/kyc`).length;
  const before = kycCount();
  let r = await c.post('/signup', '', signupForm('nopan@t.in', { tax_doc: pdf, photo: png }));
  check('India sign-up without PAN card is refused', r.status === 200 && (await r.text()).includes('Upload PAN card.'));
  check('refused sign-up leaves no files behind', kycCount() === before, `${before} → ${kycCount()}`);
  r = await c.post('/signup', '', signupForm('pdfphoto@t.in', { tax_doc: pdf, pan_doc: pdf, photo: pdf }));
  check('a PDF as the photo is refused', (await r.text()).includes('Your photo must be a JPG, PNG or WebP image.'));
  r = await c.post('/signup', '', signupForm('huge@t.in', { tax_doc: pdf, pan_doc: [HUGE_PNG, 'image/png', 'pan.png'], photo: png }));
  check('a 400-megapixel image is refused', (await r.text()).includes('too large to view'));
  r = await c.post('/signup', '', signupForm('badgst@t.in', { tax_doc: pdf, pan_doc: pdf, photo: png }, { gstin: 'NOTAGSTIN' }));
  check('an invalid GSTIN is refused', (await r.text()).includes('GSTIN should be 15 characters'));
  r = await c.post('/signup', '', signupForm('omar@t.ae', { tax_doc: pdf, photo: png }, { country: 'United Arab Emirates', gstin: '', tax_id: 'TRN100200300400' }));
  check('a foreign agency signs up without a PAN card', r.status === 302);
  r = await c.post('/signup', '', signupForm('asha@t.in', { tax_doc: pdf, pan_doc: pdf, photo: png }));
  check('a complete Indian application is accepted', r.status === 302 && r.headers.get('location') === '/agent/settings');
  const asha = await c.login('asha@t.in', 'secret123');
  const ag = await one("SELECT a.* FROM agencies a JOIN users u ON u.agency_id = a.id WHERE u.email = 'asha@t.in'");
  check('new agency is pending with GST, PAN and photo stored', ag.status === 'pending' && ag.tax_doc && ag.pan_doc && ag.photo && ag.pan === 'AABCT1234M');
  check('documents are kept in the database', (await one("SELECT COUNT(*) AS n FROM files WHERE path LIKE 'data/kyc/%' AND path IN (?, ?, ?)", `data/kyc/${ag.tax_doc}`, `data/kyc/${ag.pan_doc}`, `data/kyc/${ag.photo}`)).n === 3);
  check('documents are not public', (await c.get(`/uploads/${ag.photo}`)).status === 404);
  check('agents cannot open KYC files', (await c.get(`/admin/agents/${ag.id}/kyc/photo`, asha)).status !== 200);
  check('admin can open the photo', (await c.get(`/admin/agents/${ag.id}/kyc/photo`, admin)).status === 200);
  check('unknown KYC field is 404', (await c.get(`/admin/agents/${ag.id}/kyc/password_hash`, admin)).status === 404);

  // ---------- pending lockdown ----------
  const home = await (await c.get('/agent', asha)).text();
  check('pending agency lands on the application status page', home.includes('Application status') && home.includes('Your application is under review'));
  check('no booking menu or balances while pending', !home.includes('href="/agent/flights"') && !home.includes('Credit available'));
  const leaks = [];
  for (const p of ['/agent/flights', '/agent/hotels', '/agent/packages', '/agent/packages/new', '/agent/quotes', '/agent/bookings', '/agent/wallet', '/agent/leads', '/agent/customers', '/agent/website', '/agent/api', '/agent/reports', '/agent/invoices']) {
    const res = await c.get(p, asha);
    if (!(res.status === 302 && res.headers.get('location') === '/agent')) leaks.push(`${p}:${res.status}`);
  }
  check('every selling page sends pending agencies to their status page', !leaks.length, leaks.join(' '));
  for (const p of ['/agent/packages', '/agent/quotes', '/agent/customers', '/agent/leads']) await c.post(p, asha, { title: 'x', name: 'x' });
  check('pending agency could not create anything', (await one('SELECT (SELECT COUNT(*) FROM packages WHERE agency_id = ?) + (SELECT COUNT(*) FROM quotes WHERE agency_id = ?) + (SELECT COUNT(*) FROM customers WHERE agency_id = ?) AS n', ag.id, ag.id, ag.id)).n === 0);
  await c.post(`/admin/agents/${ag.id}/status`, admin, { status: 'active', kyc_status: 'verified' });
  check('approval opens the full portal', (await c.get('/agent/flights', asha)).status === 200);
  await c.post('/admin/team', admin, {}); // no-op guard: empty form must not crash
  // Approval needs complete documents.
  await db.prepare('UPDATE agencies SET photo = NULL, status = ? WHERE id = ?').run('pending', ag.id);
  await c.post(`/admin/agents/${ag.id}/status`, admin, { status: 'active', kyc_status: 'verified' });
  check('cannot approve an agency missing its photo', (await one('SELECT status FROM agencies WHERE id = ?', ag.id)).status === 'pending');

  // ---------- margins ----------
  const off = await one(`SELECT COUNT(*) AS n FROM products WHERE cost_adult IS NULL
    OR net_adult <> ROUND(cost_adult * CASE kind WHEN 'hotel' THEN 1.03 WHEN 'activity' THEN 1.05 WHEN 'transfer' THEN 1.05 ELSE 1 END)`);
  check('all demo inventory carries cost + margin (hotels 3%, activities/transfers 5%)', off.n === 0, off.n);
  const make = async (fields) => Number((await c.post('/backend/products', backend, fields)).headers.get('location').match(/(\d+)$/)[1]);
  const base = { city: 'Dubai', country: 'United Arab Emirates', duration: '3 hours', d_room: 'Deluxe', d_stars: '4', d_mealPlan: 'CP' };
  const actId = await make({ ...base, kind: 'activity', title: 'Margin tour', price_basis: 'per_person', net_adult: '100', net_child: '60' });
  const hotelId = await make({ ...base, kind: 'hotel', title: 'Margin hotel', net_adult: '100' });
  const flightId = await make({ ...base, kind: 'flight', title: 'Margin fare', net_adult: '100', d_airline: 'EK', d_from: 'DEL', d_to: 'DXB' });
  const a = await one('SELECT * FROM products WHERE id = ?', actId);
  check('activity ₹100 → agents ₹105, child ₹60 → ₹63', a.cost_adult === 100 && a.net_adult === 105 && a.net_child === 63);
  check('hotel ₹100 → agents ₹103', (await one('SELECT net_adult FROM products WHERE id = ?', hotelId)).net_adult === 103);
  check('airfare has no margin by default', (await one('SELECT net_adult FROM products WHERE id = ?', flightId)).net_adult === 100);
  check('backend form edits the cost', (await (await c.get(`/backend/products/${actId}`, backend)).text()).includes('name="net_adult" value="100"'));
  await c.post('/admin/settings', admin, { margin_activity: '10' });
  check('changing the activity margin to 10% reprices it (₹110)', (await one('SELECT net_adult FROM products WHERE id = ?', actId)).net_adult === 110);
  check('hotels unaffected', (await one('SELECT net_adult FROM products WHERE id = ?', hotelId)).net_adult === 103);
  await c.post('/admin/settings', admin, { margin_hotel: '150' });
  check('a margin over 100% is refused', (await one('SELECT net_adult FROM products WHERE id = ?', hotelId)).net_adult === 103);
  await c.post('/admin/settings', admin, { margin_activity: '5' });

  // ---------- rate card ----------
  const card = 'C:/Users/Dell/Downloads/VaayuTrip-RateCard-Template.xlsx';
  if (fs.existsSync(card)) {
    const upload = async () => { const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(card)]), 'card.xlsx'); return c.follow(await c.post('/backend/import', backend, fd), backend); };
    const page = await upload();
    check('rate card imports activities and transfers', page.includes('Rate card imported: 6 new items added as drafts'));
    const safari = await one("SELECT * FROM products WHERE title = 'Desert Safari with BBQ Dinner (Private)'");
    check('AED converted to ₹ as cost; agents see +5%', safari && safari.cost_adult === 4091 && safari.net_adult === 4296, safari && `${safari.cost_adult}/${safari.net_adult}`);
    check('rows outside our destinations are explained', page.includes('is not one of our destination countries'));
    const again = await upload();
    check('re-upload updates instead of duplicating', again.includes('6 existing items updated'));
  } else {
    console.log('(rate card file not found in Downloads; skipped)');
  }
  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
