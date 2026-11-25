// Business operations shared by the agent, admin and API routes.
const { one, all, run, tx, getSettings, notify } = require('./db');
const { code, round2 } = require('./util');
const { priceQuote, buildInvoice, agencyHasBranding, taxRate } = require('./pricing');
const { parseDetails, itemIds, calcPackage, snapshot, fromPrice } = require('./packages');
const { productMap, productLines, KINDS } = require('./products');
const { profileGaps } = require('./kyc');

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

// VaayuTrip never sells to customers: every customer invoice is the agency's own.
function defaultInvoiceMode() {
  return 'agent';
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
  const pkg = await one("SELECT * FROM packages WHERE id = ? AND (agency_id = ? OR (agency_id IS NULL AND status = 'published'))", packageId, agency.id);
  if (!pkg) throw new AppError('Package not found');
  const details = parseDetails(pkg.details);
  const products = await productMap(itemIds(details));
  const calc = await calcPackage(pkg, details, opts, products, agency);
  if (calc.errors.length) throw new AppError(calc.errors[0]);
  if (!calc.lines.length) throw new AppError('This package has nothing priced yet. Add VaayuTrip services, hotel prices or your own services first.');
  const o = calc.options;
  await assertSeats(pkg.id, o.date, o.adults + o.children);
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

/** A package's fixed departures with seats taken and left; [] when it has none (any date). */
async function departuresOf(packageId, { upcoming = true } = {}) {
  return (await all(
    `SELECT d.*, COALESCE((SELECT SUM(q.adults + q.children) FROM bookings b JOIN quotes q ON q.id = b.quote_id
       WHERE q.package_id = d.package_id AND b.travel_date = d.depart_on AND b.status != 'cancelled'), 0) AS booked
     FROM package_departures d WHERE d.package_id = ? ${upcoming ? "AND d.depart_on >= sqldate('now')" : ''} ORDER BY d.depart_on`, packageId,
  )).map((d) => ({ ...d, left: Math.max(0, d.seats - d.booked) }));
}

/** Throws unless a package with fixed departures has the seats on that date (packages without departures: any date). */
async function assertSeats(packageId, date, pax) {
  const deps = await departuresOf(packageId, { upcoming: false });
  if (!deps.length) return;
  const d = deps.find((x) => x.depart_on === date);
  if (!d) throw new AppError(`This package runs on fixed dates only: ${deps.filter((x) => x.left > 0).slice(0, 4).map((x) => x.depart_on).join(', ') || 'none open right now'}.`);
  if (d.left < pax) throw new AppError(d.left ? `Only ${d.left} seat${d.left === 1 ? '' : 's'} left on ${date}.` : `The ${date} departure is full.`);
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

/** Daily (from the cron): tells the agent 2 days before a confirmed trip, so the voucher reaches the traveller in time. */
async function tripReminders() {
  const today = indiaToday();
  const until = isoDay(new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 864e5));
  const trips = await all(
    `SELECT b.id, b.agency_id, b.code, b.title, b.travel_date, c.name AS customer FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.status = 'confirmed' AND b.trip_reminded = 0 AND b.travel_date BETWEEN ? AND ?`, today, until,
  );
  for (const b of trips) {
    const days = Math.round((Date.parse(`${b.travel_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
    const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    await notify(b.agency_id, `Trip ${when}: ${b.title}`,
      `${b.customer || 'Your customer'} travels ${when} (${b.travel_date}), booking ${b.code}. Download the voucher and send it to them, and share pickup times and emergency contacts.`, `/agent/bookings/${b.id}`);
    await run('UPDATE bookings SET trip_reminded = 1 WHERE id = ?', b.id);
  }
  return trips.length;
}

function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// Numbers are counted per series, so callers hold that series' lock (see issueInvoice) until they insert.
/**
 * Next invoice number in a series, at most 16 characters (CGST Rule 46): VT/26-27/000001 for VaayuTrip,
 * SKH/26-27/00001 for an agency (its initials). Each financial year starts again at 1.
 */
async function invoiceNumber(agency, kind) {
  const fy = financialYear().replace(/^20/, '');
  const [series, digits, where, params] = kind === 'customer_agent'
    ? [agency.name.split(/\s+/).map((w) => w[0]).join('').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'AG', 5, "agency_id = ? AND kind = 'customer_agent'", [agency.id]]
    : ['VT', 6, "kind <> 'customer_agent'", []];
  const prefix = `${series}/${fy}/`;
  const last = await one(`SELECT number FROM invoices WHERE ${where} AND number LIKE ? ORDER BY id DESC LIMIT 1`, ...params, `${prefix}%`);
  const n = (last ? parseInt(last.number.slice(prefix.length), 10) || 0 : 0) + 1;
  return `${prefix}${String(n).padStart(digits, '0')}`;
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
      throw new AppError('Upload your company logo in Company & branding first: invoices to your customers carry your name and logo.');
    }
    // The B2B invoice of a booking shows any offer discount the agent used.
    const b = kind === 'b2b' && bookingId ? await one('SELECT coupon_code, discount FROM bookings WHERE id = ?', bookingId) : null;
    const discount = b && b.discount > 0 ? { code: b.coupon_code, amount: b.discount, title: (await one('SELECT title FROM offers WHERE UPPER(code) = ? ORDER BY id DESC LIMIT 1', b.coupon_code))?.title } : null;
    const data = buildInvoice(kind, { ...full, agency, settings: await getSettings(), discount });
    if (!data.lines.length) throw new AppError('No items on this quote can be billed on this invoice type');
    const number = await invoiceNumber(agency, kind);
    return (await run(
      'INSERT INTO invoices (agency_id, quote_id, booking_id, number, kind, data, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
      agency.id, quoteId, bookingId, number, kind, JSON.stringify(data), data.totals.total,
    )).lastInsertRowid;
  });
}

/**
 * What an offer code takes off this quote: { offer, code, discount, base } (rupees, before tax), or an AppError saying
 * why it can't be used. The discount applies to the net of VaayuTrip services (of the offer's kinds, if it names any).
 */
async function couponFor(agencyId, full, raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (!c) throw new AppError('Enter an offer code.');
  const offer = await one('SELECT * FROM offers WHERE UPPER(code) = ? ORDER BY is_active DESC, id DESC LIMIT 1', c);
  if (!offer || !offer.is_active) throw new AppError(`${c} is not a valid offer code.`);
  if (offer.valid_until && offer.valid_until < indiaToday()) throw new AppError(`Offer ${c} ended on ${offer.valid_until}.`);
  if (!['percent', 'flat'].includes(offer.discount_type) || !(offer.discount_value > 0)) {
    throw new AppError(`${c} is not a booking discount code (${offer.title}). See Offers & deals for how it works.`);
  }
  const kinds = offer.kinds ? offer.kinds.split(',').map((k) => k.trim()).filter(Boolean) : null;
  const ids = full.priced.lines.filter((l) => l.supplier === 'vaayu' && l.product_id).map((l) => l.product_id);
  const kindOf = new Map(ids.length ? (await all(`SELECT id, kind FROM products WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids)).map((p) => [p.id, p.kind]) : []);
  const eligible = full.priced.lines.filter((l) => l.supplier === 'vaayu' && (!kinds || kinds.includes(kindOf.get(l.product_id) || l.type)));
  const base = round2(eligible.reduce((s, l) => s + l.lineNet, 0));
  const kindNames = kinds ? kinds.map((k) => (KINDS[k] ? KINDS[k].plural.toLowerCase() : k)).join(', ') : '';
  if (!base) throw new AppError(`${c} applies only to ${kindNames || 'services from VaayuTrip'}, and this quote has none.`);
  if (offer.min_amount > 0 && base < offer.min_amount) {
    throw new AppError(`${c} needs at least ₹${offer.min_amount.toLocaleString('en-IN')} of ${kindNames || 'VaayuTrip services'} (net) on the quote; this one has ₹${base.toLocaleString('en-IN')}.`);
  }
  if (offer.uses_per_agency > 0) {
    const used = (await one("SELECT COUNT(*)::int AS n FROM bookings WHERE agency_id = ? AND UPPER(coupon_code) = ? AND status <> 'cancelled' AND (quote_id IS NULL OR quote_id <> ?)", agencyId, c, full.quote.id)).n;
    if (used >= offer.uses_per_agency) throw new AppError(`You have already used ${c}${offer.uses_per_agency > 1 ? ` ${offer.uses_per_agency} times` : ''}.`);
  }
  let discount = offer.discount_type === 'percent' ? (base * offer.discount_value) / 100 : offer.discount_value;
  if (offer.discount_type === 'percent' && offer.max_discount > 0) discount = Math.min(discount, offer.max_discount);
  return { offer, code: c, discount: round2(Math.min(discount, base)), base };
}

/** Can this quote be booked right now (funds aside)? Returns { agency, full, payable }; throws an AppError if not. */
async function bookable(agencyId, quoteId) {
  const agency = await one('SELECT * FROM agencies WHERE id = ?', agencyId);
  if (agency.status !== 'active') throw new AppError('Your account must be approved before you can book');
  const gaps = profileGaps(agency);
  if (gaps.length) throw new AppError(`Complete your company profile before booking. Missing: ${gaps.join(', ')}. Go to Company & branding.`);
  const full = await getQuote(quoteId, agencyId);
  if (!full) throw new AppError('Quote not found');
  if (['booked', 'cancelled'].includes(full.quote.status)) throw new AppError('This quote is already booked');
  if (!full.items.some((i) => i.supplier === 'vaayu')) throw new AppError('Nothing on this quote is supplied by VaayuTrip');
  if (full.quote.package_id) await assertSeats(full.quote.package_id, full.quote.travel_date, full.quote.adults + full.quote.children);
  const discount = full.quote.coupon_code ? (await couponFor(agencyId, full, full.quote.coupon_code)).discount : 0;
  const payable = round2((full.priced.net - discount) * (1 + taxRate(await getSettings()) / 100));
  return { agency, full, payable, discount };
}

/**
 * Books a quote: pays VaayuTrip the net amount from the wallet first, then the credit line.
 * online: rupees just paid online for this booking (already added to the wallet); such a booking never uses credit.
 */
async function bookQuote(agencyId, quoteId, { online = 0 } = {}) {
  return await tx(async () => {
    // Row locks: a second booking for this agency (or of this quote) waits until this one has paid.
    const agency = await one('SELECT * FROM agencies WHERE id = ? FOR UPDATE', agencyId);
    await one('SELECT id FROM quotes WHERE id = ? AND agency_id = ? FOR UPDATE', quoteId, agencyId);
    if (agency.status !== 'active') throw new AppError('Your account must be approved before you can book');
    const gaps = profileGaps(agency);
    if (gaps.length) throw new AppError(`Complete your company profile before booking. Missing: ${gaps.join(', ')}. Go to Company & branding.`);
    const full = await getQuote(quoteId, agencyId);
    if (!full) throw new AppError('Quote not found');
    if (full.quote.status === 'booked') throw new AppError('This quote is already booked');
    if (!full.items.some((i) => i.supplier === 'vaayu')) throw new AppError('Nothing on this quote is supplied by VaayuTrip');

    const settings = await getSettings();
    // An offer code on the quote is checked again here: it may have expired or been used up since it was applied.
    const coupon = full.quote.coupon_code ? await couponFor(agencyId, full, full.quote.coupon_code) : null;
    const discount = coupon ? coupon.discount : 0;
    const payable = round2((full.priced.net - discount) * (1 + taxRate(settings) / 100));
    // Fixed-departure seats: checked again here, with the departure row locked so two bookings can't take the last seats.
    if (full.quote.package_id) {
      await run('SELECT id FROM package_departures WHERE package_id = ? AND depart_on = ? FOR UPDATE', full.quote.package_id, full.quote.travel_date || '');
      await assertSeats(full.quote.package_id, full.quote.travel_date, full.quote.adults + full.quote.children);
    }
    const fromWallet = Math.min(Math.max(agency.wallet_balance, 0), payable);
    const fromCredit = round2(payable - fromWallet);
    if (online && fromCredit) throw new AppError(`The amount paid online (₹${online.toLocaleString('en-IN')}) no longer covers this booking (₹${payable.toLocaleString('en-IN')}). It is in your wallet.`);
    if (fromCredit && creditStatus(agency).overdue) {
      throw new AppError(`Your credit of ₹${agency.credit_used.toLocaleString('en-IN')} is overdue. Repay it from your wallet (Wallet & credit) or top up enough to pay this booking from your wallet.`);
    }
    if (fromCredit > round2(agency.credit_limit - agency.credit_used)) {
      throw new AppError(`Insufficient funds: ₹${payable.toLocaleString('en-IN')} needed, wallet ₹${agency.wallet_balance.toLocaleString('en-IN')} + available credit ₹${(agency.credit_limit - agency.credit_used).toLocaleString('en-IN')}`);
    }

    const bookingCode = code('VT');
    const bookingId = (await run(
      `INSERT INTO bookings (agency_id, quote_id, customer_id, code, title, travel_date, total_net, total_sell, total_cost, paid_wallet, paid_credit, paid_online, coupon_code, discount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agencyId, quoteId, full.quote.customer_id, bookingCode, full.quote.title, full.quote.travel_date, round2(full.priced.net - discount), full.priced.sell, full.priced.agentCost, fromWallet, fromCredit, round2(Math.min(online, fromWallet)),
      coupon ? coupon.code : null, discount,
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
    const { UTR_SQL, normUtr } = require('./report-utils');
    const dup = r.utr && await one(`SELECT id FROM topup_requests WHERE id != ? AND method = 'bank' AND status = 'approved' AND ${UTR_SQL} = ?`, r.id, normUtr(r.utr));
    if (dup) throw new AppError(`UTR ${r.utr} was already credited (request #${dup.id}). Reject this one.`);
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
  const kind = 'customer_agent';
  const doc = buildInvoice(kind, { ...full, agency, settings });
  const pkgView = full.quote.package_snapshot ? JSON.parse(full.quote.package_snapshot) : null;
  return { booking, ...full, agency, settings, doc, pkgView, kinds: KINDS, favicon: kind === 'customer_agent' ? agency.logo_path : null };
}

module.exports = {
  departuresOf, assertSeats,
  bookable, couponFor,
  creditStatus, repayCredit, creditReminders, tripReminders,
  voucherFor,
  AppError, getQuote, createQuote, createQuoteFromPackage, addProductToQuote, addQuoteItem, moveWallet, issueInvoice,
  bookQuote, approveCancellation, approveTopup, packageSellPrice, defaultInvoiceMode,
};
