// Excel downloads for list pages. Any list page rendered with res.page() whose view is listed here gets
// an "Excel" button; ?download=xlsx returns the same list, with the page's filters, as an .xlsx file.
// Paged lists come out whole (see paging.js), so the file holds every matching row, not one page.
const { buildXlsx } = require('./xlsx-write');
const { txnLabel } = require('./report-utils');

const MAX_ROWS = 20000;
const wantsXlsx = (req) => req.query.download === 'xlsx' && req.method === 'GET';

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');
const yesNo = (v) => (v === null || v === undefined ? '' : Number(v) === 1 || v === true ? 'Yes' : 'No');
const BOOKING = { confirmed: 'Confirmed', cancel_requested: 'Cancellation requested', cancelled: 'Cancelled' };
const INVOICE = { b2b: 'VaayuTrip → agent', customer_vaayu: 'VaayuTrip → customer', customer_agent: "Agent's own invoice" };
const TICKET = { open: 'Waiting on VaayuTrip', answered: 'VaayuTrip replied', closed: 'Closed' };
const billedTo = (i) => (i.doc && i.doc.buyer && (i.doc.buyer.legalName || i.doc.buyer.name)) || '';
const tripOf = (i) => (i.doc && i.doc.meta && i.doc.meta.trip) || '';
const discount = (o) => (o.discount_value ? (o.discount_type === 'pct' || o.discount_type === 'percent' ? `${o.discount_value}%` : `₹${Number(o.discount_value).toLocaleString('en-IN')}`) : '');

const col = (h, v, t = 'text', extra = {}) => ({ h, v, t, ...extra });

// Bookings as admins and agents see them.
const bookingCols = (admin) => [
  col('Booking', (b) => b.code),
  col('Trip', (b) => String(b.title || '').split(' — ')[0]),
  col('Place', (b) => b.place),
  ...(admin ? [col('Agency', (b) => b.agency_name)] : []),
  col('Customer', (b) => b.customer_name || String(b.title || '').split(' — ')[1] || ''),
  col('Travel date', (b) => b.travel_date, 'date'),
  col('Status', (b) => BOOKING[b.status] || cap(b.status)),
  col('Booked on', (b) => b.created_at, 'datetime'),
  col('Net (pre-tax)', (b) => b.total_net, 'money'),
  col('Sell price', (b) => b.total_sell, 'money'),
  col('Paid from wallet', (b) => b.paid_wallet, 'money'),
  col('Paid on credit', (b) => b.paid_credit, 'money'),
  col('Coupon', (b) => b.coupon_code),
  col('Discount', (b) => b.discount, 'money'),
  col('Refund', (b) => b.refund_amount, 'money'),
  col('Cancellation reason', (b) => b.cancel_reason),
];

const notificationCols = [
  col('When', (n) => n.created_at, 'datetime'),
  col('Title', (n) => n.title),
  col('Message', (n) => n.body),
  col('Link', (n) => n.link),
];

const SHEETS = {
  // ---------- admin ----------
  'admin/agents': (d) => ({
    name: 'Agents', filter: d.status && cap(d.status), rows: d.agents, columns: [
      col('Agency', (a) => a.name), col('Legal name', (a) => a.legal_name), col('Contact', (a) => a.contact), col('Email', (a) => a.email),
      col('Phone', (a) => a.phone), col('City', (a) => a.city), col('Country', (a) => a.country), col('Status', (a) => cap(a.status)),
      col('KYC', (a) => cap(a.kyc_status)), col('Tier', (a) => cap(a.rate_tier || 'standard')), col('GSTIN / tax ID', (a) => a.gstin || a.tax_id), col('PAN', (a) => a.pan),
      col('Wallet balance', (a) => a.wallet_balance, 'money'), col('Credit limit', (a) => a.credit_limit, 'money'), col('Credit used', (a) => a.credit_used, 'money'),
      col('Bookings', (a) => a.bookings, 'int'), col('Joined', (a) => a.created_at, 'datetime'),
    ],
  }),
  'admin/tiers': (d) => ({
    name: 'Silver and Gold', rows: d.agents, columns: [
      col('Agency', (a) => a.name), col('City', (a) => a.city), col('Email', (a) => a.email), col('Tier', (a) => cap(a.tier)), col('Tier until', (a) => (a.tier !== 'standard' ? a.rate_tier_until : ''), 'date'),
    ],
  }),
  'admin/log': (d) => ({
    name: 'Activity log', filter: [d.f.area && cap(d.f.area), d.f.from && `from ${d.f.from}`, d.f.to && `to ${d.f.to}`].filter(Boolean).join(', '), rows: d.entries, columns: [
      col('When', (l) => l.created_at, 'datetime'), col('Person', (l) => l.user_name), col('Role', (l) => cap(l.role)), col('Agency', (l) => l.agency_name),
      col('Area', (l) => cap(String(l.action || '').split('.')[0])), col('Action', (l) => cap(String(l.action || '').split('.').slice(1).join(' '))), col('Details', (l) => l.summary),
    ],
  }),
  'admin/team': (d) => ({
    name: 'Team', rows: d.team, columns: [
      col('Name', (u) => u.name), col('Email', (u) => u.email), col('Phone', (u) => u.phone), col('Role', (u) => (u.role === 'backend' ? 'Backend team' : 'Admin')),
      col('Active', (u) => yesNo(u.is_active)), col('Inventory changes', (u) => u.changes, 'int'), col('Last active', (u) => u.last_seen, 'datetime'),
    ],
  }),
  'admin/bookings': (d) => ({ name: 'Bookings', filter: d.status && BOOKING[d.status], rows: d.bookings, columns: bookingCols(true) }),
  'admin/topups': (d) => ({
    name: 'Top-up requests', rows: d.requests, columns: [
      col('Request', (t) => `#${t.id}`), col('Agency', (t) => t.agency_name), col('Amount', (t) => t.amount, 'money'), col('Method', (t) => (t.method === 'phonepe' ? 'PhonePe' : 'Bank transfer')),
      col('UTR', (t) => t.utr), col('Status', (t) => cap(t.status)), col('Requested', (t) => t.created_at, 'datetime'), col('Same UTR as', (t) => (t.dupOf || []).join('; ')),
    ],
  }),
  'admin/ledger': (d) => ({
    name: 'Wallet ledger', filter: `${d.from} to ${d.to}${d.type ? `, ${txnLabel(d.type)}` : ''}`, rows: d.txns, columns: [
      col('Date', (t) => t.created_at, 'datetime'), col('Agency', (t) => t.agency_name), col('Type', (t) => txnLabel(t.type)), col('Amount', (t) => t.amount, 'money'),
      col('Balance after', (t) => t.balance_after, 'money', { noTotal: true }), col('Reference', (t) => t.ref), col('Note', (t) => t.note),
    ],
  }),
  'admin/invoices': (d) => ({
    name: 'Invoices', filter: d.kind && INVOICE[d.kind], rows: d.invoices, columns: [
      col('Invoice', (i) => i.number), col('Date', (i) => i.created_at, 'date'), col('Type', (i) => INVOICE[i.kind] || i.kind), col('Agency', (i) => i.agency_name),
      col('Billed to', billedTo), col('Trip', tripOf), col('Total', (i) => i.total, 'money'),
    ],
  }),
  'admin/offers': (d) => ({
    name: 'Offers', rows: d.offers, columns: [
      col('Offer', (o) => o.title), col('Code', (o) => o.code), col('Discount', discount), col('Valid until', (o) => o.valid_until, 'date'), col('Live', (o) => (o.live ? 'Yes' : 'No')),
      col('Times used', (o) => o.used, 'int'), col('Discount given', (o) => o.given, 'money'), col('Details', (o) => o.body),
    ],
  }),
  'admin/tickets': (d) => ({
    name: 'Support tickets', filter: d.status && TICKET[d.status], rows: d.tickets, columns: [
      col('Ticket', (t) => t.code), col('Subject', (t) => t.subject), col('Agency', (t) => t.agency_name), col('Topic', (t) => cap(t.category)), col('Status', (t) => TICKET[t.status] || cap(t.status)),
      col('Messages', (t) => t.messages, 'int'), col('Opened', (t) => t.created_at, 'datetime'), col('Last update', (t) => t.updated_at, 'datetime'),
    ],
  }),

  // ---------- agents ----------
  'agent/notifications': (d) => ({ name: 'Notifications', rows: d.items, columns: notificationCols }),
  'agent/bookings': (d) => ({ name: 'Bookings', rows: d.bookings, columns: bookingCols(false) }),
  'agent/quotes': (d) => ({
    name: 'Quotes', filter: d.status && cap(d.status), rows: d.quotes, columns: [
      col('Quote', (q) => q.code), col('Trip', (q) => q.title), col('Customer', (q) => q.customer_name), col('Travel date', (q) => q.travel_date, 'date'),
      col('Adults', (q) => q.adults, 'int'), col('Children', (q) => q.children, 'int'), col('Status', (q) => cap(q.status)),
      col('Quote value', (q) => q.priced && q.priced.sell, 'money'), col('Your earning', (q) => q.priced && q.priced.commission, 'money'),
      col('Times viewed', (q) => q.view_count, 'int'), col('Created', (q) => q.created_at, 'datetime'), col('Updated', (q) => q.updated_at, 'datetime'),
    ],
  }),
  'agent/customers': (d) => ({
    name: 'Customers', filter: d.q && `matching “${d.q}”`, rows: d.customers, columns: [
      col('Name', (c) => c.name), col('Phone', (c) => c.phone), col('Email', (c) => c.email), col('City', (c) => c.city), col('State', (c) => c.state),
      col('Trips', (c) => c.trips, 'int'), col('Lifetime spend', (c) => c.spend, 'money'), col('Next trip', (c) => c.next_trip, 'date'), col('Notes', (c) => c.notes), col('Added', (c) => c.created_at, 'date'),
    ],
  }),
  'agent/leads': (d) => ({
    name: 'Leads', filter: d.due ? 'Follow-ups due' : d.status && cap(d.status), rows: d.leads, columns: [
      col('Name', (l) => l.name), col('Phone', (l) => l.phone), col('Email', (l) => l.email), col('Destination', (l) => l.destination), col('Travel date', (l) => l.travel_date, 'date'),
      col('Travellers', (l) => l.pax, 'int', { noTotal: true }), col('Budget', (l) => l.budget, 'money', { noTotal: true }), col('Source', (l) => cap(l.source)), col('Status', (l) => cap(l.status)),
      col('Package', (l) => l.package_title), col('Assigned to', (l) => l.assignee), col('Follow up on', (l) => l.follow_up_on, 'date'), col('Follow-up note', (l) => l.follow_up_note),
      col('Notes', (l) => l.notes), col('Added', (l) => l.created_at, 'datetime'),
    ],
  }),
  'agent/wallet': (d) => ({
    name: 'Wallet', rows: d.txns, columns: [
      col('Date', (t) => t.created_at, 'datetime'), col('Type', (t) => txnLabel(t.type)), col('Amount', (t) => t.amount, 'money'),
      col('Balance after', (t) => t.balance_after, 'money', { noTotal: true }), col('Reference', (t) => t.ref), col('Note', (t) => t.note),
    ],
  }),
  'agent/invoices': (d) => ({
    name: 'Invoices', rows: d.invoices, columns: [
      col('Invoice', (i) => i.number), col('Date', (i) => i.created_at, 'date'), col('Type', (i) => INVOICE[i.kind] || i.kind), col('Billed to', billedTo),
      col('Trip', tripOf), col('Quote', (i) => i.quote_code), col('Total', (i) => i.total, 'money'),
    ],
  }),
  'agent/team': (d) => ({
    name: 'Team', rows: d.team, columns: [
      col('Name', (u) => u.name), col('Email', (u) => u.email), col('Phone', (u) => u.phone), col('Role', (u) => cap(u.agency_role)), col('Active', (u) => yesNo(u.is_active)), col('Last sign-in', (u) => u.last_seen, 'datetime'),
    ],
  }),
  'agent/support': (d) => ({
    name: 'Support tickets', rows: d.tickets, columns: [
      col('Ticket', (t) => t.code), col('Subject', (t) => t.subject), col('Topic', (t) => (d.categories && d.categories[t.category]) || cap(t.category)), col('Status', (t) => TICKET[t.status] || cap(t.status)),
      col('Messages', (t) => t.messages, 'int'), col('Opened', (t) => t.created_at, 'datetime'), col('Last update', (t) => t.updated_at, 'datetime'),
    ],
  }),
  'agent/offers': (d) => ({
    name: 'Offers', rows: d.offers, columns: [col('Offer', (o) => o.title), col('Code', (o) => o.code), col('Discount', discount), col('Valid until', (o) => o.valid_until, 'date'), col('Details', (o) => o.body)],
  }),
  'agent/packages': (d) => ({
    name: 'My packages', rows: d.packages, columns: [
      col('Package', (p) => p.title), col('Destination', (p) => p.destination), col('Nights', (p) => p.nights, 'int', { noTotal: true }), col('Status', (p) => cap(p.status)),
      col('Services', (p) => p.services, 'int', { noTotal: true }), col('Price from', (p) => p.price && p.price.sell, 'money', { noTotal: true }), col('Your earning', (p) => p.price && p.price.earning, 'money', { noTotal: true }),
      col('Quotes', (p) => p.quotes, 'int'), col('Updated', (p) => p.updated_at, 'datetime'),
    ],
  }),
  'agent/vaayu-packages': (d) => ({
    name: 'VaayuTrip packages', filter: d.dest, rows: d.packages, columns: [
      col('Package', (p) => p.title), col('Destination', (p) => p.destination), col('Nights', (p) => p.nights, 'int', { noTotal: true }), col('Theme', (p) => p.theme),
      col('Your net from', (p) => p.price && p.price.net, 'money', { noTotal: true }), col('Sell from', (p) => p.price && p.price.sell, 'money', { noTotal: true }),
      col('Your earning', (p) => p.price && p.price.earning, 'money', { noTotal: true }), col('Next departure', (p) => p.next && p.next.depart_on, 'date'), col('Seats left', (p) => p.next && p.next.left, 'int', { noTotal: true }),
    ],
  }),
  'agent/catalogue': (d) => ({
    name: d.cfg && d.cfg.plural ? d.cfg.plural : 'Catalogue', filter: [d.f.dest, d.f.city, d.f.category, d.f.q && `“${d.f.q}”`].filter(Boolean).join(', '), rows: d.products, columns: [
      col('Service', (p) => p.title), col('City', (p) => p.city), col('Country', (p) => p.country), col('Category', (p) => p.category), col('Duration', (p) => p.duration),
      col('Your net rate', (p) => p.price && p.price.net, 'money', { noTotal: true }), col('Per', (p) => p.price && p.price.unit), col('You earn', (p) => p.price && p.price.earn, 'money', { noTotal: true }),
    ],
  }),

  // ---------- backend team ----------
  'backend/products': (d) => ({
    name: 'Inventory', filter: [d.f.kind && d.kinds[d.f.kind] && d.kinds[d.f.kind].plural, d.f.status && cap(d.f.status), d.f.dest, d.f.q && `“${d.f.q}”`].filter(Boolean).join(', '), rows: d.products, columns: [
      col('Type', (p) => (d.kinds[p.kind] ? d.kinds[p.kind].label || cap(p.kind) : cap(p.kind))), col('Title', (p) => p.title), col('City', (p) => p.city), col('Country', (p) => p.country), col('Category', (p) => p.category),
      col('Status', (p) => cap(p.status)), col('Priced per', (p) => (d.basisLabels && d.basisLabels[p.price_basis]) || p.price_basis),
      col('Net adult', (p) => p.net_adult, 'money', { noTotal: true }), col('Net child', (p) => p.net_child, 'money', { noTotal: true }), col('Net infant', (p) => p.net_infant, 'money', { noTotal: true }),
      col('Cost adult', (p) => p.cost_adult, 'money', { noTotal: true }), col('Bookings', (p) => p.bookings, 'int'), col('Updated by', (p) => p.updated_by_name), col('Updated', (p) => p.updated_at, 'datetime'),
    ],
  }),
  'backend/booking-requests': (d) => ({
    name: 'Booking requests', filter: cap(d.show), rows: d.rows, columns: [
      col('Quote', (q) => q.code), col('Trip', (q) => q.title), col('Agency', (q) => q.agency), col('Requested by', (q) => q.requested_by), col('Travel date', (q) => q.travel_date, 'date'),
      col('Adults', (q) => q.adults, 'int'), col('Children', (q) => q.children, 'int'), col('Net', (q) => q.approval_net, 'money'), col('Status', (q) => cap(q.approval_status)),
      col('Requested', (q) => q.approval_requested_at, 'datetime'), col('Decided by', (q) => q.decided_by), col('Decided', (q) => q.approval_decided_at, 'datetime'), col('Pay by', (q) => q.approval_until, 'datetime'),
    ],
  }),
  'backend/enquiries': (d) => ({
    name: 'Enquiries', filter: [d.status && cap(d.status), d.mine && 'assigned to me', d.q && `“${d.q}”`].filter(Boolean).join(', '), rows: d.rows, columns: [
      col('Name', (e) => e.name), col('Company', (e) => e.company), col('Phone', (e) => e.phone), col('Email', (e) => e.email), col('City', (e) => e.city),
      col('Topic', (e) => (d.topics && d.topics[e.topic]) || cap(e.topic)), col('Destination', (e) => e.destination), col('Travellers', (e) => e.pax, 'int', { noTotal: true }),
      col('Status', (e) => cap(e.status)), col('Assigned to', (e) => e.assignee), col('Follow up on', (e) => e.follow_up_on, 'date'), col('Received', (e) => e.created_at, 'datetime'),
    ],
  }),
  'backend/packages': (d) => ({
    name: 'VaayuTrip packages', rows: d.packages, columns: [
      col('Package', (p) => p.title), col('Destination', (p) => p.destination), col('Nights', (p) => p.nights, 'int', { noTotal: true }), col('Type', (p) => cap(p.package_type)), col('Status', (p) => cap(p.status)),
      col('Net from', (p) => p.price && p.price.net, 'money', { noTotal: true }), col('Services', (p) => p.services, 'int', { noTotal: true }), col('Quotes', (p) => p.quotes, 'int'),
      col('Agent copies', (p) => p.copies, 'int'), col('Upcoming departures', (p) => p.departures, 'int'), col('Updated', (p) => p.updated_at, 'datetime'),
    ],
  }),
};

const hasExport = (view) => Object.prototype.hasOwnProperty.call(SHEETS, view);

// The current page's address with ?download=xlsx (and without ?page), for the Excel button.
function exportHref(req) {
  const q = new URLSearchParams(req.query);
  q.delete('page');
  q.set('download', 'xlsx');
  return `${req.baseUrl}${req.path}?${q}`;
}

function sendXlsx(req, res, view, data) {
  const s = SHEETS[view](data);
  const rows = (s.rows || []).slice(0, MAX_ROWS);
  const now = new Date(Date.now() + 330 * 60000);
  const stamp = now.toISOString().slice(0, 10);
  const when = now.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  const who = data.agency || res.locals.agency;
  const owner = req.user && req.user.role === 'agent' && who ? who.name : 'VaayuTrip';
  const meta = [`Downloaded ${when} IST`, req.user && `by ${req.user.name}`, s.filter && `Showing: ${s.filter}`, `${rows.length} row${rows.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const buf = buildXlsx({ sheet: s.name, title: `${owner} · ${s.name}`, meta, columns: s.columns, rows });
  const file = `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}_${stamp}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${file}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(buf);
}

module.exports = { wantsXlsx, hasExport, exportHref, sendXlsx, MAX_ROWS };
