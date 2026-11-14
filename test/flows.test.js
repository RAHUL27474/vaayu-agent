// End-to-end workflows for every role, driven through the same forms people use.
const fs = require('fs');
const path = require('path');
const { start, finish, check, cookieOf, db, ROLES } = require('./helpers');

const one = (sql, ...p) => db.prepare(sql).get(...p);
// The last number in the redirect path: /agent/quotes/12, /agent/packages/7/edit …
const idFrom = (r) => Number(((r.headers.get('location') || '').split('?')[0].match(/\/(\d+)(?!.*\/\d)/) || [])[1]);
const PDF = '%PDF-1.4\n%test\n';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077053e0000000c4944415408d763f8ffff3f0005fe02fea7d6a5d50000000049454e44ae426082', 'hex');

(async () => {
  const c = await start();
  const login = (role) => c.login(...ROLES[role]);
  const [agent, admin, backend] = [await login('agent'), await login('admin'), await login('backend')];
  const ag = await one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");
  const ok = (r) => r.status === 302 || r.status === 200;
  /** POST then report whether the page it leads to shows an error flash. */
  async function act(name, p, cookie, fields, referer) {
    const r = await c.post(p, cookie, fields, referer);
    const page = await c.follow(r, cookie);
    const err = (page.match(/<div class="alert error"[^>]*>[\s\S]*?<span>([^<]*)<\/span>/) || [])[1];
    check(name, ok(r) && !err, err || r.status);
    return r;
  }

  // ---------- customers & leads ----------
  let r = await act('agent adds a customer', '/agent/customers', agent, { name: 'Flow Customer', email: 'flow@cust.in', phone: '+91 90000 00001', city: 'Pune' });
  const cust = await one("SELECT * FROM customers WHERE email = 'flow@cust.in'");
  check('customer stored', cust && cust.agency_id === ag.id);
  await act('agent edits the customer', `/agent/customers/${cust.id}`, agent, { name: 'Flow Customer B', email: 'flow@cust.in', phone: '+91 90000 00001', city: 'Mumbai', notes: 'VIP' });
  check('customer updated', (await one('SELECT city FROM customers WHERE id = ?', cust.id)).city === 'Mumbai');
  check('customer page renders', (await c.get(`/agent/customers/${cust.id}`, agent)).status === 200);
  await act('agent adds a lead', '/agent/leads', agent, { name: 'Flow Lead', phone: '+91 90000 00002', destination: 'Dubai', pax: '2', budget: '150000' });
  const lead = await one("SELECT * FROM leads WHERE name = 'Flow Lead'");
  await act('lead status → contacted', `/agent/leads/${lead.id}/status`, agent, { status: 'contacted' });
  check('lead status saved', (await one('SELECT status FROM leads WHERE id = ?', lead.id)).status === 'contacted');
  r = await act('lead → quote', `/agent/leads/${lead.id}/quote`, agent, {});
  const leadQuote = idFrom(r);
  check('lead quote created and lead marked quoted', leadQuote > 0 && (await one('SELECT status FROM leads WHERE id = ?', lead.id)).status === 'quoted');

  // ---------- quotes ----------
  r = await act('agent creates a blank quote', '/agent/quotes', agent, { title: 'Flow quote', customer_id: String(cust.id), travel_date: '2027-01-15' });
  const qid = idFrom(r);
  const act1 = await one("SELECT * FROM products WHERE kind = 'activity' AND status = 'published' ORDER BY id LIMIT 1");
  await act('add a VaayuTrip activity to the quote', `/agent/activities/${act1.id}/quote`, agent, { quote_id: String(qid) });
  await act('add a custom service', `/agent/quotes/${qid}/items/custom`, agent, { title: 'Own cab', type: 'transfer', price: '2500', cost: '1800', qty: '1' });
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(qid);
  const itemList = await items;
  check('quote has both lines', itemList.length >= 2, itemList.length);
  const vaayuItem = itemList.find((i) => i.supplier === 'vaayu');
  check('VaayuTrip line priced at agent net (cost + margin)', vaayuItem && vaayuItem.net_price === act1.net_adult, `${vaayuItem && vaayuItem.net_price} vs ${act1.net_adult}`);
  r = await c.post(`/agent/quotes/${qid}/items`, agent, { [`sell_${vaayuItem.id}`]: String(vaayuItem.net_price - 1), [`qty_${vaayuItem.id}`]: '2' });
  check('selling a VaayuTrip line below net is refused', (await c.follow(r, agent)).includes("can&#39;t be below"));
  await act('update quote settings', `/agent/quotes/${qid}`, agent, { title: 'Flow quote', customer_id: String(cust.id), travel_date: '2027-01-15', adults: '2', children: '1', markup_type: 'percent', markup_value: '12', invoice_mode: 'vaayu' });
  check('quote page renders', (await c.get(`/agent/quotes/${qid}`, agent)).status === 200);
  await act('send the quote', `/agent/quotes/${qid}/send`, agent, {});
  const quote = await one('SELECT * FROM quotes WHERE id = ?', qid);
  check('quote marked sent', quote.status === 'sent');
  const shared = await c.get(`/q/${quote.code}`);
  check('customer can open the shared quote', shared.status === 200);
  await act('customer accepts the quote', `/q/${quote.code}/accept`, '', {});
  check('quote accepted', (await one('SELECT status FROM quotes WHERE id = ?', qid)).status === 'accepted');
  r = await act('agent creates a payment link for the quote', `/agent/quotes/${qid}/payment-link`, agent, { amount: '5000' });
  const link = await one('SELECT * FROM payment_links WHERE quote_id = ? ORDER BY id DESC', qid);
  check('payment link opens', (await c.get(`/pay/${link.code}`)).status === 200);
  await act('customer pays the link (demo checkout)', `/pay/${link.code}`, '', {});
  check('payment link paid', (await one('SELECT status FROM payment_links WHERE id = ?', link.id)).status === 'paid');

  // ---------- booking, invoices, cancellation ----------
  const w0 = (await one('SELECT wallet_balance FROM agencies WHERE id = ?', ag.id)).wallet_balance;
  await act('agent books the quote', `/agent/quotes/${qid}/book`, agent, {});
  const booking = await one('SELECT * FROM bookings WHERE quote_id = ?', qid);
  const w1 = (await one('SELECT wallet_balance FROM agencies WHERE id = ?', ag.id)).wallet_balance;
  check('booking created and wallet charged', booking && Math.abs((w0 - w1) - booking.paid_wallet) < 0.01 && booking.paid_wallet > 0, `${w0} → ${w1}`);
  check('B2B invoice issued for the booking', Boolean(await one("SELECT 1 FROM invoices WHERE booking_id = ? AND kind = 'b2b'", booking.id)));
  await act('agent issues the customer invoice', `/agent/quotes/${qid}/invoice`, agent, {});
  const custInv = await one("SELECT * FROM invoices WHERE quote_id = ? AND kind <> 'b2b' ORDER BY id DESC", qid);
  check('customer invoice opens for agent and customer', custInv && (await c.get(`/agent/invoices/${custInv.id}`, agent)).status === 200 && (await c.get(`/q/${quote.code}/invoice/${custInv.id}`)).status === 200);
  check('booking page renders', (await c.get(`/agent/bookings/${booking.id}`, agent)).status === 200);
  await act('agent requests cancellation', `/agent/bookings/${booking.id}/cancel`, agent, { reason: 'Customer fell ill' });
  check('booking cancel requested', (await one('SELECT status FROM bookings WHERE id = ?', booking.id)).status === 'cancel_requested');
  check('admin booking page renders', (await c.get(`/admin/bookings/${booking.id}`, admin)).status === 200);
  const w2 = (await one('SELECT wallet_balance, credit_used FROM agencies WHERE id = ?', ag.id));
  await act('admin approves the cancellation with a refund', `/admin/bookings/${booking.id}/cancel`, admin, { refund: String(booking.paid_wallet + booking.paid_credit) });
  const w3 = (await one('SELECT wallet_balance, credit_used FROM agencies WHERE id = ?', ag.id));
  check('booking cancelled and refunded in full', (await one('SELECT status FROM bookings WHERE id = ?', booking.id)).status === 'cancelled'
    && Math.abs((w3.wallet_balance - w2.wallet_balance) + (w2.credit_used - w3.credit_used) - (booking.paid_wallet + booking.paid_credit)) < 0.01);

  // A second booking whose cancellation is rejected.
  r = await act('second quote from a VaayuTrip hotel', `/agent/hotels/${(await one("SELECT id FROM products WHERE kind = 'hotel' AND status = 'published' ORDER BY id LIMIT 1")).id}/quote`, agent, { quote_id: 'new', new_title: 'Hotel only' });
  const q2 = idFrom(r) || (await one("SELECT id FROM quotes WHERE title = 'Hotel only'")).id;
  await act('book the second quote', `/agent/quotes/${q2}/book`, agent, {});
  const b2 = await one('SELECT * FROM bookings WHERE quote_id = ?', q2);
  await act('agent requests cancellation of booking 2', `/agent/bookings/${b2.id}/cancel`, agent, { reason: 'Changed plans' });
  await act('admin rejects that cancellation', `/admin/bookings/${b2.id}/reject-cancel`, admin, { reason: 'Non-refundable' });
  check('booking back to confirmed', (await one('SELECT status FROM bookings WHERE id = ?', b2.id)).status === 'confirmed');

  // Delete a draft quote.
  r = await act('create a throwaway quote', '/agent/quotes', agent, { title: 'Delete me' });
  const qdel = idFrom(r);
  await act('delete the draft quote', `/agent/quotes/${qdel}/delete`, agent, {});
  check('draft quote deleted', !(await one('SELECT 1 FROM quotes WHERE id = ?', qdel)));

  // ---------- packages ----------
  const hotel = await one("SELECT * FROM products WHERE kind = 'hotel' AND status = 'published' AND country = 'United Arab Emirates' ORDER BY id LIMIT 1");
  const pkgFields = {
    title: 'Flow Dubai escape', destination: 'Dubai', nights: '4', theme: 'Family', summary: 'Test package', is_international: '1', departure_city: 'Mumbai',
    'route[0][city]': 'Dubai', 'route[0][nights]': '4',
    'days[0][title]': 'Arrive', 'days[0][description]': 'Check in', 'days[0][b]': '1',
    'items[0][day]': '1', 'items[0][id]': String(hotel.id), 'items[0][nights]': '2',
    'items[1][day]': '2', 'items[1][id]': String(act1.id),
    'stays[0][source]': 'agent', 'stays[0][city]': 'Dubai', 'stays[0][hotel]': 'Agent Inn', 'stays[0][nights]': '1', 'stays[0][cost]': '4000', 'stays[0][price]': '5000',
    'stays[1][source]': 'client', 'stays[1][city]': 'Dubai', 'stays[1][hotel]': 'Friend flat', 'stays[1][nights]': '1', 'stays[1][price]': '9999',
    'extras[0][type]': 'guide', 'extras[0][title]': 'Private guide', 'extras[0][basis]': 'per_booking', 'extras[0][cost]': '1500', 'extras[0][price]': '2500',
    inclusions: 'Breakfast', exclusions: 'Visa',
  };
  r = await act('agent builds a package', '/agent/packages', agent, pkgFields);
  const pid = idFrom(r);
  const pkg = await one('SELECT * FROM packages WHERE id = ?', pid);
  const d = JSON.parse(pkg.details);
  check('package keeps VaayuTrip items, own and customer hotels, extras', d.items.length === 2 && d.stays.length === 2 && d.stays[1].source === 'client' && d.stays[1].price === 0 && d.extras[0].price === 2500,
    `${d.items.length} items, ${d.stays.map((s) => `${s.source}:${s.price}`).join(',')}, extra ${d.extras[0] && d.extras[0].price}`);
  const pkgPage = await (await c.get(`/agent/packages/${pid}?adults=2&rooms=1`, agent)).text();
  check('package page shows all three hotel sources', pkgPage.includes('From VaayuTrip') && pkgPage.includes('Your own') && pkgPage.includes("Customer&#39;s own"));
  check('package edit form renders', (await c.get(`/agent/packages/${pid}/edit`, agent)).status === 200);
  await act('agent edits the package', `/agent/packages/${pid}`, agent, { ...pkgFields, title: 'Flow Dubai escape v2' });
  check('package edit saved', (await one('SELECT title FROM packages WHERE id = ?', pid)).title === 'Flow Dubai escape v2');
  await act('publish the package', `/agent/packages/${pid}/status`, agent, { status: 'published' });
  const pub = await one('SELECT status, slug FROM packages WHERE id = ?', pid);
  check('package published', pub.status === 'published');
  check('package on the agent website', (await c.get(`/site/${ag.slug}/p/${pub.slug}`)).status === 200);
  r = await act('quote from the package', `/agent/packages/${pid}/quote`, agent, { adults: '2', children: '0', rooms: '1', customer_id: String(cust.id), date: '2027-02-01' });
  const pq = idFrom(r);
  const pqItems = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(pq);
  check("package quote prices the agent's hotel but not the customer's", pqItems.some((i) => i.title.startsWith('Agent Inn')) && !pqItems.some((i) => i.title.includes('Friend flat')));
  r = await act('duplicate the package', `/agent/packages/${pid}/duplicate`, agent, {});
  const dup = idFrom(r);
  await act('delete the duplicate', `/agent/packages/${dup}/delete`, agent, {});
  check('duplicate deleted', !(await one('SELECT 1 FROM packages WHERE id = ?', dup)));
  r = await act('add a product to a package from the catalogue', `/agent/activities/${act1.id}/add-to-package`, agent, { package_id: String(pid), day: '3' });
  check('item added to package', JSON.parse((await one('SELECT details FROM packages WHERE id = ?', pid)).details).items.length === 3);

  // ---------- website, enquiries, API ----------
  await act('agent updates website text', '/agent/website', agent, { website_enabled: '1', website_tagline: 'Holidays made easy', website_about: 'We are Skyline.' });
  check('website shows the tagline', (await (await c.get(`/site/${ag.slug}`)).text()).includes('Holidays made easy'));
  await act('visitor enquires on the website', `/site/${ag.slug}/enquire`, '', { name: 'Web Visitor', phone: '+91 90000 00003', package_id: String(pid), message: 'Hi' }, `/site/${ag.slug}`);
  check('enquiry became a website lead', Boolean(await one("SELECT 1 FROM leads WHERE name = 'Web Visitor' AND source = 'website'")));
  await act('agent regenerates the API key', '/agent/api/regenerate', agent, {});
  const key = (await one('SELECT api_key FROM agencies WHERE id = ?', ag.id)).api_key;
  const api = (p, init = {}) => fetch(c.B + '/api/v1' + p, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${key}` } });
  const apiPk = await api('/packages');
  const apiJson = await apiPk.json();
  check('API lists published packages with prices', apiPk.status === 200 && apiJson.data.some((p) => p.title === 'Flow Dubai escape v2' && p.price_per_person_from > 0), JSON.stringify(apiJson).slice(0, 120));
  const apiDetail = await api(`/packages/${pub.slug}`);
  const apiText = await apiDetail.text();
  check('API package detail', apiDetail.status === 200);
  check('API never names VaayuTrip as the supplier', !/vaayu/i.test(apiText.replace(/vaayutrip.com|vaayu-agent/gi, '')), apiText.match(/.{30}vaayu.{30}/i)?.[0]);
  const apiLead = await api('/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API Lead', phone: '+91 90000 00004', package_slug: pub.slug }) });
  check('API creates a lead', apiLead.status === 201 || apiLead.status === 200, apiLead.status);
  check('API bookings list', (await api('/bookings')).status === 200);
  check('API refuses a wrong key', (await fetch(c.B + '/api/v1/packages', { headers: { authorization: 'Bearer nope' } })).status === 401);

  // ---------- money: wallet top-up, payment links ----------
  await act('agent requests a wallet top-up', '/agent/wallet/topup', agent, { amount: '25000', utr: 'UTRFLOW123' });
  const tu = await one("SELECT * FROM topup_requests WHERE utr = 'UTRFLOW123'");
  const wb = (await one('SELECT wallet_balance FROM agencies WHERE id = ?', ag.id)).wallet_balance;
  await act('admin approves the top-up', `/admin/topups/${tu.id}/approve`, admin, {});
  check('top-up credited once', Math.abs((await one('SELECT wallet_balance FROM agencies WHERE id = ?', ag.id)).wallet_balance - wb - 25000) < 0.01);
  await act('agent requests another top-up', '/agent/wallet/topup', agent, { amount: '1000', utr: 'UTRFLOW999' });
  const tu2 = await one("SELECT * FROM topup_requests WHERE utr = 'UTRFLOW999'");
  await act('admin rejects it', `/admin/topups/${tu2.id}/reject`, admin, {});
  check('rejected top-up not credited', (await one('SELECT status FROM topup_requests WHERE id = ?', tu2.id)).status === 'rejected');
  await act('agent creates a standalone payment link', '/agent/payment-links', agent, { amount: '3000', purpose: 'Advance', customer_name: 'Flow Customer' });
  const pl = await one("SELECT * FROM payment_links WHERE purpose = 'Advance' ORDER BY id DESC");
  await act('agent expires it', `/agent/payment-links/${pl.id}/expire`, agent, {});
  check('payment link expired', (await one('SELECT status FROM payment_links WHERE id = ?', pl.id)).status === 'expired');
  for (const csv of ['/agent/reports/bookings.csv', '/agent/reports/ledger.csv']) {
    const res = await c.get(csv, agent);
    check(`${csv} downloads`, res.status === 200 && (res.headers.get('content-type') || '').includes('csv') && (await res.text()).split('\n').length > 1);
  }

  // ---------- support ----------
  await act('agent opens a support ticket', '/agent/support', agent, { subject: 'Flow ticket', body: 'Help please', category: 'booking' });
  const tk = await one("SELECT * FROM tickets WHERE subject = 'Flow ticket'");
  await act('admin replies', `/admin/tickets/${tk.id}/reply`, admin, { body: 'On it' });
  check('ticket answered', (await one('SELECT status FROM tickets WHERE id = ?', tk.id)).status === 'answered');
  await act('agent replies and closes', `/agent/support/${tk.id}/reply`, agent, { body: 'Thanks', close: '1' });
  check('ticket closed', (await one('SELECT status FROM tickets WHERE id = ?', tk.id)).status === 'closed');

  // ---------- agent settings ----------
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Skyline Holidays', legal_name: 'Skyline Holidays LLP', phone: '+91 98200 11111', email: 'hello@skyline.in', city: 'Mumbai', brand_color: '#123456', markup_type: 'percent', markup_value: '15' })) fd.append(k, v);
  fd.append('logo', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  await act('agent saves branding with a new logo', '/agent/settings', agent, fd);
  const branded = await one('SELECT brand_color, logo_path, markup_value FROM agencies WHERE id = ?', ag.id);
  check('branding saved', branded.brand_color === '#123456' && branded.markup_value === 15 && /^\/uploads\//.test(branded.logo_path));
  check('new logo is served', (await c.get(branded.logo_path)).status === 200);
  check('logo stored in the database', Boolean(await one('SELECT 1 FROM files WHERE path = ?', `uploads/${branded.logo_path.replace('/uploads/', '')}`)));

  // ---------- sign-up, KYC, approval ----------
  const sf = new FormData();
  for (const [k, v] of Object.entries({ agency: 'Flow Travels', name: 'Fiona Flow', email: 'fiona@flow.in', phone: '+91 90000 00005', city: 'Delhi', country: 'India', gstin: '07AABCF1234M1Z5', password: 'secret123' })) sf.append(k, v);
  sf.append('tax_doc', new Blob([PDF], { type: 'application/pdf' }), 'gst.pdf');
  sf.append('pan_doc', new Blob([PDF], { type: 'application/pdf' }), 'pan.pdf');
  sf.append('photo', new Blob([PNG], { type: 'image/png' }), 'me.png');
  r = await c.post('/signup', '', sf);
  check('new agency signs up', r.status === 302 && r.headers.get('location') === '/agent/settings', r.status);
  const fiona = cookieOf(r);
  const fa = await one("SELECT * FROM agencies WHERE name = 'Flow Travels'");
  check('pending agency sees the status page and cannot book', (await (await c.get('/agent', fiona)).text()).includes('Application status') && (await c.get('/agent/flights', fiona)).headers.get('location') === '/agent');
  await act('admin rejects KYC with a reason', `/admin/agents/${fa.id}/kyc-reject`, admin, { reason: 'PAN blurred' });
  check('agency sees the reason', (await (await c.get('/agent', fiona)).text()).includes('PAN blurred'));
  const rf = new FormData();
  rf.append('country', 'India'); rf.append('gstin', '07AABCF1234M1Z5');
  rf.append('pan_doc', new Blob([PDF], { type: 'application/pdf' }), 'pan2.pdf');
  await act('agency re-uploads the PAN card', '/agent/settings/tax', fiona, rf);
  check('KYC back to pending', (await one('SELECT kyc_status FROM agencies WHERE id = ?', fa.id)).kyc_status === 'pending');
  check('admin KYC viewer works', (await c.get(`/admin/agents/${fa.id}/kyc/pan_doc/view`, admin)).status === 200);
  await act('admin approves the agency', `/admin/agents/${fa.id}/status`, admin, { status: 'active', kyc_status: 'verified' });
  check('approved agency gets the full dashboard', (await (await c.get('/agent', fiona)).text()).includes('What are you booking today?'));
  await act('admin sets a credit limit', `/admin/agents/${fa.id}/credit`, admin, { credit_limit: '50000' });
  await act('admin adjusts the wallet', `/admin/agents/${fa.id}/wallet`, admin, { amount: '10000', ref: 'ADJ1', note: 'Welcome credit' });
  const fa2 = await one('SELECT credit_limit, wallet_balance FROM agencies WHERE id = ?', fa.id);
  check('credit and wallet set', fa2.credit_limit === 50000 && fa2.wallet_balance === 10000, JSON.stringify(fa2));

  // ---------- admin: team, offers, settings ----------
  await act('admin adds a backend team member', '/admin/team', admin, { name: 'New Staff', email: 'staff@vaayutrip.com', password: 'staffpass1', role: 'backend' });
  const staff = await one("SELECT * FROM users WHERE email = 'staff@vaayutrip.com'");
  check('new staff can log in', Boolean(await c.login('staff@vaayutrip.com', 'staffpass1')) && (await c.get('/backend', await c.login('staff@vaayutrip.com', 'staffpass1'))).status === 200);
  await act('admin resets their password', `/admin/team/${staff.id}/password`, admin, { password: 'newpass123' });
  await act('admin switches them off', `/admin/team/${staff.id}/toggle`, admin, {});
  const off = await c.login('staff@vaayutrip.com', 'newpass123');
  check('switched-off staff cannot use the portal', (await c.get('/backend', off)).status !== 200);
  await act('admin creates an offer', '/admin/offers', admin, { title: 'Flow offer', body: 'Save big', code: 'FLOW10', valid_until: '2099-12-31' });
  const offer = await one("SELECT * FROM offers WHERE title = 'Flow offer'");
  check('agents see the offer', (await (await c.get('/agent/offers', agent)).text()).includes('Flow offer'));
  await act('admin pauses the offer', `/admin/offers/${offer.id}/toggle`, admin, {});
  await act('admin deletes the offer', `/admin/offers/${offer.id}/delete`, admin, {});
  check('offer gone', !(await one('SELECT 1 FROM offers WHERE id = ?', offer.id)));
  await act('admin saves settings', '/admin/settings', admin, { company_name: 'VaayuTrip', margin_hotel: '3' });

  // ---------- backend inventory ----------
  r = await act('backend adds an activity', '/backend/products', backend, { kind: 'activity', title: 'Flow tour', city: 'Bali', country: 'Indonesia', duration: '4 hours', price_basis: 'per_person', net_adult: '1000' });
  const prod = idFrom(r);
  await act('backend publishes it', `/backend/products/${prod}/status`, backend, { status: 'published' });
  check('agents see it at cost + 5%', (await one('SELECT net_adult, status FROM products WHERE id = ?', prod)).net_adult === 1050);
  r = await act('backend duplicates it', `/backend/products/${prod}/duplicate`, backend, {});
  await act('backend deletes the copy', `/backend/products/${idFrom(r)}/delete`, backend, {});
  const csv = 'kind,title,city,country,duration,net_adult\r\nactivity,CSV flow tour,Dubai,United Arab Emirates,2 hours,500\r\n';
  const cf = new FormData(); cf.append('file', new Blob([csv], { type: 'text/csv' }), 'x.csv');
  await act('backend imports a CSV', '/backend/import', backend, cf);
  check('CSV item imported with margin', (await one("SELECT net_adult FROM products WHERE title = 'CSV flow tour'")).net_adult === 525);
  const card = 'C:/Users/Dell/Downloads/VaayuTrip-RateCard-Template.xlsx';
  if (fs.existsSync(card)) {
    const xf = new FormData(); xf.append('file', new Blob([fs.readFileSync(card)]), 'card.xlsx');
    r = await c.post('/backend/import', backend, xf);
    check('rate card (Excel) imports', (await c.follow(r, backend)).includes('Rate card imported'));
  }

  // ---------- notifications ----------
  check('agent notifications page', (await c.get('/agent/notifications', agent)).status === 200);
  check('admin notifications page', (await c.get('/admin/notifications', admin)).status === 200);
  check('unread count cleared after viewing', (await one('SELECT COUNT(*) AS n FROM notifications WHERE agency_id = ? AND is_read = 0', ag.id)).n === 0);

  // ---------- access control ----------
  check('agent cannot open admin', (await c.get('/admin', agent)).status === 302);
  check('agent cannot open backend', (await c.get('/backend', agent)).status === 302);
  check('backend cannot open admin', (await c.get('/admin', backend)).status === 302);
  const other = await one("SELECT id FROM quotes WHERE agency_id <> ? LIMIT 1", ag.id);
  if (other) check("agent cannot open another agency's quote", (await c.get(`/agent/quotes/${other.id}`, agent)).status !== 200);
  check('logged-out users are sent to login', (await c.get('/agent')).headers.get('location').startsWith('/login'));

  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
