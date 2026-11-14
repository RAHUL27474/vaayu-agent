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

  // ---------- agent markup by service ----------
  const agent = await c.login(...ROLES.agent);
  const sky = await one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");
  await c.post('/agent/settings', agent, {
    name: sky.name, markup_type: 'percent', markup_value: '12',
    markup_type_hotel: 'percent', markup_hotel: '8', markup_type_activity: 'percent', markup_activity: '20', markup_type_transfer: 'flat', markup_transfer: '500', markup_flight: '',
  });
  const { kindRates, priceQuote } = require('../src/pricing');
  const rates = kindRates(await one('SELECT markup_by_kind FROM agencies WHERE id = ?', sky.id));
  check('agent saves a default per service: hotels 8%, activities 20%, transfers ₹500 (airfares blank = overall 12%)',
    rates.hotel.value === 8 && rates.activity.value === 20 && rates.transfer.type === 'flat' && rates.transfer.value === 500 && !rates.flight, JSON.stringify(rates));
  const pick = (kind) => one("SELECT * FROM products WHERE kind = ? AND status = 'published' ORDER BY id LIMIT 1", kind);
  const [actP, hotP, fliP, traP] = [await pick('activity'), await pick('hotel'), await pick('flight'), await pick('transfer')];
  const cat = await (await c.get(`/agent/activities?q=${encodeURIComponent(actP.title.slice(0, 12))}`, agent)).text();
  check('catalogue "You earn" uses the activity default (20%)', cat.includes(`₹${Math.round(actP.net_adult * 0.2).toLocaleString('en-IN')}`));
  const qid = Number((await c.post('/agent/quotes', agent, { title: 'Per-service markup' })).headers.get('location').match(/(\d+)$/)[1]);
  for (const [path, p] of [['activities', actP], ['hotels', hotP], ['flights', fliP], ['transfers', traP]]) await c.post(`/agent/${path}/${p.id}/quote`, agent, { quote_id: String(qid) });
  const priced = async () => priceQuote(await one('SELECT * FROM quotes WHERE id = ?', qid), await db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(qid));
  const pct = (p, kind) => { const l = p.lines.find((x) => x.type === kind); return Math.round((l.unitSell / l.unitNet - 1) * 1000) / 10; };
  const earnOn = (p, kind) => Math.round(p.lines.filter((x) => x.type === kind).reduce((n, x) => n + x.commission, 0) * 100) / 100;
  let p = await priced();
  check('new quote uses the defaults: activity +20%, hotel +8%, airfare +12%', pct(p, 'activity') === 20 && pct(p, 'hotel') === 8 && pct(p, 'flight') === 12, `${pct(p, 'activity')}/${pct(p, 'hotel')}/${pct(p, 'flight')}`);
  check('transfers earn the ₹500 default, spread over their lines', earnOn(p, 'transfer') === 500, earnOn(p, 'transfer'));
  const page = await (await c.get(`/agent/quotes/${qid}`, agent)).text();
  check('quote shows a ticked "Default" box per service', (page.match(/name="use_default_[a-z]+" value="1"\s+checked/g) || []).length === 6 && page.includes('Default (8%)'));
  // Untick hotels → own 10%; untick activities → own ₹1,000; leave the rest on their defaults.
  const form = { title: 'Per-service markup', adults: '2', markup_type: 'percent', markup_value: '12',
    markup_type_hotel: 'percent', markup_hotel: '10', markup_type_activity: 'flat', markup_activity: '1000',
    use_default_flight: '1', use_default_transfer: '1', use_default_visa: '1', use_default_insurance: '1' };
  await c.post(`/agent/quotes/${qid}`, agent, form);
  p = await priced();
  check("unticked hotel uses this quote's own 10%", pct(p, 'hotel') === 10, pct(p, 'hotel'));
  check("unticked activity earns this quote's own ₹1,000", earnOn(p, 'activity') === 1000, earnOn(p, 'activity'));
  check('ticked services keep their defaults (transfer ₹500, airfare 12%)', earnOn(p, 'transfer') === 500 && pct(p, 'flight') === 12);
  check("the agent's own defaults are unchanged", kindRates(await one('SELECT markup_by_kind FROM agencies WHERE id = ?', sky.id)).hotel.value === 8);
  const after = await (await c.get(`/agent/quotes/${qid}`, agent)).text();
  check('the quote page shows hotels unticked with 10%', /name="use_default_hotel" value="1"\s+(?!checked)/.test(after) && after.includes('name="markup_hotel" type="number" min="0" step="0.5" value="10"'));
  // Ticking a box again goes back to the default.
  await c.post(`/agent/quotes/${qid}`, agent, { ...form, use_default_hotel: '1' });
  check('ticking "Default" again restores hotels to 8%', pct(await priced(), 'hotel') === 8);

  // ---------- markup chosen on a product page ----------
  const pp = await (await c.get(`/agent/activities/${actP.id}?adults=2`, agent)).text();
  check('product page offers "My default" (ticked) with the service default', pp.includes('name="use_default" value="1" checked') && pp.includes('(20%)'));
  const own = await (await c.get(`/agent/activities/${actP.id}?adults=2&mu_type=percent&mu=25`, agent)).text();
  const pl = (await import('../src/products.js')).default || require('../src/products');
  const lines = pl.productLines(actP, { adults: 2, children: 0, infants: 0, rooms: 1, nights: 1 });
  const net = lines.reduce((n, l) => n + l.net * l.qty, 0);
  check('unticked with 25%: the page prices at net + 25%', own.includes(`₹${Math.round(net * 1.25).toLocaleString('en-IN')}`) && own.includes('name="mu" value="25"'), Math.round(net * 1.25));
  const q3 = Number((await c.post(`/agent/activities/${actP.id}/quote`, agent, { quote_id: 'new', new_title: 'Own markup', adults: '2', children: '0', mu_type: 'percent', mu: '25' })).headers.get('location').match(/quotes\/(\d+)/)[1]);
  const items3 = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(q3);
  check('"Add to quote" carries that price into the quote line', items3.length && items3.every((i) => Math.abs(i.sell_price - i.net_price * 1.25) < 0.02), items3.map((i) => `${i.net_price}→${i.sell_price}`).join(', '));

  // ---------- travel voucher and search ----------
  const bk = await one("SELECT b.*, q.code AS qcode FROM bookings b JOIN quotes q ON q.id = b.quote_id WHERE b.agency_id = (SELECT agency_id FROM users WHERE email = ?) AND b.status = 'confirmed' ORDER BY b.id LIMIT 1", ROLES.agent[0]);
  const voucher = await (await c.get(`/agent/bookings/${bk.id}/voucher`, agent)).text();
  check('agent opens a travel voucher with no prices', voucher.includes('TRAVEL VOUCHER') && voucher.includes(bk.code) && !voucher.includes('₹'));
  const shared = await c.get(`/q/${bk.qcode}/voucher`);
  check('customer opens the voucher from the quote link', shared.status === 200 && (await shared.text()).includes(bk.code));
  const other = await one('SELECT id FROM bookings WHERE agency_id != (SELECT agency_id FROM users WHERE email = ?) LIMIT 1', ROLES.agent[0]);
  check("another agency's voucher is not found", !other || (await c.get(`/agent/bookings/${other.id}/voucher`, agent)).status === 404);
  const found = await (await c.get(`/agent/search?q=${encodeURIComponent(bk.code)}`, agent)).text();
  check('agent search finds a booking by code', found.includes(`/agent/bookings/${bk.id}`));
  check('agent search treats % literally', !(await (await c.get('/agent/search?q=%25%25', agent)).text()).includes('/agent/bookings/'));
  const adminCookie = await c.login(...ROLES.admin);
  check('admin search finds the agency by name', (await (await c.get('/admin/search?q=skyline', adminCookie)).text()).includes('/admin/agents/'));

  // ---------- duplicate quote ----------
  const srcQ = await one('SELECT q.* FROM quotes q WHERE q.agency_id = (SELECT agency_id FROM users WHERE email = ?) AND EXISTS (SELECT 1 FROM quote_items i WHERE i.quote_id = q.id) ORDER BY q.id LIMIT 1', ROLES.agent[0]);
  const dupLoc = (await c.post(`/agent/quotes/${srcQ.id}/duplicate`, agent, {})).headers.get('location') || '';
  const dupId = Number((dupLoc.match(/quotes\/(\d+)/) || [])[1]);
  const dup = dupId && await one('SELECT * FROM quotes WHERE id = ?', dupId);
  const cnt = async (id) => (await one('SELECT COUNT(*) AS n FROM quote_items WHERE quote_id = ?', id)).n;
  check('duplicate quote is a new draft with the same services', dup && dup.status === 'draft' && dup.code !== srcQ.code && !dup.customer_id && await cnt(dupId) === await cnt(srcQ.id));
  check("another agency's quote can't be duplicated", (await c.post(`/agent/quotes/${srcQ.id}/duplicate`, await c.login(...ROLES.agent2), {})).status === 404);

  // ---------- passwords ----------
  const pwUser = 'agent@ravitours.com';
  const devA = await c.login(pwUser, 'agent123');
  const devB = await c.login(pwUser, 'agent123');
  check('My account page opens', (await (await c.get('/account', devA)).text()).includes('Change password'));
  const pwChange = (cookie, fields) => c.post('/account/password', cookie, fields);
  const canLogin = async (email, password) => (await c.post('/login', '', { email, password })).status === 302;
  const merge = (cookie, r) => { const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((x) => x.split(/=(.*)/s).slice(0, 2))); for (const sc of r.headers.getSetCookie()) { const [k, v] = sc.split(';')[0].split(/=(.*)/s); jar[k] = v; } return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); };
  await pwChange(devA, { current: 'wrong-one', password: 'newpass123', confirm: 'newpass123' });
  check('wrong current password is refused', !(await canLogin(pwUser, 'newpass123')));
  const devA2 = merge(devA, await pwChange(devA, { current: 'agent123', password: 'newpass123', confirm: 'newpass123' }));
  check('password changes with the current one', await canLogin(pwUser, 'newpass123') && !(await canLogin(pwUser, 'agent123')));
  check('the device that changed it stays logged in', (await c.get('/agent', devA2)).status === 200);
  check('other devices are logged out', (await c.get('/agent', devB)).status === 302);
  await c.post('/forgot-password', '', { email: pwUser });
  await c.post('/forgot-password', '', { email: pwUser });
  check('forgot password notifies VaayuTrip support once', (await one("SELECT COUNT(*) AS n FROM notifications WHERE agency_id IS NULL AND title = 'Password reset request' AND body LIKE ?", `%${pwUser}%`)).n === 1);
  await c.post('/forgot-password', '', { email: 'nobody@nowhere.in' });
  check('unknown emails create no request', (await one("SELECT COUNT(*) AS n FROM notifications WHERE body LIKE '%nobody@nowhere.in%'")).n === 0);
  const ru = await one('SELECT id, agency_id FROM users WHERE email = ?', pwUser);
  await c.post(`/admin/agents/${ru.agency_id}/users/${ru.id}/password`, adminCookie, { password: 'reset12345' });
  check('admin sets a new password for an agency user', await canLogin(pwUser, 'reset12345'));

  // ---------- health check, structured data ----------
  const hz = await c.get('/healthz');
  check('health check answers', hz.status === 200 && (await hz.json()).ok === true);
  const pkgUrl = (await (await c.get('/sitemap.xml')).text()).match(/\/site\/skyline-holidays\/p\/[^<]+/)[0];
  const ldm = (await (await c.get(pkgUrl)).text()).match(/<script type="application\/ld\+json">(.*?)<\/script>/);
  const ld = ldm && JSON.parse(ldm[1]);
  check('package page has TouristTrip data with an INR price', ld && ld['@type'] === 'TouristTrip' && ld.offers.priceCurrency === 'INR' && ld.offers.price > 0 && ld.provider.name === 'Skyline Holidays');

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
