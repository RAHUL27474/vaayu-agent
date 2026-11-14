const express = require('express');
const { one, all, run, tx, notify, audit, getSettings } = require('../db');
const { hashPassword, verifyPassword, uniqueSlug, num, code, round2 } = require('../util');
const { getQuote, packageSellPrice, voucherFor } = require('../services');
const { buildInvoice, emiPlans } = require('../pricing');
const { h, homeFor } = require('../auth');
const { parseDetails, present } = require('../packages');
const { COUNTRIES, withKycDocs, checkTax, checkKycFiles, removeUploaded } = require('../kyc');
const { DESTINATIONS, destinationOf } = require('../products');
const phonepe = require('../phonepe');
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
  for (const r of await all("SELECT city, country, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY city, country")) {
    const d = byDest[destinationOf(r.country)];
    if (d) { d.cities.add(r.city); d.items += r.n; }
  }
  const destinations = Object.values(byDest).map((d) => ({ name: d.name, cities: [...d.cities], items: d.items }));
  res.page('public/home', { title: 'B2B travel platform for agents', activities, stats, destinations }, 'public');
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
  res.page('public/login', { title: 'Log in', next: req.query.next || '', email: '' }, 'public');
});

// Password guessing: 8 failures for one email, or 30 from one address, in 15 minutes pause logins there.
const LOGIN_LIMITS = { email: 8, ip: 30 };

router.post('/login', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const loginError = (message) => res.status(message.startsWith('Too many') ? 429 : 200)
    .page('public/login', { title: 'Log in', next: req.body.next || '', email, flash: [{ type: 'error', message }] }, 'public');
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
  req.session.userId = user.id;
  req.session.pw = user.password_hash.slice(-12);
  await audit(user, 'user.login', { entity: 'user', id: user.id, summary: `${user.name} logged in` });
  const next = String(req.body.next || '');
  const home = homeFor(user.role);
  res.redirect(next.startsWith(home) ? next : home);
}));

// ---------- your own account (any role) ----------

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));

router.get('/account', requireLogin, h(async (req, res) => {
  const me = await one('SELECT name, email, phone, created_at FROM users WHERE id = ?', req.user.id);
  const lastLogin = await one("SELECT created_at FROM audit_log WHERE user_id = ? AND action = 'user.login' ORDER BY id DESC LIMIT 1 OFFSET 1", req.user.id);
  res.page('account', { title: 'My account', me, lastLogin });
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
    const already = u && await one("SELECT 1 FROM notifications WHERE agency_id IS NULL AND title = 'Password reset request' AND body LIKE ? AND created_at > datetime('now', '-1 day')", `%(${email}%`);
    if (u && !already) {
      await notify(null, 'Password reset request', `${u.name} (${email}${u.agency ? `, ${u.agency}` : ''}) asked for a new password. Call ${u.phone || u.agency_phone || 'them'} to verify before resetting.`,
        u.agency_id ? `/admin/agents/${u.agency_id}#users` : '/admin/team');
    }
  }
  res.page('public/forgot', { title: 'Forgot password', email, sent: true, noindex: true }, 'public');
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
    return (await run('INSERT INTO users (role, agency_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)', 'agent', agencyId, f.name, f.email, f.phone, hashPassword(f.password))).lastInsertRowid;
  });
  req.session.userId = userId;
  req.flash('success', 'Application received. Our team will check your documents and approve your agency, usually within one working day. Meanwhile you can explore the portal and set up your branding.');
  res.redirect('/agent/settings');
}));

// ---------- agent mini-websites ----------

async function siteAgency(req) {
  return await one("SELECT * FROM agencies WHERE slug = ? AND status = 'active' AND website_enabled = 1", req.params.slug);
}

router.get('/site/:slug', h(async (req, res, next) => {
  const agency = await siteAgency(req);
  if (!agency) return next();
  const rows = await all("SELECT * FROM packages WHERE agency_id = ? AND status = 'published' ORDER BY updated_at DESC", agency.id);
  const packages = await Promise.all(rows.map(async (p) => ({ ...p, price: (await packageSellPrice(agency, p)).sell })));
  res.page('public/site-home', { title: agency.name, site: agency, packages, bare: true }, 'public');
}));

router.get('/site/:slug/p/:pkg', h(async (req, res, next) => {
  const agency = await siteAgency(req);
  const pkg = agency && await one("SELECT * FROM packages WHERE slug = ? AND agency_id = ? AND status = 'published'", req.params.pkg, agency.id);
  if (!pkg) return next();
  const view = await present(pkg, parseDetails(pkg.details));
  const price = (await packageSellPrice(agency, pkg)).sell;
  res.page('public/site-package', {
    title: `${pkg.title} · ${agency.name}`, site: agency, pkg, view, price, bare: true,
    meta: { description: `${pkg.nights} nights in ${pkg.destination}${pkg.summary ? `: ${pkg.summary.trim().replace(/\.+$/, '')}` : ''}. From ₹${Math.round(price).toLocaleString('en-IN')} per person.`, image: pkg.image_url, type: 'article', ld: { pkg, price } },
  }, 'public');
}));

router.post('/site/:slug/enquire', h(async (req, res, next) => {
  const agency = await siteAgency(req);
  if (!agency) return next();
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!name || !phone) {
    req.flash('error', 'Please share your name and phone number.');
    return res.redirect(req.get('referer') || `/site/${agency.slug}`);
  }
  const pkg = req.body.package_id ? await one("SELECT id, slug, title, destination FROM packages WHERE id = ? AND agency_id = ? AND status = 'published'", num(req.body.package_id), agency.id) : null;
  await run(
    "INSERT INTO leads (agency_id, package_id, name, phone, email, destination, travel_date, pax, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'website')",
    agency.id, pkg?.id || null, name, phone, String(req.body.email || '').trim() || null, pkg?.destination || String(req.body.destination || '').trim() || null,
    req.body.travel_date || null, num(req.body.pax, 0) || null, String(req.body.message || '').trim() || null,
  );
  await notify(agency.id, 'New website enquiry', `${name} enquired about ${pkg ? pkg.title : 'a trip'}.`, '/agent/leads');
  req.flash('success', `Thank you, ${name}! ${agency.name} will call you shortly.`);
  res.redirect(pkg ? `/site/${agency.slug}/p/${pkg.slug}` : `/site/${agency.slug}`);
}));

// ---------- shared quote, invoices and payment links ----------

async function sharedQuote(codeParam) {
  const q = await one('SELECT * FROM quotes WHERE code = ?', codeParam);
  if (!q) return null;
  const full = await getQuote(q.id);
  const agency = await one('SELECT * FROM agencies WHERE id = ?', q.agency_id);
  const settings = await getSettings();
  const kind = q.invoice_mode === 'agent' && agency.logo_path ? 'customer_agent' : 'customer_vaayu';
  const doc = buildInvoice(kind, { ...full, agency, settings });
  const agentItems = kind === 'customer_vaayu' ? full.priced.lines.filter((l) => l.supplier === 'agent') : [];
  const pkgView = q.package_snapshot ? JSON.parse(q.package_snapshot) : null;
  return { ...full, agency, settings, kind, doc, agentItems, pkgView };
}

router.get('/q/:code', h(async (req, res, next) => {
  const s = await sharedQuote(req.params.code);
  if (!s) return next();
  const payLink = await one("SELECT * FROM payment_links WHERE quote_id = ? AND status = 'pending' ORDER BY id DESC", s.quote.id);
  const total = s.doc.totals.total + s.agentItems.reduce((t, l) => t + l.lineSell, 0);
  res.page('public/quote', {
    title: `${s.quote.title} — quote`, ...s, payLink, total,
    emi: s.quote.emi_enabled && total > 0 ? emiPlans(total, s.settings) : [],
    favicon: s.kind === 'customer_agent' ? s.agency.logo_path : null,
    noindex: true,
    site: s.kind === 'customer_agent' ? s.agency : undefined,
    meta: { description: `Your holiday quote${s.agency ? ` from ${s.agency.name}` : ''}: ${s.quote.title}.`, image: s.quote.package_snapshot ? JSON.parse(s.quote.package_snapshot).image : null },
  }, 'doc');
}));

router.post('/q/:code/accept', h(async (req, res, next) => {
  const q = await one('SELECT * FROM quotes WHERE code = ?', req.params.code);
  if (!q) return next();
  if (['draft', 'sent'].includes(q.status)) {
    await run("UPDATE quotes SET status = 'accepted', updated_at = datetime('now') WHERE id = ?", q.id);
    await notify(q.agency_id, 'Quote accepted', `Your customer accepted "${q.title}". Book it to confirm.`, `/agent/quotes/${q.id}`);
  }
  req.flash('success', 'Thank you! Your travel agent has been notified and will confirm your booking.');
  res.redirect(`/q/${q.code}`);
}));

router.get('/q/:code/invoice/:id', h(async (req, res, next) => {
  const q = await one('SELECT id FROM quotes WHERE code = ?', req.params.code);
  const inv = q && await one("SELECT * FROM invoices WHERE id = ? AND quote_id = ? AND kind != 'b2b'", num(req.params.id), q.id);
  if (!inv) return next();
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, doc: JSON.parse(inv.data), back: `/q/${req.params.code}` }, 'doc');
}));

// Back from PhonePe (GET, or POST for older PhonePe set-ups): confirm the payment and show where it stands.
router.all('/payments/return/:orderId', h(async (req, res, next) => {
  let p = await one('SELECT * FROM payments WHERE order_id = ?', String(req.params.orderId).slice(0, 64));
  if (!p) return next();
  try { p = await payments.settle(p.order_id); } catch { /* status unknown for now; shown as processing */ }
  const msg = p.status === 'completed' ? ['success', p.purpose === 'topup' ? `Payment received. ₹${p.amount.toLocaleString('en-IN')} added to your wallet.` : 'Payment successful. Thank you! Your travel agent has been notified.']
    : p.status === 'failed' ? ['error', 'The payment did not go through and no money was taken. You can try again.']
      : ['info', 'Your payment is being confirmed by PhonePe. This page will show it as paid within a few minutes; please don\'t pay again.'];
  req.flash(...msg);
  if (p.purpose === 'topup') return res.redirect('/agent/wallet');
  const link = await one('SELECT code FROM payment_links WHERE id = ?', p.ref_id);
  res.redirect(`/pay/${link.code}`);
}));

// "Pay now" on a shared quote (when the agent allows it): a payment link for the trip total, then PhonePe.
router.post('/q/:code/pay', h(async (req, res, next) => {
  const s = await sharedQuote(req.params.code);
  if (!s) return next();
  const total = round2(s.doc.totals.total + s.agentItems.reduce((t, l) => t + l.lineSell, 0));
  if (!s.quote.pay_online || !['sent', 'accepted'].includes(s.quote.status) || total < 1) return res.redirect(`/q/${s.quote.code}`);
  let link = await one("SELECT * FROM payment_links WHERE quote_id = ? AND status = 'pending' ORDER BY id DESC", s.quote.id);
  if (link && Math.abs(link.amount - total) >= 0.01) {
    await run("UPDATE payment_links SET status = 'expired' WHERE id = ?", link.id);
    link = null;
  }
  if (!link) {
    const id = (await run('INSERT INTO payment_links (agency_id, quote_id, code, purpose, amount, customer_name) VALUES (?, ?, ?, ?, ?, ?)',
      s.quote.agency_id, s.quote.id, code('PAY'), s.quote.title, total, s.customer ? s.customer.name : null)).lastInsertRowid;
    link = await one('SELECT * FROM payment_links WHERE id = ?', id);
  }
  res.redirect(`/pay/${link.code}`);
}));

// The customer's travel voucher, once the quote is booked.
router.get('/q/:code/voucher', h(async (req, res, next) => {
  const q = await one('SELECT id FROM quotes WHERE code = ?', req.params.code);
  const v = q && await voucherFor(await one('SELECT * FROM bookings WHERE quote_id = ? ORDER BY id DESC', q.id));
  if (!v) return next();
  res.page('voucher', {
    title: `Travel voucher ${v.booking.code}`, ...v, back: `/q/${req.params.code}`, noindex: true,
    site: v.favicon ? v.agency : undefined, meta: { description: `Your travel voucher for ${v.quote.title}.` },
  }, 'doc');
}));

router.get('/pay/:code', h(async (req, res, next) => {
  let link = await one('SELECT * FROM payment_links WHERE code = ?', req.params.code);
  if (!link) return next();
  // A payment started here but never returned from PhonePe: find out how it ended.
  const open = link.status === 'pending' && await one("SELECT order_id FROM payments WHERE purpose = 'link' AND ref_id = ? AND status = 'pending' ORDER BY id DESC", link.id);
  if (open) {
    await payments.settle(open.order_id).catch(() => null);
    link = await one('SELECT * FROM payment_links WHERE id = ?', link.id);
  }
  res.locals.payOnline = phonepe.enabled() ? 'phonepe' : process.env.VERCEL_ENV === 'production' ? null : 'demo';
  const agency = await one('SELECT * FROM agencies WHERE id = ?', link.agency_id);
  res.page('public/pay', { title: `Pay ${agency.name}`, link, site: agency, noindex: true, meta: { description: `${link.purpose}: payment to ${agency.name}.` }, emi: emiPlans(link.amount, await getSettings()) }, 'doc');
}));

// Demo checkout: a real deployment would redirect to Razorpay/Cashfree and mark paid from their webhook.
router.post('/pay/:code', h(async (req, res, next) => {
  const link = await one('SELECT * FROM payment_links WHERE code = ?', req.params.code);
  if (!link) return next();
  if (link.status !== 'pending') return res.redirect(`/pay/${link.code}`);
  if (phonepe.enabled()) {
    try {
      const url = await payments.startPayment({ purpose: 'link', agencyId: link.agency_id, refId: link.id, amount: link.amount, origin: res.locals.origin, note: link.purpose, payerRef: link.code });
      return res.redirect(303, url);
    } catch (e) {
      req.flash('error', e.message);
      return res.redirect(`/pay/${link.code}`);
    }
  }
  // Without PhonePe the live site takes no payments; elsewhere the checkout is simulated for demos and tests.
  if (process.env.VERCEL_ENV === 'production') {
    req.flash('error', 'Online payment is not available yet. Please contact your travel agent to pay.');
    return res.redirect(`/pay/${link.code}`);
  }
  {
    await run("UPDATE payment_links SET status = 'paid', paid_at = datetime('now') WHERE id = ?", link.id);
    await notify(link.agency_id, 'Payment received', `${link.customer_name || 'Customer'} paid ₹${link.amount.toLocaleString('en-IN')} for ${link.purpose}.`, '/agent/payment-links');
  }
  req.flash('success', 'Payment successful. A receipt has been sent to your travel agent.');
  res.redirect(`/pay/${link.code}`);
}));

// Public pages for search engines: VaayuTrip's own pages, plus each live agency website and its packages.
router.get('/sitemap.xml', h(async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const urls = ['/', '/signup', '/terms', '/privacy'];
  const sites = await all("SELECT id, slug FROM agencies WHERE status = 'active' AND website_enabled = 1");
  const pkgs = sites.length ? await all(`SELECT agency_id, slug FROM packages WHERE status = 'published' AND agency_id IN (${sites.map(() => '?').join(', ')})`, ...sites.map((s) => s.id)) : [];
  for (const s of sites) {
    urls.push(`/site/${s.slug}`);
    for (const p of pkgs.filter((x) => x.agency_id === s.id)) urls.push(`/site/${s.slug}/p/${p.slug}`);
  }
  const esc = (u) => u.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(base + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
}));

module.exports = router;
