const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, notify, getSettings, setSetting, UPLOADS_DIR } = require('../db');
const { num, uniqueSlug, round2 } = require('../util');
const { requireAdmin, h } = require('../auth');
const svc = require('../services');
const {
  CATEGORIES, MEAL_PLANS, STAY_TYPES, ADDON_TYPES, PACKAGE_TYPES, emptyDetails, parseDetails, detailsFromForm, publishProblems, categoriesOf, fromPrice,
  calcPackage, present,
} = require('../packages');
const { priceQuote } = require('../pricing');
const { CATALOGUE, slugOf } = require('../sync-packages');

// Package photos: JPG/PNG/WebP up to 5 MB each, saved under <uploads>/packages.
const PHOTO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const PHOTO_DIR = path.join(UPLOADS_DIR, 'packages');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    // Extension comes from the checked MIME type, never from the uploaded filename.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${PHOTO_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 13, fields: 10000, fieldSize: 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = Boolean(PHOTO_TYPES[file.mimetype]);
    if (!ok) req.photosRejected = (req.photosRejected || 0) + 1;
    cb(null, ok);
  },
}).fields([{ name: 'cover_file', maxCount: 1 }, { name: 'gallery_files', maxCount: 12 }]);

// Runs the upload and turns multer errors (too large, too many) into a friendly message.
function withPhotos(req, res, next) {
  photoUpload(req, res, (err) => {
    if (err) return next(new svc.AppError(err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 5 MB.' : `Upload failed: ${err.message}`));
    next();
  });
}

// Applies uploaded/removed photos to the package core fields and details.
function applyPhotos(req, core, details) {
  const files = req.files || {};
  if (req.body.remove_cover) core.image_url = null;
  if (files.cover_file && files.cover_file[0]) core.image_url = `/uploads/packages/${files.cover_file[0].filename}`;
  for (const f of files.gallery_files || []) details.gallery.push(`/uploads/packages/${f.filename}`);
  if (req.photosRejected) req.flash('warn', `${req.photosRejected} file(s) skipped: photos must be JPG, PNG or WebP.`);
}

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.pendingTopups = one("SELECT COUNT(*) AS n FROM topup_requests WHERE status = 'pending'").n;
  next();
});

const str = (v) => String(v ?? '').trim();

// ---------- dashboard ----------

router.get('/', h((req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const stats = {
    agents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'active'").n,
    pendingAgents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'pending'").n,
    packages: one("SELECT COUNT(*) AS n FROM packages WHERE status = 'published'").n,
    ...one(`SELECT COUNT(*) AS bookings, COALESCE(SUM(total_net), 0) AS revenue FROM bookings WHERE status != 'cancelled' AND substr(created_at, 1, 7) = ?`, month),
    walletFloat: one('SELECT COALESCE(SUM(wallet_balance), 0) AS n FROM agencies').n,
    creditOut: one('SELECT COALESCE(SUM(credit_used), 0) AS n FROM agencies').n,
    cancelRequests: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancel_requested'").n,
  };
  const bookings = all('SELECT b.*, a.name AS agency_name FROM bookings b JOIN agencies a ON a.id = b.agency_id ORDER BY b.id DESC LIMIT 8');
  const pending = all("SELECT * FROM agencies WHERE status = 'pending' ORDER BY id DESC LIMIT 5");
  const topAgents = all(
    `SELECT a.id, a.name, a.city, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_net), 0) AS revenue
     FROM agencies a LEFT JOIN bookings b ON b.agency_id = a.id AND b.status != 'cancelled'
     WHERE a.status = 'active' GROUP BY a.id ORDER BY revenue DESC LIMIT 5`,
  );
  const topPackages = all(
    `SELECT p.id, p.title, COUNT(b.id) AS bookings FROM packages p
     LEFT JOIN quotes q ON q.package_id = p.id LEFT JOIN bookings b ON b.quote_id = q.id AND b.status != 'cancelled'
     GROUP BY p.id ORDER BY bookings DESC, p.id LIMIT 5`,
  );
  res.page('admin/dashboard', { title: 'Admin dashboard', stats, bookings, pending, topAgents, topPackages });
}));

// ---------- agents ----------

router.get('/agents', h((req, res) => {
  const status = ['pending', 'active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const agents = all(
    `SELECT a.*, (SELECT COUNT(*) FROM bookings b WHERE b.agency_id = a.id AND b.status != 'cancelled') AS bookings,
       (SELECT u.name FROM users u WHERE u.agency_id = a.id ORDER BY u.id LIMIT 1) AS contact
     FROM agencies a ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC`, ...(status ? [status] : []),
  );
  res.page('admin/agents', { title: 'Agents', agents, status });
}));

router.get('/agents/:id', h((req, res, next) => {
  const agent = one('SELECT * FROM agencies WHERE id = ?', num(req.params.id));
  if (!agent) return next();
  const users = all('SELECT id, name, email, phone, created_at FROM users WHERE agency_id = ?', agent.id);
  const bookings = all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const txns = all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const totals = one("SELECT COUNT(*) AS n, COALESCE(SUM(total_net), 0) AS revenue, COALESCE(SUM(total_sell - total_net), 0) AS commission FROM bookings WHERE agency_id = ? AND status != 'cancelled'", agent.id);
  res.page('admin/agent', { title: agent.name, agent, users, bookings, txns, totals });
}));

router.post('/agents/:id/status', h((req, res) => {
  const id = num(req.params.id);
  const status = ['active', 'suspended', 'pending'].includes(req.body.status) ? req.body.status : null;
  const kyc = ['verified', 'rejected', 'pending'].includes(req.body.kyc_status) ? req.body.kyc_status : null;
  if (status) run('UPDATE agencies SET status = ? WHERE id = ?', status, id);
  if (kyc) run('UPDATE agencies SET kyc_status = ? WHERE id = ?', kyc, id);
  if (status === 'active') {
    const agency = one('SELECT api_key FROM agencies WHERE id = ?', id);
    if (!agency.api_key) run('UPDATE agencies SET api_key = ? WHERE id = ?', `vt_live_${crypto.randomBytes(18).toString('hex')}`, id);
    notify(id, 'Account approved', 'Welcome aboard! You can now book packages, flights and hotels on VaayuTrip.', '/agent');
  }
  if (status === 'suspended') notify(id, 'Account suspended', 'Contact VaayuTrip support for details.', null);
  req.flash('success', 'Agent updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/credit', h((req, res) => {
  const id = num(req.params.id);
  run('UPDATE agencies SET credit_limit = ? WHERE id = ?', Math.max(0, round2(num(req.body.credit_limit, 0))), id);
  notify(id, 'Credit limit updated', `Your credit limit is now ₹${Math.max(0, num(req.body.credit_limit, 0)).toLocaleString('en-IN')}.`, '/agent/wallet');
  req.flash('success', 'Credit limit updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/wallet', h((req, res) => {
  const id = num(req.params.id);
  const amount = round2(num(req.body.amount, 0));
  if (!amount) throw new svc.AppError('Enter a non-zero amount (negative to debit).');
  tx(() => svc.moveWallet(id, amount > 0 ? 'topup' : 'adjustment', amount, str(req.body.ref) || null, str(req.body.note) || 'Adjustment by VaayuTrip'));
  notify(id, amount > 0 ? 'Wallet credited' : 'Wallet debited', `₹${Math.abs(amount).toLocaleString('en-IN')} ${amount > 0 ? 'added to' : 'deducted from'} your wallet.`, '/agent/wallet');
  req.flash('success', 'Wallet updated.');
  res.redirect(`/admin/agents/${id}`);
}));

// ---------- packages ----------

const PKG_CORE = ['title', 'destination', 'nights', 'theme', 'summary', 'inclusions', 'exclusions', 'image_url', 'package_type', 'is_international', 'departure_city'];

function packageCore(b, details) {
  const routeNights = details.route.reduce((s, r) => s + r.nights, 0);
  return {
    title: str(b.title),
    destination: str(b.destination),
    nights: routeNights || Math.max(1, num(b.nights, 1)),
    theme: str(b.theme) || null,
    summary: str(b.summary) || null,
    inclusions: str(b.inclusions) || null,
    exclusions: str(b.exclusions) || null,
    image_url: str(b.image_url) || details.gallery[0] || null,
    package_type: PACKAGE_TYPES[b.package_type] ? b.package_type : 'customizable',
    is_international: b.is_international ? 1 : 0,
    departure_city: str(b.departure_city) || null,
  };
}

function newPackageDetails() {
  const d = emptyDetails();
  d.policies.cancellation = [{ days: 30, percent: 10 }, { days: 15, percent: 25 }, { days: 7, percent: 50 }, { days: 0, percent: 100 }];
  d.policies.child = 'Infants below 2 years: infant rate. Children 2–11 years: child rate (with or without extra bed). 12 years and above: adult rate.';
  d.policies.notes = 'Hotel check-in 14:00, check-out 11:00. Valid government photo ID required for all travellers. Rates may change during peak dates and long weekends.';
  return d;
}

router.get('/packages', h((req, res) => {
  const packages = all(
    'SELECT p.*, (SELECT COUNT(*) FROM quotes q WHERE q.package_id = p.id) AS quotes FROM packages p ORDER BY p.updated_at DESC',
  ).map((p) => {
    const d = parseDetails(p.details);
    return { ...p, from: fromPrice(d), categories: categoriesOf(d), departures: d.departures.length, problems: publishProblems(p, d) };
  });
  const demoSlugs = new Set(CATALOGUE.map((p) => slugOf(p.title)));
  const demoCount = packages.filter((p) => demoSlugs.has(p.slug)).length;
  res.page('admin/packages', { title: 'Packages', packages, demoCount });
}));

const formData = (pkg, details) => ({
  pkg, d: details, categories: CATEGORIES, mealPlans: MEAL_PLANS, stayTypes: STAY_TYPES, addonTypes: ADDON_TYPES, packageTypes: PACKAGE_TYPES,
  problems: pkg.id ? publishProblems(pkg, details) : [],
});

// Removes the bundled demo packages so only your own catalogue remains. Quotes keep their frozen copy.
router.post('/packages/remove-demo', h((req, res) => {
  const slugs = CATALOGUE.map((p) => slugOf(p.title));
  const removed = tx(() => slugs.reduce((n, slug) => n + Number(run('DELETE FROM packages WHERE slug = ?', slug).changes), 0));
  req.flash('success', removed ? `Removed ${removed} demo package(s). Add your own with "New package".` : 'No demo packages left to remove.');
  res.redirect('/admin/packages');
}));

router.get('/packages/new', (req, res) => {
  res.page('admin/package-form', { title: 'New package', ...formData({ nights: 3, status: 'draft', package_type: 'customizable' }, newPackageDetails()) });
});

router.post('/packages', withPhotos, h((req, res) => {
  const details = detailsFromForm(req.body);
  const core = packageCore(req.body, details);
  applyPhotos(req, core, details);
  if (!core.title || !core.destination) throw new svc.AppError('Title and destination are required.');
  const id = run(
    `INSERT INTO packages (${PKG_CORE.join(', ')}, details, slug) VALUES (${PKG_CORE.map(() => '?').join(', ')}, ?, ?)`,
    ...PKG_CORE.map((k) => core[k]), JSON.stringify(details), uniqueSlug('packages', core.title),
  ).lastInsertRowid;
  req.flash('success', 'Package saved as a draft. Publish it when the rates, hotels and itinerary are complete.');
  res.redirect(`/admin/packages/${id}`);
}));

router.get('/packages/:id', h((req, res, next) => {
  const pkg = one('SELECT * FROM packages WHERE id = ?', num(req.params.id));
  if (!pkg) return next();
  res.page('admin/package-form', { title: pkg.title, ...formData(pkg, parseDetails(pkg.details)) });
}));

router.post('/packages/:id', withPhotos, h((req, res, next) => {
  const pkg = one('SELECT * FROM packages WHERE id = ?', num(req.params.id));
  if (!pkg) return next();
  const details = detailsFromForm(req.body);
  // Seats already sold on fixed departures are kept even if the form omits them.
  const old = parseDetails(pkg.details);
  for (const dep of details.departures) {
    const prev = old.departures.find((x) => x.date === dep.date);
    if (prev) dep.booked = Math.max(dep.booked, prev.booked);
  }
  const core = packageCore(req.body, details);
  applyPhotos(req, core, details);
  if (!core.title || !core.destination) throw new svc.AppError('Title and destination are required.');
  run(
    `UPDATE packages SET ${PKG_CORE.map((k) => `${k} = ?`).join(', ')}, details = ?, updated_at = datetime('now') WHERE id = ?`,
    ...PKG_CORE.map((k) => core[k]), JSON.stringify(details), pkg.id,
  );
  const problems = publishProblems({ ...pkg, ...core }, details);
  if (pkg.status === 'published' && problems.length) {
    run("UPDATE packages SET status = 'draft' WHERE id = ?", pkg.id);
    req.flash('warn', `Package moved back to draft: ${problems[0]}`);
  } else {
    req.flash('success', 'Package saved.');
  }
  res.redirect(`/admin/packages/${pkg.id}`);
}));

router.post('/packages/:id/duplicate', h((req, res, next) => {
  const pkg = one('SELECT * FROM packages WHERE id = ?', num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  details.departures.forEach((d) => { d.booked = 0; });
  const copy = { ...pkg, title: `${pkg.title} (copy)` };
  const id = run(
    `INSERT INTO packages (${PKG_CORE.join(', ')}, details, slug) VALUES (${PKG_CORE.map(() => '?').join(', ')}, ?, ?)`,
    ...PKG_CORE.map((k) => copy[k]), JSON.stringify(details), uniqueSlug('packages', copy.title),
  ).lastInsertRowid;
  req.flash('success', 'Copy created as a draft.');
  res.redirect(`/admin/packages/${id}`);
}));

router.post('/packages/:id/status', h((req, res, next) => {
  const pkg = one('SELECT * FROM packages WHERE id = ?', num(req.params.id));
  if (!pkg) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = publishProblems(pkg, parseDetails(pkg.details));
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  run("UPDATE packages SET status = ?, updated_at = datetime('now') WHERE id = ?", status, pkg.id);
  if (status === 'published' && pkg.status !== 'published') {
    for (const a of all("SELECT id FROM agencies WHERE status = 'active'")) {
      notify(a.id, 'New package available', `${pkg.title} (${pkg.nights}N, ${pkg.destination}) is now bookable.`, `/agent/packages/${pkg.id}`);
    }
  }
  req.flash('success', status === 'published' ? 'Published: all active agents can now sell this package.' : 'Package unpublished.');
  res.redirect(`/admin/packages/${pkg.id}`);
}));

// What agents see: package page and calculator at net prices (no markup), for drafts too.
router.get('/packages/:id/preview', h((req, res, next) => {
  const pkg = one('SELECT * FROM packages WHERE id = ?', num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  const q = req.query;
  const calc = calcPackage(pkg, details, {
    category: str(q.category), date: str(q.date), rooms: q.rooms, adults: q.adults, cwb: q.cwb, cnb: q.cnb, infants: q.infants, addons: q.addons,
    withFlights: q.flights === undefined ? undefined : [].concat(q.flights).pop() === '1',
  });
  const previewMarkup = { markup_type: 'percent', markup_value: 0 };
  const priced = priceQuote(previewMarkup, calc.lines.map((l) => ({ ...l, net_price: l.net, supplier: 'vaayu', sell_price: null })));
  const net = fromPrice(details);
  res.page('agent/package', {
    title: `Preview: ${pkg.title}`, pkg, details, calc, priced, view: present(pkg, details, calc.options.category, true),
    from: { net, sell: net }, customers: [], preview: true, previewMarkup, calcAction: `/admin/packages/${pkg.id}/preview`,
  });
}));

router.post('/packages/:id/delete', h((req, res) => {
  run('DELETE FROM packages WHERE id = ?', num(req.params.id));
  req.flash('success', 'Package deleted. Existing quotes keep their copy of the package.');
  res.redirect('/admin/packages');
}));

// ---------- bookings ----------

router.get('/bookings', h((req, res) => {
  const status = ['confirmed', 'cancel_requested', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const bookings = all(
    `SELECT b.*, a.name AS agency_name, c.name AS customer_name FROM bookings b JOIN agencies a ON a.id = b.agency_id
     LEFT JOIN customers c ON c.id = b.customer_id ${status ? 'WHERE b.status = ?' : ''} ORDER BY b.id DESC`, ...(status ? [status] : []),
  );
  res.page('admin/bookings', { title: 'Bookings', bookings, status });
}));

router.get('/bookings/:id', h((req, res, next) => {
  const booking = one('SELECT b.*, a.name AS agency_name FROM bookings b JOIN agencies a ON a.id = b.agency_id WHERE b.id = ?', num(req.params.id));
  if (!booking) return next();
  const full = booking.quote_id ? svc.getQuote(booking.quote_id) : null;
  const invoices = all('SELECT * FROM invoices WHERE booking_id = ? OR (quote_id = ? AND quote_id IS NOT NULL) ORDER BY id DESC', booking.id, booking.quote_id);
  res.page('admin/booking', { title: `Booking ${booking.code}`, booking, full, invoices });
}));

router.post('/bookings/:id/cancel', h((req, res) => {
  const id = num(req.params.id);
  svc.approveCancellation(id, Math.max(0, num(req.body.refund, 0)));
  req.flash('success', 'Booking cancelled and refund credited to the agent.');
  res.redirect(`/admin/bookings/${id}`);
}));

router.post('/bookings/:id/reject-cancel', h((req, res) => {
  const id = num(req.params.id);
  const b = one('SELECT * FROM bookings WHERE id = ?', id);
  run("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'cancel_requested'", id);
  notify(b.agency_id, 'Cancellation declined', `${b.code}: ${str(req.body.reason) || 'non-refundable as per supplier policy.'}`, `/agent/bookings/${id}`);
  req.flash('success', 'Cancellation request declined.');
  res.redirect(`/admin/bookings/${id}`);
}));

// ---------- wallet top-ups ----------

router.get('/topups', h((req, res) => {
  const requests = all('SELECT t.*, a.name AS agency_name, a.wallet_balance FROM topup_requests t JOIN agencies a ON a.id = t.agency_id ORDER BY t.status = \'pending\' DESC, t.id DESC');
  res.page('admin/topups', { title: 'Top-up requests', requests });
}));

router.post('/topups/:id/approve', h((req, res) => {
  svc.approveTopup(num(req.params.id));
  req.flash('success', 'Top-up approved and wallet credited.');
  res.redirect('/admin/topups');
}));

router.post('/topups/:id/reject', h((req, res) => {
  const r = one("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending'", num(req.params.id));
  if (r) {
    run("UPDATE topup_requests SET status = 'rejected' WHERE id = ?", r.id);
    notify(r.agency_id, 'Top-up not verified', `We couldn't verify your ₹${r.amount.toLocaleString('en-IN')} payment. Contact support with the UTR.`, '/agent/wallet');
  }
  res.redirect('/admin/topups');
}));

// ---------- invoices, notifications, settings ----------

router.get('/invoices', h((req, res) => {
  const kind = ['b2b', 'customer_vaayu', 'customer_agent'].includes(req.query.kind) ? req.query.kind : '';
  const invoices = all(
    `SELECT i.*, a.name AS agency_name FROM invoices i JOIN agencies a ON a.id = i.agency_id ${kind ? 'WHERE i.kind = ?' : ''} ORDER BY i.id DESC`, ...(kind ? [kind] : []),
  ).map((i) => ({ ...i, doc: JSON.parse(i.data) }));
  res.page('admin/invoices', { title: 'Invoices', invoices, kind });
}));

router.get('/invoices/:id', h((req, res, next) => {
  const inv = one('SELECT * FROM invoices WHERE id = ?', num(req.params.id));
  if (!inv) return next();
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, doc: JSON.parse(inv.data), back: '/admin/invoices' }, 'doc');
}));

router.get('/notifications', h((req, res) => {
  const items = all('SELECT * FROM notifications WHERE agency_id IS NULL ORDER BY id DESC LIMIT 100');
  run('UPDATE notifications SET is_read = 1 WHERE agency_id IS NULL');
  res.locals.unread = 0;
  res.page('agent/notifications', { title: 'Notifications', items });
}));

const SETTING_KEYS = ['company_name', 'legal_name', 'gstin', 'address', 'phone', 'email', 'tax_rate', 'tcs_rate', 'emi_rate'];

router.get('/settings', (req, res) => {
  res.page('admin/settings', { title: 'Settings', keys: SETTING_KEYS, values: getSettings() });
});

router.post('/settings', h((req, res) => {
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) setSetting(k, str(req.body[k]));
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

module.exports = router;
