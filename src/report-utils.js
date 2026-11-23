// Shared by agent and admin reports: a date period from the query string, and CSV downloads.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Period from ?from=&to= (YYYY-MM-DD, inclusive); defaults to the last `days` days (6 months).
function reportPeriod(q, days = 182) {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const from = ISO_DATE.test(q.from) ? q.from : start;
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

// Wallet ledger entry types, as people read them.
const TXN_LABELS = { topup: 'Top-up', booking: 'Booking', refund: 'Refund', adjustment: 'Adjustment', credit_repay: 'Credit repaid' };
const txnLabel = (t) => TXN_LABELS[t] || t;

// A UTR as typed ("utr 4521-88 ") reduced to what identifies the transfer ("UTR452188"), to catch the same one twice.
const normUtr = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// The same reduction in SQL, for comparing against stored UTRs.
const UTR_SQL = "UPPER(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(utr, ''), ' ', ''), '-', ''), '/', ''), '.', ''))";

module.exports = { ISO_DATE, reportPeriod, csvCell, sendCsv, TXN_LABELS, txnLabel, normUtr, UTR_SQL };
