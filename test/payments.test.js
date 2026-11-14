// Online payments through PhonePe (v2 API), against a stand-in PhonePe server: wallet top-ups, customer payment
// links and quotes, credited exactly once and only for the amount asked; webhooks must carry PhonePe's signature.
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

  // ---------- customer payment link, with gateway fee ----------
  await c.post('/admin/settings', admin, { pg_fee_pct: '2' });
  await c.post('/agent/payment-links', agent, { purpose: 'Bali deposit', amount: '10000', customer_name: 'Asha' });
  const link = await one('SELECT * FROM payment_links WHERE agency_id = ? ORDER BY id DESC LIMIT 1', agencyId);
  check('payment page offers secure PhonePe checkout', (await (await c.get(`/pay/${link.code}`)).text()).includes('securely'));
  r = await c.post(`/pay/${link.code}`, '', {});
  check('customer is sent to PhonePe', r.status === 303);
  orders.get(lastOrder()).state = 'COMPLETED';
  const b1 = await balance();
  r = await c.get(`/payments/return/${lastOrder()}`);
  check('customer returns to the payment page', r.headers.get('location') === `/pay/${link.code}`);
  check('link paid; agency credited less 2% fee', (await one('SELECT status FROM payment_links WHERE id = ?', link.id)).status === 'paid' && await balance() === b1 + 9800, `${b1} → ${await balance()}`);
  check('customer can not pay a paid link again', (await c.post(`/pay/${link.code}`, '', {})).headers.get('location') === `/pay/${link.code}` && (await one("SELECT COUNT(*) AS n FROM payments WHERE purpose = 'link' AND ref_id = ?", link.id)).n === 1);

  // ---------- quote "Pay now" ----------
  const q = await one("SELECT * FROM quotes WHERE agency_id = ? AND status IN ('sent', 'accepted', 'draft') AND EXISTS (SELECT 1 FROM quote_items WHERE quote_id = quotes.id) ORDER BY id LIMIT 1", agencyId);
  await db.prepare("UPDATE quotes SET status = 'sent', pay_online = 0 WHERE id = ?").run(q.id);
  check('no Pay button until the agent allows it', !(await (await c.get(`/q/${q.code}`)).text()).includes(`/q/${q.code}/pay`));
  await db.prepare('UPDATE quotes SET pay_online = 1 WHERE id = ?').run(q.id);
  check('quote shows "Pay online" when allowed', (await (await c.get(`/q/${q.code}`)).text()).includes(`/q/${q.code}/pay`));
  r = await c.post(`/q/${q.code}/pay`, '', {});
  const ql = await one("SELECT * FROM payment_links WHERE quote_id = ? AND status = 'pending'", q.id);
  check('Pay now makes a payment link for the trip total', ql && r.headers.get('location') === `/pay/${ql.code}` && ql.amount > 0);
  await c.post(`/q/${q.code}/pay`, '', {});
  check('pressing again reuses the same link', (await one("SELECT COUNT(*) AS n FROM payment_links WHERE quote_id = ? AND status = 'pending'", q.id)).n === 1);

  fake.close();
  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
