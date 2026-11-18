// What an invoice page shows beyond the stored snapshot (invoices.data): GST split by place of supply, SAC code,
// PAN, amount in words, booking and payment details. Worked out when the invoice is shown, so invoices issued
// before these details existed get them too.
const { one, getSettings } = require('./db');
const { round2 } = require('./util');

// GST state codes (first two digits of a GSTIN).
const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland',
  14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha',
  22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands',
  36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory',
};
const INDIAN_STATES = [...new Set(Object.values(STATES))].filter((s) => s !== 'Other Territory').sort();
const GSTIN = /^(\d{2})([A-Z]{5}\d{4}[A-Z])[A-Z\d]Z[A-Z\d]$/i;
const stateOf = (gstin) => {
  const m = GSTIN.exec(String(gstin || '').trim());
  return m && STATES[m[1]] ? { code: m[1], name: STATES[m[1]] } : null;
};
const byName = (name) => { const e = Object.entries(STATES).find(([, n]) => n === name); return e ? { code: String(e[0]).padStart(2, '0'), name } : null; };
const panOf = (party) => party.pan || (GSTIN.exec(String(party.gstin || '').trim()) || [])[2] || '';

// ---------- amount in words, Indian numbering (lakh, crore) ----------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}
function inWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7);
  if (crore) parts.push(`${inWords(crore)} Crore`);
  n %= 1e7;
  for (const [size, name] of [[1e5, 'Lakh'], [1e3, 'Thousand']]) {
    const k = Math.floor(n / size);
    if (k) parts.push(`${below1000(k)} ${name}`);
    n %= size;
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
function rupeesInWords(amount) {
  const paise = Math.round(amount * 100);
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${inWords(r)}${p ? ` and ${inWords(p)} Paise` : ''} Only`;
}

/** Everything the invoice template needs: { doc, gst, words, booking, payment, bank, terms }. */
async function invoiceView(inv) {
  const doc = JSON.parse(inv.data);
  const settings = await getSettings();
  const sac = settings.sac_code || '998552';

  // Place of supply: a GST-registered buyer's state; otherwise (customers, whose address we don't hold) the supplier's.
  const supplierState = stateOf(doc.seller.gstin);
  // Unregistered customers: the state on their profile, when the agency has filled it in.
  const buyerState = stateOf(doc.buyer.gstin) || byName(doc.buyer.state);
  const pos = buyerState || supplierState;
  const interState = Boolean(supplierState && pos && supplierState.code !== pos.code);
  const t = doc.totals;
  const half = round2(t.tax / 2);
  const gst = {
    sac, supplierState, buyerState, pos, interState,
    registered: Boolean(supplierState),
    charged: t.tax > 0,
    rows: !t.tax ? [] : interState
      ? [{ label: 'IGST', rate: t.taxRate, amount: t.tax }]
      : [{ label: 'CGST', rate: t.taxRate / 2, amount: half }, { label: 'SGST/UTGST', rate: t.taxRate / 2, amount: round2(t.tax - half) }],
  };
  doc.seller.pan = panOf(doc.seller);
  doc.buyer.pan = panOf(doc.buyer);

  const booking = inv.booking_id ? await one('SELECT code, created_at, paid_wallet, paid_credit, status FROM bookings WHERE id = ?', inv.booking_id) : null;
  // Customer invoices: what the customer has paid online against this quote.
  const paidOnline = inv.kind !== 'b2b' && inv.quote_id
    ? (await one("SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_links WHERE quote_id = ? AND status = 'paid'", inv.quote_id)).paid
    : 0;
  const payment = inv.kind === 'b2b' && booking
    ? { status: 'Paid', detail: `Paid on booking ${booking.code}: wallet ₹${booking.paid_wallet.toLocaleString('en-IN')}${booking.paid_credit ? `, credit ₹${booking.paid_credit.toLocaleString('en-IN')}` : ''}` }
    : paidOnline >= t.total - 0.5 ? { status: 'Paid', detail: 'Paid online' }
      : paidOnline > 0 ? { status: 'Part paid', detail: `₹${paidOnline.toLocaleString('en-IN')} received; balance ₹${round2(t.total - paidOnline).toLocaleString('en-IN')} due` }
        : null;

  // VaayuTrip's bank details on its own invoices (an agency's invoice is paid to the agency).
  // VaayuTrip's bank on its invoices; an agency's own on its branded invoices (from its profile if issued before it was saved).
  const bank = inv.kind !== 'customer_agent' ? settings.bank_details || ''
    : doc.seller.bank || (await one('SELECT bank_details FROM agencies WHERE id = ?', inv.agency_id) || {}).bank_details || '';
  const terms = [
    'Cancellations and refunds follow the policy of each service as stated on the quote; charges apply as per that policy.',
    'Hotel, transfer and activity confirmations are subject to the operators\' terms. Visa issuance is at the discretion of the embassy.',
    doc.totals.tcs ? 'TCS has been collected under section 206C(1G) of the Income-tax Act on the overseas tour package and will be reflected in your Form 26AS.' : null,
    `Subject to ${(supplierState && supplierState.name) || 'Delhi'} jurisdiction. E. & O. E.`,
  ].filter(Boolean);

  return { doc, gst, words: rupeesInWords(t.total), booking, payment, bank, terms };
}

module.exports = { invoiceView, rupeesInWords, stateOf, INDIAN_STATES, STATES };
