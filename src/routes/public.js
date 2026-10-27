const express = require('express');
const { one, all, run, tx, notify, audit, getSettings } = require('../db');
const { hashPassword, verifyPassword, uniqueSlug, num } = require('../util');
const { getQuote, packageSellPrice } = require('../services');
const { buildInvoice, emiPlans } = require('../pricing');
const { h, homeFor } = require('../auth');
const { parseDetails, present } = require('../packages');
const { COUNTRIES, withTaxDoc, checkTax, removeDoc } = require('../kyc');

const router = express.Router();

router.get('/', h((req, res) => {
  const activities = all("SELECT * FROM products WHERE status = 'published' AND kind = 'activity' ORDER BY RANDOM() LIMIT 5");
  const counts = Object.fromEntries(all("SELECT kind, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY kind").map((r) => [r.kind, r.n]));
  const stats = {
    agents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'active'").n,
    hotels: counts.hotel || 0,
    activities: counts.activity || 0,
    flights: counts.flight || 0,
    cities: one("SELECT COUNT(DISTINCT city) AS n FROM products WHERE status = 'published'").n,
  };
  res.page('public/home', { title: 'B2B travel platform for agents', activities, stats }, 'public');
}));

// Generated cover card for packages and hotels without an uploaded photo.
const COVER_PALETTES = [['#0b6fa4', '#0c2233'], ['#0f766e', '#042f2e'], ['#7c3aed', '#1e1b4b'], ['#c2410c', '#431407'], ['#be123c', '#4c0519'], ['#1d4ed8', '#172554'], ['#15803d', '#052e16'], ['#a16207', '#422006']];
router.get('/cover/:name.svg', (req, res) => {
  const name = String(req.params.name || 'Holiday').slice(0, 40);
  const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [c1, c2] = COVER_PALETTES[hash % COVER_PALETTES.length];
  const size = name.length > 18 ? 52 : 68;
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="1200" height="800" fill="url(#g)"/>
<circle cx="${900 + (hash % 160)}" cy="${170 + (hash % 60)}" r="70" fill="#f59e0b" opacity=".85"/>
<path d="M0 620 L${220 + (hash % 90)} ${400 + (hash % 50)} L420 560 L${640 + (hash % 80)} ${360 + (hash % 70)} L1200 650 L1200 800 L0 800 Z" fill="#fff" opacity=".12"/>
<path d="M0 700 C200 650 400 740 600 700 S1000 650 1200 700 L1200 800 L0 800 Z" fill="#fff" opacity=".16"/>
<text x="70" y="${470 - size}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="800" fill="#fff">${esc(name)}</text>
<text x="72" y="${470 - size + 52}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="26" fill="#fff" opacity=".8" letter-spacing="3">VAAYUTRIP HOLIDAYS</text>
</svg>`);
});

// ---------- auth ----------

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user.role));
  res.page('public/login', { title: 'Log in', next: req.query.next || '', email: '' }, 'public');
});

router.post('/login', h((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user || !user.is_active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    const flash = [{ type: 'error', message: 'Wrong email or password.' }];
    return res.page('public/login', { title: 'Log in', next: req.body.next || '', email, flash }, 'public');
  }
  req.session.userId = user.id;
  audit(user, 'user.login', { entity: 'user', id: user.id, summary: `${user.name} logged in` });
  const next = String(req.body.next || '');
  const home = homeFor(user.role);
  res.redirect(next.startsWith(home) ? next : home);
}));

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/signup', (req, res) => {
  res.page('public/signup', { title: 'Become a VaayuTrip partner', form: { country: 'India' }, countries: COUNTRIES }, 'public');
});

router.post('/signup', withTaxDoc('tax_doc'), h((req, res) => {
  const f = Object.fromEntries(['agency', 'name', 'email', 'phone', 'city', 'country', 'gstin', 'tax_id', 'password'].map((k) => [k, String(req.body[k] || '').trim()]));
  f.email = f.email.toLowerCase();
  const tax = checkTax({ country: f.country, gstin: f.gstin, taxId: f.tax_id }, {
    docUploaded: Boolean(req.file), needDoc: true, rejected: req.taxDocRejected, uploadError: req.uploadError,
  });
  const errors = [];
  if (!f.agency) errors.push('Agency name is required.');
  if (!f.name) errors.push('Your name is required.');
  if (!/^\S+@\S+\.\S+$/.test(f.email)) errors.push('Enter a valid email.');
  if (f.password.length < 8) errors.push('Password must be at least 8 characters.');
  if (one('SELECT 1 FROM users WHERE email = ?', f.email)) errors.push('An account with this email already exists. Log in instead.');
  errors.push(...tax.errors);
  if (errors.length) {
    // Browsers can't refill a file input, so a valid upload is dropped and asked for again.
    if (req.file) {
      removeDoc(req.file.filename);
      errors.push('Please choose your tax document again.');
    }
    return res.page('public/signup', { title: 'Become a VaayuTrip partner', form: f, countries: COUNTRIES, flash: errors.map((m) => ({ type: 'error', message: m })) }, 'public');
  }
  const userId = tx(() => {
    const agencyId = run(
      'INSERT INTO agencies (name, slug, email, phone, city, country, gstin, pan, tax_id, tax_doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.agency, uniqueSlug('agencies', f.agency), f.email, f.phone, f.city, tax.country, tax.gstin, tax.pan, tax.taxId, req.file.filename,
    ).lastInsertRowid;
    notify(null, 'New agent signup', `${f.agency}${f.city ? ` (${f.city})` : ''} is waiting for approval.`, `/admin/agents/${agencyId}`);
    return run('INSERT INTO users (role, agency_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)', 'agent', agencyId, f.name, f.email, f.phone, hashPassword(f.password)).lastInsertRowid;
  });
  req.session.userId = userId;
  req.flash('success', 'Welcome to VaayuTrip! Your account is under review; complete your company profile and branding meanwhile.');
  res.redirect('/agent/settings');
}));

// ---------- agent mini-websites ----------

function siteAgency(req) {
  return one("SELECT * FROM agencies WHERE slug = ? AND status = 'active' AND website_enabled = 1", req.params.slug);
}

router.get('/site/:slug', h((req, res, next) => {
  const agency = siteAgency(req);
  if (!agency) return next();
  const packages = all("SELECT * FROM packages WHERE agency_id = ? AND status = 'published' ORDER BY updated_at DESC", agency.id)
    .map((p) => ({ ...p, price: packageSellPrice(agency, p).sell }));
  res.page('public/site-home', { title: agency.name, site: agency, packages, bare: true }, 'public');
}));

router.get('/site/:slug/p/:pkg', h((req, res, next) => {
  const agency = siteAgency(req);
  const pkg = agency && one("SELECT * FROM packages WHERE slug = ? AND agency_id = ? AND status = 'published'", req.params.pkg, agency.id);
  if (!pkg) return next();
  const view = present(pkg, parseDetails(pkg.details));
  res.page('public/site-package', { title: `${pkg.title} · ${agency.name}`, site: agency, pkg, view, price: packageSellPrice(agency, pkg).sell, bare: true }, 'public');
}));

router.post('/site/:slug/enquire', h((req, res, next) => {
  const agency = siteAgency(req);
  if (!agency) return next();
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!name || !phone) {
    req.flash('error', 'Please share your name and phone number.');
    return res.redirect(req.get('referer') || `/site/${agency.slug}`);
  }
  const pkg = req.body.package_id ? one("SELECT id, slug, title, destination FROM packages WHERE id = ? AND agency_id = ? AND status = 'published'", num(req.body.package_id), agency.id) : null;
  run(
    "INSERT INTO leads (agency_id, package_id, name, phone, email, destination, travel_date, pax, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'website')",
    agency.id, pkg?.id || null, name, phone, String(req.body.email || '').trim() || null, pkg?.destination || String(req.body.destination || '').trim() || null,
    req.body.travel_date || null, num(req.body.pax, 0) || null, String(req.body.message || '').trim() || null,
  );
  notify(agency.id, 'New website enquiry', `${name} enquired about ${pkg ? pkg.title : 'a trip'}.`, '/agent/leads');
  req.flash('success', `Thank you, ${name}! ${agency.name} will call you shortly.`);
  res.redirect(pkg ? `/site/${agency.slug}/p/${pkg.slug}` : `/site/${agency.slug}`);
}));

// ---------- shared quote, invoices and payment links ----------

function sharedQuote(codeParam) {
  const q = one('SELECT * FROM quotes WHERE code = ?', codeParam);
  if (!q) return null;
  const full = getQuote(q.id);
  const agency = one('SELECT * FROM agencies WHERE id = ?', q.agency_id);
  const settings = getSettings();
  const kind = q.invoice_mode === 'agent' && agency.logo_path ? 'customer_agent' : 'customer_vaayu';
  const doc = buildInvoice(kind, { ...full, agency, settings });
  const agentItems = kind === 'customer_vaayu' ? full.priced.lines.filter((l) => l.supplier === 'agent') : [];
  const pkgView = q.package_snapshot ? JSON.parse(q.package_snapshot) : null;
  return { ...full, agency, settings, kind, doc, agentItems, pkgView };
}

router.get('/q/:code', h((req, res, next) => {
  const s = sharedQuote(req.params.code);
  if (!s) return next();
  const payLink = one("SELECT * FROM payment_links WHERE quote_id = ? AND status = 'pending' ORDER BY id DESC", s.quote.id);
  const total = s.doc.totals.total + s.agentItems.reduce((t, l) => t + l.lineSell, 0);
  res.page('public/quote', {
    title: `${s.quote.title} — quote`, ...s, payLink, total,
    emi: s.quote.emi_enabled && total > 0 ? emiPlans(total, s.settings) : [],
    favicon: s.kind === 'customer_agent' ? s.agency.logo_path : null,
  }, 'doc');
}));

router.post('/q/:code/accept', h((req, res, next) => {
  const q = one('SELECT * FROM quotes WHERE code = ?', req.params.code);
  if (!q) return next();
  if (['draft', 'sent'].includes(q.status)) {
    run("UPDATE quotes SET status = 'accepted', updated_at = datetime('now') WHERE id = ?", q.id);
    notify(q.agency_id, 'Quote accepted', `Your customer accepted "${q.title}". Book it to confirm.`, `/agent/quotes/${q.id}`);
  }
  req.flash('success', 'Thank you! Your travel agent has been notified and will confirm your booking.');
  res.redirect(`/q/${q.code}`);
}));

router.get('/q/:code/invoice/:id', h((req, res, next) => {
  const q = one('SELECT id FROM quotes WHERE code = ?', req.params.code);
  const inv = q && one("SELECT * FROM invoices WHERE id = ? AND quote_id = ? AND kind != 'b2b'", num(req.params.id), q.id);
  if (!inv) return next();
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, doc: JSON.parse(inv.data), back: `/q/${req.params.code}` }, 'doc');
}));

router.get('/pay/:code', h((req, res, next) => {
  const link = one('SELECT * FROM payment_links WHERE code = ?', req.params.code);
  if (!link) return next();
  const agency = one('SELECT * FROM agencies WHERE id = ?', link.agency_id);
  res.page('public/pay', { title: `Pay ${agency.name}`, link, site: agency, emi: emiPlans(link.amount, getSettings()) }, 'doc');
}));

// Demo checkout: a real deployment would redirect to Razorpay/Cashfree and mark paid from their webhook.
router.post('/pay/:code', h((req, res, next) => {
  const link = one('SELECT * FROM payment_links WHERE code = ?', req.params.code);
  if (!link) return next();
  if (link.status === 'pending') {
    run("UPDATE payment_links SET status = 'paid', paid_at = datetime('now') WHERE id = ?", link.id);
    notify(link.agency_id, 'Payment received', `${link.customer_name || 'Customer'} paid ₹${link.amount.toLocaleString('en-IN')} for ${link.purpose}.`, '/agent/payment-links');
  }
  req.flash('success', 'Payment successful. A receipt has been sent to your travel agent.');
  res.redirect(`/pay/${link.code}`);
}));

module.exports = router;
