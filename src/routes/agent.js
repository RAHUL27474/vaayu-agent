const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, getSettings, notify, UPLOADS_DIR } = require('../db');
const { num, code, round2, uniqueSlug } = require('../util');
const { requireAgent, requireActiveAgency, h } = require('../auth');
const svc = require('../services');
const { priceQuote, emiPlans, agencyHasBranding, withTax } = require('../pricing');
const inventory = require('../inventory');
const {
  MEAL_PLANS, STAY_TYPES, EXTRA_TYPES, emptyDetails, parseDetails, detailsFromForm, calcPackage, priceLines, fromPrice, publishProblems, present,
} = require('../packages');
const {
  CATEGORIES: ACTIVITY_CATEGORIES, activityLines, activityMap, netPerPerson, sellPerPerson, isInternational, published: publishedActivity,
} = require('../activities');
const { withCover, coverFrom } = require('../photos');
const { COUNTRIES, withTaxDoc, checkTax, removeDoc } = require('../kyc');

const router = express.Router();
router.use(requireAgent);

const LOGO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    // Extension comes from the checked MIME type, never from the uploaded filename.
    filename: (req, file, cb) => cb(null, `${req.agency.slug}-logo-${Date.now()}${LOGO_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  // SVG is excluded on purpose: uploaded SVGs can carry scripts.
  fileFilter: (req, file, cb) => {
    const ok = Boolean(LOGO_TYPES[file.mimetype]);
    if (!ok) req.logoRejected = true;
    cb(null, ok);
  },
});

const openQuotes = (agencyId) => all("SELECT id, code, title FROM quotes WHERE agency_id = ? AND status IN ('draft', 'sent', 'accepted') ORDER BY updated_at DESC LIMIT 30", agencyId);
const customersOf = (agencyId) => all('SELECT id, name FROM customers WHERE agency_id = ? ORDER BY name', agencyId);
const str = (v) => String(v ?? '').trim();

function ownQuote(req) {
  const full = svc.getQuote(num(req.params.id), req.agency.id);
  if (!full) throw new svc.AppError('Quote not found');
  return full;
}

function assertEditable(quote) {
  if (['booked', 'cancelled'].includes(quote.status)) throw new svc.AppError('This quote is booked; its items can no longer be changed.');
}

// ---------- dashboard ----------

router.get('/', h((req, res) => {
  const a = req.agency.id;
  const month = new Date().toISOString().slice(0, 7);
  const stats = one(
    `SELECT COUNT(*) AS bookings, COALESCE(SUM(total_sell), 0) AS sales, COALESCE(SUM(total_sell - total_net - total_cost), 0) AS earnings
     FROM bookings WHERE agency_id = ? AND status != 'cancelled' AND substr(created_at, 1, 7) = ?`, a, month,
  );
  const openLeads = one("SELECT COUNT(*) AS n FROM leads WHERE agency_id = ? AND status IN ('new', 'contacted')", a).n;
  const quotes = all('SELECT * FROM quotes WHERE agency_id = ? ORDER BY updated_at DESC LIMIT 5', a);
  const bookings = all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 5', a);
  const leads = all("SELECT * FROM leads WHERE agency_id = ? AND status = 'new' ORDER BY id DESC LIMIT 5", a);
  const upcoming = all("SELECT * FROM bookings WHERE agency_id = ? AND status = 'confirmed' AND travel_date >= date('now') ORDER BY travel_date LIMIT 5", a);
  const featured = all("SELECT * FROM activities WHERE status = 'published' ORDER BY created_at DESC, id DESC LIMIT 4").map((x) => ({ ...x, net: netPerPerson(x), sell: sellPerPerson(req.agency, x) }));
  const hasPackage = Boolean(one('SELECT 1 FROM packages WHERE agency_id = ?', a));
  const branded = agencyHasBranding(req.agency);
  // Last 6 calendar months, oldest first, including months without bookings.
  const earned = Object.fromEntries(all(
    `SELECT substr(created_at, 1, 7) AS month, SUM(total_sell - total_net - total_cost) AS earnings, COUNT(*) AS n FROM bookings
     WHERE agency_id = ? AND status != 'cancelled' AND created_at >= date('now', 'start of month', '-5 months') GROUP BY month`, a,
  ).map((m) => [m.month, m]));
  const chart = [...Array(6)].map((_, i) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 5 + i);
    const m = earned[d.toISOString().slice(0, 7)];
    return { label: d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }), value: m ? m.earnings : 0, note: m ? `${m.n} booking${m.n === 1 ? '' : 's'}` : 'no bookings' };
  });
  const hasQuote = quotes.length > 0;
  const hasBooking = bookings.length > 0;
  const checklist = [
    { done: Boolean(req.agency.tax_doc), label: 'Upload your tax registration', href: '/agent/settings#tax' },
    { done: req.agency.status === 'active', label: 'Get approved by VaayuTrip', href: '/agent/support' },
    { done: branded, label: 'Add your logo for branded invoices', href: '/agent/settings' },
    { done: hasPackage, label: 'Build your first package from our activities', href: '/agent/packages/new' },
    { done: hasQuote, label: 'Send your first quote', href: '/agent/packages' },
    { done: hasBooking, label: 'Make your first booking', href: '/agent/quotes' },
  ];
  res.page('agent/dashboard', { title: 'Dashboard', stats, openLeads, quotes, bookings, leads, upcoming, featured, branded, chart, checklist, offers: liveOffers(2) });
}));

// ---------- activities from VaayuTrip ----------

// Party for activity prices (query string or form body).
const partyOf = (src) => ({ adults: Math.max(1, Math.round(num(src.adults, 2))), children: Math.max(0, Math.round(num(src.children, 0))) });
const ownPackages = (agencyId) => all('SELECT id, title, nights, destination FROM packages WHERE agency_id = ? ORDER BY updated_at DESC', agencyId);
const withPrices = (agency) => (a) => ({ ...a, net: netPerPerson(a), sell: sellPerPerson(agency, a) });

router.get('/activities', h((req, res) => {
  const f = {
    q: str(req.query.q),
    city: str(req.query.city),
    category: ACTIVITY_CATEGORIES.includes(req.query.category) ? req.query.category : '',
    region: ['india', 'abroad'].includes(req.query.region) ? req.query.region : '',
  };
  const where = [["status = 'published'"]];
  if (f.q) where.push(['(title LIKE ? OR city LIKE ? OR country LIKE ? OR summary LIKE ?)', ...Array(4).fill(`%${f.q}%`)]);
  if (f.city) where.push(['city = ?', f.city]);
  if (f.category) where.push(['category = ?', f.category]);
  if (f.region) where.push([f.region === 'india' ? "country = 'India'" : "country != 'India'"]);
  const activities = all(
    `SELECT * FROM activities WHERE ${where.map(([c]) => c).join(' AND ')} ORDER BY country != 'India', city, title`,
    ...where.flatMap(([, ...p]) => p),
  ).map(withPrices(req.agency));
  const cities = all("SELECT city, country, COUNT(*) AS n FROM activities WHERE status = 'published' GROUP BY city, country ORDER BY country != 'India', city");
  res.page('agent/activities', { title: 'Activities', activities, cities, categories: ACTIVITY_CATEGORIES, f });
}));

router.get('/activities/:id', h((req, res, next) => {
  const a = publishedActivity(num(req.params.id));
  if (!a) return next();
  const party = partyOf(req.query);
  const lines = activityLines(a, party).map((l) => ({ ...l, supplier: 'vaayu', sell: null }));
  const more = all("SELECT * FROM activities WHERE status = 'published' AND city = ? AND id != ? ORDER BY title LIMIT 4", a.city, a.id).map(withPrices(req.agency));
  res.page('agent/activity', {
    title: a.title, a: withPrices(req.agency)(a), party, lines, priced: priceLines(req.agency, lines), more,
    quotes: openQuotes(req.agency.id), packages: ownPackages(req.agency.id), customers: customersOf(req.agency.id),
  });
}));

router.post('/activities/:id/quote', h((req, res, next) => {
  const a = publishedActivity(num(req.params.id));
  if (!a) return next();
  const party = partyOf(req.body);
  let quoteId = num(req.body.quote_id, 0);
  if (quoteId) {
    const q = one('SELECT status FROM quotes WHERE id = ? AND agency_id = ?', quoteId, req.agency.id);
    if (!q) throw new svc.AppError('Quote not found');
    assertEditable(q);
  } else {
    const customerId = num(req.body.customer_id, 0);
    quoteId = svc.createQuote(req.agency, {
      title: str(req.body.new_title) || a.title, ...party, travelDate: str(req.body.date) || null,
      customerId: customerId && one('SELECT 1 FROM customers WHERE id = ? AND agency_id = ?', customerId, req.agency.id) ? customerId : null,
    });
  }
  svc.addActivityToQuote(quoteId, a, party);
  req.flash('success', `${a.title} added to the quote.`);
  res.redirect(`/agent/quotes/${quoteId}#items`);
}));

router.post('/activities/:id/add-to-package', h((req, res, next) => {
  const a = publishedActivity(num(req.params.id));
  if (!a) return next();
  const day = Math.max(1, Math.min(60, Math.round(num(req.body.day, 1))));
  let pkg = num(req.body.package_id, 0) ? ownPackage(req, num(req.body.package_id)) : null;
  if (req.body.package_id && req.body.package_id !== 'new' && !pkg) throw new svc.AppError('Package not found');
  if (!pkg) {
    const id = insertPackage(req.agency, {
      title: `${a.city} holiday`, destination: a.city, nights: Math.max(3, day - 1), is_international: isInternational(a) ? 1 : 0,
    }, newPackageDetails());
    pkg = ownPackage(req, id);
  }
  const d = parseDetails(pkg.details);
  d.activities.push({ day, id: a.id, title: a.title });
  d.activities.sort((x, y) => x.day - y.day);
  while (d.days.length < day) d.days.push({ title: `Day ${d.days.length + 1}`, description: '', meals: { b: false, l: false, d: false }, overnight: '' });
  run(
    "UPDATE packages SET details = ?, is_international = MAX(is_international, ?), updated_at = datetime('now') WHERE id = ?",
    JSON.stringify(d), isInternational(a) ? 1 : 0, pkg.id,
  );
  req.flash('success', `${a.title} added to day ${day} of ${pkg.title}. Fill in the rest of the package and save.`);
  res.redirect(`/agent/packages/${pkg.id}/edit#activities`);
}));

// ---------- my packages (built by the agency from activities + its own services) ----------

const PKG_CORE = ['title', 'destination', 'nights', 'theme', 'summary', 'inclusions', 'exclusions', 'image_url', 'is_international', 'departure_city'];

function ownPackage(req, id) {
  return one('SELECT * FROM packages WHERE id = ? AND agency_id = ?', id, req.agency.id);
}

function insertPackage(agency, core, details) {
  const row = { nights: 3, is_international: 0, ...core };
  return run(
    `INSERT INTO packages (${PKG_CORE.join(', ')}, details, slug, agency_id, status) VALUES (${PKG_CORE.map(() => '?').join(', ')}, ?, ?, ?, 'draft')`,
    ...PKG_CORE.map((k) => row[k] ?? null), JSON.stringify(details), uniqueSlug('packages', row.title), agency.id,
  ).lastInsertRowid;
}

function newPackageDetails() {
  const d = emptyDetails();
  d.days = [{ title: 'Arrival', description: '', meals: { b: false, l: false, d: true }, overnight: '' }];
  d.policies.cancellation = [{ days: 30, percent: 10 }, { days: 15, percent: 25 }, { days: 7, percent: 50 }, { days: 0, percent: 100 }];
  d.policies.child = 'Infants below 2 years travel free. Children 2–11 years pay the child price for activities. 12 years and above: adult price.';
  d.policies.notes = 'Hotel check-in 14:00, check-out 11:00. Valid government photo ID required for all travellers. Activity timings may change with weather and local conditions.';
  return d;
}

// Every published activity, for the builder's pickers and for validating the form.
const activityCatalogue = () => new Map(all("SELECT * FROM activities WHERE status = 'published' ORDER BY country != 'India', city, title").map((a) => [a.id, a]));

function packageCore(b, d, catalogue) {
  const routeNights = d.route.reduce((s, r) => s + r.nights, 0);
  return {
    title: str(b.title),
    destination: str(b.destination),
    nights: routeNights || Math.max(1, Math.round(num(b.nights, 1))),
    theme: str(b.theme) || null,
    summary: str(b.summary) || null,
    inclusions: str(b.inclusions) || null,
    exclusions: str(b.exclusions) || null,
    // International when ticked or when any activity is outside India (TCS applies on customer invoices).
    is_international: b.is_international || d.activities.some((x) => isInternational(catalogue.get(x.id))) ? 1 : 0,
    departure_city: str(b.departure_city) || null,
  };
}

function builderData(req, pkg, details) {
  const catalogue = activityCatalogue();
  return {
    pkg, d: details, catalogue: [...catalogue.values()].map(withPrices(req.agency)), mealPlans: MEAL_PLANS, stayTypes: STAY_TYPES, extraTypes: EXTRA_TYPES,
    problems: pkg.id ? publishProblems(pkg, details) : [],
    from: pkg.id ? fromPrice(req.agency, pkg, details) : null,
  };
}

router.get('/packages', h((req, res) => {
  const packages = all(
    'SELECT p.*, (SELECT COUNT(*) FROM quotes q WHERE q.package_id = p.id) AS quotes FROM packages p WHERE p.agency_id = ? ORDER BY p.updated_at DESC', req.agency.id,
  ).map((p) => {
    const d = parseDetails(p.details);
    return { ...p, price: fromPrice(req.agency, p, d), activities: d.activities.length, problems: publishProblems(p, d) };
  });
  res.page('agent/packages', { title: 'My packages', packages });
}));

router.get('/packages/new', h((req, res) => {
  const destination = str(req.query.destination);
  res.page('agent/package-form', { title: 'New package', ...builderData(req, { nights: 3, status: 'draft', destination, title: '' }, newPackageDetails()) });
}));

router.post('/packages', withCover(svc.AppError), h((req, res) => {
  const catalogue = activityCatalogue();
  const details = detailsFromForm(req.body, catalogue);
  const core = { ...packageCore(req.body, details, catalogue), image_url: coverFrom(req, null) };
  if (!core.title || !core.destination) throw new svc.AppError('Give the package a name and destination.');
  const id = insertPackage(req.agency, core, details);
  req.flash('success', 'Package saved. Price it for a customer below, or publish it to your website.');
  res.redirect(`/agent/packages/${id}`);
}));

// Package page with a price calculator: the form re-submits to this page with GET.
router.get('/packages/:id', h((req, res, next) => {
  const pkg = ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  const acts = activityMap(details.activities.map((a) => a.id));
  const calc = calcPackage(pkg, details, req.query, acts);
  res.page('agent/package', {
    title: pkg.title, pkg, details, calc, priced: priceLines(req.agency, calc.lines),
    view: present(pkg, details, acts), from: fromPrice(req.agency, pkg, details, acts),
    problems: publishProblems(pkg, details), customers: customersOf(req.agency.id),
    // The agent's own website only serves active agencies with the site switched on.
    siteUrl: pkg.status === 'published' && req.agency.status === 'active' && req.agency.website_enabled
      ? `${req.protocol}://${req.get('host')}/site/${req.agency.slug}/p/${pkg.slug}` : null,
  });
}));

router.get('/packages/:id/edit', h((req, res, next) => {
  const pkg = ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  res.page('agent/package-form', { title: `Edit ${pkg.title}`, ...builderData(req, pkg, parseDetails(pkg.details)) });
}));

router.post('/packages/:id', withCover(svc.AppError), h((req, res, next) => {
  const pkg = ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const catalogue = activityCatalogue();
  const details = detailsFromForm(req.body, catalogue);
  const core = { ...packageCore(req.body, details, catalogue), image_url: coverFrom(req, pkg.image_url) };
  if (!core.title || !core.destination) throw new svc.AppError('Give the package a name and destination.');
  run(
    `UPDATE packages SET ${PKG_CORE.map((k) => `${k} = ?`).join(', ')}, details = ?, updated_at = datetime('now') WHERE id = ?`,
    ...PKG_CORE.map((k) => core[k]), JSON.stringify(details), pkg.id,
  );
  const problems = publishProblems(core, details);
  if (pkg.status === 'published' && problems.length) {
    run("UPDATE packages SET status = 'draft' WHERE id = ?", pkg.id);
    req.flash('warn', `Package taken off your website: ${problems[0]}`);
  } else {
    req.flash('success', 'Package saved.');
  }
  res.redirect(`/agent/packages/${pkg.id}`);
}));

router.post('/packages/:id/status', h((req, res, next) => {
  const pkg = ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = publishProblems(pkg, parseDetails(pkg.details));
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  run("UPDATE packages SET status = ?, updated_at = datetime('now') WHERE id = ?", status, pkg.id);
  req.flash('success', status === 'published' ? 'Published: the package is live on your website and API.' : 'Unpublished: the package is hidden from your website and API.');
  res.redirect(`/agent/packages/${pkg.id}`);
}));

router.post('/packages/:id/duplicate', h((req, res, next) => {
  const pkg = ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const id = insertPackage(req.agency, { ...pkg, title: `${pkg.title} (copy)` }, parseDetails(pkg.details));
  req.flash('success', 'Copy created as a draft.');
  res.redirect(`/agent/packages/${id}/edit`);
}));

router.post('/packages/:id/delete', h((req, res) => {
  run('DELETE FROM packages WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  req.flash('success', 'Package deleted. Quotes made from it keep their copy.');
  res.redirect('/agent/packages');
}));

router.post('/packages/:id/quote', h((req, res) => {
  const customerId = num(req.body.customer_id, 0);
  const quoteId = svc.createQuoteFromPackage(req.agency, num(req.params.id), {
    adults: req.body.adults, children: req.body.children, rooms: req.body.rooms, date: str(req.body.date),
    title: str(req.body.title) || undefined,
    customerId: customerId && one('SELECT 1 FROM customers WHERE id = ? AND agency_id = ?', customerId, req.agency.id) ? customerId : null,
  });
  req.flash('success', 'Quote created from your package. Adjust prices and items, then share it with your customer.');
  res.redirect(`/agent/quotes/${quoteId}`);
}));

// ---------- search: flights, hotels, transfers, insurance ----------

const SEARCHES = {
  flights: { fn: inventory.searchFlights, keys: ['from', 'to', 'date', 'adults', 'children'], title: 'Flights' },
  hotels: { fn: inventory.searchHotels, keys: ['city', 'checkin', 'nights', 'rooms'], title: 'Hotels' },
  transfers: { fn: inventory.searchTransfers, keys: ['city', 'kind', 'pax'], title: 'Transfers & cabs' },
  insurance: { fn: inventory.insurancePlans, keys: ['days', 'travellers', 'region'], title: 'Travel insurance' },
};

// Turns a search result into a quote line. Prices are always recomputed on the server.
function resultToItem(kind, r) {
  if (kind === 'flights') {
    return { type: 'flight', title: `${r.airline} ${r.flightNo}: ${r.fromCity} → ${r.toCity}`, description: `${r.date || ''} ${r.depart}–${r.arrive}, ${r.stops ? '1 stop' : 'non-stop'}, ${r.baggage}, ${r.pax} pax${r.refundable ? ', refundable' : ''}`.trim(), net: r.net };
  }
  if (kind === 'hotels') {
    return { type: 'hotel', title: `${r.name}, ${r.city} — ${r.nights} night${r.nights > 1 ? 's' : ''}`, description: `${r.stars}★ ${r.roomType}, ${r.meal}, ${r.rooms} room${r.rooms > 1 ? 's' : ''}${r.checkin ? `, check-in ${r.checkin}` : ''}`, net: r.net };
  }
  if (kind === 'transfers') return { type: 'transfer', title: r.title, description: `${r.city}, up to ${r.seats} passengers`, net: r.net };
  return { type: 'insurance', title: r.title, description: `${r.cover}; ${r.travellers} traveller${r.travellers > 1 ? 's' : ''}, ${r.days} days`, net: r.net };
}

for (const [kind, cfg] of Object.entries(SEARCHES)) {
  router.get(`/${kind}`, h((req, res) => {
    const params = Object.fromEntries(cfg.keys.map((k) => [k, str(req.query[k])]));
    const searched = cfg.keys.some((k) => req.query[k]);
    const results = searched ? cfg.fn(params) : [];
    res.page(`agent/search-${kind}`, { title: cfg.title, kind, params, searched, results, quotes: openQuotes(req.agency.id), cities: inventory.CITIES, agencyMarkup: req.agency });
  }));
}

router.post('/quotes/add-item', h((req, res) => {
  const cfg = SEARCHES[req.body.kind];
  if (!cfg) throw new svc.AppError('Unknown item');
  const params = Object.fromEntries(cfg.keys.map((k) => [k, str(req.body[`p_${k}`])]));
  const result = cfg.fn(params).find((r) => r.id === req.body.result_id);
  if (!result) throw new svc.AppError('That option is no longer available; search again.');

  let quoteId = num(req.body.quote_id, 0);
  if (quoteId && !one('SELECT 1 FROM quotes WHERE id = ? AND agency_id = ?', quoteId, req.agency.id)) throw new svc.AppError('Quote not found');
  if (quoteId) assertEditable(one('SELECT status FROM quotes WHERE id = ?', quoteId));
  if (!quoteId) quoteId = svc.createQuote(req.agency, { title: str(req.body.new_title) || `${cfg.title} quote` });
  svc.addQuoteItem(quoteId, resultToItem(req.body.kind, result));
  req.flash('success', 'Added to quote.');
  res.redirect(`/agent/quotes/${quoteId}`);
}));

// ---------- quotes ----------

router.get('/quotes', h((req, res) => {
  const status = str(req.query.status);
  const quotes = all(
    `SELECT q.*, c.name AS customer_name FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.agency_id = ? ${status ? 'AND q.status = ?' : ''} ORDER BY q.updated_at DESC`,
    req.agency.id, ...(status ? [status] : []),
  ).map((q) => ({ ...q, priced: priceQuote(q, all('SELECT * FROM quote_items WHERE quote_id = ?', q.id)) }));
  res.page('agent/quotes', { title: 'Quotes', quotes, status, customers: customersOf(req.agency.id) });
}));

router.post('/quotes', h((req, res) => {
  const id = svc.createQuote(req.agency, {
    title: str(req.body.title) || 'New quote',
    customerId: num(req.body.customer_id, 0) || null,
    travelDate: str(req.body.travel_date) || null,
  });
  res.redirect(`/agent/quotes/${id}`);
}));

router.get('/quotes/:id', h((req, res) => {
  const full = ownQuote(req);
  const settings = getSettings();
  const invoices = all('SELECT * FROM invoices WHERE quote_id = ? ORDER BY id DESC', full.quote.id);
  const links = all('SELECT * FROM payment_links WHERE quote_id = ? ORDER BY id DESC', full.quote.id);
  const booking = one('SELECT * FROM bookings WHERE quote_id = ? ORDER BY id DESC', full.quote.id);
  const customerTotal = withTax(full.priced.sell, settings, { international: Boolean(full.quote.is_international) });
  const netPayable = withTax(full.priced.net, settings);
  res.page('agent/quote', {
    title: full.quote.title, ...full, invoices, links, booking, customerTotal, netPayable,
    customers: customersOf(req.agency.id), branded: agencyHasBranding(req.agency),
    pkgView: full.quote.package_snapshot ? JSON.parse(full.quote.package_snapshot) : null,
    emi: emiPlans(customerTotal.total, settings), shareUrl: `${req.protocol}://${req.get('host')}/q/${full.quote.code}`,
  });
}));

router.post('/quotes/:id', h((req, res) => {
  const { quote } = ownQuote(req);
  const b = req.body;
  let mode = b.invoice_mode === 'agent' ? 'agent' : 'vaayu';
  if (mode === 'agent' && !agencyHasBranding(req.agency)) {
    mode = 'vaayu';
    req.flash('warn', 'Upload your logo in Company & branding to use your own invoice. Using the VaayuTrip invoice for now.');
  }
  const locked = ['booked', 'cancelled'].includes(quote.status);
  run(
    `UPDATE quotes SET title = ?, customer_id = ?, travel_date = ?, adults = ?, children = ?, notes = ?, invoice_mode = ?, show_service_fee = ?, emi_enabled = ?,
       markup_type = ?, markup_value = ?, updated_at = datetime('now') WHERE id = ?`,
    str(b.title) || quote.title, num(b.customer_id, 0) || null, str(b.travel_date) || null, Math.max(1, num(b.adults, 1)), Math.max(0, num(b.children, 0)),
    str(b.notes) || null, mode, b.show_service_fee ? 1 : 0, b.emi_enabled ? 1 : 0,
    locked ? quote.markup_type : b.markup_type === 'flat' ? 'flat' : 'percent', locked ? quote.markup_value : Math.max(0, num(b.markup_value, 0)), quote.id,
  );
  req.flash('success', 'Quote saved.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

// Bulk update of line prices and quantities from the quote editor table.
router.post('/quotes/:id/items', h((req, res) => {
  const { quote, items } = ownQuote(req);
  assertEditable(quote);
  tx(() => {
    for (const it of items) {
      const sell = str(req.body[`sell_${it.id}`]);
      const qty = Math.max(1, Math.round(num(req.body[`qty_${it.id}`], it.qty)));
      const sellPrice = sell === '' ? null : Math.max(0, num(sell, 0));
      if (it.supplier === 'vaayu' && sellPrice !== null && sellPrice < it.net_price) {
        throw new svc.AppError(`"${it.title}": your price can't be below the VaayuTrip net price.`);
      }
      run('UPDATE quote_items SET sell_price = ?, qty = ? WHERE id = ?', it.supplier === 'agent' ? (sellPrice ?? it.sell_price ?? 0) : sellPrice, qty, it.id);
    }
    run("UPDATE quotes SET updated_at = datetime('now') WHERE id = ?", quote.id);
  });
  req.flash('success', 'Prices updated.');
  res.redirect(`/agent/quotes/${quote.id}#items`);
}));

router.post('/quotes/:id/items/custom', h((req, res) => {
  const { quote } = ownQuote(req);
  assertEditable(quote);
  const title = str(req.body.title);
  if (!title) throw new svc.AppError('Give the item a name.');
  svc.addQuoteItem(quote.id, {
    type: str(req.body.type) || 'other', title, description: str(req.body.description), supplier: 'agent',
    net: 0, sell: Math.max(0, num(req.body.price, 0)), cost: Math.max(0, num(req.body.cost, 0)), qty: Math.max(1, num(req.body.qty, 1)),
  });
  req.flash('success', 'Your own service was added. It appears on your branded invoice.');
  res.redirect(`/agent/quotes/${quote.id}#items`);
}));

router.post('/quotes/:id/items/:itemId/delete', h((req, res) => {
  const { quote } = ownQuote(req);
  assertEditable(quote);
  run('DELETE FROM quote_items WHERE id = ? AND quote_id = ?', num(req.params.itemId), quote.id);
  res.redirect(`/agent/quotes/${quote.id}#items`);
}));

router.post('/quotes/:id/send', h((req, res) => {
  const { quote, items } = ownQuote(req);
  if (!items.length) throw new svc.AppError('Add items before sharing the quote.');
  if (quote.status === 'draft') run("UPDATE quotes SET status = 'sent', updated_at = datetime('now') WHERE id = ?", quote.id);
  req.flash('success', 'Quote marked as sent. Share the link below with your customer.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

router.post('/quotes/:id/book', requireActiveAgency, h((req, res) => {
  const { quote } = ownQuote(req);
  const bookingId = svc.bookQuote(req.agency.id, quote.id);
  req.flash('success', 'Booking confirmed! VaayuTrip has been paid from your wallet/credit.');
  res.redirect(`/agent/bookings/${bookingId}`);
}));

router.post('/quotes/:id/invoice', requireActiveAgency, h((req, res) => {
  const { quote } = ownQuote(req);
  const kind = quote.invoice_mode === 'agent' ? 'customer_agent' : 'customer_vaayu';
  const booking = one('SELECT id FROM bookings WHERE quote_id = ? ORDER BY id DESC', quote.id);
  const id = svc.issueInvoice(req.agency, quote.id, kind, booking?.id || null);
  req.flash('success', 'Invoice issued. Print it, save as PDF, or share the link with your customer.');
  res.redirect(`/agent/invoices/${id}`);
}));

router.post('/quotes/:id/payment-link', requireActiveAgency, h((req, res) => {
  const { quote, customer, priced } = ownQuote(req);
  const total = withTax(priced.sell, getSettings(), { international: Boolean(quote.is_international) }).total;
  const amount = round2(num(req.body.amount, total));
  if (amount <= 0) throw new svc.AppError('Enter an amount.');
  run(
    'INSERT INTO payment_links (agency_id, quote_id, code, purpose, amount, customer_name) VALUES (?, ?, ?, ?, ?, ?)',
    req.agency.id, quote.id, code('PAY'), quote.title, amount, customer?.name || null,
  );
  req.flash('success', 'Payment link created.');
  res.redirect(`/agent/quotes/${quote.id}#share`);
}));

router.post('/quotes/:id/delete', h((req, res) => {
  const { quote } = ownQuote(req);
  if (quote.status === 'booked') throw new svc.AppError('Booked quotes cannot be deleted.');
  run('DELETE FROM quotes WHERE id = ?', quote.id);
  req.flash('success', 'Quote deleted.');
  res.redirect('/agent/quotes');
}));

// ---------- bookings ----------

router.get('/bookings', h((req, res) => {
  const bookings = all(
    'SELECT b.*, c.name AS customer_name FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id WHERE b.agency_id = ? ORDER BY b.id DESC',
    req.agency.id,
  );
  res.page('agent/bookings', { title: 'Bookings', bookings });
}));

router.get('/bookings/:id', h((req, res, next) => {
  const booking = one('SELECT * FROM bookings WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!booking) return next();
  const full = booking.quote_id ? svc.getQuote(booking.quote_id, req.agency.id) : null;
  const invoices = all('SELECT * FROM invoices WHERE booking_id = ? OR (quote_id = ? AND quote_id IS NOT NULL) ORDER BY id DESC', booking.id, booking.quote_id);
  res.page('agent/booking', { title: `Booking ${booking.code}`, booking, full, invoices });
}));

router.post('/bookings/:id/cancel', h((req, res, next) => {
  const booking = one("SELECT * FROM bookings WHERE id = ? AND agency_id = ? AND status = 'confirmed'", num(req.params.id), req.agency.id);
  if (!booking) return next();
  run("UPDATE bookings SET status = 'cancel_requested', cancel_reason = ? WHERE id = ?", str(req.body.reason) || 'Customer request', booking.id);
  notify(null, 'Cancellation request', `${req.agency.name} requested cancellation of ${booking.code}.`, `/admin/bookings/${booking.id}`);
  req.flash('success', 'Cancellation requested. VaayuTrip will confirm the refund amount.');
  res.redirect(`/agent/bookings/${booking.id}`);
}));

// ---------- customers ----------

router.get('/customers', h((req, res) => {
  const q = str(req.query.q);
  const customers = all(
    `SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) AS trips,
       (SELECT COALESCE(SUM(total_sell), 0) FROM bookings b WHERE b.customer_id = c.id AND b.status != 'cancelled') AS spend
     FROM customers c WHERE c.agency_id = ? ${q ? 'AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)' : ''} ORDER BY c.name`,
    req.agency.id, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []),
  );
  res.page('agent/customers', { title: 'Customers', customers, q });
}));

router.post('/customers', h((req, res) => {
  const name = str(req.body.name);
  if (!name) throw new svc.AppError('Customer name is required.');
  const id = run('INSERT INTO customers (agency_id, name, email, phone, city, notes) VALUES (?, ?, ?, ?, ?, ?)',
    req.agency.id, name, str(req.body.email) || null, str(req.body.phone) || null, str(req.body.city) || null, str(req.body.notes) || null).lastInsertRowid;
  req.flash('success', 'Customer added.');
  res.redirect(`/agent/customers/${id}`);
}));

router.get('/customers/:id', h((req, res, next) => {
  const customer = one('SELECT * FROM customers WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!customer) return next();
  const quotes = all('SELECT * FROM quotes WHERE customer_id = ? ORDER BY id DESC', customer.id);
  const bookings = all('SELECT * FROM bookings WHERE customer_id = ? ORDER BY id DESC', customer.id);
  const leads = all('SELECT * FROM leads WHERE customer_id = ? ORDER BY id DESC', customer.id);
  res.page('agent/customer', { title: customer.name, customer, quotes, bookings, leads });
}));

router.post('/customers/:id', h((req, res) => {
  const id = num(req.params.id);
  run('UPDATE customers SET name = ?, email = ?, phone = ?, city = ?, notes = ? WHERE id = ? AND agency_id = ?',
    str(req.body.name) || 'Customer', str(req.body.email) || null, str(req.body.phone) || null, str(req.body.city) || null, str(req.body.notes) || null, id, req.agency.id);
  req.flash('success', 'Customer updated.');
  res.redirect(`/agent/customers/${id}`);
}));

// ---------- leads ----------

const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

router.get('/leads', h((req, res) => {
  const status = LEAD_STATUSES.includes(req.query.status) ? req.query.status : '';
  const leads = all(
    `SELECT l.*, p.title AS package_title FROM leads l LEFT JOIN packages p ON p.id = l.package_id
     WHERE l.agency_id = ? ${status ? 'AND l.status = ?' : ''} ORDER BY l.id DESC`, req.agency.id, ...(status ? [status] : []),
  );
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM leads WHERE agency_id = ? GROUP BY status', req.agency.id).map((r) => [r.status, r.n]));
  res.page('agent/leads', { title: 'Leads', leads, status, counts, statuses: LEAD_STATUSES, packages: ownPackages(req.agency.id) });
}));

router.post('/leads', h((req, res) => {
  const name = str(req.body.name);
  if (!name) throw new svc.AppError('Lead name is required.');
  run('INSERT INTO leads (agency_id, name, phone, email, destination, travel_date, pax, budget, package_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.agency.id, name, str(req.body.phone) || null, str(req.body.email) || null, str(req.body.destination) || null, str(req.body.travel_date) || null,
    num(req.body.pax, 0) || null, num(req.body.budget, 0) || null, ownPackage(req, num(req.body.package_id, 0))?.id || null, str(req.body.notes) || null);
  req.flash('success', 'Lead added.');
  res.redirect('/agent/leads');
}));

router.post('/leads/:id/status', h((req, res) => {
  if (LEAD_STATUSES.includes(req.body.status)) {
    run('UPDATE leads SET status = ? WHERE id = ? AND agency_id = ?', req.body.status, num(req.params.id), req.agency.id);
  }
  res.redirect(req.get('referer') || '/agent/leads');
}));

// Converts a lead into a customer (if needed) and a quote, prefilled from its package.
router.post('/leads/:id/quote', h((req, res, next) => {
  const lead = one('SELECT * FROM leads WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!lead) return next();
  const customerId = tx(() => {
    let customerId = lead.customer_id;
    if (!customerId) {
      customerId = run('INSERT INTO customers (agency_id, name, email, phone) VALUES (?, ?, ?, ?)', req.agency.id, lead.name, lead.email, lead.phone).lastInsertRowid;
      run('UPDATE leads SET customer_id = ? WHERE id = ?', customerId, lead.id);
    }
    return customerId;
  });
  const opts = { customerId, leadId: lead.id, travelDate: lead.travel_date, date: lead.travel_date, adults: lead.pax || 2 };
  const pkg = lead.package_id && ownPackage(req, lead.package_id);
  let id;
  try {
    id = pkg ? svc.createQuoteFromPackage(req.agency, pkg.id, { ...opts, title: `${pkg.title} — ${lead.name}` }) : null;
  } catch (e) {
    if (!(e instanceof svc.AppError)) throw e;
    req.flash('warn', `${e.message} Started an empty quote instead.`);
  }
  if (!id) id = svc.createQuote(req.agency, { ...opts, title: `${pkg ? pkg.title : lead.destination || 'Trip'} — ${lead.name}` });
  run("UPDATE leads SET status = 'quoted' WHERE id = ?", lead.id);
  req.flash('success', 'Quote created for this lead.');
  res.redirect(`/agent/quotes/${id}`);
}));

// ---------- wallet ----------

router.get('/wallet', h((req, res) => {
  const txns = all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 100', req.agency.id);
  const requests = all('SELECT * FROM topup_requests WHERE agency_id = ? ORDER BY id DESC LIMIT 10', req.agency.id);
  res.page('agent/wallet', { title: 'Wallet & credit', txns, requests });
}));

router.post('/wallet/topup', requireActiveAgency, h((req, res) => {
  const amount = round2(num(req.body.amount, 0));
  if (amount < 100) throw new svc.AppError('Minimum top-up is ₹100.');
  run('INSERT INTO topup_requests (agency_id, amount, utr) VALUES (?, ?, ?)', req.agency.id, amount, str(req.body.utr) || null);
  notify(null, 'Wallet top-up request', `${req.agency.name} requested ₹${amount.toLocaleString('en-IN')} (UTR ${str(req.body.utr) || 'n/a'}).`, '/admin/topups');
  req.flash('success', 'Top-up request sent. Your wallet is credited once VaayuTrip verifies the payment.');
  res.redirect('/agent/wallet');
}));

// ---------- invoices ----------

router.get('/invoices', h((req, res) => {
  const invoices = all('SELECT i.*, q.code AS quote_code FROM invoices i LEFT JOIN quotes q ON q.id = i.quote_id WHERE i.agency_id = ? ORDER BY i.id DESC', req.agency.id)
    .map((i) => ({ ...i, doc: JSON.parse(i.data) }));
  res.page('agent/invoices', { title: 'Invoices', invoices });
}));

router.get('/invoices/:id', h((req, res, next) => {
  const inv = one('SELECT * FROM invoices WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!inv) return next();
  const quote = inv.quote_id ? one('SELECT code FROM quotes WHERE id = ?', inv.quote_id) : null;
  const shareUrl = quote && inv.kind !== 'b2b' ? `${req.protocol}://${req.get('host')}/q/${quote.code}/invoice/${inv.id}` : null;
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, doc: JSON.parse(inv.data), back: '/agent/invoices', shareUrl }, 'doc');
}));

// ---------- payment links ----------

router.get('/payment-links', h((req, res) => {
  const links = all('SELECT * FROM payment_links WHERE agency_id = ? ORDER BY id DESC', req.agency.id);
  res.page('agent/payment-links', { title: 'Payment links', links, base: `${req.protocol}://${req.get('host')}` });
}));

router.post('/payment-links', requireActiveAgency, h((req, res) => {
  const amount = round2(num(req.body.amount, 0));
  const purpose = str(req.body.purpose);
  if (amount <= 0 || !purpose) throw new svc.AppError('Enter what the payment is for and the amount.');
  run('INSERT INTO payment_links (agency_id, code, purpose, amount, customer_name) VALUES (?, ?, ?, ?, ?)',
    req.agency.id, code('PAY'), purpose, amount, str(req.body.customer_name) || null);
  req.flash('success', 'Payment link created.');
  res.redirect('/agent/payment-links');
}));

router.post('/payment-links/:id/expire', h((req, res) => {
  run("UPDATE payment_links SET status = 'expired' WHERE id = ? AND agency_id = ? AND status = 'pending'", num(req.params.id), req.agency.id);
  res.redirect('/agent/payment-links');
}));

// ---------- website, API, notifications, settings ----------

router.get('/website', h((req, res) => {
  const leads = one("SELECT COUNT(*) AS n FROM leads WHERE agency_id = ? AND source = 'website'", req.agency.id).n;
  res.page('agent/website', { title: 'My website', siteUrl: `${req.protocol}://${req.get('host')}/site/${req.agency.slug}`, leads });
}));

router.post('/website', h((req, res) => {
  run('UPDATE agencies SET website_enabled = ?, website_tagline = ?, website_about = ? WHERE id = ?',
    req.body.website_enabled ? 1 : 0, str(req.body.website_tagline) || null, str(req.body.website_about) || null, req.agency.id);
  req.flash('success', 'Website updated.');
  res.redirect('/agent/website');
}));

router.get('/api', (req, res) => {
  res.page('agent/api', { title: 'API access', base: `${req.protocol}://${req.get('host')}/api/v1` });
});

router.post('/api/regenerate', requireActiveAgency, h((req, res) => {
  run('UPDATE agencies SET api_key = ? WHERE id = ?', `vt_live_${crypto.randomBytes(18).toString('hex')}`, req.agency.id);
  req.flash('success', 'New API key generated. The old key stopped working.');
  res.redirect('/agent/api');
}));

router.get('/notifications', h((req, res) => {
  const items = all('SELECT * FROM notifications WHERE agency_id = ? ORDER BY id DESC LIMIT 100', req.agency.id);
  run('UPDATE notifications SET is_read = 1 WHERE agency_id = ?', req.agency.id);
  res.locals.unread = 0;
  res.page('agent/notifications', { title: 'Notifications', items });
}));

// ---------- offers ----------

const liveOffers = (limit = 50) => all(
  "SELECT * FROM offers WHERE is_active = 1 AND (valid_until IS NULL OR valid_until >= date('now')) ORDER BY COALESCE(valid_until, '9999') , id DESC LIMIT ?", limit,
);

router.get('/offers', h((req, res) => {
  res.page('agent/offers', { title: 'Offers & deals', offers: liveOffers() });
}));

// ---------- support ----------

const TICKET_CATEGORIES = { booking: 'Booking or amendment', payment: 'Wallet, payment or refund', technical: 'Portal or website issue', general: 'Something else' };

router.get('/support', h((req, res) => {
  const tickets = all(
    `SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages
     FROM tickets t WHERE t.agency_id = ? ORDER BY CASE t.status WHEN 'closed' THEN 1 ELSE 0 END, t.updated_at DESC`, req.agency.id,
  );
  const bookings = all('SELECT id, code, title FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 30', req.agency.id);
  res.page('agent/support', { title: 'Help & support', tickets, bookings, categories: TICKET_CATEGORIES, settings: getSettings() });
}));

router.post('/support', h((req, res) => {
  const subject = str(req.body.subject).slice(0, 140);
  const body = str(req.body.body).slice(0, 4000);
  if (!subject || !body) throw new svc.AppError('Add a subject and describe the issue.');
  const category = TICKET_CATEGORIES[req.body.category] ? req.body.category : 'general';
  const booking = num(req.body.booking_id) ? one('SELECT id FROM bookings WHERE id = ? AND agency_id = ?', num(req.body.booking_id), req.agency.id) : null;
  const id = tx(() => {
    const ticketId = run('INSERT INTO tickets (agency_id, code, subject, category, booking_id) VALUES (?, ?, ?, ?, ?)',
      req.agency.id, code('T'), subject, category, booking ? booking.id : null).lastInsertRowid;
    run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', ticketId, req.user.id, body);
    notify(null, 'New support ticket', `${req.agency.name}: ${subject}`, `/admin/tickets/${ticketId}`);
    return ticketId;
  });
  req.flash('success', 'Ticket raised. Our team usually replies within a few working hours.');
  res.redirect(`/agent/support/${id}`);
}));

router.get('/support/:id', h((req, res, next) => {
  const ticket = one('SELECT t.*, b.code AS booking_code FROM tickets t LEFT JOIN bookings b ON b.id = t.booking_id WHERE t.id = ? AND t.agency_id = ?', num(req.params.id), req.agency.id);
  if (!ticket) return next();
  const messages = all('SELECT m.*, u.name AS author FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id', ticket.id);
  res.page('ticket', { title: `${ticket.code} · ${ticket.subject}`, ticket, messages, base: '/agent/support', back: '/agent/support' });
}));

router.post('/support/:id/reply', h((req, res, next) => {
  const ticket = one('SELECT * FROM tickets WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!ticket) return next();
  const body = str(req.body.body).slice(0, 4000);
  const close = req.body.close === '1';
  if (!body && !close) throw new svc.AppError('Write a message first.');
  tx(() => {
    if (body) run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', ticket.id, req.user.id, body);
    run("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?", close ? 'closed' : 'open', ticket.id);
    if (body) notify(null, 'Ticket updated', `${req.agency.name}: ${ticket.subject}`, `/admin/tickets/${ticket.id}`);
  });
  req.flash('success', close ? 'Ticket closed. Reply any time to reopen it.' : 'Message sent.');
  res.redirect(`/agent/support/${ticket.id}`);
}));

// ---------- reports ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Period from ?from=&to= (YYYY-MM-DD, inclusive); defaults to the last 6 months.
function reportPeriod(q) {
  const today = new Date().toISOString().slice(0, 10);
  const sixMonths = new Date(Date.now() - 182 * 864e5).toISOString().slice(0, 10);
  const from = ISO_DATE.test(q.from) ? q.from : sixMonths;
  const to = ISO_DATE.test(q.to) ? q.to : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

// Quotes a CSV cell; text starting with = + - @ is prefixed so spreadsheets don't run it as a formula.
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = /^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function sendCsv(res, filename, header, rows) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(`﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
}

router.get('/reports', h((req, res) => {
  const a = req.agency.id;
  const { from, to } = reportPeriod(req.query);
  const range = [a, from, to];
  const inRange = "agency_id = ? AND date(created_at) BETWEEN ? AND ?";
  const totals = one(
    `SELECT COUNT(*) FILTER (WHERE status != 'cancelled') AS bookings,
       COALESCE(SUM(total_sell) FILTER (WHERE status != 'cancelled'), 0) AS sales,
       COALESCE(SUM(total_net) FILTER (WHERE status != 'cancelled'), 0) AS net,
       COALESCE(SUM(total_sell - total_net - total_cost) FILTER (WHERE status != 'cancelled'), 0) AS earnings,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       COALESCE(SUM(refund_amount) FILTER (WHERE status = 'cancelled'), 0) AS refunds
     FROM bookings WHERE ${inRange}`, ...range,
  );
  const months = all(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS bookings, SUM(total_sell) AS sales, SUM(total_sell - total_net - total_cost) AS earnings
     FROM bookings WHERE ${inRange} AND status != 'cancelled' GROUP BY month ORDER BY month`, ...range,
  );
  const destinations = all(
    `SELECT COALESCE(p.destination, 'Custom trips') AS destination, COUNT(*) AS bookings, SUM(b.total_sell) AS sales, SUM(b.total_sell - b.total_net - b.total_cost) AS earnings
     FROM bookings b LEFT JOIN quotes q ON q.id = b.quote_id LEFT JOIN packages p ON p.id = q.package_id
     WHERE b.agency_id = ? AND date(b.created_at) BETWEEN ? AND ? AND b.status != 'cancelled'
     GROUP BY 1 ORDER BY sales DESC LIMIT 8`, ...range,
  );
  const customers = all(
    `SELECT c.id, c.name, COUNT(*) AS bookings, SUM(b.total_sell) AS sales
     FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.agency_id = ? AND date(b.created_at) BETWEEN ? AND ? AND b.status != 'cancelled'
     GROUP BY c.id ORDER BY sales DESC LIMIT 5`, ...range,
  );
  res.page('agent/reports', { title: 'Reports', from, to, totals, months, destinations, customers });
}));

router.get('/reports/bookings.csv', h((req, res) => {
  const { from, to } = reportPeriod(req.query);
  const rows = all(
    `SELECT b.code, b.created_at, b.title, c.name AS customer, b.travel_date, b.status, b.total_net, b.total_sell, b.total_cost, b.paid_wallet, b.paid_credit, b.refund_amount
     FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.agency_id = ? AND date(b.created_at) BETWEEN ? AND ? ORDER BY b.id`, req.agency.id, from, to,
  );
  sendCsv(res, `bookings_${from}_to_${to}.csv`,
    ['Booking ID', 'Booked on', 'Trip', 'Customer', 'Travel date', 'Status', 'Net (VaayuTrip)', 'Selling price', 'Your own costs', 'Your earnings', 'Paid from wallet', 'Paid from credit', 'Refund'],
    rows.map((b) => [b.code, b.created_at.slice(0, 10), b.title, b.customer, b.travel_date, b.status, b.total_net, b.total_sell, b.total_cost, round2(b.total_sell - b.total_net - b.total_cost), b.paid_wallet, b.paid_credit, b.refund_amount]));
}));

router.get('/reports/ledger.csv', h((req, res) => {
  const { from, to } = reportPeriod(req.query);
  const rows = all('SELECT * FROM wallet_txns WHERE agency_id = ? AND date(created_at) BETWEEN ? AND ? ORDER BY id', req.agency.id, from, to);
  sendCsv(res, `wallet-ledger_${from}_to_${to}.csv`, ['Date', 'Type', 'Amount', 'Balance after', 'Reference', 'Note'],
    rows.map((t) => [t.created_at.slice(0, 10), t.type, t.amount, t.balance_after, t.ref, t.note]));
}));

router.get('/settings', (req, res) => {
  res.page('agent/settings', { title: 'Company & branding', branded: agencyHasBranding(req.agency), countries: COUNTRIES });
});

router.post('/settings/tax', withTaxDoc('tax_doc'), h((req, res) => {
  const a = req.agency;
  const tax = checkTax({ country: req.body.country, gstin: req.body.gstin, taxId: req.body.tax_id }, {
    docUploaded: Boolean(req.file), needDoc: !a.tax_doc, rejected: req.taxDocRejected, uploadError: req.uploadError,
  });
  if (tax.errors.length) {
    if (req.file) removeDoc(req.file.filename);
    tax.errors.forEach((m) => req.flash('error', m));
    return res.redirect('/agent/settings#tax');
  }
  const changed = req.file || tax.country !== a.country || tax.gstin !== a.gstin || tax.taxId !== a.tax_id;
  if (!changed) {
    req.flash('success', 'Tax details unchanged.');
    return res.redirect('/agent/settings#tax');
  }
  if (req.file) removeDoc(a.tax_doc);
  run(
    "UPDATE agencies SET country = ?, gstin = ?, tax_id = ?, pan = COALESCE(?, pan), tax_doc = ?, kyc_status = 'pending' WHERE id = ?",
    tax.country, tax.gstin, tax.taxId, tax.pan, req.file ? req.file.filename : a.tax_doc, a.id,
  );
  notify(null, 'Tax details updated', `${a.name} updated its tax registration; KYC needs a fresh check.`, `/admin/agents/${a.id}`);
  req.flash('success', 'Tax details saved. Our team will re-verify your KYC shortly.');
  res.redirect('/agent/settings#tax');
}));

router.post('/settings', upload.single('logo'), h((req, res) => {
  const b = req.body;
  const logo = req.file ? `/uploads/${req.file.filename}` : b.remove_logo ? null : req.agency.logo_path;
  if (req.logoRejected) req.flash('error', 'Logo must be a PNG, JPG or WebP image; it was not changed.');
  run(
    `UPDATE agencies SET name = ?, legal_name = ?, pan = ?, phone = ?, email = ?, address = ?, city = ?, brand_color = ?, logo_path = ?,
       markup_type = ?, markup_value = ? WHERE id = ?`,
    str(b.name) || req.agency.name, str(b.legal_name) || null, str(b.pan).toUpperCase() || null, str(b.phone) || null,
    str(b.email) || null, str(b.address) || null, str(b.city) || null, /^#[0-9a-f]{6}$/i.test(b.brand_color) ? b.brand_color : '#0e7490', logo,
    b.markup_type === 'flat' ? 'flat' : 'percent', Math.max(0, num(b.markup_value, 0)), req.agency.id,
  );
  req.flash('success', 'Company profile saved.');
  res.redirect('/agent/settings');
}));

module.exports = router;
