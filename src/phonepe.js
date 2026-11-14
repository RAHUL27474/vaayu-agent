// PhonePe Payment Gateway (Standard Checkout). Works with either kind of PhonePe credentials:
//   v2 (current):  PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, PHONEPE_CLIENT_VERSION (default 1)
//   v1 (older):    PHONEPE_MERCHANT_ID, PHONEPE_SALT_KEY, PHONEPE_SALT_INDEX (default 1)
// PHONEPE_ENV=production for live payments; anything else uses PhonePe's sandbox.
// Webhooks (optional, v2): PHONEPE_WEBHOOK_USER / PHONEPE_WEBHOOK_PASSWORD as set in the PhonePe dashboard.
// A payment is only ever trusted after asking PhonePe for its status (checkStatus), never from a redirect or webhook body.
const crypto = require('crypto');

const env = process.env;
const live = () => env.PHONEPE_ENV === 'production';
const version = () => (env.PHONEPE_CLIENT_ID && env.PHONEPE_CLIENT_SECRET ? 'v2' : env.PHONEPE_MERCHANT_ID && env.PHONEPE_SALT_KEY ? 'v1' : null);
const enabled = () => Boolean(version());
const describe = () => (enabled() ? `${version()} · ${live() ? 'live' : 'sandbox'}` : 'not set up');

const HOSTS = {
  v2: { sandbox: 'https://api-preprod.phonepe.com/apis/pg-sandbox', live: 'https://api.phonepe.com/apis/pg', authLive: 'https://api.phonepe.com/apis/identity-manager' },
  v1: { sandbox: 'https://api-preprod.phonepe.com/apis/pg-sandbox', live: 'https://api.phonepe.com/apis/hermes' },
};
// PHONEPE_BASE_URL points every call at a stand-in PhonePe (the tests use one).
const base = () => env.PHONEPE_BASE_URL || HOSTS[version()][live() ? 'live' : 'sandbox'];

class PaymentError extends Error {}

async function call(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body };
}

// ---------- v2: OAuth token, kept until shortly before it expires ----------
let token = null;
async function authToken() {
  if (token && token.expires > Date.now() + 60000) return token.value;
  const url = `${env.PHONEPE_BASE_URL || (live() ? HOSTS.v2.authLive : HOSTS.v2.sandbox)}/v1/oauth/token`;
  const r = await call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.PHONEPE_CLIENT_ID, client_secret: env.PHONEPE_CLIENT_SECRET, client_version: env.PHONEPE_CLIENT_VERSION || '1', grant_type: 'client_credentials' }),
  });
  if (!r.ok || !r.body.access_token) throw new PaymentError(`PhonePe login failed (${r.status} ${r.body.code || r.body.message || ''})`.trim());
  // expires_at is epoch seconds; fall back to 10 minutes if it's missing.
  const exp = Number(r.body.expires_at);
  token = { value: r.body.access_token, expires: exp ? (exp < 1e12 ? exp * 1000 : exp) : Date.now() + 600000 };
  return token.value;
}

// ---------- v1: X-VERIFY checksum ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const xVerify = (s) => `${sha256(s + env.PHONEPE_SALT_KEY)}###${env.PHONEPE_SALT_INDEX || '1'}`;

/**
 * Starts a payment. orderId: our unique id (letters, digits, - and _ only); amount in rupees.
 * Returns { redirectUrl } to send the payer to PhonePe's checkout page.
 */
async function createPayment({ orderId, amount, redirectUrl, callbackUrl, payerRef, note }) {
  if (!enabled()) throw new PaymentError('Online payment is not set up.');
  const paise = Math.round(amount * 100);
  if (version() === 'v2') {
    const r = await call(`${base()}/checkout/v2/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `O-Bearer ${await authToken()}` },
      body: JSON.stringify({
        merchantOrderId: orderId, amount: paise, expireAfter: 1800,
        metaInfo: { udf1: String(note || '').slice(0, 250) },
        paymentFlow: { type: 'PG_CHECKOUT', message: String(note || 'Payment').slice(0, 100), merchantUrls: { redirectUrl } },
      }),
    });
    if (!r.ok || !r.body.redirectUrl) throw new PaymentError(`PhonePe could not start the payment (${r.body.code || r.status}).`);
    return { redirectUrl: r.body.redirectUrl };
  }
  const payload = Buffer.from(JSON.stringify({
    merchantId: env.PHONEPE_MERCHANT_ID, merchantTransactionId: orderId, merchantUserId: String(payerRef || 'guest').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36) || 'guest',
    amount: paise, redirectUrl, redirectMode: 'REDIRECT', callbackUrl, paymentInstrument: { type: 'PAY_PAGE' },
  })).toString('base64');
  const r = await call(`${base()}/pg/v1/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-VERIFY': xVerify(`${payload}/pg/v1/pay`) },
    body: JSON.stringify({ request: payload }),
  });
  const url = r.body?.data?.instrumentResponse?.redirectInfo?.url;
  if (!r.ok || !url) throw new PaymentError(`PhonePe could not start the payment (${r.body.code || r.status}).`);
  return { redirectUrl: url };
}

/** Asks PhonePe what happened: { state: 'COMPLETED' | 'FAILED' | 'PENDING', amount (rupees), transactionId, mode }. */
async function checkStatus(orderId) {
  if (version() === 'v2') {
    const r = await call(`${base()}/checkout/v2/order/${encodeURIComponent(orderId)}/status?details=false`, {
      headers: { 'Content-Type': 'application/json', Authorization: `O-Bearer ${await authToken()}` },
    });
    if (!r.ok) {
      // An order PhonePe never registered (payer closed the page before it was created) is a failure; other errors: ask again later.
      if (r.body.code === 'INVALID_MERCHANT_ORDER_ID') return { state: 'FAILED' };
      throw new PaymentError(`PhonePe status check failed (${r.body.code || r.status}).`);
    }
    const attempt = (r.body.paymentDetails || [])[0] || {};
    return { state: r.body.state, amount: Number(r.body.amount) / 100, transactionId: attempt.transactionId || r.body.orderId, mode: attempt.paymentMode };
  }
  const path = `/pg/v1/status/${env.PHONEPE_MERCHANT_ID}/${encodeURIComponent(orderId)}`;
  const r = await call(`${base()}${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-VERIFY': xVerify(path), 'X-MERCHANT-ID': env.PHONEPE_MERCHANT_ID },
  });
  const code = r.body.code;
  const d = r.body.data || {};
  const state = code === 'PAYMENT_SUCCESS' ? 'COMPLETED'
    : ['PAYMENT_PENDING', 'INTERNAL_SERVER_ERROR'].includes(code) || !r.ok ? 'PENDING'
      : 'FAILED';
  return { state, amount: Number(d.amount || 0) / 100, transactionId: d.transactionId, mode: d.paymentInstrument?.type };
}

/** Is a webhook really from PhonePe? (We still confirm the payment with checkStatus.) Returns the order id, or null. */
function webhookOrderId(headers, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); } catch { return null; }
  if (version() === 'v2') {
    if (!env.PHONEPE_WEBHOOK_USER || !env.PHONEPE_WEBHOOK_PASSWORD) return null;
    const expected = sha256(`${env.PHONEPE_WEBHOOK_USER}:${env.PHONEPE_WEBHOOK_PASSWORD}`);
    const got = String(headers.authorization || '').replace(/^SHA256\s+/i, '').trim();
    if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;
    return body.payload?.merchantOrderId || null;
  }
  if (version() === 'v1' && body.response) {
    const expected = xVerify(body.response);
    const got = String(headers['x-verify'] || '');
    if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;
    try { return JSON.parse(Buffer.from(body.response, 'base64').toString()).data?.merchantTransactionId || null; } catch { return null; }
  }
  return null;
}

module.exports = { enabled, describe, live, version, createPayment, checkStatus, webhookOrderId, PaymentError };
