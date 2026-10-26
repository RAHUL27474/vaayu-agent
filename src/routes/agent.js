const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, getSettings, notify } = require('../db');
const { num, code, round2 } = require('../util');
const { requireAgent, requireActiveAgency, h } = require('../auth');
const svc = require('../services');
const { priceQuote, emiPlans, agencyHasBranding, withTax } = require('../pricing');
const inventory = require('../inventory');
const { parseDetails, calcPackage, present } = require('../packages');

const router = express.Router();
router.use(requireAgent);

const LOGO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', '..', 'public', 'uploads'),
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
    `SELECT COUNT(*) AS bookings, COALESCE(SUM(total_sell), 0) AS sales, COALESCE(SUM(total_sell - total_net), 0) AS earnings
     FROM bookings WHERE agency_id = ? AND status != 'cancelled' AND substr(created_at, 1, 7) = ?`, a, month,
  );
  const openLeads = one("SELECT COUNT(*) AS n FROM leads WHERE agency_id = ? AND status IN ('new', 'contacted')", a).n;
  const quotes = all('SELECT * FROM quotes WHERE agency_id = ? ORDER BY updated_at DESC LIMIT 5', a);
  const bookings = all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 5', a);
  const leads = all("SELECT * FROM leads WHERE agency_id = ? AND status = 'new' ORDER BY id DESC LIMIT 5", a);
  const upcoming = all("SELECT * FROM bookings WHERE agency_id = ? AND status = 'confirmed' AND travel_date >= date('now') ORDER BY travel_date LIMIT 5", a);
  const featured = all("SELECT * FROM packages WHERE status = 'published' ORDER BY updated_at DESC LIMIT 3").map((p) => ({ ...p, price: svc.packageSellPrice(req.agency, p) }));
  res.page('agent/dashboard', { title: 'Dashboard', stats, openLeads, quotes, bookings, leads, upcoming, featured, branded: agencyHasBranding(req.agency) });
}));

// ---------- packages from VaayuTrip ----------

router.get('/packages', h((req, res) => {
  const q = str(req.query.q);
  const theme = str(req.query.theme);
  let sql = "SELECT * FROM packages WHERE status = 'published'";
  const params = [];
  if (q) { sql += ' AND (title LIKE ? OR destination LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (theme) { sql += ' AND theme = ?'; params.push(theme); }
  const packages = all(`${sql} ORDER BY updated_at DESC`, ...params).map((p) => ({ ...p, price: svc.packageSellPrice(req.agency, p) }));
  const themes = all("SELECT DISTINCT theme FROM packages WHERE status = 'published' AND theme IS NOT NULL ORDER BY theme").map((r) => r.theme);
  res.page('agent/packages', { title: 'Holiday packages', packages, themes, q, theme });
}));

// Party options from the package calculator (query string or form body).
function partyOptions(src) {
  return {
    category: str(src.category),
    date: str(src.date),
    rooms: src.rooms,
    adults: src.adults,
    cwb: src.cwb,
    cnb: src.cnb,
    infants: src.infants,
    // A hidden flights=0 precedes the checkbox, so a ticked box arrives as ['0', '1'].
    withFlights: src.flights === undefined ? undefined : [].concat(src.flights).pop() === '1',
    addons: src.addons,
  };
}

// Package details plus a live price calculator: the form re-submits to this page with GET.
router.get('/packages/:id', h((req, res, next) => {
  const pkg = one("SELECT * FROM packages WHERE id = ? AND status = 'published'", num(req.params.id));
  if (!pkg) return next();
  const details = parseDetails(pkg.details);
  const calc = calcPackage(pkg, details, partyOptions(req.query));
  const markup = { markup_type: req.agency.markup_type, markup_value: req.agency.markup_value };
  const priced = priceQuote(markup, calc.lines.map((l) => ({ ...l, net_price: l.net, supplier: 'vaayu', sell_price: null })));
  res.page('agent/package', {
    title: pkg.title, pkg, details, calc, priced, calculated: Object.keys(req.query).length > 0,
    view: present(pkg, details, calc.options.category, true),
    from: svc.packageSellPrice(req.agency, pkg), customers: customersOf(req.agency.id),
  });
}));

router.post('/packages/:id/quote', h((req, res) => {
  const quoteId = svc.createQuoteFromPackage(req.agency, num(req.params.id), {
    ...partyOptions(req.body),
    customerId: num(req.body.customer_id, 0) || null,
  });
  req.flash('success', 'Quote created from the package. Adjust prices and items, then share it with your customer.');
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
    net: 0, sell: Math.max(0, num(req.body.price, 0)), qty: Math.max(1, num(req.body.qty, 1)),
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
  res.page('agent/leads', { title: 'Leads', leads, status, counts, statuses: LEAD_STATUSES, packages: all("SELECT id, title FROM packages WHERE status = 'published' ORDER BY title") });
}));

router.post('/leads', h((req, res) => {
  const name = str(req.body.name);
  if (!name) throw new svc.AppError('Lead name is required.');
  run('INSERT INTO leads (agency_id, name, phone, email, destination, travel_date, pax, budget, package_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.agency.id, name, str(req.body.phone) || null, str(req.body.email) || null, str(req.body.destination) || null, str(req.body.travel_date) || null,
    num(req.body.pax, 0) || null, num(req.body.budget, 0) || null, num(req.body.package_id, 0) || null, str(req.body.notes) || null);
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
  const opts = { customerId, leadId: lead.id, travelDate: lead.travel_date, date: lead.travel_date, adults: lead.pax || 2, rooms: Math.max(1, Math.ceil((lead.pax || 2) / 2)) };
  let id;
  if (lead.package_id) {
    const pkgOpts = { ...opts, title: `${one('SELECT title FROM packages WHERE id = ?', lead.package_id).title} — ${lead.name}` };
    try {
      id = svc.createQuoteFromPackage(req.agency, lead.package_id, pkgOpts);
    } catch (e) {
      // The lead's date or party may not fit the package (season, room limits); start from the default party instead.
      if (!(e instanceof svc.AppError)) throw e;
      id = svc.createQuoteFromPackage(req.agency, lead.package_id, { ...pkgOpts, date: '', rooms: undefined, adults: undefined });
      req.flash('warn', `${e.message} The quote uses default dates and rooms; adjust them before sending.`);
    }
  } else {
    id = svc.createQuote(req.agency, { ...opts, title: `${lead.destination || 'Trip'} — ${lead.name}` });
  }
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

router.get('/settings', (req, res) => {
  res.page('agent/settings', { title: 'Company & branding', branded: agencyHasBranding(req.agency) });
});

router.post('/settings', upload.single('logo'), h((req, res) => {
  const b = req.body;
  const logo = req.file ? `/uploads/${req.file.filename}` : b.remove_logo ? null : req.agency.logo_path;
  if (req.logoRejected) req.flash('error', 'Logo must be a PNG, JPG or WebP image; it was not changed.');
  run(
    `UPDATE agencies SET name = ?, legal_name = ?, gstin = ?, pan = ?, phone = ?, email = ?, address = ?, city = ?, brand_color = ?, logo_path = ?,
       markup_type = ?, markup_value = ? WHERE id = ?`,
    str(b.name) || req.agency.name, str(b.legal_name) || null, str(b.gstin).toUpperCase() || null, str(b.pan).toUpperCase() || null, str(b.phone) || null,
    str(b.email) || null, str(b.address) || null, str(b.city) || null, /^#[0-9a-f]{6}$/i.test(b.brand_color) ? b.brand_color : '#0e7490', logo,
    b.markup_type === 'flat' ? 'flat' : 'percent', Math.max(0, num(b.markup_value, 0)), req.agency.id,
  );
  req.flash('success', 'Company profile saved.');
  res.redirect('/agent/settings');
}));

module.exports = router;
