const crypto = require('crypto');
const express = require('express');
const { one, all, run, tx, notify, audit, getSettings } = require('../db');
const { hashPassword, verifyPassword, uniqueSlug, num, code, round2 } = require('../util');
const { h, homeFor } = require('../auth');
const { COUNTRIES, withKycDocs, checkTax, checkKycFiles, removeUploaded } = require('../kyc');
const { DESTINATIONS, destinationOf } = require('../products');
const { CITY_PHOTOS, DEST_PHOTOS } = require('../destination-photos');
const mailer = require('../mailer');
const otp = require('../otp');
const payments = require('../payments');

const router = express.Router();

router.get('/', h(async (req, res) => {
  const activities = await all("SELECT * FROM products WHERE status = 'published' AND kind = 'activity' ORDER BY RANDOM() LIMIT 5");
  const counts = Object.fromEntries((await all("SELECT kind, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY kind")).map((r) => [r.kind, r.n]));
  const stats = {
    agents: (await one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'active'")).n,
    hotels: counts.hotel || 0,
    activities: counts.activity || 0,
    flights: counts.flight || 0,
    cities: (await one("SELECT COUNT(DISTINCT city) AS n FROM products WHERE status = 'published'")).n,
  };
  // Cities and live items per destination for the destinations grid.
  const byDest = Object.fromEntries(Object.keys(DESTINATIONS).map((d) => [d, { name: d, cities: new Set(), items: 0 }]));
  const perCity = new Map();
  for (const r of await all("SELECT city, country, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY city, country")) {
    const d = byDest[destinationOf(r.country)];
    if (d) { d.cities.add(r.city); d.items += r.n; perCity.set(r.city, (perCity.get(r.city) || 0) + r.n); }
  }
  const destinations = Object.values(byDest).map((d) => ({ name: d.name, cities: [...d.cities], items: d.items }));
  // City photos for the gallery and the small round photos on destination cards (served as WebP, see pic() in server.js).
  const cityThumbs = CITY_PHOTOS;
  const cityShots = [];
  for (const d of destinations) {
    const withPhoto = d.cities.filter((c) => cityThumbs[c]).sort();
    const own = DEST_PHOTOS[d.name];
    if (!withPhoto.length && own) cityShots.push({ city: d.name, dest: d.name, photo: own, n: d.items });
    for (const c of withPhoto) cityShots.push({ city: c, dest: d.name, photo: CITY_PHOTOS[c], n: perCity.get(c) || 0 });
  }
  // The first hero photo starts downloading with the stylesheet (it is the largest thing on the first screen).
  const heroImage = req.app.locals.pic('/img/destinations/bali-kelingking-hero.jpg');
  const enq = req.session.enqDraft || {};
  if (req.session.enqDraft) req.session.enqDraft = null;
  res.page('public/home', { title: 'B2B travel platform for agents', activities, stats, destinations, cityShots, cityThumbs, heroImage, enq }, 'public');
}));

// Generated cover card for packages and hotels without an uploaded photo.
const COVER_PALETTES = [['#0369a1', '#0c2a43'], ['#0077c0', '#0f1d4a'], ['#7c3aed', '#2e1065'], ['#c2410c', '#431407'], ['#be123c', '#4c0519'], ['#1d4ed8', '#0f172a'], ['#0e7490', '#083344'], ['#b45309', '#3b1d06']];
router.get('/cover/:name.svg', (req, res) => {
  const name = String(req.params.name || 'Holiday').slice(0, 40);
  const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [c1, c2] = COVER_PALETTES[hash % COVER_PALETTES.length];
  const size = name.length > 18 ? 56 : 76;
  const cx = 860 + (hash % 180);
  const y = 500 - size / 2;
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<radialGradient id="r" cx=".8" cy=".15" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="800" fill="url(#g)"/><rect width="1200" height="800" fill="url(#r)"/>
<g fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="2"><circle cx="${cx}" cy="180" r="140"/><circle cx="${cx}" cy="180" r="240"/><circle cx="${cx}" cy="180" r="340"/></g>
<path d="M0 640 C220 590 420 680 640 630 S1020 570 1200 620 L1200 800 L0 800 Z" fill="#000" opacity=".18"/>
<rect x="72" y="${y - size - 10}" width="48" height="5" rx="2.5" fill="#8fd14f"/>
<text x="70" y="${y}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="800" letter-spacing="-1" fill="#fff">${esc(name)}</text>
<text x="72" y="${y + 50}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="22" font-weight="600" fill="#fff" opacity=".75" letter-spacing="4">VAAYUTRIP HOLIDAYS</text>
</svg>`);
});

// ---------- auth ----------

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user.role));
  res.page('public/login', { title: 'Log in', next: req.query.next || '', email: String(req.query.email || '').slice(0, 120), mode: req.query.mode === 'otp' && mailer.enabled() ? 'otp' : 'password', otpOn: mailer.enabled() }, 'public');
});

// "Chrome on Windows · 1.2.3.4", recorded with each login so people can spot one that wasn't them.
function loginPlace(req) {
  const ua = String(req.get('user-agent') || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return ` · ${browser}${os ? ` on ${os}` : ''} · ${req.ip}`;
}

// Password guessing: 8 failures for one email, or 30 from one address, in 15 minutes pause logins there.
const LOGIN_LIMITS = { email: 8, ip: 30 };

router.post('/login', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const loginError = (message) => res.status(message.startsWith('Too many') ? 429 : 200)
    .page('public/login', { title: 'Log in', next: req.body.next || '', email, mode: 'password', otpOn: mailer.enabled(), flash: [{ type: 'error', message }] }, 'public');
  const recent = await one(
    "SELECT COUNT(*) FILTER (WHERE email = ?) AS by_email, COUNT(*) FILTER (WHERE ip = ?) AS by_ip FROM login_failures WHERE created_at > datetime('now', '-15 minutes')",
    email, req.ip,
  );
  if (recent.by_email >= LOGIN_LIMITS.email || recent.by_ip >= LOGIN_LIMITS.ip) {
    return loginError('Too many failed attempts. Wait 15 minutes and try again, or contact VaayuTrip support.');
  }
  const user = await one('SELECT * FROM users WHERE email = ?', email);
  if (!user || !user.is_active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    await run('INSERT INTO login_failures (email, ip) VALUES (?, ?)', email, req.ip);
    await run("DELETE FROM login_failures WHERE created_at < datetime('now', '-1 day')");
    return loginError('Wrong email or password.');
  }
  await run('DELETE FROM login_failures WHERE email = ?', email);
  // 2-step login: the password was right; now a code from their inbox. Nothing is logged in until it's entered.
  if (user.two_step && mailer.enabled()) {
    req.session.twoStep = { id: user.id, at: Date.now(), next: String(req.body.next || '') };
    const r = await otp.sendCode(user, 'login');
    return twoStepPage(res, user.email, r.sent ? null : { type: 'warn', message: otp.MESSAGES[r.reason] });
  }
  req.session.userId = user.id;
  req.session.pw = user.password_hash.slice(-12);
  await audit(user, 'user.login', { entity: 'user', id: user.id, summary: `${user.name} logged in${loginPlace(req)}` });
  const next = String(req.body.next || '');
  const home = homeFor(user.role);
  res.redirect(next.startsWith(home) ? next : home);
}));

const twoStepPage = (res, email, flash) => res.page('public/code', {
  title: '2-step login', noindex: true, purpose: 'twostep', email, action: '/login/2step', resendAction: '/login/2step/resend', ...(flash ? { flash: [flash] } : {}),
}, 'public');

// The person half-way through a 2-step login (password done), for 15 minutes.
async function twoStepUser(req) {
  const p = req.session.twoStep;
  if (!p || Date.now() - p.at > 15 * 60000) return null;
  return await one('SELECT * FROM users WHERE id = ? AND is_active = 1', p.id);
}

router.post('/login/2step', h(async (req, res) => {
  const user = await twoStepUser(req);
  if (!user) { req.session.twoStep = null; req.flash('error', 'Your login timed out. Log in again.'); return res.redirect('/login'); }
  const result = await otp.checkCode(user.id, 'login', req.body.code);
  if (result !== 'ok') return twoStepPage(res, user.email, { type: 'error', message: otp.MESSAGES[result] });
  const next = req.session.twoStep.next;
  req.session.twoStep = null;
  req.session.userId = user.id;
  req.session.pw = user.password_hash.slice(-12);
  await audit(user, 'user.login', { entity: 'user', id: user.id, summary: `${user.name} logged in with password + email code${loginPlace(req)}` });
  res.redirect(safeNext(user, next));
}));

router.post('/login/2step/resend', h(async (req, res) => {
  const user = await twoStepUser(req);
  if (!user) return res.redirect('/login');
  const r = await otp.sendCode(user, 'login');
  twoStepPage(res, user.email, r.sent ? { type: 'success', message: 'A new code is on its way.' } : { type: 'warn', message: otp.MESSAGES[r.reason] });
}));

// ---------- your own account (any role) ----------

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));

router.get('/account', requireLogin, h(async (req, res) => {
  const me = await one('SELECT name, email, phone, created_at, two_step FROM users WHERE id = ?', req.user.id);
  const logins = await all("SELECT created_at, summary FROM audit_log WHERE user_id = ? AND action = 'user.login' ORDER BY id DESC LIMIT 8", req.user.id);
  res.page('account', { title: 'My account', me, logins, lastLogin: logins[1] || null, emailOn: mailer.enabled() });
}));

// 2-step login on: confirm the password, then prove the inbox works with a code (so nobody locks themselves out).
router.post('/account/2step/on', requireLogin, h(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!mailer.enabled()) { req.flash('error', 'Email is not set up on the portal yet, so 2-step login cannot be turned on.'); return res.redirect('/account'); }
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) { req.flash('error', 'Your password is not right.'); return res.redirect('/account'); }
  const r = await otp.sendCode(u, 'verify');
  if (!r.sent) { req.flash('error', otp.MESSAGES[r.reason]); return res.redirect('/account'); }
  res.page('public/code', { title: 'Turn on 2-step login', noindex: true, purpose: 'enable', email: u.email, action: '/account/2step/confirm', resendAction: '/account' }, 'public');
}));

router.post('/account/2step/confirm', requireLogin, h(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', req.user.id);
  const result = await otp.checkCode(u.id, 'verify', req.body.code);
  if (result !== 'ok') {
    return res.page('public/code', { title: 'Turn on 2-step login', noindex: true, purpose: 'enable', email: u.email, action: '/account/2step/confirm', resendAction: '/account', flash: [{ type: 'error', message: otp.MESSAGES[result] }] }, 'public');
  }
  await run('UPDATE users SET two_step = 1, email_verified = 1 WHERE id = ?', u.id);
  await audit(req.user, 'user.two_step_on', { entity: 'user', id: u.id, summary: `${u.name} turned on 2-step login` });
  req.flash('success', '2-step login is on. From now on you\'ll enter a code from your email after your password.');
  res.redirect('/account');
}));

router.post('/account/2step/off', requireLogin, h(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) { req.flash('error', 'Your password is not right.'); return res.redirect('/account'); }
  await run('UPDATE users SET two_step = 0 WHERE id = ?', u.id);
  await audit(req.user, 'user.two_step_off', { entity: 'user', id: u.id, summary: `${u.name} turned off 2-step login` });
  req.flash('success', '2-step login is off.');
  res.redirect('/account');
}));

router.post('/account/password', requireLogin, h(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', req.user.id);
  const password = String(req.body.password || '');
  const fail = (m) => { req.flash('error', m); res.redirect('/account'); };
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) return fail('Your current password is not right.');
  if (password.length < 8) return fail('The new password must be at least 8 characters.');
  if (password !== String(req.body.confirm || '')) return fail("The new passwords don't match.");
  if (verifyPassword(password, u.password_hash)) return fail('Choose a password different from your current one.');
  const hash = hashPassword(password);
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hash, u.id);
  req.session.pw = hash.slice(-12); // this session stays; others are logged out
  await audit(req.user, 'user.password_changed', { entity: 'user', id: u.id, summary: `${u.name} changed their password` });
  req.flash('success', 'Password updated. Other devices using your account have been logged out.');
  res.redirect('/account');
}));

// No email service: a reset request goes to VaayuTrip support, who verify the person by phone and set a new password.
router.get('/forgot-password', (req, res) => {
  res.page('public/forgot', { title: 'Forgot password', email: '', sent: false, noindex: true }, 'public');
});

router.post('/forgot-password', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  // At most 5 requests an hour from one address, so this can't be used to flood support.
  const recent = await one("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND email LIKE 'reset:%' AND created_at > datetime('now', '-1 hour')", req.ip);
  if (recent.n < 5) {
    await run('INSERT INTO login_failures (email, ip) VALUES (?, ?)', `reset:${email}`, req.ip);
    const u = email && await one('SELECT u.id, u.name, u.phone, u.agency_id, a.name AS agency, a.phone AS agency_phone FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.email = ? AND u.is_active = 1', email);
    // With email set up, the person gets a one-time link; otherwise support resets it after a phone check.
    if (u && mailer.enabled()) {
      const token = crypto.randomBytes(32).toString('hex');
      await run("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))", u.id, sha256(token));
      const sent = await mailer.send({
        to: email, subject: 'Reset your VaayuTrip password', heading: 'Reset your password',
        text: `Hi ${u.name},\n\nSomeone (hopefully you) asked to reset the password for ${email}. The link works once, for the next hour. If it wasn't you, ignore this email; your password stays the same.`,
        button: { href: `${res.locals.origin}/reset-password/${token}`, label: 'Choose a new password' },
      });
      if (sent) return res.page('public/forgot', { title: 'Forgot password', email, sent: true, emailed: true, noindex: true }, 'public');
    }
    const already = u && await one("SELECT 1 FROM notifications WHERE agency_id IS NULL AND title = 'Password reset request' AND body LIKE ? AND created_at > datetime('now', '-1 day')", `%(${email}%`);
    if (u && !already) {
      await notify(null, 'Password reset request', `${u.name} (${email}${u.agency ? `, ${u.agency}` : ''}) asked for a new password. Call ${u.phone || u.agency_phone || 'them'} to verify before resetting.`,
        u.agency_id ? `/admin/agents/${u.agency_id}#users` : '/admin/team');
    }
  }
  res.page('public/forgot', { title: 'Forgot password', email, sent: true, emailed: false, noindex: true }, 'public');
}));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const resetFor = async (token) => (/^[a-f0-9]{64}$/.test(token || '')
  ? one("SELECT r.id, r.user_id, u.email, u.role, u.agency_id FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now') AND u.is_active = 1", sha256(token))
  : null);

router.get('/reset-password/:token', h(async (req, res) => {
  const r = await resetFor(req.params.token);
  res.page('public/reset', { title: 'Reset password', valid: Boolean(r), email: r ? r.email : '', noindex: true }, 'public');
}));

router.post('/reset-password/:token', h(async (req, res) => {
  const r = await resetFor(req.params.token);
  if (!r) return res.redirect(`/reset-password/${encodeURIComponent(req.params.token)}`);
  const password = String(req.body.password || '');
  const fail = (m) => res.page('public/reset', { title: 'Reset password', valid: true, email: r.email, noindex: true, flash: [{ type: 'error', message: m }] }, 'public');
  if (password.length < 8) return fail('The new password must be at least 8 characters.');
  if (password !== String(req.body.confirm || '')) return fail("The passwords don't match.");
  await tx(async () => {
    await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), r.user_id);
    await run("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", r.user_id);
    await run('DELETE FROM login_failures WHERE email = ?', r.email);
  });
  await audit({ id: r.user_id, role: r.role, agency_id: r.agency_id }, 'user.password_reset_by_email', { entity: 'user', id: r.user_id, summary: r.email });
  req.flash('success', 'Password changed. Log in with your new password.');
  res.redirect(`/login?email=${encodeURIComponent(r.email)}`);
}));

// ---------- email codes: verify after signup, log in without a password ----------

const codePage = (res, data, flash) => res.page('public/code', { title: data.purpose === 'verify' ? 'Verify your email' : 'Login code', noindex: true, ...data, ...(flash ? { flash: [flash] } : {}) }, 'public');
const safeNext = (user, next) => { const home = homeFor(user.role); return String(next || '').startsWith(home) ? next : home; };

router.get('/verify-email', h(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.email_verified) return res.redirect(homeFor(req.user.role));
  // First visit (e.g. after logging in with a password): send a code unless one is still valid.
  const active = await one("SELECT 1 FROM one_time_codes WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > datetime('now')", req.user.id);
  let flash = null;
  if (!active) {
    const r = await otp.sendCode(req.user, 'verify');
    if (!r.sent) flash = { type: 'warn', message: otp.MESSAGES[r.reason] };
  }
  codePage(res, { purpose: 'verify', email: req.user.email, action: '/verify-email', resendAction: '/verify-email/resend' }, flash);
}));

router.post('/verify-email', h(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const result = await otp.checkCode(req.user.id, 'verify', req.body.code);
  if (result !== 'ok') return codePage(res, { purpose: 'verify', email: req.user.email, action: '/verify-email', resendAction: '/verify-email/resend' }, { type: 'error', message: otp.MESSAGES[result] });
  await run('UPDATE users SET email_verified = 1 WHERE id = ?', req.user.id);
  await audit(req.user, 'user.email_verified', { entity: 'user', id: req.user.id, summary: req.user.email });
  req.flash('success', 'Email verified. Thank you!');
  res.redirect(req.user.role === 'agent' ? '/agent' : homeFor(req.user.role));
}));

router.post('/verify-email/resend', h(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const r = await otp.sendCode(req.user, 'verify');
  req.flash(r.sent ? 'success' : 'warn', r.sent ? `New code sent to ${req.user.email}.` : otp.MESSAGES[r.reason]);
  res.redirect('/verify-email');
}));

// Log in with a code: the same answer whether or not the email has an account.
async function sendLoginCode(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.redirect('/login?mode=otp');
  const recent = await one("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND email LIKE 'otp:%' AND created_at > datetime('now', '-1 hour')", req.ip);
  let flash = null;
  if (recent.n >= 20) {
    flash = { type: 'warn', message: otp.MESSAGES.limit };
  } else {
    await run('INSERT INTO login_failures (email, ip) VALUES (?, ?)', `otp:${email}`, req.ip);
    const user = await one('SELECT id, email FROM users WHERE email = ? AND is_active = 1', email);
    if (user) {
      const r = await otp.sendCode(user, 'login');
      if (!r.sent) flash = { type: 'warn', message: otp.MESSAGES[r.reason] };
    }
  }
  codePage(res, { purpose: 'login', email, next: req.body.next || '', action: '/login/otp/verify', resendAction: '/login/otp' }, flash);
}
router.post('/login/otp', h(sendLoginCode));

router.post('/login/otp/verify', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const again = (message) => codePage(res, { purpose: 'login', email, next: req.body.next || '', action: '/login/otp/verify', resendAction: '/login/otp' }, { type: 'error', message });
  const recent = await one(
    "SELECT COUNT(*) FILTER (WHERE email = ?) AS by_email, COUNT(*) FILTER (WHERE ip = ?) AS by_ip FROM login_failures WHERE created_at > datetime('now', '-15 minutes') AND email NOT LIKE 'otp:%' AND email NOT LIKE 'reset:%'",
    email, req.ip,
  );
  if (recent.by_email >= LOGIN_LIMITS.email || recent.by_ip >= LOGIN_LIMITS.ip) return again('Too many failed attempts. Wait 15 minutes and try again.');
  const user = await one('SELECT * FROM users WHERE email = ? AND is_active = 1', email);
  const result = user ? await otp.checkCode(user.id, 'login', req.body.code) : 'wrong';
  if (result !== 'ok') {
    await run('INSERT INTO login_failures (email, ip) VALUES (?, ?)', email, req.ip);
    return again(otp.MESSAGES[result]);
  }
  // With 2-step login on, an email code alone isn't enough: password first, then the code.
  if (user.two_step) return again('2-step login is on for this account. Log in with your password; we\'ll then email you a code.');
  // The code proves the person reads this inbox.
  await run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
  await run('DELETE FROM login_failures WHERE email = ?', email);
  req.session.userId = user.id;
  req.session.pw = user.password_hash.slice(-12);
  await audit(user, 'user.login', { entity: 'user', id: user.id, summary: `${user.name} logged in with an email code${loginPlace(req)}` });
  res.redirect(safeNext(user, req.body.next));
}));

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// Terms of use and privacy policy (views/public/legal.ejs).
router.get('/terms', (req, res) => res.page('public/legal', { title: 'Terms of use', page: 'terms', meta: { description: 'Terms of use for travel agencies using the VaayuTrip B2B platform: accounts, rates, payments, cancellations and liability.' } }, 'public'));
router.get('/privacy', (req, res) => res.page('public/legal', { title: 'Privacy policy', page: 'privacy', meta: { description: 'How VaayuTrip collects, uses, shares and protects agency and traveller data.' } }, 'public'));

router.get('/signup', (req, res) => {
  res.page('public/signup', { title: 'Become a VaayuTrip partner', form: { country: 'India' }, countries: COUNTRIES }, 'public');
});

// ---------- website enquiries (to the backend team) ----------
const ENQ_TOPICS = { partner: 'Become a partner agency', trip: 'Quote for a trip or group', other: 'Something else' };
router.post('/enquiry', h(async (req, res) => {
  const b = req.body || {};
  const back = (msg, type = 'error') => {
    req.flash(type, msg);
    // Keep what they typed when something needs fixing (not after a successful send).
    if (type === 'error') req.session.enqDraft = Object.fromEntries(['topic', 'name', 'phone', 'email', 'company', 'city', 'destination', 'pax', 'message'].map((k) => [k, String(b[k] ?? '').slice(0, k === 'message' ? 1500 : 120)]));
    else req.session.enqDraft = null;
    return res.redirect(303, '/#enquiry');
  };
  if (b.website) return back('Thank you. Our team will call you shortly.', 'success'); // filled only by bots
  const clean = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
  const name = clean(b.name, 80);
  const phone = clean(b.phone, 20);
  const email = clean(b.email, 120).toLowerCase();
  if (!name) return back('Please enter your name.');
  if (!/^\+?[\d\s()-]{7,20}$/.test(phone) || phone.replace(/\D/g, '').length < 7) return back('Please enter a phone number we can call, e.g. +91 98100 00000.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back('That email address does not look right.');
  // At most 5 enquiries an hour from one connection.
  const recent = (await one("SELECT COUNT(*)::int AS n FROM enquiries WHERE ip = ? AND created_at > datetime('now', '-1 hour')", req.ip)).n;
  if (recent >= 5) return back('We already have your enquiry. Our team will call you; for anything urgent, message us on WhatsApp.');
  const topic = ENQ_TOPICS[b.topic] ? b.topic : 'partner';
  const pax = Math.max(0, Math.min(999, Math.floor(Number(b.pax) || 0))) || null;
  const travel = /^\d{4}-\d{2}-\d{2}$/.test(b.travel_date || '') ? b.travel_date : null;
  const id = (await run(
    'INSERT INTO enquiries (topic, name, phone, email, company, city, destination, travel_date, pax, message, page, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    topic, name, phone, email || null, clean(b.company, 120) || null, clean(b.city, 80) || null, clean(b.destination, 60) || null,
    travel, pax, String(b.message ?? '').trim().slice(0, 1500) || null, clean(b.page || '/', 120), req.ip,
  )).lastInsertRowid;
  const summary = `${name} (${phone})${clean(b.company, 120) ? `, ${clean(b.company, 120)}` : ''}: ${ENQ_TOPICS[topic]}`;
  // In-app alert for VaayuTrip HQ, and an email to every active backend team member.
  await notify(null, 'New website enquiry', summary, `/backend/enquiries/${id}`);
  const team = (await all("SELECT email FROM users WHERE role = 'backend' AND is_active = 1")).map((u) => u.email);
  if (team.length && mailer.enabled()) {
    mailer.send({ to: team, subject: `New enquiry: ${name}`, text: summary, button: { href: `${mailer.siteUrl()}/backend/enquiries/${id}`, label: 'Open enquiry' } }).catch(() => false);
  }
  return back('Thank you. Our team will call you within one working day.', 'success');
}));

router.post('/signup', withKycDocs, h(async (req, res) => {
  const f = Object.fromEntries(['agency', 'name', 'email', 'phone', 'city', 'country', 'gstin', 'tax_id', 'password'].map((k) => [k, String(req.body[k] || '').trim()]));
  f.email = f.email.toLowerCase();
  const tax = checkTax({ country: f.country, gstin: f.gstin, taxId: f.tax_id });
  const docs = req.kycFiles;
  const errors = [];
  if (!f.agency) errors.push('Agency name is required.');
  if (!f.name) errors.push('Your name is required.');
  if (!/^\S+@\S+\.\S+$/.test(f.email)) errors.push('Enter a valid email.');
  if (f.password.length < 8) errors.push('Password must be at least 8 characters.');
  if (await one('SELECT 1 FROM users WHERE email = ?', f.email)) errors.push('An account with this email already exists. Log in instead.');
  errors.push(...tax.errors, ...checkKycFiles(req, tax.country));
  if (errors.length) {
    // Browsers can't refill a file input, so a valid upload is dropped and asked for again.
    if (Object.keys(docs).length) {
      await removeUploaded(req);
      errors.push('For your security, please choose your documents and photo again.');
    }
    return res.page('public/signup', { title: 'Become a VaayuTrip partner', form: f, countries: COUNTRIES, flash: errors.map((m) => ({ type: 'error', message: m })) }, 'public');
  }
  const userId = await tx(async () => {
    const agencyId = (await run(
      'INSERT INTO agencies (name, slug, email, phone, city, country, gstin, pan, tax_id, tax_doc, pan_doc, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.agency, await uniqueSlug('agencies', f.agency), f.email, f.phone, f.city, tax.country, tax.gstin, tax.pan, tax.taxId, docs.tax_doc, docs.pan_doc || null, docs.photo,
    )).lastInsertRowid;
    await notify(null, 'New agent signup', `${f.agency}${f.city ? ` (${f.city})` : ''} is waiting for approval.`, `/admin/agents/${agencyId}`);
    return (await run('INSERT INTO users (role, agency_id, name, email, phone, password_hash, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)', 'agent', agencyId, f.name, f.email, f.phone, hashPassword(f.password), mailer.enabled() ? 0 : 1)).lastInsertRowid;
  });
  req.session.userId = userId;
  if (mailer.enabled()) {
    await otp.sendCode({ id: userId, email: f.email }, 'verify');
    req.flash('success', `Application received. We've emailed a 6-digit code to ${f.email}: enter it to verify your email.`);
    return res.redirect('/verify-email');
  }
  req.flash('success', 'Application received. Our team will check your documents and approve your agency, usually within one working day. Meanwhile you can explore the portal and set up your branding.');
  res.redirect('/agent/settings');
}));

// Back from PhonePe after a wallet top-up (GET, or POST for older PhonePe set-ups): confirm it and show where it stands.
router.all('/payments/return/:orderId', h(async (req, res, next) => {
  let p = await one('SELECT * FROM payments WHERE order_id = ?', String(req.params.orderId).slice(0, 64));
  if (!p) return next();
  try { p = await payments.settle(p.order_id); } catch { /* status unknown for now; shown as processing */ }
  if (p.purpose === 'booking') {
    const b = p.status === 'completed' && await one('SELECT id, code FROM bookings WHERE quote_id = ? AND agency_id = ? ORDER BY id DESC', p.ref_id, p.agency_id);
    if (b) { req.flash('success', `Payment received and booking confirmed. Booking ID ${b.code}.`); return res.redirect(`/agent/bookings/${b.id}`); }
    req.flash(...(p.status === 'completed' ? ['error', `Payment received: ₹${p.amount.toLocaleString('en-IN')} is in your wallet, but the booking could not be completed. See your notifications, then book again.`]
      : p.status === 'failed' ? ['error', 'The payment did not go through and no money was taken. You can try again.']
        : ['info', 'PhonePe is still confirming your payment. The booking will be made automatically in a few minutes; please do not pay again.']));
    return res.redirect(`/agent/quotes/${p.ref_id}`);
  }
  const msg = p.status === 'completed' ? ['success', `Payment received. ₹${p.amount.toLocaleString('en-IN')} added to your wallet.`]
    : p.status === 'failed' ? ['error', 'The payment did not go through and no money was taken. You can try again.']
      : ['info', 'Your payment is being confirmed by PhonePe. This page will show it as paid within a few minutes; please don\'t pay again.'];
  req.flash(...msg);
  res.redirect('/agent/wallet');
}));

// Public pages for search engines: VaayuTrip's own pages (the portal itself is private).
router.get('/sitemap.xml', h(async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const urls = ['/', '/signup', '/terms', '/privacy'];
  const esc = (u) => u.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(base + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
}));

module.exports = router;
