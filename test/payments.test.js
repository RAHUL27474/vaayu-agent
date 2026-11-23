// Agents' wallet top-ups through PhonePe (v2 API), against a stand-in PhonePe server: credited exactly once and only
// for the amount asked; webhooks must carry PhonePe's signature. Customers pay their agent directly, not VaayuTrip.
const http = require('http');
const crypto = require('crypto');

// Stand-in PhonePe: orders are created PENDING; the test decides how each one ends.
const orders = new Map();
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/v1/oauth/token') return send(200, { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'O-Bearer' });
    if (req.headers.authorization !== 'O-Bearer tok') return send(401, { code: 'UNAUTHORIZED' });
    if (req.url === '/checkout/v2/pay') {
      const b = JSON.parse(body);
      orders.set(b.merchantOrderId, { state: 'PENDING', amount: b.amount, redirect: b.paymentFlow.merchantUrls.redirectUrl });
      return send(200, { orderId: `OMO${b.merchantOrderId}`, state: 'PENDING', redirectUrl: `https://pay.example/${b.merchantOrderId}` });
    }
    const m = req.url.match(/^\/checkout\/v2\/order\/([^/]+)\/status/);
    if (m) {
      const o = orders.get(decodeURIComponent(m[1]));
      if (!o) return send(400, { code: 'INVALID_MERCHANT_ORDER_ID' });
      return send(200, { state: o.state, amount: o.paidAmount ?? o.amount, paymentDetails: [{ transactionId: `T${m[1]}`, paymentMode: 'UPI_INTENT', state: o.state }] });
    }
    send(404, {});
  });
});

(async () => {
  await new Promise((r) => fake.listen(0, r));
  Object.assign(process.env, {
    PHONEPE_CLIENT_ID: 'test', PHONEPE_CLIENT_SECRET: 'secret', PHONEPE_BASE_URL: `http://localhost:${fake.address().port}`,
    PHONEPE_WEBHOOK_USER: 'hook', PHONEPE_WEBHOOK_PASSWORD: 'hookpass',
  });
  const { start, finish, check, db, ROLES } = require('./helpers');
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const c = await start();
  const agent = await c.login(...ROLES.agent);
  const agencyId = (await one('SELECT agency_id FROM users WHERE email = ?', ROLES.agent[0])).agency_id;
  const balance = async () => (await one('SELECT wallet_balance FROM agencies WHERE id = ?', agencyId)).wallet_balance;
  const lastOrder = () => [...orders.keys()].pop();

  // ---------- wallet top-up ----------
  check('wallet offers PhonePe', (await (await c.get('/agent/wallet', agent)).text()).includes('Pay with PhonePe'));
  const b0 = await balance();
  let r = await c.post('/agent/wallet/topup', agent, { method: 'phonepe', amount: '2500' });
  check('top-up goes to PhonePe checkout', r.status === 303 && r.headers.get('location').startsWith('https://pay.example/'));
  let id = lastOrder();
  check('PhonePe gets the amount in paise and our return URL', orders.get(id).amount === 250000 && orders.get(id).redirect.endsWith(`/payments/return/${id}`));
  r = await c.get(`/payments/return/${id}`, agent);
  check('returning while PhonePe still says pending credits nothing', await balance() === b0 && r.headers.get('location') === '/agent/wallet');
  orders.get(id).state = 'COMPLETED';
  await c.get(`/payments/return/${id}`, agent);
  check('completed top-up is credited', await balance() === b0 + 2500, `${b0} → ${await balance()}`);
  await c.get(`/payments/return/${id}`, agent);
  await c.get('/agent/wallet', agent);
  check('returning again does not credit twice', await balance() === b0 + 2500);
  const tr = await one("SELECT * FROM topup_requests WHERE agency_id = ? AND method = 'phonepe' ORDER BY id DESC LIMIT 1", agencyId);
  check('top-up request marked approved with the PhonePe reference', tr.status === 'approved' && /PhonePe T/.test(tr.utr));
  const admin = await c.login(...ROLES.admin);
  check('admin cannot approve a PhonePe top-up by hand', (await c.post(`/admin/topups/${tr.id}/approve`, admin, {})).status !== 302 || await balance() === b0 + 2500);

  await c.post('/agent/wallet/topup', agent, { method: 'phonepe', amount: '1000' });
  orders.get(lastOrder()).state = 'FAILED';
  await c.get(`/payments/return/${lastOrder()}`, agent);
  check('failed payment credits nothing', await balance() === b0 + 2500);

  await c.post('/agent/wallet/topup', agent, { method: 'phonepe', amount: '1000' });
  Object.assign(orders.get(lastOrder()), { state: 'COMPLETED', paidAmount: 100 });
  await c.get(`/payments/return/${lastOrder()}`, agent);
  check('payment for a different amount is not credited', await balance() === b0 + 2500);

  // ---------- webhook ----------
  await c.post('/agent/wallet/topup', agent, { method: 'phonepe', amount: '700' });
  id = lastOrder();
  orders.get(id).state = 'COMPLETED';
  const hook = (auth) => fetch(`${c.B}/payments/phonepe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: auth }, body: JSON.stringify({ event: 'checkout.order.completed', payload: { merchantOrderId: id, state: 'COMPLETED' } }) });
  check('webhook without PhonePe signature is refused', (await hook('SHA256 wrong')).status === 401 && await balance() === b0 + 2500);
  const sig = crypto.createHash('sha256').update('hook:hookpass').digest('hex');
  check('signed webhook settles the payment', (await hook(sig)).status === 200 && await balance() === b0 + 3200);

  check('customers can not pay through VaayuTrip', (await c.get('/pay/anything')).status === 404);

  // ---------- paying for a booking online (UPI / card / net banking) instead of wallet or credit ----------
  const newQuote = async (title) => {
    const qid = Number((await c.post('/agent/quotes', agent, { title })).headers.get('location').match(/(\d+)$/)[1]);
    const act1 = await one("SELECT * FROM products WHERE kind = 'activity' AND status = 'published' ORDER BY id LIMIT 1");
    await c.post(`/agent/activities/${act1.id}/quote`, agent, { quote_id: String(qid) });
    return qid;
  };
  const credit = async () => (await one('SELECT credit_used FROM agencies WHERE id = ?', agencyId)).credit_used;
  let qid = await newQuote('Online-paid trip');
  check('quote page offers paying online', (await (await c.get(`/agent/quotes/${qid}`, agent)).text()).includes('Pay online'));
  const wb = await balance(), cb = await credit();
  r = await c.post(`/agent/quotes/${qid}/pay-online`, agent, {});
  check('pay online goes to PhonePe checkout', r.status === 303 && r.headers.get('location').startsWith('https://pay.example/'));
  id = lastOrder();
  const pay = await one('SELECT * FROM payments WHERE order_id = ?', id);
  check('payment is for this quote', pay.purpose === 'booking' && pay.ref_id === qid && pay.amount > 0);
  r = await c.post(`/agent/quotes/${qid}/pay-online`, agent, {});
  check('a second payment is refused while the first is being confirmed', r.status !== 303 && orders.size && lastOrder() === id);
  r = await c.get(`/payments/return/${id}`, agent);
  check('pending payment books nothing yet', !(await one('SELECT id FROM bookings WHERE quote_id = ?', qid)) && r.headers.get('location') === `/agent/quotes/${qid}`);
  orders.get(id).state = 'COMPLETED';
  r = await c.get(`/payments/return/${id}`, agent);
  let bk = await one('SELECT * FROM bookings WHERE quote_id = ?', qid);
  check('completed payment books the quote', bk && r.headers.get('location') === `/agent/bookings/${bk.id}`);
  check('booking marked paid online, wallet and credit untouched', bk.paid_online === pay.amount && bk.paid_credit === 0 && await balance() === wb && await credit() === cb, `${bk.paid_online} ${await balance()} ${wb}`);
  await c.get(`/payments/return/${id}`, agent);
  await c.get(`/agent/quotes/${qid}`, agent);
  check('returning again does not book twice', (await one('SELECT COUNT(*)::int AS n FROM bookings WHERE quote_id = ?', qid)).n === 1);
  check('booking page shows the online payment', (await (await c.get(`/agent/bookings/${bk.id}`, agent)).text()).includes('Paid online'));
  check('a booked quote cannot be paid again', (await c.post(`/agent/quotes/${qid}/pay-online`, agent, {})).status !== 303);

  qid = await newQuote('Online-paid, failed');
  await c.post(`/agent/quotes/${qid}/pay-online`, agent, {});
  orders.get(lastOrder()).state = 'FAILED';
  await c.get(`/payments/return/${lastOrder()}`, agent);
  check('failed online payment books nothing and takes nothing', !(await one('SELECT id FROM bookings WHERE quote_id = ?', qid)) && await balance() === wb);

  // Paid, but the quote was booked from the wallet meanwhile: the money stays in the wallet.
  await c.post(`/agent/quotes/${qid}/pay-online`, agent, {});
  id = lastOrder();
  const amt = (await one('SELECT amount FROM payments WHERE order_id = ?', id)).amount;
  await c.post(`/agent/quotes/${qid}/book`, agent, {});
  orders.get(id).state = 'COMPLETED';
  await c.get(`/payments/return/${id}`, agent);
  check('payment for an already-booked quote lands in the wallet, no double booking',
    (await one('SELECT COUNT(*)::int AS n FROM bookings WHERE quote_id = ?', qid)).n === 1 && Math.abs(await balance() - (wb - amt + amt)) < 0.01);

  // Settled by the webhook alone (payer closed the page): the booking is still made.
  qid = await newQuote('Online-paid by webhook');
  await c.post(`/agent/quotes/${qid}/pay-online`, agent, {});
  id = lastOrder();
  orders.get(id).state = 'COMPLETED';
  const hook2 = await fetch(`${c.B}/payments/phonepe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: sig }, body: JSON.stringify({ event: 'checkout.order.completed', payload: { merchantOrderId: id, state: 'COMPLETED' } }) });
  check('webhook books an online-paid quote', hook2.status === 200 && !!(await one('SELECT id FROM bookings WHERE quote_id = ?', qid)));

  fake.close();
  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
