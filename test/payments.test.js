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

  check('customers can not pay through VaayuTrip', (await c.get('/pay/anything')).status === 404 && (await c.post('/q/anything/pay', '', {})).status === 404);

  fake.close();
  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
