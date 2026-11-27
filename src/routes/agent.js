const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, getSettings, notify, audit, UPLOADS_DIR, DATA_DIR } = require('../db');
const { num, code, round2, uniqueSlug, fmtDate } = require('../util');
const { requireAgent, requireActiveAgency, limitPendingAgency, limitStaffRole, staffCan, STAFF_ROLES, h, idParam, MAX_AMOUNT } = require('../auth');
const { hashPassword } = require('../util');
const svc = require('../services');
const { searchAgency } = require('../search');
const phonepe = require('../phonepe');
const payments = require('../payments');
const { invoiceView } = require('../invoice-view');
const { tcsRows, sendTcsCsv } = require('../tcs-report');
const { PKG_CORE, withPrices, insertPackage, newPackageDetails, productCatalogue, packageCore, builderData: buildWith, vaayuPackage } = require('../package-builder');
const { priceQuote, agencyHasBranding, withTax, markupRule, buildInvoice } = require('../pricing');
const {
  MEAL_PLANS, STAY_TYPES, EXTRA_TYPES, emptyDetails, parseDetails, itemIds, detailsFromForm, calcPackage, priceLines, fromPrice, publishProblems, present,
} = require('../packages');
const {
  KINDS, KIND_BY_PATH, DESTINATIONS, ALL_DESTINATIONS, MEAL_PLANS: PRODUCT_MEAL_PLANS, productLines, productMap, cardPrice, describe, parseProductDetails, publishedProduct,
  kindMarkupsFromForm, quoteKindMarkupsFromForm, kindMarkups, seasonOn, soldOutOn, listOf, tierPrices, TIERS, activeTier
} = require('../products');
const { withCover, coverFrom } = require('../photos');
const { persistFile, writePersisted, restoreFile, deleteFile } = require('../files');
const { INDIAN_STATES } = require('../invoice-view');
const { paging, pageOf } = require('../paging');
const { reportPeriod, sendCsv, txnLabel, normUtr, UTR_SQL } = require('../report-utils');
const { COUNTRIES, isIndia, kycLabel, requiredFiles, withKycDocs, checkTax, checkKycFiles, missingKyc, profileGaps, removeDoc, removeUploaded } = require('../kyc');

const router = express.Router();
router.param('id', idParam);
router.param('itemId', idParam);
router.use(requireAgent);
router.use(limitPendingAgency);
router.use(limitStaffRole);
// What the agency still has to fill in before it can book (shown on the dashboard, quotes and settings).
router.use((req, res, next) => { res.locals.profileGaps = profileGaps(req.agency); res.locals.tierNow = activeTier(req.agency, res.locals.settings); next(); });
router.use((req, res, next) => { res.locals.agentCan = (href) => staffCan(req.user.agency_role, href.replace(/^\/agent/, '') || '/'); next(); });

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
  const prevMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  // Independent lookups run in parallel; the small counts share one query (each query is a round trip to the database).
  const [followUps, counts, quotes, bookings, leads, upcoming, featuredRows, months, offers] = await Promise.all([
    all(`SELECT l.*, u.name AS assignee FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE ${DUE_FOLLOW_UPS} ORDER BY l.follow_up_on, l.id LIMIT 8`, a, indiaToday()),
    one(
      `SELECT
         COUNT(*) FILTER (WHERE b.status != 'cancelled' AND substr(b.created_at, 1, 7) = ?) AS m_bookings,
         COALESCE(SUM(b.total_sell) FILTER (WHERE b.status != 'cancelled' AND substr(b.created_at, 1, 7) = ?), 0) AS m_sales,
         COALESCE(SUM(b.total_sell - b.total_net - b.total_cost) FILTER (WHERE b.status != 'cancelled' AND substr(b.created_at, 1, 7) = ?), 0) AS m_earnings,
         COALESCE(SUM(b.total_sell - b.total_net - b.total_cost) FILTER (WHERE b.status != 'cancelled' AND substr(b.created_at, 1, 7) = ?), 0) AS prev_earnings,
         COUNT(*) FILTER (WHERE b.status != 'cancelled') AS life_n,
         COALESCE(SUM(b.total_sell - b.total_net - b.total_cost) FILTER (WHERE b.status != 'cancelled'), 0) AS life_earnings,
         MIN(b.created_at) FILTER (WHERE b.status != 'cancelled') AS life_first,
         (SELECT COUNT(*) FROM leads WHERE agency_id = ? AND status IN ('new', 'contacted')) AS open_leads,
         (SELECT COUNT(*) FROM customers WHERE agency_id = ?) AS customers,
         (SELECT COUNT(*) FROM quotes WHERE agency_id = ? AND status = 'sent') AS awaiting,
         EXISTS (SELECT 1 FROM packages WHERE agency_id = ?) AS has_package
       FROM bookings b WHERE b.agency_id = ?`, month, month, month, prevMonth, a, a, a, a, a,
    ),
    all('SELECT * FROM quotes WHERE agency_id = ? ORDER BY updated_at DESC LIMIT 5', a),
    all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 5', a),
    all("SELECT * FROM leads WHERE agency_id = ? AND status = 'new' ORDER BY id DESC LIMIT 5", a),
    all(`SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, p.destination FROM bookings b
         LEFT JOIN customers c ON c.id = b.customer_id LEFT JOIN quotes q ON q.id = b.quote_id LEFT JOIN packages p ON p.id = q.package_id
         WHERE b.agency_id = ? AND b.status = 'confirmed' AND b.travel_date >= ? ORDER BY b.travel_date LIMIT 5`, a, indiaToday()),
    all("SELECT * FROM products WHERE status = 'published' ORDER BY created_at DESC, id DESC LIMIT 5"),
    // Last 6 calendar months, oldest first, including months without bookings.
    all(
      `SELECT substr(created_at, 1, 7) AS month, SUM(total_sell - total_net - total_cost) AS earnings, COUNT(*) AS n FROM bookings
       WHERE agency_id = ? AND status != 'cancelled' AND created_at >= sqldate('now', 'start of month', '-5 months') GROUP BY month`, a,
    ),
    liveOffers(3),
  ]);
  const stats = { bookings: counts.m_bookings, sales: counts.m_sales, earnings: counts.m_earnings };
  const openLeads = counts.open_leads;
  const hasPackage = Boolean(counts.has_package);
  const prev = { earnings: counts.prev_earnings };
  const life = { n: counts.life_n, earnings: counts.life_earnings, first: counts.life_first };
  const customersCount = counts.customers;
  const awaiting = counts.awaiting;
  const hour = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const daysTo = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${indiaToday()}T00:00:00Z`)) / 864e5);
  const trips = upcoming.map((b) => ({ ...b, days: daysTo(b.travel_date), who: b.customer_name || (b.title.split(' — ')[1] || ''), trip: b.title.split(' — ')[0] }));
  const lastQuote = quotes.find((q) => ['draft', 'sent', 'accepted'].includes(q.status)) || null;
  const personal = { greeting, prevEarnings: prev.earnings, life, customersCount, trips, lastQuote, awaiting, weekTrips: trips.filter((t) => t.days <= 7).length };
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
  const services = Object.entries(KIND_BY_PATH).map(([path, kind]) => ({ path, kind, label: KINDS[kind].plural, icon: KINDS[kind].icon, categories: KINDS[kind].categories }));
  const credit = svc.creditStatus(req.agency);
  const lowWallet = req.agency.low_balance_alert > 0 && req.agency.wallet_balance < req.agency.low_balance_alert;
  res.page('agent/dashboard', { title: 'Dashboard', personal, followUps, credit, lowWallet, today: indiaToday(), stats, openLeads, quotes, bookings, leads, upcoming, featured, branded, chart, checklist, offers, services, destinations: Object.keys(DESTINATIONS) });
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
    date: /^\d{4}-\d{2}-\d{2}$/.test(src.date || '') ? src.date : '',
  };
}
const ownPackages = async (agencyId) => await all('SELECT id, title, nights, destination FROM packages WHERE agency_id = ? ORDER BY updated_at DESC', agencyId);

// Dashboard booking panel: send the agent to the chosen service's catalogue with the destination and search applied.
// The dashboard search: each service tab has its own fields, named <service>_dest / _q / _cat (plain dest / q also work).
router.get('/find', (req, res) => {
  const path = KIND_BY_PATH[req.query.svc] ? req.query.svc : 'hotels';
  const field = (k) => req.query[`${path}_${k}`] ?? req.query[k];
  const qs = new URLSearchParams();
  if (DESTINATIONS[field('dest')]) qs.set('dest', field('dest'));
  const q = str(field('q')).slice(0, 80);
  if (q) qs.set('q', q);
  if (KINDS[KIND_BY_PATH[path]].categories.includes(field('cat'))) qs.set('category', field('cat'));
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
    const products = found.rows.map(withPrices(req.agency, res.locals.settings));
    const cities = (await all("SELECT city, country, COUNT(*) AS n FROM products WHERE status = 'published' AND kind = ? GROUP BY city, country ORDER BY country, city", kind))
      .filter((c) => !f.dest || DESTINATIONS[f.dest].includes(c.country) || c.country === ALL_DESTINATIONS);
    const services = Object.entries(KIND_BY_PATH).map(([p, k]) => ({ path: p, kind: k, label: KINDS[k].plural, icon: KINDS[k].icon }));
    res.page('agent/catalogue', { title: cfg.plural, kind, cfg, products, pager: found.pager, cities, f, services, destinations: Object.keys(DESTINATIONS) });
  }));

  router.get(`/${path}/:id`, h(async (req, res, next) => {
    const raw = await publishedProduct(num(req.params.id), kind);
    const p = tierPrices(req.agency, raw, res.locals.settings);
    if (!p) return next();
    const party = partyOf(req.query);
    const lines = productLines(p, party).map((l) => ({ ...l, supplier: 'vaayu', sell: null }));
    const own = ownMarkup(req.query);
    const [moreRows, quotes, packages, customers] = await Promise.all([
      all("SELECT * FROM products WHERE status = 'published' AND kind = ? AND city = ? AND id != ? ORDER BY net_adult LIMIT 4", kind, p.city, p.id),
      openQuotes(req.agency.id), ownPackages(req.agency.id), customersOf(req.agency.id),
    ]);
    const more = moreRows.map(withPrices(req.agency, res.locals.settings));
    res.page('agent/product', {
      title: p.title, kind, cfg, p: withPrices(req.agency, res.locals.settings)(p), d: parseProductDetails(p.details), party, lines, priced: priceLines(own || req.agency, lines), more,
      own, defaultRule: markupRule(req.agency, kind),
      // What the tier saves on this calculation (net, before markup).
      tierSaving: p.tier ? Math.max(0, priceLines(own || req.agency, productLines(raw, party).map((l) => ({ ...l, supplier: 'vaayu', sell: null }))).net - priceLines(own || req.agency, lines).net) : 0, season: seasonOn(p, party.date), soldOut: soldOutOn(p, party.date), seasons: listOf(p.seasons), blackouts: listOf(p.blackouts),
      quotes, packages, customers, mealPlans: PRODUCT_MEAL_PLANS,
    });
  }));

  router.post(`/${path}/:id/quote`, h(async (req, res, next) => {
    const p = tierPrices(req.agency, await publishedProduct(num(req.params.id), kind), res.locals.settings);
    if (!p) return next();
    const party = partyOf(req.body);
    let quoteId = num(req.body.quote_id, 0);
    if (quoteId) {
      const q = await one('SELECT status, travel_date FROM quotes WHERE id = ? AND agency_id = ?', quoteId, req.agency.id);
      if (!q) throw new svc.AppError('Quote not found');
      assertEditable(q);
      if (!party.date && q.travel_date) party.date = q.travel_date;
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
      const ownLines = productLines(p, party);
      if (ownLines.some((l) => l.soldOut)) throw new svc.AppError(`${p.title} is sold out on ${party.date}. Choose another date.`);
      const priced = priceLines(own, ownLines.map((l) => ({ ...l, supplier: 'vaayu', sell: null })));
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

async function ownPackage(req, id) {
  return await one('SELECT * FROM packages WHERE id = ? AND agency_id = ?', id, req.agency.id);
}
const builderData = (req, pkg, details) => buildWith(req.agency, pkg, details, { KINDS, MEAL_PLANS, STAY_TYPES, EXTRA_TYPES });

router.get('/packages', h(async (req, res) => {
  const rows = await all(
    'SELECT p.*, (SELECT COUNT(*) FROM quotes q WHERE q.package_id = p.id) AS quotes FROM packages p WHERE p.agency_id = ? ORDER BY p.updated_at DESC', req.agency.id,
  );
  const details = rows.map((p) => parseDetails(p.details));
  const products = await productMap(details.flatMap(itemIds)); // one query for every package's services
  const packages = await Promise.all(rows.map(async (p, i) => {
    const d = details[i];
    return { ...p, price: await fromPrice(req.agency, p, d, products), services: d.items.length, problems: publishProblems(p, d) };
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
  const calc = await calcPackage(pkg, details, req.query, products, req.agency);
  res.page('agent/package', {
    title: pkg.title, pkg, details, calc, priced: priceLines(req.agency, calc.lines),
    view: await present(pkg, details, products), from: await fromPrice(req.agency, pkg, details, products),
    problems: publishProblems(pkg, details), customers: await customersOf(req.agency.id),
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
  req.flash('success', status === 'published' ? 'Published: shown on your website (when VaayuTrip has built one for you) and through the API.' : 'Unpublished.');
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

// ---------- VaayuTrip packages: ready-made by VaayuTrip, sold as they are or copied into My packages ----------

router.get('/vaayutrip-packages', h(async (req, res) => {
  const dest = str(req.query.destination);
  const [rows, destinations] = await Promise.all([
    all(`SELECT * FROM packages WHERE agency_id IS NULL AND status = 'published' ${dest ? 'AND destination = ?' : ''} ORDER BY updated_at DESC`, ...(dest ? [dest] : [])),
    all("SELECT destination, COUNT(*) AS n FROM packages WHERE agency_id IS NULL AND status = 'published' GROUP BY destination ORDER BY destination"),
  ]);
  // Products and departures for every card in two queries, not two per package.
  const details = rows.map((p) => parseDetails(p.details));
  const [products, deps] = await Promise.all([productMap(details.flatMap(itemIds)), svc.departuresOfMany(rows.map((p) => p.id))]);
  const packages = await Promise.all(rows.map(async (p, i) => ({ ...p, price: await fromPrice(req.agency, p, details[i], products), next: deps.get(p.id).find((d) => d.left > 0) || null })));
  res.page('agent/vaayu-packages', { title: 'VaayuTrip packages', packages, destinations, dest });
}));

router.get('/vaayutrip-packages/:id', h(async (req, res, next) => {
  const pkg = await vaayuPackage(num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  const products = await productMap(itemIds(details));
  const calc = await calcPackage(pkg, details, req.query, products, req.agency);
  const stdNet = res.locals.tierNow.tier !== 'standard' ? priceLines(req.agency, (await calcPackage(pkg, details, req.query, products, null)).lines).net : 0;
  const [view, from, customers, copies, departures] = await Promise.all([
    present(pkg, details, products), fromPrice(req.agency, pkg, details, products), customersOf(req.agency.id),
    all('SELECT id, title FROM packages WHERE agency_id = ? AND copied_from = ?', req.agency.id, pkg.id),
    svc.departuresOf(pkg.id),
  ]);
  res.page('agent/vaayu-package', {
    title: pkg.title, pkg, details, calc, priced: priceLines(req.agency, calc.lines),
    view, from, customers, copies, departures,
    tierSaving: stdNet ? Math.max(0, stdNet - priceLines(req.agency, calc.lines).net) : 0,
  });
}));

router.post('/vaayutrip-packages/:id/quote', h(async (req, res, next) => {
  const pkg = await vaayuPackage(num(req.params.id));
  if (!pkg) return next();
  const customerId = num(req.body.customer_id, 0);
  const quoteId = await svc.createQuoteFromPackage(req.agency, pkg.id, {
    adults: req.body.adults, children: req.body.children, infants: req.body.infants, rooms: req.body.rooms, date: str(req.body.date),
    customerId: customerId && await one('SELECT 1 FROM customers WHERE id = ? AND agency_id = ?', customerId, req.agency.id) ? customerId : null,
  });
  await audit(req.user, 'quote.created', { entity: 'quote', id: quoteId, summary: `From VaayuTrip package: ${pkg.title}` });
  req.flash('success', 'Quote created from the VaayuTrip package. Adjust it if you like, then share it with your customer.');
  res.redirect(`/agent/quotes/${quoteId}`);
}));

// Copy into My packages (to change hotels, days or add own services), optionally straight onto the agent's website.
router.post('/vaayutrip-packages/:id/copy', h(async (req, res, next) => {
  const pkg = await vaayuPackage(num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  const publish = req.body.publish === '1' && !publishProblems(pkg, details).length;
  const id = await insertPackage(req.agency, pkg, details, publish ? 'published' : 'draft');
  await run('UPDATE packages SET copied_from = ? WHERE id = ?', pkg.id, id);
  await audit(req.user, 'package.created', { entity: 'package', id, summary: `Copied VaayuTrip package: ${pkg.title}` });
  if (publish) {
    req.flash('success', `${pkg.title} copied and published${req.agency.website_status === 'live' ? ': it shows on your website' : ''}.`);
    return res.redirect(`/agent/packages/${id}`);
  }
  req.flash('success', 'Copied to My packages. Change anything you like and save.');
  res.redirect(`/agent/packages/${id}/edit`);
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
  const [paying, settings, invoices, booking, customers] = await Promise.all([
    // Back from paying online but the return page was missed: confirm it now (the booking is made if it went through).
    one("SELECT order_id FROM payments WHERE purpose = 'booking' AND ref_id = ? AND agency_id = ? AND status = 'pending' ORDER BY id DESC", full.quote.id, req.agency.id),
    getSettings(),
    all('SELECT * FROM invoices WHERE quote_id = ? ORDER BY id DESC', full.quote.id),
    one('SELECT * FROM bookings WHERE quote_id = ? ORDER BY id DESC', full.quote.id),
    customersOf(req.agency.id),
  ]);
  if (paying) {
    const p = await payments.settle(paying.order_id).catch(() => null);
    if (p?.bookingId) { req.flash('success', 'Your online payment went through and the booking is confirmed.'); return res.redirect(`/agent/bookings/${p.bookingId}`); }
    if (p?.status === 'pending') full.payingOnline = true;
  }
  const customerTotal = withTax(full.priced.sell, settings, { international: Boolean(full.quote.is_international) });
  // An offer code applied on this quote: its discount now, or why it no longer works.
  let coupon = null;
  if (full.quote.coupon_code && !['booked', 'cancelled'].includes(full.quote.status)) {
    try { coupon = await svc.couponFor(req.agency.id, full, full.quote.coupon_code); } catch (e) {
      if (!(e instanceof svc.AppError)) throw e;
      coupon = { code: full.quote.coupon_code, discount: 0, error: e.message };
    }
  }
  const netPayable = withTax(full.priced.net - (coupon ? coupon.discount : 0), settings);
  const approval = svc.approvalState(full, settings);
  const couponTry = req.session.couponTry && req.session.couponTry.quote === full.quote.id ? req.session.couponTry : null;
  if (req.session.couponTry) req.session.couponTry = null;
  res.page('agent/quote', {
    coupon, couponTry, approval,
    kinds: KINDS, kindMarkups, agencyRates: kindMarkups(req.agency),
    title: full.quote.title, ...full, invoices, booking, customerTotal, netPayable, phonepeOn: phonepe.enabled(),
    customers, branded: agencyHasBranding(req.agency),
    pkgView: full.quote.package_snapshot ? JSON.parse(full.quote.package_snapshot) : null,
  });
}));

// Offer codes: applied on the quote before paying; the discount comes off what the agent pays VaayuTrip.
router.post('/quotes/:id/coupon', h(async (req, res) => {
  const full = await ownQuote(req);
  if (['booked', 'cancelled'].includes(full.quote.status)) throw new svc.AppError('This quote is already booked.');
  try {
    const c = await svc.couponFor(req.agency.id, full, req.body.code);
    await run("UPDATE quotes SET coupon_code = ?, updated_at = datetime('now') WHERE id = ?", c.code, full.quote.id);
    req.flash('success', `${c.code} applied: ₹${c.discount.toLocaleString('en-IN')} off what you pay VaayuTrip.`);
  } catch (e) {
    if (!(e instanceof svc.AppError)) throw e;
    // Shown inside the offer-code box (the page opens there), with the code kept in the field.
    req.session.couponTry = { quote: full.quote.id, code: String(req.body.code || '').trim().toUpperCase().slice(0, 30), error: e.message };
  }
  res.redirect(`/agent/quotes/${full.quote.id}#pay`);
}));

router.post('/quotes/:id/coupon/remove', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  if (!['booked', 'cancelled'].includes(quote.status)) await run('UPDATE quotes SET coupon_code = NULL WHERE id = ?', quote.id);
  req.flash('success', 'Offer code removed.');
  res.redirect(`/agent/quotes/${quote.id}#pay`);
}));

router.post('/quotes/:id', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const b = req.body;
  const mode = 'agent';
  const locked = ['booked', 'cancelled'].includes(quote.status);
  await run(
    `UPDATE quotes SET title = ?, customer_id = ?, travel_date = ?, adults = ?, children = ?, notes = ?, invoice_mode = ?, show_service_fee = ?, emi_enabled = ?, pay_online = ?,
       markup_type = ?, markup_value = ?, markup_by_kind = ?, updated_at = datetime('now') WHERE id = ?`,
    str(b.title) || quote.title, num(b.customer_id, 0) || null, str(b.travel_date) || null, Math.max(1, num(b.adults, 1)), Math.max(0, num(b.children, 0)),
    str(b.notes) || null, mode, b.show_service_fee ? 1 : 0, b.emi_enabled ? 1 : 0, b.pay_online ? 1 : 0,
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

// A fresh draft with the same services, markup and itinerary: for the next customer on the same trip.
router.post('/quotes/:id/duplicate', h(async (req, res, next) => {
  const q = await one('SELECT * FROM quotes WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!q) return next();
  const id = await tx(async () => {
    const newId = (await run(
      `INSERT INTO quotes (agency_id, package_id, code, title, adults, children, infants, markup_type, markup_value, markup_by_kind, invoice_mode,
         show_service_fee, notes, emi_enabled, is_international, package_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.agency.id, q.package_id, code('Q'), `${q.title} (copy)`.slice(0, 200), q.adults, q.children, q.infants, q.markup_type, q.markup_value, q.markup_by_kind,
      q.invoice_mode, q.show_service_fee, q.notes, q.emi_enabled, q.is_international, q.package_snapshot,
    )).lastInsertRowid;
    await run(
      `INSERT INTO quote_items (quote_id, type, title, description, supplier, net_price, sell_price, qty, sort, product_id, cost)
       SELECT ?, type, title, description, supplier, net_price, sell_price, qty, sort, product_id, cost FROM quote_items WHERE quote_id = ? ORDER BY sort, id`,
      newId, q.id,
    );
    return newId;
  });
  req.flash('success', 'Quote copied as a new draft. Pick the customer and travel date, then send it.');
  res.redirect(`/agent/quotes/${id}`);
}));

// The quote for the customer, as a page to print or save as PDF (customers have no access to the portal).
router.get('/quotes/:id/pdf', h(async (req, res) => {
  const full = await ownQuote(req);
  const settings = await getSettings();
  const doc = buildInvoice('customer_agent', { ...full, agency: req.agency, settings });
  res.page('public/quote', {
    title: `${full.quote.title} — quote`, ...full, agency: req.agency, settings, kind: 'customer_agent', doc, agentItems: [], total: doc.totals.total,
    pkgView: full.quote.package_snapshot ? JSON.parse(full.quote.package_snapshot) : null, back: `/agent/quotes/${full.quote.id}`, noindex: true, site: req.agency,
  }, 'doc');
}));

// The customer said yes (by phone, WhatsApp …): the agent records it.
router.post('/quotes/:id/accepted', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  if (['draft', 'sent'].includes(quote.status)) await run("UPDATE quotes SET status = 'accepted', updated_at = datetime('now') WHERE id = ?", quote.id);
  req.flash('success', 'Marked as accepted by your customer. Book it to confirm.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

router.post('/quotes/:id/send', h(async (req, res) => {
  const { quote, items } = await ownQuote(req);
  if (!items.length) throw new svc.AppError('Add items before sharing the quote.');
  if (quote.status === 'draft') await run("UPDATE quotes SET status = 'sent', updated_at = datetime('now') WHERE id = ?", quote.id);
  req.flash('success', 'Quote marked as sent.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

// Booking request: VaayuTrip operations confirm availability before the agent pays.
router.post('/quotes/:id/request-booking', requireActiveAgency, h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const { full } = await svc.bookable(req.agency.id, quote.id, { skipApproval: true });
  if (quote.approval_status === 'requested') { req.flash('success', 'Already sent. VaayuTrip operations will reply shortly.'); return res.redirect(`/agent/quotes/${quote.id}`); }
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  await run(`UPDATE quotes SET approval_status = 'requested', approval_net = ?, approval_requested_at = datetime('now'), approval_requested_by = ?, approval_request_note = ?,
    approval_decided_at = NULL, approval_decided_by = NULL, approval_note = NULL, approval_until = NULL WHERE id = ?`, full.priced.net, req.user.id, note, quote.id);
  const summary = `${req.agency.name}: ${quote.title} (${quote.code}), net ₹${full.priced.net.toLocaleString('en-IN')}${quote.travel_date ? `, travel ${new Date(quote.travel_date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}` : ''}`;
  await notify(null, 'New booking request', summary, `/backend/booking-requests/${quote.id}`);
  const team = (await all("SELECT email FROM users WHERE role = 'backend' AND is_active = 1")).map((u) => u.email);
  const mailer = require('../mailer');
  if (team.length && mailer.enabled()) mailer.send({ to: team, subject: `Booking request: ${quote.title}`, text: summary, button: { href: `${mailer.siteUrl()}/backend/booking-requests/${quote.id}`, label: 'Review request' } }).catch(() => false);
  await audit(req.user, 'booking.requested', { entity: 'quote', id: quote.id, summary, link: `/backend/booking-requests/${quote.id}` });
  req.flash('success', 'Booking request sent to VaayuTrip operations. You will be notified when it is approved, then you can pay.');
  res.redirect(`/agent/quotes/${quote.id}`);
}));

router.post('/quotes/:id/withdraw-request', h(async (req, res) => {
  const { quote } = await ownQuote(req);
  if (quote.approval_status === 'requested') {
    await run('UPDATE quotes SET approval_status = NULL WHERE id = ?', quote.id);
    await audit(req.user, 'booking.request_withdrawn', { entity: 'quote', id: quote.id, summary: quote.title });
  }
  req.flash('success', 'Booking request withdrawn.');
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

// Pay for this booking by card / UPI / net banking (PhonePe) instead of the wallet or credit. The booking is made as
// soon as PhonePe confirms the payment (on return, by webhook or by the background check).
router.post('/quotes/:id/pay-online', requireActiveAgency, h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const { payable } = await svc.bookable(req.agency.id, quote.id);
  if (payable > MAX_AMOUNT) throw new svc.AppError('This booking is too large to pay online in one go. Pay from your wallet, or contact VaayuTrip.');
  const waiting = await one("SELECT order_id FROM payments WHERE purpose = 'booking' AND ref_id = ? AND agency_id = ? AND status = 'pending' AND created_at > datetime('now', '-15 minutes')", quote.id, req.agency.id);
  if (waiting) {
    try { const p = await payments.settle(waiting.order_id); if (p.bookingId) return res.redirect(`/agent/bookings/${p.bookingId}`); } catch { /* PhonePe unreachable: treat as still pending */ }
    const still = await one("SELECT status FROM payments WHERE order_id = ?", waiting.order_id);
    if (still.status === 'pending') throw new svc.AppError('A payment for this quote was started a few minutes ago and PhonePe is still confirming it. Please wait a few minutes before paying again.');
  }
  await audit(req.user, 'booking.pay_online_started', { entity: 'quote', id: quote.id, summary: `${quote.title}: ₹${payable.toLocaleString('en-IN')} online` });
  res.redirect(303, await payments.startPayment({ purpose: 'booking', agencyId: req.agency.id, refId: quote.id, amount: payable, origin: res.locals.origin, note: `Booking ${quote.code}`, payerRef: `A${req.agency.id}` }));
}));

router.post('/quotes/:id/invoice', requireActiveAgency, h(async (req, res) => {
  const { quote } = await ownQuote(req);
  const kind = 'customer_agent';
  const booking = await one('SELECT id FROM bookings WHERE quote_id = ? ORDER BY id DESC', quote.id);
  const id = await svc.issueInvoice(req.agency, quote.id, kind, booking?.id || null);
  req.flash('success', 'Invoice issued. Print it, save as PDF, or share the link with your customer.');
  res.redirect(`/agent/invoices/${id}`);
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
  const [full, invoices, heroProduct] = await Promise.all([
    booking.quote_id ? svc.getQuote(booking.quote_id, req.agency.id) : null,
    all('SELECT * FROM invoices WHERE booking_id = ? OR (quote_id = ? AND quote_id IS NOT NULL) ORDER BY id DESC', booking.id, booking.quote_id),
    // Trips not built from a package take their cover photo from the first VaayuTrip service in them.
    booking.quote_id ? one(`SELECT p.image_url, p.city, p.title FROM quote_items i JOIN products p ON p.id = i.product_id
      WHERE i.quote_id = ? ORDER BY i.sort, i.id LIMIT 1`, booking.quote_id) : null,
  ]);
  res.page('agent/booking', { title: `Booking ${booking.code}`, booking, full, invoices, heroProduct });
}));

router.get('/bookings/:id/voucher', h(async (req, res, next) => {
  const booking = await one('SELECT * FROM bookings WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  const v = await svc.voucherFor(booking);
  if (!v) return next();
  res.page('voucher', { title: `Voucher ${booking.code}`, ...v, back: `/agent/bookings/${booking.id}`, noindex: true, site: req.agency }, 'doc');
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
       (SELECT COALESCE(SUM(total_sell), 0) FROM bookings b WHERE b.customer_id = c.id AND b.status != 'cancelled') AS spend,
       (SELECT MIN(travel_date) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.travel_date >= ?) AS next_trip
     FROM customers c WHERE c.agency_id = ? ${q ? 'AND (c.name ILIKE ? OR c.phone ILIKE ? OR c.email ILIKE ?)' : ''} ORDER BY c.name, c.id ${p.sql}`,
    indiaToday(), req.agency.id, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), ...p.params,
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
  const docs = await all('SELECT * FROM traveller_docs WHERE customer_id = ? ORDER BY traveller, doc_type, id', customer.id);
  const nextTrip = bookings.filter((b) => b.status === 'confirmed' && b.travel_date && b.travel_date >= res.locals.today).map((b) => b.travel_date).sort()[0] || null;
  res.page('agent/customer', { title: customer.name, customer, quotes, bookings, leads, docs, nextTrip, docTypes: DOC_TYPES, states: INDIAN_STATES });
}));

// ---------- travellers' documents ----------

const DOC_TYPES = { passport: 'Passport', visa: 'Visa', photo: 'Photo', ticket: 'Ticket', insurance: 'Insurance', other: 'Other' };
const DOC_FILES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const TRAVEL_DIR = path.join(DATA_DIR, 'travel');
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Boolean(DOC_FILES[file.mimetype])),
}).single('file');
const ownCustomer = (req) => one('SELECT * FROM customers WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);

router.post('/customers/:id/docs', (req, res, next) => docUpload(req, res, (err) => {
  if (err) { req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 4 MB. Upload a smaller scan or photo.' : 'Upload failed. Try again.'); return res.redirect(`/agent/customers/${num(req.params.id)}#docs`); }
  next();
}), h(async (req, res, next) => {
  const customer = await ownCustomer(req);
  if (!customer) return next();
  if (!req.file) throw new svc.AppError('Choose a PDF or photo (JPG, PNG or WebP).');
  const name = `${req.agency.id}-${customer.id}-${crypto.randomBytes(12).toString('hex')}${DOC_FILES[req.file.mimetype]}`;
  const abs = path.join(TRAVEL_DIR, name);
  await writePersisted(abs, req.file.buffer);
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on || '') ? req.body.expires_on : null;
  await run('INSERT INTO traveller_docs (agency_id, customer_id, traveller, doc_type, doc_number, expires_on, file_path, file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    req.agency.id, customer.id, str(req.body.traveller).slice(0, 80) || customer.name, DOC_TYPES[req.body.doc_type] ? req.body.doc_type : 'other',
    str(req.body.doc_number).slice(0, 40) || null, expires, `data/travel/${name}`, String(req.file.originalname || '').slice(0, 120));
  await audit(req.user, 'traveller_doc.added', { entity: 'customer', id: customer.id, summary: `${DOC_TYPES[req.body.doc_type] || 'Document'} for ${str(req.body.traveller) || customer.name}`, link: `/agent/customers/${customer.id}` });
  req.flash('success', 'Document saved.');
  res.redirect(`/agent/customers/${customer.id}#docs`);
}));

router.get('/customers/:id/docs/:docId', h(async (req, res, next) => {
  const doc = await one('SELECT * FROM traveller_docs WHERE id = ? AND customer_id = ? AND agency_id = ?', num(req.params.docId), num(req.params.id), req.agency.id);
  if (!doc) return next();
  const abs = path.join(DATA_DIR, doc.file_path.replace(/^data\//, ''));
  if (!await restoreFile(abs)) return next();
  res.set('Cache-Control', 'private, no-store');
  if (req.query.download) return res.download(abs, doc.file_name || path.basename(abs));
  res.sendFile(abs);
}));

router.post('/customers/:id/docs/:docId/delete', h(async (req, res, next) => {
  const doc = await one('SELECT * FROM traveller_docs WHERE id = ? AND customer_id = ? AND agency_id = ?', num(req.params.docId), num(req.params.id), req.agency.id);
  if (!doc) return next();
  await deleteFile(path.join(DATA_DIR, doc.file_path.replace(/^data\//, '')));
  await run('DELETE FROM traveller_docs WHERE id = ?', doc.id);
  await audit(req.user, 'traveller_doc.deleted', { entity: 'customer', id: doc.customer_id, summary: `${DOC_TYPES[doc.doc_type]} for ${doc.traveller}`, link: `/agent/customers/${doc.customer_id}` });
  req.flash('success', 'Document deleted.');
  res.redirect(`/agent/customers/${doc.customer_id}#docs`);
}));

router.post('/customers/:id', h(async (req, res) => {
  const id = num(req.params.id);
  const pan = str(req.body.pan).toUpperCase();
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new svc.AppError('PAN should look like ABCDE1234F.');
  await run('UPDATE customers SET name = ?, email = ?, phone = ?, city = ?, notes = ?, address = ?, state = ?, pan = ? WHERE id = ? AND agency_id = ?',
    str(req.body.name) || 'Customer', str(req.body.email) || null, str(req.body.phone) || null, str(req.body.city) || null, str(req.body.notes) || null,
    str(req.body.address) || null, INDIAN_STATES.includes(req.body.state) ? req.body.state : null, pan || null, id, req.agency.id);
  req.flash('success', 'Customer updated.');
  res.redirect(`/agent/customers/${id}`);
}));

// ---------- leads ----------

const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

// Open leads whose follow-up date has come (today in India, or earlier).
const DUE_FOLLOW_UPS = "l.agency_id = ? AND l.follow_up_on IS NOT NULL AND l.follow_up_on <= ? AND l.status NOT IN ('won', 'lost')";
const indiaToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

router.get('/leads', h(async (req, res) => {
  const due = req.query.due === '1';
  const status = !due && LEAD_STATUSES.includes(req.query.status) ? req.query.status : '';
  const leads = await all(
    `SELECT l.*, p.title AS package_title, u.name AS assignee FROM leads l LEFT JOIN packages p ON p.id = l.package_id LEFT JOIN users u ON u.id = l.assigned_to
     WHERE ${due ? DUE_FOLLOW_UPS : `l.agency_id = ? ${status ? 'AND l.status = ?' : ''}`} ORDER BY ${due ? 'l.follow_up_on, l.id' : 'l.id DESC'}`,
    req.agency.id, ...(due ? [indiaToday()] : status ? [status] : []),
  );
  const [countRows, due1, staff, packages] = await Promise.all([
    all('SELECT status, COUNT(*) AS n FROM leads WHERE agency_id = ? GROUP BY status', req.agency.id),
    one(`SELECT COUNT(*) AS n FROM leads l WHERE ${DUE_FOLLOW_UPS}`, req.agency.id, indiaToday()),
    all("SELECT id, name FROM users WHERE agency_id = ? AND is_active = 1 AND agency_role IN ('owner', 'sales') ORDER BY name", req.agency.id),
    ownPackages(req.agency.id),
  ]);
  const counts = Object.fromEntries(countRows.map((r) => [r.status, r.n]));
  res.page('agent/leads', { title: 'Leads', leads, status, due, dueCount: due1.n, counts, statuses: LEAD_STATUSES, staff, packages });
}));

router.post('/leads/:id/follow-up', h(async (req, res, next) => {
  const lead = await one('SELECT id FROM leads WHERE id = ? AND agency_id = ?', num(req.params.id), req.agency.id);
  if (!lead) return next();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.follow_up_on || '') ? req.body.follow_up_on : null;
  const assignee = num(req.body.assigned_to, 0) && await one('SELECT id FROM users WHERE id = ? AND agency_id = ?', num(req.body.assigned_to, 0), req.agency.id);
  await run('UPDATE leads SET follow_up_on = ?, follow_up_note = ?, assigned_to = ? WHERE id = ?', date, date ? str(req.body.follow_up_note).slice(0, 200) || null : null, assignee ? assignee.id : null, lead.id);
  req.flash('success', date ? `Follow-up set for ${fmtDate(date)}.` : 'Follow-up cleared.');
  res.redirect(req.get('referer') || '/agent/leads');
}));

router.post('/leads', h(async (req, res) => {
  const name = str(req.body.name);
  if (!name) throw new svc.AppError('Lead name is required.');
  const followUp = /^\d{4}-\d{2}-\d{2}$/.test(req.body.follow_up_on || '') ? req.body.follow_up_on : null;
  await run('INSERT INTO leads (agency_id, follow_up_on, assigned_to, name, phone, email, destination, travel_date, pax, budget, package_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.agency.id, followUp, followUp ? req.user.id : null, name, str(req.body.phone) || null, str(req.body.email) || null, str(req.body.destination) || null, str(req.body.travel_date) || null,
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
  await payments.settlePending({ agencyId: req.agency.id, olderThanMinutes: 1 }).catch(() => 0);
  const txns = await all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 100', req.agency.id);
  const requests = await all('SELECT * FROM topup_requests WHERE agency_id = ? ORDER BY id DESC LIMIT 10', req.agency.id);
  res.page('agent/wallet', { title: 'Wallet & credit', txns, requests, phonepeOn: phonepe.enabled(), credit: svc.creditStatus(req.agency) });
}));

// A bank-style account statement for a period, printable as a PDF.
router.get('/wallet/statement', h(async (req, res) => {
  const { from, to } = reportPeriod(req.query, 30);
  const before = await one('SELECT balance_after FROM wallet_txns WHERE agency_id = ? AND sqldate(created_at) < ? ORDER BY id DESC LIMIT 1', req.agency.id, from);
  const txns = await all('SELECT * FROM wallet_txns WHERE agency_id = ? AND sqldate(created_at) BETWEEN ? AND ? ORDER BY id', req.agency.id, from, to);
  const opening = before ? before.balance_after : 0;
  const credits = round2(txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const debits = round2(txns.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0));
  res.page('agent/statement', {
    title: `Account statement ${from} to ${to}`, from, to, txns, opening, credits, debits, txnLabel,
    closing: txns.length ? txns[txns.length - 1].balance_after : opening, settings: await getSettings(), back: '/agent/wallet', noindex: true,
  }, 'doc');
}));

router.post('/wallet/repay', requireActiveAgency, h(async (req, res) => {
  const paid = await svc.repayCredit(req.agency.id, round2(num(req.body.amount, 0)) || req.agency.credit_used);
  await audit(req.user, 'credit.repaid', { entity: 'agency', id: req.agency.id, summary: `₹${paid.toLocaleString('en-IN')}`, link: '/agent/wallet' });
  req.flash('success', `₹${paid.toLocaleString('en-IN')} of credit repaid from your wallet.`);
  res.redirect('/agent/wallet');
}));

router.post('/wallet/alert', h(async (req, res) => {
  const v = round2(Math.min(MAX_AMOUNT, Math.max(0, num(req.body.low_balance_alert, 0))));
  await run('UPDATE agencies SET low_balance_alert = ? WHERE id = ?', v, req.agency.id);
  req.flash('success', v ? `We'll alert you when your wallet drops below ₹${v.toLocaleString('en-IN')}.` : 'Low-balance alert switched off.');
  res.redirect('/agent/wallet');
}));

router.post('/wallet/topup', requireActiveAgency, h(async (req, res) => {
  const amount = round2(num(req.body.amount, 0));
  if (amount < 100) throw new svc.AppError('Minimum top-up is ₹100.');
  if (amount > MAX_AMOUNT) throw new svc.AppError('That amount is too large for one top-up. Split it, or contact VaayuTrip.');
  if (req.body.method === 'phonepe') {
    const id = (await run("INSERT INTO topup_requests (agency_id, amount, method) VALUES (?, ?, 'phonepe')", req.agency.id, amount)).lastInsertRowid;
    await audit(req.user, 'topup.phonepe_started', { entity: 'topup', id, summary: `₹${amount.toLocaleString('en-IN')} via PhonePe`, link: '/admin/topups' });
    try {
      return res.redirect(303, await payments.startPayment({ purpose: 'topup', agencyId: req.agency.id, refId: id, amount, origin: res.locals.origin, note: `Wallet top-up ${req.agency.name}`, payerRef: `A${req.agency.id}` }));
    } catch (e) {
      await run("UPDATE topup_requests SET status = 'rejected' WHERE id = ?", id);
      throw e;
    }
  }
  const utr = normUtr(req.body.utr);
  if (!utr) throw new svc.AppError('Enter the UTR / reference number of your transfer.');
  if (utr.length < 6 || utr.length > 30) throw new svc.AppError('That UTR doesn\'t look right. It is usually 12 to 22 letters and digits, as shown in your bank app.');
  // One transfer can be credited only once, whoever submits it.
  const seen = await one(`SELECT agency_id, status FROM topup_requests WHERE method = 'bank' AND status IN ('pending', 'approved') AND ${UTR_SQL} = ?`, utr);
  if (seen) {
    if (seen.agency_id !== req.agency.id) await notify(null, 'Repeated UTR', `${req.agency.name} tried UTR ${utr}, which is already on another agent's top-up. Check before approving anything with it.`, '/admin/topups');
    throw new svc.AppError(seen.status === 'approved' ? `UTR ${utr} has already been credited to a wallet. Each transfer can be used once.` : `A top-up with UTR ${utr} is already waiting for verification.`);
  }
  await run('INSERT INTO topup_requests (agency_id, amount, utr) VALUES (?, ?, ?)', req.agency.id, amount, utr);
  await notify(null, 'Wallet top-up request', `${req.agency.name} requested ₹${amount.toLocaleString('en-IN')} (UTR ${utr}).`, '/admin/topups');
  await audit(req.user, 'topup.requested', { entity: 'topup', summary: `₹${amount.toLocaleString('en-IN')} (UTR ${utr})`, link: '/admin/topups' });
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
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, ...await invoiceView(inv), back: '/agent/invoices', noindex: true, site: inv.kind === 'customer_agent' ? req.agency : null }, 'doc');
}));

// ---------- website, API, notifications, settings ----------

// Websites are built by VaayuTrip's team on the agency's own domain and connected to the portal through the API.
router.get('/website', h(async (req, res) => {
  res.page('agent/website', { title: 'My website' });
}));

router.post('/website/request', h(async (req, res) => {
  if (['requested', 'in_progress', 'live'].includes(req.agency.website_status)) return res.redirect('/agent/website');
  const domain = str(req.body.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 100);
  const note = [domain && `Domain: ${domain}`, str(req.body.phone) && `Call: ${str(req.body.phone)}`, str(req.body.message)].filter(Boolean).join('\n').slice(0, 1000);
  await run("UPDATE agencies SET website_status = 'requested', website_domain = ?, website_request = ?, website_requested_at = datetime('now') WHERE id = ?", domain || null, note || null, req.agency.id);
  await notify(null, 'Website request', `${req.agency.name} wants its own website${domain ? ` on ${domain}` : ''}. Call ${str(req.body.phone) || req.agency.phone || 'them'} with the charges.`, `/admin/agents/${req.agency.id}#website`);
  await audit(req.user, 'website.requested', { entity: 'agency', id: req.agency.id, summary: domain || 'Website request' });
  req.flash('success', 'Request sent. Our team will call you with the charges and next steps.');
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

// ---------- team (agency staff logins; owners only, see limitStaffRole) ----------

router.get('/team', h(async (req, res) => {
  const team = await all(
    `SELECT u.id, u.name, u.email, u.phone, u.agency_role, u.is_active,
       (SELECT MAX(l.created_at) FROM audit_log l WHERE l.user_id = u.id AND l.action = 'user.login') AS last_seen
     FROM users u WHERE u.agency_id = ? ORDER BY u.agency_role = 'owner' DESC, u.name`, req.agency.id,
  );
  res.page('agent/team', { title: 'Team', team, roles: STAFF_ROLES });
}));

const teamMember = (req) => one("SELECT * FROM users WHERE id = ? AND agency_id = ? AND role = 'agent'", num(req.params.id), req.agency.id);
const roleOf = (v) => (STAFF_ROLES[v] ? v : 'sales');

router.post('/team', h(async (req, res) => {
  const name = str(req.body.name).slice(0, 80);
  const email = str(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new svc.AppError('Enter a name and a valid email.');
  if (password.length < 8) throw new svc.AppError('The temporary password must be at least 8 characters.');
  if (await one('SELECT 1 FROM users WHERE email = ?', email)) throw new svc.AppError('Someone already logs in with that email.');
  const role = roleOf(req.body.role);
  const id = (await run("INSERT INTO users (role, agency_id, agency_role, name, email, phone, password_hash) VALUES ('agent', ?, ?, ?, ?, ?, ?)",
    req.agency.id, role, name, email, str(req.body.phone) || null, hashPassword(password))).lastInsertRowid;
  await audit(req.user, 'team.added', { entity: 'user', id, summary: `${name} (${STAFF_ROLES[role].label})`, link: '/agent/team' });
  req.flash('success', `${name} can now log in as ${STAFF_ROLES[role].label}.`);
  res.redirect('/agent/team');
}));

router.post('/team/:id/role', h(async (req, res, next) => {
  const u = await teamMember(req);
  if (!u) return next();
  const role = roleOf(req.body.role);
  if (u.agency_role === 'owner' && role !== 'owner' && (await one("SELECT COUNT(*) AS n FROM users WHERE agency_id = ? AND agency_role = 'owner' AND is_active = 1", req.agency.id)).n < 2) {
    throw new svc.AppError('Keep at least one active owner.');
  }
  await run('UPDATE users SET agency_role = ? WHERE id = ?', role, u.id);
  await audit(req.user, 'team.role', { entity: 'user', id: u.id, summary: `${u.name} → ${STAFF_ROLES[role].label}`, link: '/agent/team' });
  req.flash('success', `${u.name} is now ${STAFF_ROLES[role].label}.`);
  res.redirect('/agent/team');
}));

router.post('/team/:id/password', h(async (req, res, next) => {
  const u = await teamMember(req);
  if (!u) return next();
  const password = String(req.body.password || '');
  if (password.length < 8) throw new svc.AppError('The password must be at least 8 characters.');
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  await audit(req.user, 'team.password_reset', { entity: 'user', id: u.id, summary: u.name, link: '/agent/team' });
  req.flash('success', `New password set for ${u.name}.`);
  res.redirect('/agent/team');
}));

router.post('/team/:id/toggle', h(async (req, res, next) => {
  const u = await teamMember(req);
  if (!u || u.id === req.user.id) return next();
  await run('UPDATE users SET is_active = ? WHERE id = ?', u.is_active ? 0 : 1, u.id);
  await audit(req.user, u.is_active ? 'team.deactivated' : 'team.reactivated', { entity: 'user', id: u.id, summary: u.name, link: '/agent/team' });
  req.flash('success', u.is_active ? `${u.name} can no longer log in.` : `${u.name} can log in again.`);
  res.redirect('/agent/team');
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

router.get('/reports', h(async (req, res) => {
  const a = req.agency.id;
  const { from, to } = reportPeriod(req.query);
  const range = [a, from, to];
  const inRange = "agency_id = ? AND sqldate(created_at) BETWEEN ? AND ?";
  const [totals, months, destinations, customers] = await Promise.all([
    one(
      `SELECT COUNT(*) FILTER (WHERE status != 'cancelled') AS bookings,
         COALESCE(SUM(total_sell) FILTER (WHERE status != 'cancelled'), 0) AS sales,
         COALESCE(SUM(total_net) FILTER (WHERE status != 'cancelled'), 0) AS net,
         COALESCE(SUM(total_sell - total_net - total_cost) FILTER (WHERE status != 'cancelled'), 0) AS earnings,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
         COALESCE(SUM(refund_amount) FILTER (WHERE status = 'cancelled'), 0) AS refunds
       FROM bookings WHERE ${inRange}`, ...range,
    ),
    all(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS bookings, SUM(total_sell) AS sales, SUM(total_sell - total_net - total_cost) AS earnings
       FROM bookings WHERE ${inRange} AND status != 'cancelled' GROUP BY month ORDER BY month`, ...range,
    ),
    all(
      `SELECT COALESCE(p.destination, 'Custom trips') AS destination, COUNT(*) AS bookings, SUM(b.total_sell) AS sales, SUM(b.total_sell - b.total_net - b.total_cost) AS earnings
       FROM bookings b LEFT JOIN quotes q ON q.id = b.quote_id LEFT JOIN packages p ON p.id = q.package_id
       WHERE b.agency_id = ? AND sqldate(b.created_at) BETWEEN ? AND ? AND b.status != 'cancelled'
       GROUP BY 1 ORDER BY sales DESC LIMIT 8`, ...range,
    ),
    all(
      `SELECT c.id, c.name, COUNT(*) AS bookings, SUM(b.total_sell) AS sales
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.agency_id = ? AND sqldate(b.created_at) BETWEEN ? AND ? AND b.status != 'cancelled'
       GROUP BY c.id ORDER BY sales DESC LIMIT 5`, ...range,
    ),
  ]);
  res.page('agent/reports', { title: 'Reports', from, to, totals, months, destinations, customers });
}));

router.get('/reports/tcs.csv', h(async (req, res) => {
  const { from, to } = reportPeriod(req.query);
  sendTcsCsv(res, `tcs_${from}_to_${to}.csv`, await tcsRows({ agencyId: req.agency.id, from, to }));
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
       markup_type = ?, markup_value = ?, markup_by_kind = ?, bank_details = ? WHERE id = ?`,
    str(b.name) || req.agency.name, str(b.legal_name) || null, str(b.pan).toUpperCase() || null, str(b.phone) || null,
    str(b.email) || null, str(b.address) || null, str(b.city) || null, /^#[0-9a-f]{6}$/i.test(b.brand_color) ? b.brand_color : '#0e7490', logo,
    b.markup_type === 'flat' ? 'flat' : 'percent', Math.max(0, num(b.markup_value, 0)), kindMarkupsFromForm(b), str(b.bank_details).slice(0, 500) || null, req.agency.id,
  );
  req.flash('success', 'Company profile saved.');
  res.redirect('/agent/settings');
}));

module.exports = router;
