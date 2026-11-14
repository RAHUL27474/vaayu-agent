// Portal search (the box in the top bar): quotes, bookings, customers, invoices and more, grouped by kind.
const { all } = require('./db');
const { fmtDate } = require('./util');

const PER_GROUP = 8;

// ILIKE pattern for free text, with the user's % and _ taken literally.
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function group(label, sql, params, toItem) {
  const rows = await all(`${sql} LIMIT ${PER_GROUP}`, ...params);
  return rows.length ? { label, items: rows.map(toItem) } : null;
}

/** An agency's own records. */
async function searchAgency(agencyId, q) {
  const p = like(q);
  const groups = await Promise.all([
    group('Quotes', `SELECT q.id, q.code, q.title, q.status, c.name AS customer FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
      WHERE q.agency_id = ? AND (q.code ILIKE ? OR q.title ILIKE ? OR c.name ILIKE ?) ORDER BY q.id DESC`, [agencyId, p, p, p],
    (r) => ({ href: `/agent/quotes/${r.id}`, title: r.title, sub: [r.code, r.customer].filter(Boolean).join(' · '), badge: r.status })),
    group('Bookings', `SELECT b.id, b.code, b.title, b.status, b.travel_date, c.name AS customer FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.agency_id = ? AND (b.code ILIKE ? OR b.title ILIKE ? OR c.name ILIKE ?) ORDER BY b.id DESC`, [agencyId, p, p, p],
    (r) => ({ href: `/agent/bookings/${r.id}`, title: r.title, sub: [r.code, r.customer, r.travel_date && `travel ${fmtDate(r.travel_date)}`].filter(Boolean).join(' · '), badge: r.status })),
    group('Customers', `SELECT id, name, phone, email, city FROM customers
      WHERE agency_id = ? AND (name ILIKE ? OR phone ILIKE ? OR email ILIKE ?) ORDER BY name`, [agencyId, p, p, p],
    (r) => ({ href: `/agent/customers/${r.id}`, title: r.name, sub: [r.phone, r.email, r.city].filter(Boolean).join(' · ') })),
    group('Invoices', `SELECT id, number, total, kind FROM invoices WHERE agency_id = ? AND number ILIKE ? ORDER BY id DESC`, [agencyId, p],
    (r) => ({ href: `/agent/invoices/${r.id}`, title: r.number, sub: r.kind === 'b2b' ? 'VaayuTrip → you' : 'Customer invoice', amount: r.total })),
    group('Packages', `SELECT id, title, destination, status FROM packages WHERE agency_id = ? AND (title ILIKE ? OR destination ILIKE ?) ORDER BY id DESC`, [agencyId, p, p],
    (r) => ({ href: `/agent/packages/${r.id}`, title: r.title, sub: r.destination, badge: r.status })),
  ]);
  return groups.filter(Boolean);
}

/** Across all agencies, for VaayuTrip admins. */
async function searchAll(q) {
  const p = like(q);
  const groups = await Promise.all([
    group('Agencies', `SELECT a.id, a.name, a.status, a.city, a.phone, (SELECT u.email FROM users u WHERE u.agency_id = a.id ORDER BY u.id LIMIT 1) AS email FROM agencies a
      WHERE a.name ILIKE ? OR a.phone ILIKE ? OR a.gstin ILIKE ? OR EXISTS (SELECT 1 FROM users u WHERE u.agency_id = a.id AND (u.email ILIKE ? OR u.name ILIKE ?))
      ORDER BY a.name`, [p, p, p, p, p],
    (r) => ({ href: `/admin/agents/${r.id}`, title: r.name, sub: [r.email, r.phone, r.city].filter(Boolean).join(' · '), badge: r.status })),
    group('Bookings', `SELECT b.id, b.code, b.title, b.status, a.name AS agency FROM bookings b JOIN agencies a ON a.id = b.agency_id
      WHERE b.code ILIKE ? OR b.title ILIKE ? ORDER BY b.id DESC`, [p, p],
    (r) => ({ href: `/admin/bookings/${r.id}`, title: r.title, sub: `${r.code} · ${r.agency}`, badge: r.status })),
    group('Invoices', `SELECT i.id, i.number, i.total, a.name AS agency FROM invoices i JOIN agencies a ON a.id = i.agency_id WHERE i.number ILIKE ? ORDER BY i.id DESC`, [p],
    (r) => ({ href: `/admin/invoices/${r.id}`, title: r.number, sub: r.agency, amount: r.total })),
    group('Support tickets', `SELECT t.id, t.code, t.subject, t.status, a.name AS agency FROM tickets t JOIN agencies a ON a.id = t.agency_id
      WHERE t.code ILIKE ? OR t.subject ILIKE ? ORDER BY t.id DESC`, [p, p],
    (r) => ({ href: `/admin/tickets/${r.id}`, title: r.subject, sub: `${r.code} · ${r.agency}`, badge: r.status })),
  ]);
  return groups.filter(Boolean);
}

module.exports = { searchAgency, searchAll };
