// Business operations shared by the agent, admin and API routes.
const { one, all, run, tx, getSettings, notify } = require('./db');
const { code, round2 } = require('./util');
const { priceQuote, buildInvoice, agencyHasBranding, taxRate } = require('./pricing');
const { parseDetails, itemIds, calcPackage, snapshot, fromPrice } = require('./packages');
const { productMap, productLines } = require('./products');

class AppError extends Error {}

function getQuote(quoteId, agencyId) {
  const quote = agencyId
    ? one('SELECT * FROM quotes WHERE id = ? AND agency_id = ?', quoteId, agencyId)
    : one('SELECT * FROM quotes WHERE id = ?', quoteId);
  if (!quote) return null;
  const items = all('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id', quote.id);
  const customer = quote.customer_id ? one('SELECT * FROM customers WHERE id = ?', quote.customer_id) : null;
  return { quote, items, customer, priced: priceQuote(quote, items) };
}

function defaultInvoiceMode(agency) {
  return agencyHasBranding(agency) ? 'agent' : 'vaayu';
}

function createQuote(agency, { title, customerId = null, leadId = null, packageId = null, travelDate = null, adults = 2, children = 0, infants = 0 }) {
  return run(
    `INSERT INTO quotes (agency_id, customer_id, lead_id, package_id, code, title, travel_date, adults, children, infants, markup_type, markup_value, invoice_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agency.id, customerId, leadId, packageId, code('Q'), title, travelDate, adults, children, infants,
    agency.markup_type, agency.markup_value, defaultInvoiceMode(agency),
  ).lastInsertRowid;
}

/**
 * Turns one of the agency's own packages into a quote for a party: VaayuTrip products at net,
 * the agent's hotels and services at their price, and a frozen copy of the itinerary.
 * opts: { title, customerId, leadId, date, adults, children, infants, rooms }
 */
function createQuoteFromPackage(agency, packageId, opts = {}) {
  const pkg = one('SELECT * FROM packages WHERE id = ? AND agency_id = ?', packageId, agency.id);
  if (!pkg) throw new AppError('Package not found');
  const details = parseDetails(pkg.details);
  const products = productMap(itemIds(details));
  const calc = calcPackage(pkg, details, opts, products);
  if (calc.errors.length) throw new AppError(calc.errors[0]);
  if (!calc.lines.length) throw new AppError('This package has nothing priced yet. Add VaayuTrip services, hotel prices or your own services first.');
  const o = calc.options;
  return tx(() => {
    const quoteId = run(
      `INSERT INTO quotes (agency_id, customer_id, lead_id, package_id, code, title, travel_date, adults, children, infants, markup_type, markup_value,
         invoice_mode, is_international, package_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agency.id, opts.customerId || null, opts.leadId || null, pkg.id, code('Q'), opts.title || pkg.title, o.date || null,
      o.adults, o.children, o.infants, agency.markup_type, agency.markup_value, defaultInvoiceMode(agency),
      pkg.is_international ? 1 : 0, JSON.stringify(snapshot(pkg, details, calc, products)),
    ).lastInsertRowid;
    calc.lines.forEach((l) => addQuoteItem(quoteId, l));
    if (opts.leadId) run("UPDATE leads SET status = 'quoted' WHERE id = ? AND agency_id = ?", opts.leadId, agency.id);
    return quoteId;
  });
}

/** Adds a VaayuTrip product to a quote for a party ({ adults, children, infants, rooms, nights }). Every destination is abroad, so TCS applies. */
function addProductToQuote(quoteId, product, party) {
  for (const l of productLines(product, party)) addQuoteItem(quoteId, l);
  run('UPDATE quotes SET is_international = 1 WHERE id = ?', quoteId);
}

function addQuoteItem(quoteId, { type, title, description = '', supplier = 'vaayu', net = 0, sell = null, qty = 1, productId = null, cost = 0 }) {
  const max = one('SELECT COALESCE(MAX(sort), -1) AS m FROM quote_items WHERE quote_id = ?', quoteId).m;
  run(
    'INSERT INTO quote_items (quote_id, type, title, description, supplier, net_price, sell_price, qty, sort, product_id, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    quoteId, type, title, description, supplier, net, sell, qty, max + 1, productId, supplier === 'agent' ? cost || 0 : 0,
  );
  run("UPDATE quotes SET updated_at = datetime('now') WHERE id = ?", quoteId);
}

function moveWallet(agencyId, type, amount, ref, note) {
  const agency = one('SELECT wallet_balance FROM agencies WHERE id = ?', agencyId);
  const balance = round2(agency.wallet_balance + amount);
  run('UPDATE agencies SET wallet_balance = ? WHERE id = ?', balance, agencyId);
  run('INSERT INTO wallet_txns (agency_id, type, amount, balance_after, ref, note) VALUES (?, ?, ?, ?, ?, ?)', agencyId, type, round2(amount), balance, ref || null, note || null);
  return balance;
}

function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

function invoiceNumber(agency, kind) {
  const fy = financialYear();
  if (kind === 'customer_agent') {
    const prefix = agency.name.split(/\s+/).map((w) => w[0]).join('').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'AG';
    const n = one("SELECT COUNT(*) AS n FROM invoices WHERE agency_id = ? AND kind = 'customer_agent'", agency.id).n + 1;
    return `${prefix}/${fy}/${String(n).padStart(4, '0')}`;
  }
  const n = one("SELECT COUNT(*) AS n FROM invoices WHERE kind IN ('customer_vaayu', 'b2b')").n + 1;
  return `VT/${fy}/${String(n).padStart(6, '0')}`;
}

function issueInvoice(agency, quoteId, kind, bookingId = null) {
  const full = getQuote(quoteId, agency.id);
  if (!full) throw new AppError('Quote not found');
  if (!full.items.length) throw new AppError('Add at least one item before issuing an invoice');
  if (kind === 'customer_agent' && !agencyHasBranding(agency)) {
    throw new AppError('Upload your company logo in Settings to issue invoices under your own brand');
  }
  const data = buildInvoice(kind, { ...full, agency, settings: getSettings() });
  if (!data.lines.length) throw new AppError('No items on this quote can be billed on this invoice type');
  const number = invoiceNumber(agency, kind);
  return run(
    'INSERT INTO invoices (agency_id, quote_id, booking_id, number, kind, data, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
    agency.id, quoteId, bookingId, number, kind, JSON.stringify(data), data.totals.total,
  ).lastInsertRowid;
}

/** Books a quote: pays VaayuTrip the net amount from the wallet first, then the credit line. */
function bookQuote(agencyId, quoteId) {
  return tx(() => {
    const agency = one('SELECT * FROM agencies WHERE id = ?', agencyId);
    if (agency.status !== 'active') throw new AppError('Your account must be approved before you can book');
    const full = getQuote(quoteId, agencyId);
    if (!full) throw new AppError('Quote not found');
    if (full.quote.status === 'booked') throw new AppError('This quote is already booked');
    if (!full.items.some((i) => i.supplier === 'vaayu')) throw new AppError('Nothing on this quote is supplied by VaayuTrip');

    const settings = getSettings();
    const payable = round2(full.priced.net * (1 + taxRate(settings) / 100));
    const fromWallet = Math.min(Math.max(agency.wallet_balance, 0), payable);
    const fromCredit = round2(payable - fromWallet);
    if (fromCredit > round2(agency.credit_limit - agency.credit_used)) {
      throw new AppError(`Insufficient funds: ₹${payable.toLocaleString('en-IN')} needed, wallet ₹${agency.wallet_balance.toLocaleString('en-IN')} + available credit ₹${(agency.credit_limit - agency.credit_used).toLocaleString('en-IN')}`);
    }

    const bookingCode = code('VT');
    const bookingId = run(
      `INSERT INTO bookings (agency_id, quote_id, customer_id, code, title, travel_date, total_net, total_sell, total_cost, paid_wallet, paid_credit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agencyId, quoteId, full.quote.customer_id, bookingCode, full.quote.title, full.quote.travel_date, full.priced.net, full.priced.sell, full.priced.agentCost, fromWallet, fromCredit,
    ).lastInsertRowid;
    if (fromWallet) moveWallet(agencyId, 'booking', -fromWallet, bookingCode, full.quote.title);
    if (fromCredit) run('UPDATE agencies SET credit_used = credit_used + ? WHERE id = ?', fromCredit, agencyId);
    run("UPDATE quotes SET status = 'booked', updated_at = datetime('now') WHERE id = ?", quoteId);
    if (full.quote.lead_id) run("UPDATE leads SET status = 'won' WHERE id = ?", full.quote.lead_id);

    issueInvoice(agency, quoteId, 'b2b', bookingId);
    notify(null, 'New booking', `${agency.name} booked ${full.quote.title} (${bookingCode})`, `/admin/bookings/${bookingId}`);
    notify(agencyId, 'Booking confirmed', `${full.quote.title} is confirmed. Booking ID ${bookingCode}.`, `/agent/bookings/${bookingId}`);
    return bookingId;
  });
}

/** Refunds go back to the credit line first (up to what was drawn), the rest to the wallet. */
function approveCancellation(bookingId, refund) {
  return tx(() => {
    const b = one('SELECT * FROM bookings WHERE id = ?', bookingId);
    if (!b || b.status === 'cancelled') throw new AppError('Booking not found or already cancelled');
    refund = Math.min(round2(refund), round2(b.paid_wallet + b.paid_credit));
    const toCredit = Math.min(refund, b.paid_credit);
    const toWallet = round2(refund - toCredit);
    if (toCredit) run('UPDATE agencies SET credit_used = MAX(credit_used - ?, 0) WHERE id = ?', toCredit, b.agency_id);
    if (toWallet) moveWallet(b.agency_id, 'refund', toWallet, b.code, `Refund for ${b.title}`);
    run("UPDATE bookings SET status = 'cancelled', refund_amount = ? WHERE id = ?", refund, bookingId);
    if (b.quote_id) {
      run("UPDATE quotes SET status = 'cancelled' WHERE id = ?", b.quote_id);
    }
    notify(b.agency_id, 'Cancellation approved', `${b.code}: ₹${refund.toLocaleString('en-IN')} refunded.`, `/agent/bookings/${bookingId}`);
  });
}

function approveTopup(requestId) {
  return tx(() => {
    const r = one("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending'", requestId);
    if (!r) throw new AppError('Request not found');
    moveWallet(r.agency_id, 'topup', r.amount, r.utr, 'Wallet top-up');
    run("UPDATE topup_requests SET status = 'approved' WHERE id = ?", requestId);
    notify(r.agency_id, 'Wallet topped up', `₹${r.amount.toLocaleString('en-IN')} added to your wallet.`, '/agent/wallet');
  });
}

/** Price per person (two adults sharing a room) of one of the agency's packages: { net, sell }. */
function packageSellPrice(agency, pkg) {
  const d = parseDetails(pkg.details);
  return fromPrice(agency, pkg, d, productMap(itemIds(d)));
}

module.exports = {
  AppError, getQuote, createQuote, createQuoteFromPackage, addProductToQuote, addQuoteItem, moveWallet, issueInvoice,
  bookQuote, approveCancellation, approveTopup, packageSellPrice, defaultInvoiceMode,
};
