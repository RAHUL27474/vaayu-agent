const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, getSettings, notify, audit, UPLOADS_DIR } = require('../db');
const { num, code, round2, uniqueSlug, fmtDate } = require('../util');
const { requireAgent, requireActiveAgency, limitPendingAgency, h, idParam, MAX_AMOUNT } = require('../auth');
const svc = require('../services');
const { searchAgency } = require('../search');
const { priceQuote, emiPlans, agencyHasBranding, withTax, markupRule } = require('../pricing');
const {
  MEAL_PLANS, STAY_TYPES, EXTRA_TYPES, emptyDetails, parseDetails, itemIds, detailsFromForm, calcPackage, priceLines, fromPrice, publishProblems, present,
} = require('../packages');
const {
  KINDS, KIND_BY_PATH, DESTINATIONS, ALL_DESTINATIONS, MEAL_PLANS: PRODUCT_MEAL_PLANS, productLines, productMap, cardPrice, describe, parseProductDetails, publishedProduct,
  kindMarkupsFromForm, quoteKindMarkupsFromForm, kindMarkups,
} = require('../products');
const { withCover, coverFrom } = require('../photos');
const { persistFile } = require('../files');
const { paging, pageOf } = require('../paging');
const { COUNTRIES, isIndia, kycLabel, requiredFiles, withKycDocs, checkTax, checkKycFiles, missingKyc, removeDoc, removeUploaded } = require('../kyc');

const router = express.Router();
router.param('id', idParam);
router.param('itemId', idParam);
router.use(requireAgent);
router.use(limitPendingAgency);

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

const openQuotes = async (agencyId) => await all("SELECT id, code, title FROM quotes WHERE agency_id = ? AND status IN ('draft', 'sent', 'accepted') ORDER BY updated_at DESC LIMIT 30", agencyId);
const customersOf = async (agencyId) => await all('SELECT id, name FROM customers WHERE agency_id = ? ORDER BY name', agencyId);
const str = (v) => String(v ?? '').trim();

/**
 * Markup chosen on a product page: null = the agent's default for that service; otherwise the agent's own
 * % or ₹ for this item ("My default" unticked, mu_type / mu filled in).
 */
function ownMarkup(src) {
  if (src.use_default || str(src.mu) === '') return null;
  const type = src.mu_type === 'flat' ? 'flat' : 'percent';
  return { markup_type: type, markup_value: Math.min(type === 'flat' ? MAX_AMOUNT : 500, Math.max(0, num(src.mu, 0))) };
}

async function ownQuote(req) {
  const full = await svc.getQuote(num(req.params.id), req.agency.id);
  if (!full) throw new svc.AppError('Quote not found');
  return full;
}

function assertEditable(quote) {
  if (['booked', 'cancelled'].includes(quote.status)) throw new svc.AppError('This quote is booked; its items can no longer be changed.');
}

// ---------- dashboard ----------

/** Where a pending agency's application stands: stages for the status page. */
function applicationStages(agency) {
  const missing = missingKyc(agency);
  const docsDone = !missing.length && agency.kyc_status !== 'rejected';
  const verified = agency.kyc_status === 'verified';
  const docs = missing.length
    ? { state: 'action', text: `Still needed: ${missing.join(', ')}.`, action: { href: '/agent/settings#tax', label: 'Upload documents' } }
    : agency.kyc_status === 'rejected'
      ? { state: 'action', text: `Our team sent your documents back${agency.kyc_note ? `: ${agency.kyc_note.replace(/[.!?]?$/, '.')}` : '.'} Please upload corrected documents.`, action: { href: '/agent/settings#tax', label: 'Upload corrected documents' } }
      : { state: 'done', text: 'All documents received.' };
  return {
    missing,
    current: !docsDone ? 'documents' : verified ? 'approval' : 'review',
    steps: [
      { key: 'submitted', title: 'Application submitted', state: 'done', text: `Received on ${fmtDate(agency.created_at)}.` },
      { key: 'documents', title: 'Documents', ...docs },
      { key: 'review', title: 'Verification by VaayuTrip', state: !docsDone ? 'todo' : verified ? 'done' : 'current',
        text: !docsDone ? 'Starts as soon as your documents are complete.' : verified ? 'Your documents are verified.' : 'Our team is checking your tax registration, documents and photo. This usually takes one working day.' },
      { key: 'approval', title: 'Agency approved', state: verified ? 'current' : 'todo',
        text: verified ? 'Final approval is in progress. We will notify you here and by email.' : 'You can book airfares, hotels and activities, build packages and send quotes once approved.' },
    ],
  };
}

router.get('/', h(async (req, res) => {
  if (req.agency.status !== 'active') {
    const agency = req.agency;
    const user = await one('SELECT name, email, phone FROM users WHERE id = ?', req.user.id);
    const docs = requiredFiles(agency.country).map((k) => ({ label: kycLabel(k, agency.country).replace(/^your /, 'Applicant ').replace(/^./, (c) => c.toUpperCase()), have: Boolean(agency[k]) }));
    return res.page('agent/application', { title: 'Application status', app: applicationStages(agency), applicant: user, docs, india: isIndia(agency.country) });
  }
  const a = req.agency.id;
  const month = new Date().toISOString().slice(0, 7);
  // Independent lookups run in parallel.
  const [stats, openLeads, quotes, bookings, leads, upcoming, featuredRows, hasPackage, months, offers] = await Promise.all([
    one(
      `SELECT COUNT(*) AS bookings, COALESCE(SUM(total_sell), 0) AS sales, COALESCE(SUM(total_sell - total_net - total_cost), 0) AS earnings
       FROM bookings WHERE agency_id = ? AND status != 'cancelled' AND substr(created_at, 1, 7) = ?`, a, month,
    ),
    one("SELECT COUNT(*) AS n FROM leads WHERE agency_id = ? AND status IN ('new', 'contacted')", a).then((r) => r.n),
    all('SELECT * FROM quotes WHERE agency_id = ? ORDER BY updated_at DESC LIMIT 5', a),
    all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 5', a),
    all("SELECT * FROM leads WHERE agency_id = ? AND status = 'new' ORDER BY id DESC LIMIT 5", a),
    all("SELECT * FROM bookings WHERE agency_id = ? AND status = 'confirmed' AND travel_date >= sqldate('now') ORDER BY travel_date LIMIT 5", a),
    all("SELECT * FROM products WHERE status = 'published' ORDER BY created_at DESC, id DESC LIMIT 5"),
    one('SELECT 1 FROM packages WHERE agency_id = ?', a).then(Boolean),
    // Last 6 calendar months, oldest first, including months without bookings.
    all(
      `SELECT substr(created_at, 1, 7) AS month, SUM(total_sell - total_net - total_cost) AS earnings, COUNT(*) AS n FROM bookings
       WHERE agency_id = ? AND status != 'cancelled' AND created_at >= sqldate('now', 'start of month', '-5 months') GROUP BY month`, a,
    ),
    liveOffers(2),
  ]);
  const featured = featuredRows.map((x) => ({ ...x, price: cardPrice(req.agency, x), path: KINDS[x.kind].path }));
  const branded = agencyHasBranding(req.agency);
  const earned = Object.fromEntries(months.map((m) => [m.month, m]));
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
    { done: !missingKyc(req.agency).length, label: 'Upload your KYC documents and photo', href: '/agent/settings#tax' },
    { done: req.agency.status === 'active', label: 'Get approved by VaayuTrip', href: '/agent/support' },
    { done: branded, label: 'Add your logo for branded invoices', href: '/agent/settings' },
    { done: hasPackage, label: 'Build your first package from our inventory', href: '/agent/packages/new' },
    { done: hasQuote, label: 'Send your first quote', href: '/agent/packages' },
    { done: hasBooking, label: 'Make your first booking', href: '/agent/quotes' },
  ];
  const services = Object.entries(KIND_BY_PATH).map(([path, kind]) => ({ path, kind, label: KINDS[kind].plural, icon: KINDS[kind].icon }));
  res.page('agent/dashboard', { title: 'Dashboard', stats, openLeads, quotes, bookings, leads, upcoming, featured, branded, chart, checklist, offers, services, destinations: Object.keys(DESTINATIONS) });
}));

// ---------- VaayuTrip inventory: activities, hotels, airfares, transfers, visas, insurance ----------

// Party for product prices (query string or form body).
function partyOf(src) {
  const adults = Math.max(1, Math.round(num(src.adults, 2)));
  return {
    adults,
    children: Math.max(0, Math.round(num(src.children, 0))),
    infants: Math.max(0, Math.round(num(src.infants, 0))),
    rooms: Math.max(1, Math.round(num(src.rooms, Math.ceil(adults / 2)))),
    nights: Math.max(1, Math.min(60, Math.round(num(src.nights, 1)))),
  };
}
const ownPackages = async (agencyId) => await all('SELECT id, title, nights, destination FROM packages WHERE agency_id = ? ORDER BY updated_at DESC', agencyId);
const withPrices = (agency) => (p) => ({ ...p, price: cardPrice(agency, p), line: describe(p) });

// Dashboard booking panel: send the agent to the chosen service's catalogue with the destination and search applied.
router.get('/find', (req, res) => {
  const path = KIND_BY_PATH[req.query.svc] ? req.query.svc : 'hotels';
  const qs = new URLSearchParams();
  if (DESTINATIONS[req.query.dest]) qs.set('dest', req.query.dest);
  const q = str(req.query.q).slice(0, 80);
  if (q) qs.set('q', q);
  res.redirect(`/agent/${path}${qs.toString() ? `?${qs}` : ''}`);
});

for (const [path, kind] of Object.entries(KIND_BY_PATH)) {
  const cfg = KINDS[kind];

  router.get(`/${path}`, h(async (req, res) => {
    const f = {
      q: str(req.query.q),
      dest: DESTINATIONS[req.query.dest] ? req.query.dest : '',
      city: str(req.query.city),
      category: cfg.categories.includes(req.query.category) ? req.query.category : '',
    };
    const where = [["status = 'published'"], ['kind = ?', kind]];
    if (f.q) where.push(['(title ILIKE ? OR city ILIKE ? OR summary ILIKE ?)', ...Array(3).fill(`%${f.q}%`)]);
    if (f.dest) where.push([`country IN (${DESTINATIONS[f.dest].map(() => '?').join(', ')}, ?)`, ...DESTINATIONS[f.dest], ALL_DESTINATIONS]);
    if (f.city) where.push(['city = ?', f.city]);
    if (f.category) where.push(['category = ?', f.category]);
    const pg = paging(req, 48);
    const found = pageOf(await all(
      `SELECT * FROM products WHERE ${where.map(([c]) => c).join(' AND ')} ORDER BY country, city, net_adult, id ${pg.sql}`,
      ...where.flatMap(([, ...p]) => p), ...pg.params,
    ), pg);
    const products = found.rows.map(withPrices(req.agency));
    const cities = (await all("SELECT city, country, COUNT(*) AS n FROM products WHERE status = 'published' AND kind = ? GROUP BY city, country ORDER BY country, city", kind))
      .filter((c) => !f.dest || DESTINATIONS[f.dest].includes(c.country) || c.country === ALL_DESTINATIONS);
    const services = Object.entries(KIND_BY_PATH).map(([p, k]) => ({ path: p, kind: k, label: KINDS[k].plural, icon: KINDS[k].icon }));
    res.page('agent/catalogue', { title: cfg.plural, kind, cfg, products, pager: found.pager, cities, f, services, destinations: Object.keys(DESTINATIONS) });
  }));

  router.get(`/${path}/:id`, h(async (req, res, next) => {
    const p = await publishedProduct(num(req.params.id), kind);
    if (!p) return next();
    const party = partyOf(req.query);
    const lines = productLines(p, party).map((l) => ({ ...l, supplier: 'vaayu', sell: null }));
    const own = ownMarkup(req.query);
    const more = (await all("SELECT * FROM products WHERE status = 'published' AND kind = ? AND city = ? AND id != ? ORDER BY net_adult LIMIT 4", kind, p.city, p.id))
      .map(withPrices(req.agency));
    res.page('agent/product', {
      title: p.title, kind, cfg, p: withPrices(req.agency)(p), d: parseProductDetails(p.details), party, lines, priced: priceLines(own || req.agency, lines), more,
      own, defaultRule: markupRule(req.agency, kind),
      quotes: await openQuotes(req.agency.id), packages: await ownPackages(req.agency.id), customers: await customersOf(req.agency.id), mealPlans: PRODUCT_MEAL_PLANS,
    });
  }));

  router.post(`/${path}/:id/quote`, h(async (req, res, next) => {
    const p = await publishedProduct(num(req.params.id), kind);
    if (!p) return next();
    const party = partyOf(req.body);
    let quoteId = num(req.body.quote_id, 0);
    if (quoteId) {
      const q = await one('SELECT status FROM quotes WHERE id = ? AND agency_id = ?', quoteId, req.agency.id);
      if (!q) throw new svc.AppError('Quote not found');
      assertEditable(q);
    } else {
      const customerId = num(req.body.customer_id, 0);
      quoteId = await svc.createQuote(req.agency, {
        title: str(req.body.new_title) || p.title, adults: party.adults, children: party.children, infants: party.infants, travelDate: str(req.body.date) || null,
        customerId: customerId && await one('SELECT 1 FROM customers WHERE id = ? AND agency_id = ?', customerId, req.agency.id) ? customerId : null,
      });
      await audit(req.user, 'quote.created', { entity: 'quote', id: quoteId, summary: `From ${cfg.label.toLowerCase()}: ${p.title}` });
    }
    const own = ownMarkup(req.body);
    if (own) {
      // The agent's own markup for this item: its lines go on the quote at the price shown on the product page.
      const priced = priceLines(own, productLines(p, party).map((l) => ({ ...l, supplier: 'vaayu', sell: null })));
      await tx(async () => {
        for (const l of priced.lines) await svc.addQuoteItem(quoteId, { type: l.type, title: l.title, description: l.description, net: l.net_price, sell: l.unitSell, qty: l.qty, productId: l.productId });
        await run('UPDATE quotes SET is_international = 1 WHERE id = ?', quoteId);
      });
    } else {
      await svc.addProductToQuote(quoteId, p, party);
    }
    req.flash('success', `${p.title} added to the quote${own ? ' at your price' : ''}.`);
    res.redirect(`/agent/quotes/${quoteId}#items`);
  }));

  router.post(`/${path}/:id/add-to-package`, h(async (req, res, next) => {
    const p = await publishedProduct(num(req.params.id), kind);
    if (!p) return next();
    const day = Math.max(1, Math.min(60, Math.round(num(req.body.day, 1))));
    const nights = Math.max(1, Math.min(60, Math.round(num(req.body.nights, 1))));
    let pkg = num(req.body.package_id, 0) ? await ownPackage(req, num(req.body.package_id)) : null;
    if (req.body.package_id && req.body.package_id !== 'new' && !pkg) throw new svc.AppError('Package not found');
    if (!pkg) {
      const id = await insertPackage(req.agency, { title: `${p.city} holiday`, destination: p.city, nights: Math.max(3, day - 1, kind === 'hotel' ? nights : 0) }, newPackageDetails());
      await audit(req.user, 'package.created', { entity: 'package', id, summary: `${p.city} holiday (started from ${p.title})` });
      pkg = await ownPackage(req, id);
    }
    const d = parseDetails(pkg.details);
    d.items.push({ day, id: p.id, kind, title: p.title, ...(kind === 'hotel' ? { nights } : {}) });
    d.items.sort((x, y) => x.day - y.day);
    while (d.days.length < day) d.days.push({ title: `Day ${d.days.length + 1}`, description: '', meals: { b: false, l: false, d: false }, overnight: '' });
    await run("UPDATE packages SET details = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(d), pkg.id);
    req.flash('success', `${p.title} added to day ${day} of ${pkg.title}. Fill in the rest of the package and save.`);
    res.redirect(`/agent/packages/${pkg.id}/edit#items`);
  }));
}

// ---------- my packages (built by the agency from VaayuTrip inventory + its own services) ----------

const PKG_CORE = ['title', 'destination', 'nights', 'theme', 'summary', 'inclusions', 'exclusions', 'image_url', 'is_international', 'departure_city'];

async function ownPackage(req, id) {
  return await one('SELECT * FROM packages WHERE id = ? AND agency_id = ?', id, req.agency.id);
}

async function insertPackage(agency, core, details) {
  const row = { nights: 3, ...core, is_international: 1 };
  return (await run(
    `INSERT INTO packages (${PKG_CORE.join(', ')}, details, slug, agency_id, status) VALUES (${PKG_CORE.map(() => '?').join(', ')}, ?, ?, ?, 'draft')`,
    ...PKG_CORE.map((k) => row[k] ?? null), JSON.stringify(details), await uniqueSlug('packages', row.title), agency.id,
  )).lastInsertRowid;
}

function newPackageDetails() {
  const d = emptyDetails();
  d.days = [{ title: 'Arrival', description: '', meals: { b: false, l: false, d: true }, overnight: '' }];
  d.policies.cancellation = [{ days: 30, percent: 10 }, { days: 15, percent: 25 }, { days: 7, percent: 50 }, { days: 0, percent: 100 }];
  d.policies.child = 'Infants below 2 years travel free. Children 2–11 years pay the child price for activities. 12 years and above: adult price.';
  d.policies.notes = 'Hotel check-in 14:00, check-out 11:00. Valid government photo ID required for all travellers. Activity timings may change with weather and local conditions.';
  return d;
}

// Every published product, for the builder's pickers and for validating the form.
const productCatalogue = async () => new Map((await all("SELECT * FROM products WHERE status = 'published' ORDER BY kind, country, city, title")).map((p) => [p.id, p]));

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
    // Every VaayuTrip destination is abroad, so TCS applies on customer invoices.
    is_international: 1,
    departure_city: str(b.departure_city) || null,
  };
}

async function builderData(req, pkg, details) {
  const catalogue = await productCatalogue();
  return {
    pkg, d: details, catalogue: [...catalogue.values()].map(withPrices(req.agency)), kinds: KINDS, mealPlans: MEAL_PLANS, stayTypes: STAY_TYPES, extraTypes: EXTRA_TYPES,
    problems: pkg.id ? publishProblems(pkg, details) : [],
    from: pkg.id ? await fromPrice(req.agency, pkg, details) : null,
  };
}

router.get('/packages', h(async (req, res) => {
  const rows = await all(
    'SELECT p.*, (SELECT COUNT(*) FROM quotes q WHERE q.package_id = p.id) AS quotes FROM packages p WHERE p.agency_id = ? ORDER BY p.updated_at DESC', req.agency.id,
  );
  const packages = await Promise.all(rows.map(async (p) => {
    const d = parseDetails(p.details);
    return { ...p, price: await fromPrice(req.agency, p, d), services: d.items.length, problems: publishProblems(p, d) };
  }));
  res.page('agent/packages', { title: 'My packages', packages });
}));

router.get('/packages/new', h(async (req, res) => {
  const destination = str(req.query.destination);
  res.page('agent/package-form', { title: 'New package', ...await builderData(req, { nights: 3, status: 'draft', destination, title: '' }, newPackageDetails()) });
}));

router.post('/packages', withCover(svc.AppError), h(async (req, res) => {
  const catalogue = await productCatalogue();
  const details = detailsFromForm(req.body, catalogue);
  const core = { ...packageCore(req.body, details, catalogue), image_url: coverFrom(req, null) };
  if (!core.title || !core.destination) throw new svc.AppError('Give the package a name and destination.');
  const id = await insertPackage(req.agency, core, details);
  await audit(req.user, 'package.created', { entity: 'package', id, summary: core.title });
  req.flash('success', 'Package saved. Price it for a customer below, or publish it to your website.');
  res.redirect(`/agent/packages/${id}`);
}));

// Package page with a price calculator: the form re-submits to this page with GET.
router.get('/packages/:id', h(async (req, res, next) => {
  const pkg = await ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  const products = await productMap(itemIds(details));
  const calc = await calcPackage(pkg, details, req.query, products);
  res.page('agent/package', {
    title: pkg.title, pkg, details, calc, priced: priceLines(req.agency, calc.lines),
    view: await present(pkg, details, products), from: await fromPrice(req.agency, pkg, details, products),
    problems: publishProblems(pkg, details), customers: await customersOf(req.agency.id),
    // The agent's own website only serves active agencies with the site switched on.
    siteUrl: pkg.status === 'published' && req.agency.status === 'active' && req.agency.website_enabled
      ? `${req.protocol}://${req.get('host')}/site/${req.agency.slug}/p/${pkg.slug}` : null,
  });
}));

router.get('/packages/:id/edit', h(async (req, res, next) => {
  const pkg = await ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  res.page('agent/package-form', { title: `Edit ${pkg.title}`, ...await builderData(req, pkg, parseDetails(pkg.details)) });
}));

router.post('/packages/:id', withCover(svc.AppError), h(async (req, res, next) => {
  const pkg = await ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const catalogue = await productCatalogue();
  const details = detailsFromForm(req.body, catalogue);
  const core = { ...packageCore(req.body, details, catalogue), image_url: coverFrom(req, pkg.image_url) };
  if (!core.title || !core.destination) throw new svc.AppError('Give the package a name and destination.');
  await run(
    `UPDATE packages SET ${PKG_CORE.map((k) => `${k} = ?`).join(', ')}, details = ?, updated_at = datetime('now') WHERE id = ?`,
    ...PKG_CORE.map((k) => core[k]), JSON.stringify(details), pkg.id,
  );
  await audit(req.user, 'package.updated', { entity: 'package', id: pkg.id, summary: core.title });
  const problems = publishProblems(core, details);
  if (pkg.status === 'published' && problems.length) {
    await run("UPDATE packages SET status = 'draft' WHERE id = ?", pkg.id);
    req.flash('warn', `Package taken off your website: ${problems[0]}`);
  } else {
    req.flash('success', 'Package saved.');
  }
  res.redirect(`/agent/packages/${pkg.id}`);
}));

router.post('/packages/:id/status', h(async (req, res, next) => {
  const pkg = await ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = publishProblems(pkg, parseDetails(pkg.details));
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  await run("UPDATE packages SET status = ?, updated_at = datetime('now') WHERE id = ?", status, pkg.id);
  await audit(req.user, status === 'published' ? 'package.published' : 'package.unpublished', { entity: 'package', id: pkg.id, summary: pkg.title });
  req.flash('success', status === 'published' ? 'Published: the package is live on your website and API.' : 'Unpublished: the package is hidden from your website and API.');
  res.redirect(`/agent/packages/${pkg.id}`);
}));

router.post('/packages/:id/duplicate', h(async (req, res, next) => {
  const pkg = await ownPackage(req, num(req.params.id));
  if (!pkg) return next();
  const id = await insertPackage(req.agency, { ...pkg, title: `${pkg.title} (copy)` }, parseDetails(pkg.details));
  await audit(req.user, 'package.created', { entity: 'package', id, summary: `Copy of ${pkg.title}` });
  req.flash('success', 'Copy created as a draft.');
  res.redirect(`/agent/packages/${id}/edit`);
}));

router.post('/packages/:id/delete', h(async (req, res) => {
  const gone = await ownPackage(req, num(req.params.id));
  await run('DELETE FROM packages WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (gone) await audit(req.user, 'package.deleted', { entity: 'package', id: gone.id, summary: gone.title });
  req.flash('success', 'Package deleted. Quotes made from it keep their copy.');
  res.redirect('/agent/packages');
}));

router.post('/packages/:id/quote', h(async (req, res) => {
  const customerId = num(req.body.customer_id, 0);
  const quoteId = await svc.createQuoteFromPackage(req.agency, num(req.params.id), {
    adults: req.body.adults, children: req.body.children, infants: req.body.infants, rooms: req.body.rooms, date: str(req.body.date),
    title: str(req.body.title) || undefined,
    customerId: customerId && await one('SELECT 1 FROM customers WHERE id = ? AND agency_id = ?', customerId, req.agency.id) ? customerId : null,
  });
  await audit(req.user, 'quote.created', { entity: 'quote', id: quoteId, summary: `From package: ${(await one('SELECT title FROM quotes WHERE id = ?', quoteId)).title}` });
  req.flash('success', 'Quote created from your package. Adjust prices and items, then share it with your customer.');
  res.redirect(`/agent/quotes/${quoteId}`);
}));

// ---------- quotes ----------

router.get('/quotes', h(async (req, res) => {
  const status = str(req.query.status);
  const p = paging(req);
  const { rows, pager } = pageOf(await all(
    `SELECT q.*, c.name AS customer_name FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.agency_id = ? ${status ? 'AND q.status = ?' : ''} ORDER BY q.updated_at DESC, q.id DESC ${p.sql}`,
    req.agency.id, ...(status ? [status] : []), ...p.params,
  ), p);
  // Line items for the quotes on this page only, in one query.
  const itemsByQuote = new Map();
  const items = rows.length ? await all(`SELECT * FROM quote_items WHERE quote_id IN (${rows.map(() => '?').join(', ')}) ORDER BY sort, id`, ...rows.map((q) => q.id)) : [];
  for (const it of items) {
    if (!itemsByQuote.has(it.quote_id)) itemsByQuote.set(it.quote_id, []);
    itemsByQuote.get(it.quote_id).push(it);
  }
  const quotes = rows.map((q) => ({ ...q, priced: priceQuote(q, itemsByQuote.get(q.id) || []) }));
  res.page('agent/quotes', { title: 'Quotes', quotes, pager, status, customers: await customersOf(req.agency.id) });
}));

router.post('/quotes', h(async (req, res) => {
  const id = await svc.createQuote(req.agency, {
    title: str(req.body.title) || 'New quote',
    customerId: num(req.body.customer_id, 0) || null,
    travelDate: str(req.body.travel_date) || null,
  });
  res.redirect(`/agent/quotes/${id}`);
}));

router.get('/quotes/:id', h(async (req, res) => {
  const full = await ownQuote(req);
  const settings = await getSettings();
  const invoices = await all('SELECT * FROM invoices WHERE quote_id = ? ORDER BY id DESC', full.quote.id);
  const links = await all('SELECT * FROM payment_links WHERE quote_id = ? ORDER BY id DESC', full.quote.id);
  const booking = await one('SELECT * FROM bookings WHERE quote_id = ? ORDER BY id DESC', full.quote.id);
  const customerTotal = withTax(full.priced.sell, settings, { international: Boolean(full.quote.is_international) });
  const netPayable = withTax(full.priced.net, settings);
  res.page('agent/quote', {
    kinds: KINDS, kindMarkups, agencyRates: kindMarkups(req.agency),
    title: full.quote.title, ...full, invoices, links, booking, customerTotal, netPayable,
    customers: await customersOf(req.agency.id), branded: agencyHasBranding(req.agency),
    pkgView: full.quote.package_snapshot ? JSON.parse(full.quote.package_snapshot) : null,
    emi: emiPlans(customerTotal.total, settings), shareUrl: `${req.protocol}://${req.get('host')}/q/${full.quote.code}`,
  });
}));

router.post('/quotes/:id', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const b = req.body;
  let mode = b.invoice_mode === 'agent' ? 'agent' : 'vaayu';
  if (mode === 'agent' && !agencyHasBranding(req.agency)) {
    mode = 'vaayu';
    req.flash('warn', 'Upload your logo in Company & branding to use your own invoice. Using the VaayuTrip invoice for now.');
  }
  const locked = ['booked', 'cancelled'].includes(quote.status);
  await run(
    `UPDATE quotes SET title = ?, customer_id = ?, travel_date = ?, adults = ?, children = ?, notes = ?, invoice_mode = ?, show_service_fee = ?, emi_enabled = ?,
       markup_type = ?, markup_value = ?, markup_by_kind = ?, updated_at = datetime('now') WHERE id = ?`,
    str(b.title) || quote.title, num(b.customer_id, 0) || null, str(b.travel_date) || null, Math.max(1, num(b.adults, 1)), Math.max(0, num(b.children, 0)),
    str(b.notes) || null, mode, b.show_service_fee ? 1 : 0, b.emi_enabled ? 1 : 0,
    locked ? quote.markup_type : b.markup_type === 'flat' ? 'flat' : 'percent', locked ? quote.markup_value : Math.max(0, num(b.markup_value, 0)),
    locked ? quote.markup_by_kind : quoteKindMarkupsFromForm(b, req.agency), quote.id,
  );
  req.flash('success', 'Quote saved.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

// Bulk update of line prices and quantities from the quote editor table.
router.post('/quotes/:id/items', h(async (req, res) => {
  const { quote, items } = await ownQuote(req);
  assertEditable(quote);
  await tx(async () => {
    for (const it of items) {
      const sell = str(req.body[`sell_${it.id}`]);
      const qty = Math.max(1, Math.round(num(req.body[`qty_${it.id}`], it.qty)));
      const sellPrice = sell === '' ? null : Math.max(0, num(sell, 0));
      if (it.supplier === 'vaayu' && sellPrice !== null && sellPrice < it.net_price) {
        throw new svc.AppError(`"${it.title}": your price can't be below the VaayuTrip net price.`);
      }
      await run('UPDATE quote_items SET sell_price = ?, qty = ? WHERE id = ?', it.supplier === 'agent' ? (sellPrice ?? it.sell_price ?? 0) : sellPrice, qty, it.id);
    }
    await run("UPDATE quotes SET updated_at = datetime('now') WHERE id = ?", quote.id);
  });
  req.flash('success', 'Prices updated.');
  res.redirect(`/agent/quotes/${quote.id}#items`);
}));

router.post('/quotes/:id/items/custom', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  assertEditable(quote);
  const title = str(req.body.title);
  if (!title) throw new svc.AppError('Give the item a name.');
  await svc.addQuoteItem(quote.id, {
    type: str(req.body.type) || 'other', title, description: str(req.body.description), supplier: 'agent',
    net: 0, sell: Math.max(0, num(req.body.price, 0)), cost: Math.max(0, num(req.body.cost, 0)), qty: Math.max(1, num(req.body.qty, 1)),
  });
  req.flash('success', 'Your own service was added. It appears on your branded invoice.');
  res.redirect(`/agent/quotes/${quote.id}#items`);
}));

router.post('/quotes/:id/items/:itemId/delete', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  assertEditable(quote);
  await run('DELETE FROM quote_items WHERE id = ? AND quote_id = ?', num(req.params.itemId), quote.id);
  res.redirect(`/agent/quotes/${quote.id}#items`);
}));

router.post('/quotes/:id/send', h(async (req, res) => {
  const { quote, items } = await ownQuote(req);
  if (!items.length) throw new svc.AppError('Add items before sharing the quote.');
  if (quote.status === 'draft') await run("UPDATE quotes SET status = 'sent', updated_at = datetime('now') WHERE id = ?", quote.id);
  req.flash('success', 'Quote marked as sent. Share the link below with your customer.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

router.post('/quotes/:id/book', requireActiveAgency, h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const bookingId = await svc.bookQuote(req.agency.id, quote.id);
  const bk = await one('SELECT code, total_net FROM bookings WHERE id = ?', bookingId);
  await audit(req.user, 'booking.created', { entity: 'booking', id: bookingId, summary: `${quote.title} (${bk.code}), net ₹${bk.total_net.toLocaleString('en-IN')}`, link: `/admin/bookings/${bookingId}` });
  req.flash('success', 'Booking confirmed! VaayuTrip has been paid from your wallet/credit.');
  res.redirect(`/agent/bookings/${bookingId}`);
}));

router.post('/quotes/:id/invoice', requireActiveAgency, h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const kind = quote.invoice_mode === 'agent' ? 'customer_agent' : 'customer_vaayu';
  const booking = await one('SELECT id FROM bookings WHERE quote_id = ? ORDER BY id DESC', quote.id);
  const id = await svc.issueInvoice(req.agency, quote.id, kind, booking?.id || null);
  req.flash('success', 'Invoice issued. Print it, save as PDF, or share the link with your customer.');
  res.redirect(`/agent/invoices/${id}`);
}));

router.post('/quotes/:id/payment-link', requireActiveAgency, h(async (req, res) => {
  const { quote, customer, priced } = await ownQuote(req);
  const total = withTax(priced.sell, await getSettings(), { international: Boolean(quote.is_international) }).total;
  const amount = round2(num(req.body.amount, total));
  if (amount <= 0) throw new svc.AppError('Enter an amount.');
  await run(
    'INSERT INTO payment_links (agency_id, quote_id, code, purpose, amount, customer_name) VALUES (?, ?, ?, ?, ?, ?)',
    req.agency.id, quote.id, code('PAY'), quote.title, amount, customer?.name || null,
  );
  req.flash('success', 'Payment link created.');
  res.redirect(`/agent/quotes/${quote.id}#share`);
}));

router.post('/quotes/:id/delete', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  if (quote.status === 'booked') throw new svc.AppError('Booked quotes cannot be deleted.');
  await run('DELETE FROM quotes WHERE id = ?', quote.id);
  req.flash('success', 'Quote deleted.');
  res.redirect('/agent/quotes');
}));

// ---------- bookings ----------

router.get('/bookings', h(async (req, res) => {
  const p = paging(req);
  const { rows: bookings, pager } = pageOf(await all(
    `SELECT b.*, c.name AS customer_name FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id WHERE b.agency_id = ? ORDER BY b.id DESC ${p.sql}`,
    req.agency.id, ...p.params,
  ), p);
  res.page('agent/bookings', { title: 'Bookings', bookings, pager });
}));

router.get('/bookings/:id', h(async (req, res, next) => {
  const booking = await one('SELECT * FROM bookings WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!booking) return next();
  const full = booking.quote_id ? await svc.getQuote(booking.quote_id, req.agency.id) : null;
  const invoices = await all('SELECT * FROM invoices WHERE booking_id = ? OR (quote_id = ? AND quote_id IS NOT NULL) ORDER BY id DESC', booking.id, booking.quote_id);
  res.page('agent/booking', { title: `Booking ${booking.code}`, booking, full, invoices });
}));

router.get('/bookings/:id/voucher', h(async (req, res, next) => {
  const booking = await one('SELECT * FROM bookings WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  const v = await svc.voucherFor(booking);
  if (!v) return next();
  const shareUrl = `${req.protocol}://${req.get('host')}/q/${v.quote.code}/voucher`;
  res.page('voucher', { title: `Voucher ${booking.code}`, ...v, back: `/agent/bookings/${booking.id}`, shareUrl, noindex: true }, 'doc');
}));

router.post('/bookings/:id/cancel', h(async (req, res, next) => {
  const booking = await one("SELECT * FROM bookings WHERE id = ? AND agency_id = ? AND status = 'confirmed'", num(req.params.id), req.agency.id);
  if (!booking) return next();
  await run("UPDATE bookings SET status = 'cancel_requested', cancel_reason = ? WHERE id = ?", str(req.body.reason) || 'Customer request', booking.id);
  await audit(req.user, 'booking.cancel_requested', { entity: 'booking', id: booking.id, summary: booking.code, link: `/admin/bookings/${booking.id}` });
  await notify(null, 'Cancellation request', `${req.agency.name} requested cancellation of ${booking.code}.`, `/admin/bookings/${booking.id}`);
  req.flash('success', 'Cancellation requested. VaayuTrip will confirm the refund amount.');
  res.redirect(`/agent/bookings/${booking.id}`);
}));

// ---------- customers ----------

router.get('/customers', h(async (req, res) => {
  const q = str(req.query.q);
  const p = paging(req);
  const { rows: customers, pager } = pageOf(await all(
    `SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) AS trips,
       (SELECT COALESCE(SUM(total_sell), 0) FROM bookings b WHERE b.customer_id = c.id AND b.status != 'cancelled') AS spend
     FROM customers c WHERE c.agency_id = ? ${q ? 'AND (c.name ILIKE ? OR c.phone ILIKE ? OR c.email ILIKE ?)' : ''} ORDER BY c.name, c.id ${p.sql}`,
    req.agency.id, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), ...p.params,
  ), p);
  res.page('agent/customers', { title: 'Customers', customers, pager, q });
}));

router.post('/customers', h(async (req, res) => {
  const name = str(req.body.name);
  if (!name) throw new svc.AppError('Customer name is required.');
  const id = (await run('INSERT INTO customers (agency_id, name, email, phone, city, notes) VALUES (?, ?, ?, ?, ?, ?)',
    req.agency.id, name, str(req.body.email) || null, str(req.body.phone) || null, str(req.body.city) || null, str(req.body.notes) || null)).lastInsertRowid;
  req.flash('success', 'Customer added.');
  res.redirect(`/agent/customers/${id}`);
}));

router.get('/customers/:id', h(async (req, res, next) => {
  const customer = await one('SELECT * FROM customers WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!customer) return next();
  const quotes = await all('SELECT * FROM quotes WHERE customer_id = ? ORDER BY id DESC', customer.id);
  const bookings = await all('SELECT * FROM bookings WHERE customer_id = ? ORDER BY id DESC', customer.id);
  const leads = await all('SELECT * FROM leads WHERE customer_id = ? ORDER BY id DESC', customer.id);
  res.page('agent/customer', { title: customer.name, customer, quotes, bookings, leads });
}));

router.post('/customers/:id', h(async (req, res) => {
  const id = num(req.params.id);
  await run('UPDATE customers SET name = ?, email = ?, phone = ?, city = ?, notes = ? WHERE id = ? AND agency_id = ?',
    str(req.body.name) || 'Customer', str(req.body.email) || null, str(req.body.phone) || null, str(req.body.city) || null, str(req.body.notes) || null, id, req.agency.id);
  req.flash('success', 'Customer updated.');
  res.redirect(`/agent/customers/${id}`);
}));

// ---------- leads ----------

const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

router.get('/leads', h(async (req, res) => {
  const status = LEAD_STATUSES.includes(req.query.status) ? req.query.status : '';
  const leads = await all(
    `SELECT l.*, p.title AS package_title FROM leads l LEFT JOIN packages p ON p.id = l.package_id
     WHERE l.agency_id = ? ${status ? 'AND l.status = ?' : ''} ORDER BY l.id DESC`, req.agency.id, ...(status ? [status] : []),
  );
  const counts = Object.fromEntries((await all('SELECT status, COUNT(*) AS n FROM leads WHERE agency_id = ? GROUP BY status', req.agency.id)).map((r) => [r.status, r.n]));
  res.page('agent/leads', { title: 'Leads', leads, status, counts, statuses: LEAD_STATUSES, packages: await ownPackages(req.agency.id) });
}));

router.post('/leads', h(async (req, res) => {
  const name = str(req.body.name);
  if (!name) throw new svc.AppError('Lead name is required.');
  await run('INSERT INTO leads (agency_id, name, phone, email, destination, travel_date, pax, budget, package_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.agency.id, name, str(req.body.phone) || null, str(req.body.email) || null, str(req.body.destination) || null, str(req.body.travel_date) || null,
    num(req.body.pax, 0) || null, num(req.body.budget, 0) || null, (await ownPackage(req, num(req.body.package_id, 0)))?.id || null, str(req.body.notes) || null);
  req.flash('success', 'Lead added.');
  res.redirect('/agent/leads');
}));

router.post('/leads/:id/status', h(async (req, res) => {
  if (LEAD_STATUSES.includes(req.body.status)) {
    await run('UPDATE leads SET status = ? WHERE id = ? AND agency_id = ?', req.body.status, num(req.params.id), req.agency.id);
  }
  res.redirect(req.get('referer') || '/agent/leads');
}));

// Converts a lead into a customer (if needed) and a quote, prefilled from its package.
router.post('/leads/:id/quote', h(async (req, res, next) => {
  const lead = await one('SELECT * FROM leads WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!lead) return next();
  const customerId = await tx(async () => {
    let customerId = lead.customer_id;
    if (!customerId) {
      customerId = (await run('INSERT INTO customers (agency_id, name, email, phone) VALUES (?, ?, ?, ?)', req.agency.id, lead.name, lead.email, lead.phone)).lastInsertRowid;
      await run('UPDATE leads SET customer_id = ? WHERE id = ?', customerId, lead.id);
    }
    return customerId;
  });
  const opts = { customerId, leadId: lead.id, travelDate: lead.travel_date, date: lead.travel_date, adults: lead.pax || 2 };
  const pkg = lead.package_id && await ownPackage(req, lead.package_id);
  let id;
  try {
    id = pkg ? await svc.createQuoteFromPackage(req.agency, pkg.id, { ...opts, title: `${pkg.title} — ${lead.name}` }) : null;
  } catch (e) {
    if (!(e instanceof svc.AppError)) throw e;
    req.flash('warn', `${e.message} Started an empty quote instead.`);
  }
  if (!id) id = await svc.createQuote(req.agency, { ...opts, title: `${pkg ? pkg.title : lead.destination || 'Trip'} — ${lead.name}` });
  await run("UPDATE leads SET status = 'quoted' WHERE id = ?", lead.id);
  req.flash('success', 'Quote created for this lead.');
  res.redirect(`/agent/quotes/${id}`);
}));

// ---------- wallet ----------

router.get('/wallet', h(async (req, res) => {
  const txns = await all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 100', req.agency.id);
  const requests = await all('SELECT * FROM topup_requests WHERE agency_id = ? ORDER BY id DESC LIMIT 10', req.agency.id);
  res.page('agent/wallet', { title: 'Wallet & credit', txns, requests });
}));

router.post('/wallet/topup', requireActiveAgency, h(async (req, res) => {
  const amount = round2(num(req.body.amount, 0));
  if (amount < 100) throw new svc.AppError('Minimum top-up is ₹100.');
  if (amount > MAX_AMOUNT) throw new svc.AppError('That amount is too large for one top-up. Split it, or contact VaayuTrip.');
  await run('INSERT INTO topup_requests (agency_id, amount, utr) VALUES (?, ?, ?)', req.agency.id, amount, str(req.body.utr) || null);
  await notify(null, 'Wallet top-up request', `${req.agency.name} requested ₹${amount.toLocaleString('en-IN')} (UTR ${str(req.body.utr) || 'n/a'}).`, '/admin/topups');
  await audit(req.user, 'topup.requested', { entity: 'topup', summary: `₹${amount.toLocaleString('en-IN')} (UTR ${str(req.body.utr) || 'n/a'})`, link: '/admin/topups' });
  req.flash('success', 'Top-up request sent. Your wallet is credited once VaayuTrip verifies the payment.');
  res.redirect('/agent/wallet');
}));

// ---------- invoices ----------

router.get('/invoices', h(async (req, res) => {
  const p = paging(req);
  const page = pageOf(await all(`SELECT i.*, q.code AS quote_code FROM invoices i LEFT JOIN quotes q ON q.id = i.quote_id WHERE i.agency_id = ? ORDER BY i.id DESC ${p.sql}`, req.agency.id, ...p.params), p);
  const pager = page.pager;
  const invoices = page.rows.map((i) => ({ ...i, doc: JSON.parse(i.data) }));
  res.page('agent/invoices', { title: 'Invoices', pager, invoices });
}));

router.get('/invoices/:id', h(async (req, res, next) => {
  const inv = await one('SELECT * FROM invoices WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!inv) return next();
  const quote = inv.quote_id ? await one('SELECT code FROM quotes WHERE id = ?', inv.quote_id) : null;
  const shareUrl = quote && inv.kind !== 'b2b' ? `${req.protocol}://${req.get('host')}/q/${quote.code}/invoice/${inv.id}` : null;
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, doc: JSON.parse(inv.data), back: '/agent/invoices', shareUrl }, 'doc');
}));

// ---------- payment links ----------

router.get('/payment-links', h(async (req, res) => {
  const p = paging(req);
  const { rows: links, pager } = pageOf(await all(`SELECT * FROM payment_links WHERE agency_id = ? ORDER BY id DESC ${p.sql}`, req.agency.id, ...p.params), p);
  res.page('agent/payment-links', { title: 'Payment links', links, pager, base: `${req.protocol}://${req.get('host')}` });
}));

router.post('/payment-links', requireActiveAgency, h(async (req, res) => {
  const amount = round2(num(req.body.amount, 0));
  const purpose = str(req.body.purpose);
  if (amount <= 0 || !purpose) throw new svc.AppError('Enter what the payment is for and the amount.');
  if (amount > MAX_AMOUNT) throw new svc.AppError('That amount is too large for one payment link.');
  await run('INSERT INTO payment_links (agency_id, code, purpose, amount, customer_name) VALUES (?, ?, ?, ?, ?)',
    req.agency.id, code('PAY'), purpose, amount, str(req.body.customer_name) || null);
  req.flash('success', 'Payment link created.');
  res.redirect('/agent/payment-links');
}));

router.post('/payment-links/:id/expire', h(async (req, res) => {
  await run("UPDATE payment_links SET status = 'expired' WHERE id = ? AND agency_id = ? AND status = 'pending'", num(req.params.id), req.agency.id);
  res.redirect('/agent/payment-links');
}));

// ---------- website, API, notifications, settings ----------

router.get('/website', h(async (req, res) => {
  const leads = (await one("SELECT COUNT(*) AS n FROM leads WHERE agency_id = ? AND source = 'website'", req.agency.id)).n;
  res.page('agent/website', { title: 'My website', siteUrl: `${req.protocol}://${req.get('host')}/site/${req.agency.slug}`, leads });
}));

router.post('/website', h(async (req, res) => {
  await run('UPDATE agencies SET website_enabled = ?, website_tagline = ?, website_about = ? WHERE id = ?',
    req.body.website_enabled ? 1 : 0, str(req.body.website_tagline) || null, str(req.body.website_about) || null, req.agency.id);
  req.flash('success', 'Website updated.');
  res.redirect('/agent/website');
}));

router.get('/api', (req, res) => {
  res.page('agent/api', { title: 'API access', base: `${req.protocol}://${req.get('host')}/api/v1` });
});

router.post('/api/regenerate', requireActiveAgency, h(async (req, res) => {
  await run('UPDATE agencies SET api_key = ? WHERE id = ?', `vt_live_${crypto.randomBytes(18).toString('hex')}`, req.agency.id);
  req.flash('success', 'New API key generated. The old key stopped working.');
  res.redirect('/agent/api');
}));

router.get('/search', h(async (req, res) => {
  // The dashboard booking panel used to submit here.
  if (req.query.svc) return res.redirect(`/agent/find?${new URLSearchParams(req.query)}`);
  const q = str(req.query.q).slice(0, 80);
  res.page('search', { title: 'Search', q, groups: q.length >= 2 ? await searchAgency(req.agency.id, q) : [] });
}));

router.get('/notifications', h(async (req, res) => {
  const items = await all('SELECT * FROM notifications WHERE agency_id = ? ORDER BY id DESC LIMIT 100', req.agency.id);
  await run('UPDATE notifications SET is_read = 1 WHERE agency_id = ?', req.agency.id);
  res.locals.unread = 0;
  res.page('agent/notifications', { title: 'Notifications', items });
}));

// ---------- offers ----------

const liveOffers = async (limit = 50) => await all(
  "SELECT * FROM offers WHERE is_active = 1 AND (valid_until IS NULL OR valid_until >= sqldate('now')) ORDER BY COALESCE(valid_until, '9999') , id DESC LIMIT ?", limit,
);

router.get('/offers', h(async (req, res) => {
  res.page('agent/offers', { title: 'Offers & deals', offers: await liveOffers() });
}));

// ---------- support ----------

const TICKET_CATEGORIES = { booking: 'Booking or amendment', payment: 'Wallet, payment or refund', technical: 'Portal or website issue', general: 'Something else' };

router.get('/support', h(async (req, res) => {
  const tickets = await all(
    `SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages
     FROM tickets t WHERE t.agency_id = ? ORDER BY CASE t.status WHEN 'closed' THEN 1 ELSE 0 END, t.updated_at DESC`, req.agency.id,
  );
  const bookings = await all('SELECT id, code, title FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 30', req.agency.id);
  res.page('agent/support', { title: 'Help & support', tickets, bookings, categories: TICKET_CATEGORIES, settings: await getSettings() });
}));

router.post('/support', h(async (req, res) => {
  const subject = str(req.body.subject).slice(0, 140);
  const body = str(req.body.body).slice(0, 4000);
  if (!subject || !body) throw new svc.AppError('Add a subject and describe the issue.');
  const category = TICKET_CATEGORIES[req.body.category] ? req.body.category : 'general';
  const booking = num(req.body.booking_id) ? await one('SELECT id FROM bookings WHERE id = ? AND agency_id = ?', num(req.body.booking_id), req.agency.id) : null;
  const id = await tx(async () => {
    const ticketId = (await run('INSERT INTO tickets (agency_id, code, subject, category, booking_id) VALUES (?, ?, ?, ?, ?)',
      req.agency.id, code('T'), subject, category, booking ? booking.id : null)).lastInsertRowid;
    await run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', ticketId, req.user.id, body);
    await notify(null, 'New support ticket', `${req.agency.name}: ${subject}`, `/admin/tickets/${ticketId}`);
    return ticketId;
  });
  await audit(req.user, 'ticket.created', { entity: 'ticket', id, summary: subject, link: `/admin/tickets/${id}` });
  req.flash('success', 'Ticket raised. Our team usually replies within a few working hours.');
  res.redirect(`/agent/support/${id}`);
}));

router.get('/support/:id', h(async (req, res, next) => {
  const ticket = await one('SELECT t.*, b.code AS booking_code FROM tickets t LEFT JOIN bookings b ON b.id = t.booking_id WHERE t.id = ? AND t.agency_id = ?', num(req.params.id), req.agency.id);
  if (!ticket) return next();
  const messages = await all('SELECT m.*, u.name AS author FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id', ticket.id);
  res.page('ticket', { title: `${ticket.code} · ${ticket.subject}`, ticket, messages, base: '/agent/support', back: '/agent/support' });
}));

router.post('/support/:id/reply', h(async (req, res, next) => {
  const ticket = await one('SELECT * FROM tickets WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!ticket) return next();
  const body = str(req.body.body).slice(0, 4000);
  const close = req.body.close === '1';
  if (!body && !close) throw new svc.AppError('Write a message first.');
  await tx(async () => {
    if (body) await run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', ticket.id, req.user.id, body);
    await run("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?", close ? 'closed' : 'open', ticket.id);
    if (body) await notify(null, 'Ticket updated', `${req.agency.name}: ${ticket.subject}`, `/admin/tickets/${ticket.id}`);
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

router.get('/reports', h(async (req, res) => {
  const a = req.agency.id;
  const { from, to } = reportPeriod(req.query);
  const range = [a, from, to];
  const inRange = "agency_id = ? AND sqldate(created_at) BETWEEN ? AND ?";
  const totals = await one(
    `SELECT COUNT(*) FILTER (WHERE status != 'cancelled') AS bookings,
       COALESCE(SUM(total_sell) FILTER (WHERE status != 'cancelled'), 0) AS sales,
       COALESCE(SUM(total_net) FILTER (WHERE status != 'cancelled'), 0) AS net,
       COALESCE(SUM(total_sell - total_net - total_cost) FILTER (WHERE status != 'cancelled'), 0) AS earnings,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       COALESCE(SUM(refund_amount) FILTER (WHERE status = 'cancelled'), 0) AS refunds
     FROM bookings WHERE ${inRange}`, ...range,
  );
  const months = await all(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS bookings, SUM(total_sell) AS sales, SUM(total_sell - total_net - total_cost) AS earnings
     FROM bookings WHERE ${inRange} AND status != 'cancelled' GROUP BY month ORDER BY month`, ...range,
  );
  const destinations = await all(
    `SELECT COALESCE(p.destination, 'Custom trips') AS destination, COUNT(*) AS bookings, SUM(b.total_sell) AS sales, SUM(b.total_sell - b.total_net - b.total_cost) AS earnings
     FROM bookings b LEFT JOIN quotes q ON q.id = b.quote_id LEFT JOIN packages p ON p.id = q.package_id
     WHERE b.agency_id = ? AND sqldate(b.created_at) BETWEEN ? AND ? AND b.status != 'cancelled'
     GROUP BY 1 ORDER BY sales DESC LIMIT 8`, ...range,
  );
  const customers = await all(
    `SELECT c.id, c.name, COUNT(*) AS bookings, SUM(b.total_sell) AS sales
     FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE b.agency_id = ? AND sqldate(b.created_at) BETWEEN ? AND ? AND b.status != 'cancelled'
     GROUP BY c.id ORDER BY sales DESC LIMIT 5`, ...range,
  );
  res.page('agent/reports', { title: 'Reports', from, to, totals, months, destinations, customers });
}));

router.get('/reports/bookings.csv', h(async (req, res) => {
  const { from, to } = reportPeriod(req.query);
  const rows = await all(
    `SELECT b.code, b.created_at, b.title, c.name AS customer, b.travel_date, b.status, b.total_net, b.total_sell, b.total_cost, b.paid_wallet, b.paid_credit, b.refund_amount
     FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.agency_id = ? AND sqldate(b.created_at) BETWEEN ? AND ? ORDER BY b.id`, req.agency.id, from, to,
  );
  sendCsv(res, `bookings_${from}_to_${to}.csv`,
    ['Booking ID', 'Booked on', 'Trip', 'Customer', 'Travel date', 'Status', 'Net (VaayuTrip)', 'Selling price', 'Your own costs', 'Your earnings', 'Paid from wallet', 'Paid from credit', 'Refund'],
    rows.map((b) => [b.code, b.created_at.slice(0, 10), b.title, b.customer, b.travel_date, b.status, b.total_net, b.total_sell, b.total_cost, round2(b.total_sell - b.total_net - b.total_cost), b.paid_wallet, b.paid_credit, b.refund_amount]));
}));

router.get('/reports/ledger.csv', h(async (req, res) => {
  const { from, to } = reportPeriod(req.query);
  const rows = await all('SELECT * FROM wallet_txns WHERE agency_id = ? AND sqldate(created_at) BETWEEN ? AND ? ORDER BY id', req.agency.id, from, to);
  sendCsv(res, `wallet-ledger_${from}_to_${to}.csv`, ['Date', 'Type', 'Amount', 'Balance after', 'Reference', 'Note'],
    rows.map((t) => [t.created_at.slice(0, 10), t.type, t.amount, t.balance_after, t.ref, t.note]));
}));

router.get('/settings', (req, res) => {
  res.page('agent/settings', { title: 'Company & branding', branded: agencyHasBranding(req.agency), countries: COUNTRIES, missing: missingKyc(req.agency), kinds: KINDS, kindMarkups });
});

router.post('/settings/tax', withKycDocs, h(async (req, res) => {
  const a = req.agency;
  const tax = checkTax({ country: req.body.country, gstin: req.body.gstin, taxId: req.body.tax_id });
  const errors = [...tax.errors, ...checkKycFiles(req, tax.country, a)];
  if (errors.length) {
    await removeUploaded(req);
    errors.forEach((m) => req.flash('error', m));
    return res.redirect('/agent/settings#tax');
  }
  const docs = req.kycFiles;
  const changed = Object.keys(docs).length || tax.country !== a.country || tax.gstin !== a.gstin || tax.taxId !== a.tax_id;
  if (!changed) {
    req.flash('success', 'Verification details unchanged.');
    return res.redirect('/agent/settings#tax');
  }
  for (const f of Object.keys(docs)) await removeDoc(a[f]);
  await run(
    "UPDATE agencies SET country = ?, gstin = ?, tax_id = ?, pan = COALESCE(?, pan), tax_doc = ?, pan_doc = ?, photo = ?, kyc_status = 'pending', kyc_note = NULL WHERE id = ?",
    tax.country, tax.gstin, tax.taxId, tax.pan, docs.tax_doc || a.tax_doc, docs.pan_doc || a.pan_doc, docs.photo || a.photo, a.id,
  );
  await notify(null, 'KYC documents updated', `${a.name} updated its verification details; KYC needs a fresh check.`, `/admin/agents/${a.id}`);
  await audit(req.user, 'agency.kyc_updated', { entity: 'agency', id: a.id, agencyId: a.id, link: `/admin/agents/${a.id}`, summary: `${a.name} updated KYC documents` });
  req.flash('success', 'Verification details saved. Our team will review them shortly.');
  res.redirect('/agent/settings#tax');
}));

router.post('/settings', upload.single('logo'), h(async (req, res) => {
  const b = req.body;
  if (req.file) await persistFile(req.file.path);
  const logo = req.file ? `/uploads/${req.file.filename}` : b.remove_logo ? null : req.agency.logo_path;
  if (req.logoRejected) req.flash('error', 'Logo must be a PNG, JPG or WebP image; it was not changed.');
  await run(
    `UPDATE agencies SET name = ?, legal_name = ?, pan = ?, phone = ?, email = ?, address = ?, city = ?, brand_color = ?, logo_path = ?,
       markup_type = ?, markup_value = ?, markup_by_kind = ? WHERE id = ?`,
    str(b.name) || req.agency.name, str(b.legal_name) || null, str(b.pan).toUpperCase() || null, str(b.phone) || null,
    str(b.email) || null, str(b.address) || null, str(b.city) || null, /^#[0-9a-f]{6}$/i.test(b.brand_color) ? b.brand_color : '#0e7490', logo,
    b.markup_type === 'flat' ? 'flat' : 'percent', Math.max(0, num(b.markup_value, 0)), kindMarkupsFromForm(b), req.agency.id,
  );
  req.flash('success', 'Company profile saved.');
  res.redirect('/agent/settings');
}));

module.exports = router;
