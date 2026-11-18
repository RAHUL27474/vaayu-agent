// One-time email codes: verifying an email address after signup, and logging in without a password.
// Codes are 6 digits, valid 10 minutes, 5 tries each; at most 5 codes an hour per person and purpose, one a minute.
const crypto = require('crypto');
const { one, run } = require('./db');
const mailer = require('./mailer');

const VALID_MINUTES = 10;
const MAX_TRIES = 5;
const hash = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

const TEXT = {
  verify: { subject: (c) => `${c} is your VaayuTrip verification code`, heading: 'Verify your email', line: 'Enter this code to verify your email address for your VaayuTrip partner account.' },
  login: { subject: (c) => `${c} is your VaayuTrip login code`, heading: 'Your login code', line: "Enter this code to log in to VaayuTrip. If you didn't try to log in, ignore this email; your account stays safe." },
};

/**
 * Emails a new code. Returns { sent: true } or { sent: false, reason: 'wait' | 'limit' | 'email' }.
 * An earlier unused code stops working when a new one is sent.
 */
async function sendCode(user, purpose) {
  const recent = await one(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM one_time_codes WHERE user_id = ? AND purpose = ? AND created_at > datetime('now', '-1 hour')`,
    user.id, purpose,
  );
  if (recent.n >= 5) return { sent: false, reason: 'limit' };
  if (recent.last && Date.now() - Date.parse(`${recent.last.replace(' ', 'T')}Z`) < 60000) return { sent: false, reason: 'wait' };
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await run("UPDATE one_time_codes SET used_at = datetime('now') WHERE user_id = ? AND purpose = ? AND used_at IS NULL", user.id, purpose);
  await run(`INSERT INTO one_time_codes (user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+${VALID_MINUTES} minutes'))`, user.id, purpose, hash(user.id, code));
  const t = TEXT[purpose];
  const ok = await mailer.send({
    to: user.email, subject: t.subject(code), heading: t.heading,
    text: `${t.line}\n\n${code}\n\nThe code works for ${VALID_MINUTES} minutes. Never share it with anyone, including VaayuTrip staff.`,
  });
  return ok ? { sent: true } : { sent: false, reason: 'email' };
}

/** Checks a code: 'ok' (and uses it up), 'wrong', 'expired' (none active, or too many tries). */
async function checkCode(userId, purpose, code) {
  const c = await one(
    "SELECT * FROM one_time_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1",
    userId, purpose,
  );
  if (!c || c.attempts >= MAX_TRIES) return 'expired';
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6 || !crypto.timingSafeEqual(Buffer.from(hash(userId, given)), Buffer.from(c.code_hash))) {
    await run('UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = ?', c.id);
    return c.attempts + 1 >= MAX_TRIES ? 'expired' : 'wrong';
  }
  await run("UPDATE one_time_codes SET used_at = datetime('now') WHERE id = ?", c.id);
  return 'ok';
}

const MESSAGES = {
  wait: 'A code was sent less than a minute ago. Check your inbox (and spam), or try again in a minute.',
  limit: 'Too many codes requested. Try again in an hour, or log in with your password.',
  email: "We couldn't send the email just now. Try again in a minute, or log in with your password.",
  wrong: "That code isn't right. Check the latest email and try again.",
  expired: 'That code has expired or was tried too many times. Request a new one.',
};

module.exports = { sendCode, checkCode, MESSAGES, VALID_MINUTES };
