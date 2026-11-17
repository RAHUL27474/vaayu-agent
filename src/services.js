// Business operations shared by the agent, admin and API routes.
const { one, all, run, tx, getSettings, notify } = require('./db');
const { code, round2 } = require('./util');
const { priceQuote, buildInvoice, agencyHasBranding, taxRate } = require('./pricing');
const { parseDetails, itemIds, calcPackage, snapshot, fromPrice } = require('./packages');
const { productMap, productLines, KINDS } = require('./products');

class AppError extends Error {}

async function getQuote(quoteId, agencyId) {
  const quote = agencyId
    ? await one('SELECT * FROM quotes WHERE id = ? AND agency_id = ?', quoteId, agencyId)
    : await one('SELECT * FROM quotes WHERE id = ?', quoteId);
  if (!quote) return null;
  const items = await all('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id', quote.id);
  const customer = quote.customer_id ? await one('SELECT * FROM customers WHERE id = ?', quote.customer_id) : null;
  return { quote, items, customer, priced: priceQuote(quote, items) };
}

function defaultInvoiceMode(agency) {
  return agencyHasBranding(agency) ? 'agent' : 'vaayu';
}

async function createQuote(agency, { title, customerId = null, leadId = null, packageId = null, travelDate = null, adults = 2, children = 0, infants = 0 }) {
  return (await run(
    `INSERT INTO quotes (agency_id, customer_id, lead_id, package_id, code, title, travel_date, adults, children, infants, markup_type, markup_value, markup_by_kind, invoice_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agency.id, customerId, leadId, packageId, code('Q'), title, travelDate, adults, children, infants,
    agency.markup_type, agency.markup_value, agency.markup_by_kind || null, defaultInvoiceMode(agency),
  )).lastInsertRowid;
}

/**
 * Turns one of the agency's own packages into a quote for a party: VaayuTrip products at net,
 * the agent's hotels and services at their price, and a frozen copy of the itinerary.
 * opts: { title, customerId, leadId, date, adults, children, infants, rooms }
 */
async function createQuoteFromPackage(agency, packageId, opts = {}) {
  const pkg = await one('SELECT * FROM packages WHERE id = ? AND agency_id = ?', packageId, agency.id);
  if (!pkg) throw new AppError('Package not found');
  const details = parseDetails(pkg.details);
  const products = await productMap(itemIds(details));
  const calc = await calcPackage(pkg, details, opts, products);
  if (calc.errors.length) throw new AppError(calc.errors[0]);
  if (!calc.lines.length) throw new AppError('This package has nothing priced yet. Add VaayuTrip services, hotel prices or your own services first.');
  const o = calc.options;
  return await tx(async () => {
    const quoteId = (await run(
      `INSERT INTO quotes (agency_id, customer_id, lead_id, package_id, code, title, travel_date, adults, children, infants, markup_type, markup_value,
         markup_by_kind, invoice_mode, is_international, package_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agency.id, opts.customerId || null, opts.leadId || null, pkg.id, code('Q'), opts.title || pkg.title, o.date || null,
      o.adults, o.children, o.infants, agency.markup_type, agency.markup_value, agency.markup_by_kind || null, defaultInvoiceMode(agency),
      pkg.is_international ? 1 : 0, JSON.stringify(await snapshot(pkg, details, calc, products)),
    )).lastInsertRowid;
    for (const l of calc.lines) await addQuoteItem(quoteId, l);
    if (opts.leadId) await run("UPDATE leads SET status = 'quoted' WHERE id = ? AND agency_id = ?", opts.leadId, agency.id);
    return quoteId;
  });
}

/** Adds a VaayuTrip product to a quote for a party ({ adults, children, infants, rooms, nights }). Every destination is abroad, so TCS applies. */
async function addProductToQuote(quoteId, product, party) {
  const lines = productLines(product, party);
  if (lines.some((l) => l.soldOut)) throw new AppError(`${product.title} is sold out on ${party.date} (${lines[0].soldOut.label}). Choose another date.`);
  for (const l of lines) await addQuoteItem(quoteId, l);
  await run('UPDATE quotes SET is_international = 1 WHERE id = ?', quoteId);
}

async function addQuoteItem(quoteId, { type, title, description = '', supplier = 'vaayu', net = 0, sell = null, qty = 1, productId = null, cost = 0 }) {
  const max = (await one('SELECT COALESCE(MAX(sort), -1) AS m FROM quote_items WHERE quote_id = ?', quoteId)).m;
  await run(
    'INSERT INTO quote_items (quote_id, type, title, description, supplier, net_price, sell_price, qty, sort, product_id, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    quoteId, type, title, description, supplier, net, sell, qty, max + 1, productId, supplier === 'agent' ? cost || 0 : 0,
  );
  await run("UPDATE quotes SET updated_at = datetime('now') WHERE id = ?", quoteId);
}

// One atomic UPDATE, so two wallet movements at the same moment can't overwrite each other.
async function moveWallet(agencyId, type, amount, ref, note) {
  const { balance, alert } = await one(
    'UPDATE agencies SET wallet_balance = ROUND((wallet_balance + ?)::numeric, 2)::double precision WHERE id = ? RETURNING wallet_balance AS balance, low_balance_alert AS alert',
    round2(amount), agencyId,
  );
  await run('INSERT INTO wallet_txns (agency_id, type, amount, balance_after, ref, note) VALUES (?, ?, ?, ?, ?, ?)', agencyId, type, round2(amount), balance, ref || null, note || null);
  // Just dropped below the agency's alert level.
  if (alert > 0 && amount < 0 && balance < alert && balance - round2(amount) >= alert) {
    await notify(agencyId, 'Low wallet balance', `Your wallet is down to ₹${balance.toLocaleString('en-IN')} (alert set at ₹${alert.toLocaleString('en-IN')}). Top up to keep booking without delays.`, '/agent/wallet');
  }
  return balance;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const indiaToday = () => isoDay(new Date(Date.now() + 330 * 60000));

/** Where an agency's credit stands: { used, dueOn, daysLeft, overdue } (dueOn null when nothing is owed). */
function creditStatus(agency) {
  if (!(agency.credit_used > 0) || !agency.credit_since) return { used: agency.credit_used || 0, dueOn: null, daysLeft: null, overdue: false };
  const due = new Date(`${agency.credit_since}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + (agency.credit_days || 0));
  const daysLeft = Math.round((due - new Date(`${indiaToday()}T00:00:00Z`)) / 864e5);
  return { used: agency.credit_used, dueOn: isoDay(due), daysLeft, overdue: daysLeft < 0 };
}

/** Pays back credit from the wallet (up to what's owed and what's in the wallet). Returns the amount repaid. */
async function repayCredit(agencyId, amount) {
  return await tx(async () => {
    const a = await one('SELECT * FROM agencies WHERE id = ? FOR UPDATE', agencyId);
    const pay = round2(Math.min(amount, a.credit_used, Math.max(a.wallet_balance, 0)));
    if (pay <= 0) throw new AppError(a.credit_used > 0 ? 'Add money to your wallet first, then repay your credit from it.' : 'You have no credit to repay.');
    await moveWallet(agencyId, 'credit_repay', -pay, null, 'Credit repaid');
    await run(`UPDATE agencies SET credit_used = GREATEST(credit_used - ?, 0),
      credit_since = CASE WHEN credit_used - ? <= 0.005 THEN NULL ELSE credit_since END, credit_reminded_on = NULL WHERE id = ?`, pay, pay, agencyId);
    await notify(null, 'Credit repaid', `${a.name} repaid ₹${pay.toLocaleString('en-IN')} of credit.`, `/admin/agents/${agencyId}`);
    return pay;
  });
}

/** Daily (from the cron): reminders 3 days and 1 day before credit falls due, on the day, then every 3 days overdue. */
async function creditReminders() {
  const today = indiaToday();
  const owing = await all("SELECT * FROM agencies WHERE credit_used > 0 AND credit_since IS NOT NULL AND status = 'active' AND (credit_reminded_on IS NULL OR credit_reminded_on <> ?)", today);
  let sent = 0;
  for (const a of owing) {
    const s = creditStatus(a);
    if (!([3, 1, 0].includes(s.daysLeft) || (s.overdue && -s.daysLeft % 3 === 1))) continue;
    const amount = `₹${a.credit_used.toLocaleString('en-IN')}`;
    await notify(a.id, s.overdue ? 'Credit overdue' : 'Credit due soon',
      s.overdue ? `${amount} of credit was due on ${s.dueOn}. Repay it from your wallet to keep booking on credit.` : `${amount} of credit is due ${s.daysLeft ? `in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}` : 'today'} (${s.dueOn}).`, '/agent/wallet');
    if (s.overdue && s.daysLeft === -1) await notify(null, 'Agency credit overdue', `${a.name} owes ${amount}, due ${s.dueOn}.`, `/admin/agents/${a.id}`);
    await run('UPDATE agencies SET credit_reminded_on = ? WHERE id = ?', today, a.id);
    sent += 1;
  }
  return sent;
}

function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// Numbers are counted per series, so callers hold that series' lock (see issueInvoice) until they insert.
async function invoiceNumber(agency, kind) {
  const fy = financialYear();
  if (kind === 'customer_agent') {
    const prefix = agency.name.split(/\s+/).map((w) => w[0]).join('').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'AG';
    const n = (await one("SELECT COUNT(*) AS n FROM invoices WHERE agency_id = ? AND kind = 'customer_agent'", agency.id)).n + 1;
    return `${prefix}/${fy}/${String(n).padStart(4, '0')}`;
  }
  const n = (await one("SELECT COUNT(*) AS n FROM invoices WHERE kind IN ('customer_vaayu', 'b2b')")).n + 1;
  return `VT/${fy}/${String(n).padStart(6, '0')}`;
}

async function issueInvoice(agency, quoteId, kind, bookingId = null) {
  return tx(async () => {
    // Serialises numbering within a series (VaayuTrip-wide, or per agency for agent-branded invoices).
    if (kind === 'customer_agent') await run('SELECT pg_advisory_xact_lock(731101, ?)', agency.id);
    else await run('SELECT pg_advisory_xact_lock(731100)');
    const full = await getQuote(quoteId, agency.id);
    if (!full) throw new AppError('Quote not found');
    if (!full.items.length) throw new AppError('Add at least one item before issuing an invoice');
    if (kind === 'customer_agent' && !agencyHasBranding(agency)) {
      throw new AppError('Upload your company logo in Settings to issue invoices under your own brand');
    }
    const data = buildInvoice(kind, { ...full, agency, settings: await getSettings() });
    if (!data.lines.length) throw new AppError('No items on this quote can be billed on this invoice type');
    const number = await invoiceNumber(agency, kind);
    return (await run(
      'INSERT INTO invoices (agency_id, quote_id, booking_id, number, kind, data, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
      agency.id, quoteId, bookingId, number, kind, JSON.stringify(data), data.totals.total,
    )).lastInsertRowid;
  });
}

/** Books a quote: pays VaayuTrip the net amount from the wallet first, then the credit line. */
async function bookQuote(agencyId, quoteId) {
  return await tx(async () => {
    // Row locks: a second booking for this agency (or of this quote) waits until this one has paid.
    const agency = await one('SELECT * FROM agencies WHERE id = ? FOR UPDATE', agencyId);
    await one('SELECT id FROM quotes WHERE id = ? AND agency_id = ? FOR UPDATE', quoteId, agencyId);
    if (agency.status !== 'active') throw new AppError('Your account must be approved before you can book');
    const full = await getQuote(quoteId, agencyId);
    if (!full) throw new AppError('Quote not found');
    if (full.quote.status === 'booked') throw new AppError('This quote is already booked');
    if (!full.items.some((i) => i.supplier === 'vaayu')) throw new AppError('Nothing on this quote is supplied by VaayuTrip');

    const settings = await getSettings();
    const payable = round2(full.priced.net * (1 + taxRate(settings) / 100));
    const fromWallet = Math.min(Math.max(agency.wallet_balance, 0), payable);
    const fromCredit = round2(payable - fromWallet);
    if (fromCredit && creditStatus(agency).overdue) {
      throw new AppError(`Your credit of ₹${agency.credit_used.toLocaleString('en-IN')} is overdue. Repay it from your wallet (Wallet & credit) or top up enough to pay this booking from your wallet.`);
    }
    if (fromCredit > round2(agency.credit_limit - agency.credit_used)) {
      throw new AppError(`Insufficient funds: ₹${payable.toLocaleString('en-IN')} needed, wallet ₹${agency.wallet_balance.toLocaleString('en-IN')} + available credit ₹${(agency.credit_limit - agency.credit_used).toLocaleString('en-IN')}`);
    }

    const bookingCode = code('VT');
    const bookingId = (await run(
      `INSERT INTO bookings (agency_id, quote_id, customer_id, code, title, travel_date, total_net, total_sell, total_cost, paid_wallet, paid_credit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agencyId, quoteId, full.quote.customer_id, bookingCode, full.quote.title, full.quote.travel_date, full.priced.net, full.priced.sell, full.priced.agentCost, fromWallet, fromCredit,
    )).lastInsertRowid;
    if (fromWallet) await moveWallet(agencyId, 'booking', -fromWallet, bookingCode, full.quote.title);
    if (fromCredit) await run("UPDATE agencies SET credit_used = credit_used + ?, credit_since = COALESCE(credit_since, to_char(CURRENT_DATE, 'YYYY-MM-DD')) WHERE id = ?", fromCredit, agencyId);
    await run("UPDATE quotes SET status = 'booked', updated_at = datetime('now') WHERE id = ?", quoteId);
    if (full.quote.lead_id) await run("UPDATE leads SET status = 'won' WHERE id = ?", full.quote.lead_id);

    await issueInvoice(agency, quoteId, 'b2b', bookingId);
    await notify(null, 'New booking', `${agency.name} booked ${full.quote.title} (${bookingCode})`, `/admin/bookings/${bookingId}`);
    await notify(agencyId, 'Booking confirmed', `${full.quote.title} is confirmed. Booking ID ${bookingCode}.`, `/agent/bookings/${bookingId}`);
    return bookingId;
  });
}

/** Refunds go back to the credit line first (up to what was drawn), the rest to the wallet. */
async function approveCancellation(bookingId, refund) {
  return await tx(async () => {
    const b = await one('SELECT * FROM bookings WHERE id = ? FOR UPDATE', bookingId);
    if (!b || b.status === 'cancelled') throw new AppError('Booking not found or already cancelled');
    refund = Math.min(round2(refund), round2(b.paid_wallet + b.paid_credit));
    const toCredit = Math.min(refund, b.paid_credit);
    const toWallet = round2(refund - toCredit);
    if (toCredit) await run('UPDATE agencies SET credit_used = GREATEST(credit_used - ?, 0), credit_since = CASE WHEN credit_used - ? <= 0.005 THEN NULL ELSE credit_since END WHERE id = ?', toCredit, toCredit, b.agency_id);
    if (toWallet) await moveWallet(b.agency_id, 'refund', toWallet, b.code, `Refund for ${b.title}`);
    await run("UPDATE bookings SET status = 'cancelled', refund_amount = ? WHERE id = ?", refund, bookingId);
    if (b.quote_id) {
      await run("UPDATE quotes SET status = 'cancelled' WHERE id = ?", b.quote_id);
    }
    await notify(b.agency_id, 'Cancellation approved', `${b.code}: ₹${refund.toLocaleString('en-IN')} refunded.`, `/agent/bookings/${bookingId}`);
  });
}

async function approveTopup(requestId) {
  return await tx(async () => {
    const r = await one("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending' AND method = 'bank' FOR UPDATE", requestId);
    if (!r) throw new AppError('Request not found');
    await moveWallet(r.agency_id, 'topup', r.amount, r.utr, 'Wallet top-up');
    await run("UPDATE topup_requests SET status = 'approved' WHERE id = ?", requestId);
    await notify(r.agency_id, 'Wallet topped up', `₹${r.amount.toLocaleString('en-IN')} added to your wallet.`, '/agent/wallet');
  });
}

/** Price per person (two adults sharing a room) of one of the agency's packages: { net, sell }. */
async function packageSellPrice(agency, pkg) {
  const d = parseDetails(pkg.details);
  return await fromPrice(agency, pkg, d, await productMap(itemIds(d)));
}

/**
 * Everything the travel voucher (views/voucher.ejs) shows for a booking made from a quote: branded with the
 * agency when it has its own branding (as its customer invoices are), otherwise with VaayuTrip.
 */
async function voucherFor(booking) {
  if (!booking || !booking.quote_id) return null;
  const full = await getQuote(booking.quote_id);
  if (!full) return null;
  const agency = await one('SELECT * FROM agencies WHERE id = ?', booking.agency_id);
  const settings = await getSettings();
  const kind = full.quote.invoice_mode === 'agent' && agencyHasBranding(agency) ? 'customer_agent' : 'customer_vaayu';
  const doc = buildInvoice(kind, { ...full, agency, settings });
  const pkgView = full.quote.package_snapshot ? JSON.parse(full.quote.package_snapshot) : null;
  return { booking, ...full, agency, settings, doc, pkgView, kinds: KINDS, favicon: kind === 'customer_agent' ? agency.logo_path : null };
}

module.exports = {
  creditStatus, repayCredit, creditReminders,
  voucherFor,
  AppError, getQuote, createQuote, createQuoteFromPackage, addProductToQuote, addQuoteItem, moveWallet, issueInvoice,
  bookQuote, approveCancellation, approveTopup, packageSellPrice, defaultInvoiceMode,
};
