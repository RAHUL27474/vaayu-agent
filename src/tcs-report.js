// TCS collected on overseas tour packages (Income-tax Act s. 206C(1G)), per invoice, for the CA's TCS return
// (Form 27EQ). VaayuTrip's report covers the invoices VaayuTrip issues to customers; an agency's covers its own.
const { all, one } = require('./db');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Rows for invoices with TCS issued between from and to (YYYY-MM-DD, inclusive). agencyId null = VaayuTrip's. */
async function tcsRows({ agencyId = null, from, to }) {
  const f = ISO.test(from || '') ? from : '2000-01-01';
  const t = ISO.test(to || '') ? to : '2999-12-31';
  const invoices = await all(
    `SELECT i.*, a.name AS agency_name, q.customer_id FROM invoices i JOIN agencies a ON a.id = i.agency_id LEFT JOIN quotes q ON q.id = i.quote_id
     WHERE i.kind = ? ${agencyId ? 'AND i.agency_id = ?' : ''} AND substr(i.created_at, 1, 10) BETWEEN ? AND ? ORDER BY i.id`,
    agencyId ? 'customer_agent' : 'customer_vaayu', ...(agencyId ? [agencyId] : []), f, t,
  );
  const rows = [];
  for (const inv of invoices) {
    const d = JSON.parse(inv.data);
    if (!(d.totals.tcs > 0)) continue;
    // PAN from the invoice; invoices issued before PAN was kept fall back to the customer's profile.
    const c = !d.buyer.pan && inv.customer_id ? await one('SELECT pan, state FROM customers WHERE id = ?', inv.customer_id) : null;
    rows.push({
      number: inv.number, date: inv.created_at.slice(0, 10), customer: d.buyer.legalName || d.buyer.name, pan: d.buyer.pan || (c && c.pan) || '',
      state: d.buyer.state || (c && c.state) || '', trip: d.meta.trip, agency: inv.agency_name,
      taxable: d.totals.subtotal, gst: d.totals.tax, tcsBase: Math.round((d.totals.subtotal + d.totals.tax) * 100) / 100,
      rate: d.totals.tcsRate, tcs: d.totals.tcs, total: d.totals.total,
    });
  }
  return rows;
}

const HEADER = ['Invoice no.', 'Date', 'Customer', 'Customer PAN', 'Customer state', 'Trip', 'Booked through', 'Taxable value', 'GST', 'Amount TCS is on', 'TCS rate %', 'TCS', 'Invoice total'];
const asRow = (r) => [r.number, r.date, r.customer, r.pan || 'PAN not given', r.state, r.trip, r.agency, r.taxable, r.gst, r.tcsBase, r.rate, r.tcs, r.total];

// CSV cell: text starting with = + - @ is prefixed so spreadsheets don't run it as a formula.
const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = /^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Sends the report as a CSV download (with totals at the end). */
function sendTcsCsv(res, filename, rows) {
  const sum = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
  const lines = [HEADER, ...rows.map(asRow), [], ['Total', '', `${rows.length} invoices`, '', '', '', '', sum('taxable'), sum('gst'), sum('tcsBase'), '', sum('tcs'), sum('total')]];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(`﻿${lines.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
}

module.exports = { tcsRows, sendTcsCsv };
