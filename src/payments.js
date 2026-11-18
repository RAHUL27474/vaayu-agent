// Agents' wallet top-ups through PhonePe: start one, and settle it once PhonePe confirms it. (Customers pay their
// agent directly; VaayuTrip takes no customer payments.) Settling is idempotent, so the
// payer's return, PhonePe's webhook and the background check can all call it for the same order safely.
const crypto = require('crypto');
const { one, all, run, tx, notify } = require('./db');
const { round2 } = require('./util');
const phonepe = require('./phonepe');
const { moveWallet, AppError } = require('./services');

const newOrderId = (prefix) => `VT${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/**
 * Creates the payment and returns PhonePe's checkout URL.
 * purpose: 'topup'; refId = topup_requests.id.
 */
async function startPayment({ purpose, agencyId, refId, amount, origin, note, payerRef }) {
  if (!phonepe.enabled()) throw new AppError('Online payment is not set up yet.');
  const orderId = newOrderId('T');
  await run('INSERT INTO payments (order_id, purpose, agency_id, ref_id, amount) VALUES (?, ?, ?, ?, ?)', orderId, purpose, agencyId, refId, round2(amount));
  try {
    const { redirectUrl } = await phonepe.createPayment({
      orderId, amount, note, payerRef,
      redirectUrl: `${origin}/payments/return/${orderId}`,
      callbackUrl: `${origin}/payments/phonepe/webhook`,
    });
    return redirectUrl;
  } catch (e) {
    await run("UPDATE payments SET status = 'failed' WHERE order_id = ?", orderId);
    throw new AppError(e instanceof phonepe.PaymentError ? `${e.message} Please try again in a minute.` : 'Could not reach PhonePe. Please try again in a minute.');
  }
}

/**
 * Asks PhonePe about an order and records the outcome. Returns the payments row (with its new status).
 * Money moves only when PhonePe says COMPLETED for exactly the amount we asked for.
 */
async function settle(orderId) {
  const p = await one('SELECT * FROM payments WHERE order_id = ?', orderId);
  if (!p || p.status !== 'pending') return p;
  const s = await phonepe.checkStatus(orderId);
  if (s.state === 'PENDING') return p;
  return await tx(async () => {
    const cur = await one('SELECT * FROM payments WHERE id = ? FOR UPDATE', p.id);
    if (cur.status !== 'pending') return cur;
    const paid = s.state === 'COMPLETED' && Math.abs(s.amount - cur.amount) < 0.01;
    if (!paid) {
      await run("UPDATE payments SET status = 'failed', provider_txn = ?, completed_at = datetime('now') WHERE id = ?", s.transactionId || null, cur.id);
      if (cur.purpose === 'topup') await run("UPDATE topup_requests SET status = 'rejected' WHERE id = ? AND status = 'pending'", cur.ref_id);
      if (s.state === 'COMPLETED') await notify(null, 'Payment amount mismatch', `PhonePe order ${orderId} completed for ₹${s.amount} but ₹${cur.amount} was expected. Check it in the PhonePe dashboard.`, '/admin/topups');
      return { ...cur, status: 'failed' };
    }
    await run("UPDATE payments SET status = 'completed', provider_txn = ?, mode = ?, completed_at = datetime('now') WHERE id = ?", s.transactionId || null, s.mode || null, cur.id);
    const ref = `PhonePe ${s.transactionId || orderId}`;
    await run("UPDATE topup_requests SET status = 'approved', utr = ? WHERE id = ?", ref, cur.ref_id);
    await moveWallet(cur.agency_id, 'topup', cur.amount, ref, 'Wallet top-up (PhonePe)');
    await notify(cur.agency_id, 'Wallet topped up', `₹${cur.amount.toLocaleString('en-IN')} added to your wallet via PhonePe.`, '/agent/wallet');
    return { ...cur, status: 'completed' };
  });
}

/** Settles payments still waiting (payer closed the page before returning, webhook missed). */
async function settlePending({ agencyId = null, olderThanMinutes = 2, limit = 20 } = {}) {
  if (!phonepe.enabled()) return 0;
  const rows = await all(
    `SELECT order_id FROM payments WHERE status = 'pending' AND created_at < datetime('now', ?) AND created_at > datetime('now', '-3 days')
     ${agencyId ? 'AND agency_id = ?' : ''} ORDER BY id LIMIT ${limit}`,
    `-${olderThanMinutes} minutes`, ...(agencyId ? [agencyId] : []),
  );
  let done = 0;
  for (const r of rows) {
    try { if ((await settle(r.order_id)).status !== 'pending') done += 1; } catch { /* PhonePe unreachable: next time */ }
  }
  return done;
}

module.exports = { startPayment, settle, settlePending };
