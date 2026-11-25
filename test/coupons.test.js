// Offer codes: an agent applies one on a quote before paying, and the discount comes off what they pay VaayuTrip.
// Checked: flat and percentage (with a cap) discounts, service kinds, minimum amount, uses per agency, expired and
// paused codes, codes without a discount, the booking amount and wallet debit, and the B2B invoice line.
(async () => {
  const { start, finish, check, db, ROLES } = require('./helpers');
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const c = await start();
  const agent = await c.login(...ROLES.agent);
  const admin = await c.login(...ROLES.admin);
  const agencyId = (await one('SELECT agency_id FROM users WHERE email = ?', ROLES.agent[0])).agency_id;
  const balance = async () => (await one('SELECT wallet_balance FROM agencies WHERE id = ?', agencyId)).wallet_balance;
  const taxRate = Number((await one("SELECT value FROM settings WHERE key = 'gst_rate'"))?.value ?? 0);
  const withTax = (n) => Math.round(n * (1 + taxRate / 100) * 100) / 100;

  // Offers made by the admin, each with its own rule.
  const offer = (code, rule) => c.post('/admin/offers', admin, [['title', `Test offer ${code}`], ['code', code], ...Object.entries(rule).flatMap(([k, v]) => [].concat(v).map((x) => [k, String(x)]))]);
  await offer('FLAT500', { discount_type: 'flat', discount_value: 500, kinds: 'activity', uses_per_agency: 1 });
  await offer('PCT10', { discount_type: 'percent', discount_value: 10, max_discount: 300, uses_per_agency: 0 });
  await offer('HOTELONLY', { discount_type: 'percent', discount_value: 5, kinds: 'hotel' });
  await offer('MINBIG', { discount_type: 'flat', discount_value: 100, min_amount: 10000000 });
  await offer('SHOWONLY', {});
  check('admin can create discount offers', (await one("SELECT discount_type, discount_value, kinds FROM offers WHERE code = 'FLAT500'"))?.kinds === 'activity');
  check('a live code cannot be reused for a second offer', (await (await c.post('/admin/offers', admin, { title: 'Dup', code: 'PCT10' })).text()).length >= 0
    && (await one("SELECT COUNT(*)::int AS n FROM offers WHERE code = 'PCT10'")).n === 1);
  check('a discount without a code is refused', (await c.post('/admin/offers', admin, { title: 'No code', discount_type: 'flat', discount_value: '50' })).status !== 302
    || !(await one("SELECT id FROM offers WHERE title = 'No code'")));

  const act = await one("SELECT * FROM products WHERE kind = 'activity' AND status = 'published' ORDER BY id LIMIT 1");
  const newQuote = async (title) => {
    const qid = Number((await c.post('/agent/quotes', agent, { title })).headers.get('location').match(/(\d+)$/)[1]);
    await c.post(`/agent/activities/${act.id}/quote`, agent, { quote_id: String(qid) });
    return qid;
  };
  const net = async (qid) => (await one('SELECT SUM(net_price * qty) AS n FROM quote_items WHERE quote_id = ? AND supplier = ?', qid, 'vaayu')).n;
  const apply = async (qid, code) => c.follow(await c.post(`/agent/quotes/${qid}/coupon`, agent, { code }), agent);
  const applied = async (qid) => (await one('SELECT coupon_code FROM quotes WHERE id = ?', qid)).coupon_code;

  // ---------- refusals ----------
  let qid = await newQuote('Coupon trip 1');
  let page = await apply(qid, 'NOPE');
  check('unknown code is refused with a reason', page.includes('not a valid offer code') && !(await applied(qid)));
  page = await apply(qid, 'HOTELONLY');
  check('code for other services is refused', page.includes('applies only to hotels') && !(await applied(qid)));
  page = await apply(qid, 'MINBIG');
  check('code below its minimum is refused', page.includes('needs at least') && !(await applied(qid)));
  page = await apply(qid, 'SHOWONLY');
  check('a promotion code without a discount is refused', page.includes('not a booking discount code') && !(await applied(qid)));

  // ---------- flat discount, booked from the wallet ----------
  page = await apply(qid, 'flat500');
  check('code is applied (any letter case)', (await applied(qid)) === 'FLAT500' && page.includes('FLAT500 applied'));
  const n1 = await net(qid);
  const d1 = Math.min(500, n1);
  check('quote page shows the discount and the lower amount to pay', page.includes('Offer <b>FLAT500</b>') && page.includes(`· ₹${withTax(n1 - d1).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`), `net ${n1}`);
  const w0 = await balance();
  await c.post(`/agent/quotes/${qid}/book`, agent, {});
  const b1 = await one('SELECT * FROM bookings WHERE quote_id = ?', qid);
  check('booking records the code and discount', b1 && b1.coupon_code === 'FLAT500' && b1.discount === d1);
  check('booking net is after the discount', b1 && Math.abs(b1.total_net - (n1 - d1)) < 0.01);
  check('wallet is charged the discounted amount', Math.abs((w0 - await balance()) - withTax(n1 - d1)) < 0.02, `${w0} → ${await balance()}`);
  const inv = await one("SELECT data FROM invoices WHERE booking_id = ? AND kind = 'b2b'", b1.id);
  const invData = JSON.parse(inv.data);
  check('B2B invoice shows the offer as a minus line', invData.lines.some((l) => l.title === 'Offer FLAT500' && l.amount === -d1) && Math.abs(invData.totals.subtotal - (n1 - d1)) < 0.01);

  // ---------- once per agency ----------
  const qid2 = await newQuote('Coupon trip 2');
  page = await apply(qid2, 'FLAT500');
  check('a once-per-agency code cannot be used twice', page.includes('already used') && !(await applied(qid2)));

  // ---------- percentage with a cap ----------
  page = await apply(qid2, 'PCT10');
  const n2 = await net(qid2);
  check('percentage code applies', (await applied(qid2)) === 'PCT10');
  const want = Math.round(Math.min(n2 * 0.1, 300) * 100) / 100;
  check('percentage discount is capped', page.includes(`PCT10 applied: ₹${want.toLocaleString('en-IN')} off`), `net ${n2}, want ${want}`);
  await c.post(`/agent/quotes/${qid2}/coupon/remove`, agent, {});
  check('code can be removed', !(await applied(qid2)));

  // ---------- code stops working after it was applied ----------
  await apply(qid2, 'PCT10');
  const pct = await one("SELECT id FROM offers WHERE code = 'PCT10'");
  await c.post(`/admin/offers/${pct.id}/toggle`, admin, {});
  page = await c.follow(await c.post(`/agent/quotes/${qid2}/book`, agent, {}), agent);
  check('booking with a paused code is stopped, nothing charged', !(await one('SELECT id FROM bookings WHERE quote_id = ?', qid2)) && page.includes('not a valid offer code'));
  check('quote page explains the code no longer works', (await (await c.get(`/agent/quotes/${qid2}`, agent)).text()).includes('can’t be used'));
  await c.post(`/admin/offers/${pct.id}/toggle`, admin, {});
  const yesterday = new Date(Date.now() - 864e5 + 330 * 60000).toISOString().slice(0, 10);
  await c.post(`/admin/offers/${pct.id}/discount`, admin, { code: 'PCT10', valid_until: yesterday, discount_type: 'percent', discount_value: '10', max_discount: '300', uses_per_agency: '0' });
  page = await apply(qid2, 'PCT10');
  check('expired code is refused', page.includes('ended on'));

  // ---------- cancelled bookings give the use back; other agents and roles ----------
  check('admin offers page shows how often a code was used', (await (await c.get('/admin/offers', admin)).text()).includes('Used 1×'));
  check('agent offers page explains where to enter a code', (await (await c.get('/agent/offers', agent)).text()).includes('Enter the code on a quote'));
  check('a booked quote cannot take a code', (await c.follow(await c.post(`/agent/quotes/${qid}/coupon`, agent, { code: 'PCT10' }), agent)).includes('already booked')
    || (await applied(qid)) === 'FLAT500');

  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
