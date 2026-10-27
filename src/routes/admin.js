const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { one, all, run, tx, notify, getSettings, setSetting, UPLOADS_DIR } = require('../db');
const { num, uniqueSlug, round2 } = require('../util');
const { requireAdmin, h } = require('../auth');
const svc = require('../services');
const { CATEGORIES, activityFromForm, publishProblems, netPerPerson } = require('../activities');
const { withCover, coverFrom } = require('../photos');
const { KYC_DIR } = require('../kyc');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.pendingTopups = one("SELECT COUNT(*) AS n FROM topup_requests WHERE status = 'pending'").n;
  res.locals.openTickets = one("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'").n;
  next();
});

const str = (v) => String(v ?? '').trim();

// ---------- dashboard ----------

router.get('/', h((req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const stats = {
    agents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'active'").n,
    pendingAgents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'pending'").n,
    activities: one("SELECT COUNT(*) AS n FROM activities WHERE status = 'published'").n,
    agentPackages: one('SELECT COUNT(*) AS n FROM packages WHERE agency_id IS NOT NULL').n,
    ...one(`SELECT COUNT(*) AS bookings, COALESCE(SUM(total_net), 0) AS revenue FROM bookings WHERE status != 'cancelled' AND substr(created_at, 1, 7) = ?`, month),
    walletFloat: one('SELECT COALESCE(SUM(wallet_balance), 0) AS n FROM agencies').n,
    creditOut: one('SELECT COALESCE(SUM(credit_used), 0) AS n FROM agencies').n,
    cancelRequests: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancel_requested'").n,
  };
  const bookings = all('SELECT b.*, a.name AS agency_name FROM bookings b JOIN agencies a ON a.id = b.agency_id ORDER BY b.id DESC LIMIT 8');
  const pending = all("SELECT * FROM agencies WHERE status = 'pending' ORDER BY id DESC LIMIT 5");
  const topAgents = all(
    `SELECT a.id, a.name, a.city, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_net), 0) AS revenue
     FROM agencies a LEFT JOIN bookings b ON b.agency_id = a.id AND b.status != 'cancelled'
     WHERE a.status = 'active' GROUP BY a.id ORDER BY revenue DESC LIMIT 5`,
  );
  const topActivities = all(
    `SELECT a.id, a.title, a.city, COUNT(DISTINCT b.id) AS bookings FROM activities a
     LEFT JOIN quote_items qi ON qi.activity_id = a.id LEFT JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled'
     GROUP BY a.id ORDER BY bookings DESC, a.id LIMIT 5`,
  );
  res.page('admin/dashboard', { title: 'Admin dashboard', stats, bookings, pending, topAgents, topActivities });
}));

// ---------- agents ----------

router.get('/agents', h((req, res) => {
  const status = ['pending', 'active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const agents = all(
    `SELECT a.*, (SELECT COUNT(*) FROM bookings b WHERE b.agency_id = a.id AND b.status != 'cancelled') AS bookings,
       (SELECT u.name FROM users u WHERE u.agency_id = a.id ORDER BY u.id LIMIT 1) AS contact
     FROM agencies a ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC`, ...(status ? [status] : []),
  );
  res.page('admin/agents', { title: 'Agents', agents, status });
}));

router.get('/agents/:id', h((req, res, next) => {
  const agent = one('SELECT * FROM agencies WHERE id = ?', num(req.params.id));
  if (!agent) return next();
  const users = all('SELECT id, name, email, phone, created_at FROM users WHERE agency_id = ?', agent.id);
  const bookings = all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const txns = all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const totals = one("SELECT COUNT(*) AS n, COALESCE(SUM(total_net), 0) AS revenue, COALESCE(SUM(total_sell - total_net - total_cost), 0) AS commission FROM bookings WHERE agency_id = ? AND status != 'cancelled'", agent.id);
  res.page('admin/agent', { title: agent.name, agent, users, bookings, txns, totals });
}));

// Tax certificates are private: served only here, inline, from the KYC folder.
router.get('/agents/:id/tax-doc', h((req, res, next) => {
  const a = one('SELECT tax_doc FROM agencies WHERE id = ?', num(req.params.id));
  const file = a && a.tax_doc && path.join(KYC_DIR, path.basename(a.tax_doc));
  if (!file || !fs.existsSync(file)) return next();
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.sendFile(file);
}));

router.post('/agents/:id/status', h((req, res) => {
  const id = num(req.params.id);
  const status = ['active', 'suspended', 'pending'].includes(req.body.status) ? req.body.status : null;
  const kyc = ['verified', 'rejected', 'pending'].includes(req.body.kyc_status) ? req.body.kyc_status : null;
  if (kyc === 'verified') {
    const a = one('SELECT gstin, tax_id, tax_doc FROM agencies WHERE id = ?', id);
    if (!a || !(a.gstin || a.tax_id) || !a.tax_doc) throw new svc.AppError("Can't verify KYC: the agency hasn't provided a tax number and registration certificate yet.");
  }
  if (status) run('UPDATE agencies SET status = ? WHERE id = ?', status, id);
  if (kyc) run('UPDATE agencies SET kyc_status = ? WHERE id = ?', kyc, id);
  if (status === 'active') {
    const agency = one('SELECT api_key FROM agencies WHERE id = ?', id);
    if (!agency.api_key) run('UPDATE agencies SET api_key = ? WHERE id = ?', `vt_live_${crypto.randomBytes(18).toString('hex')}`, id);
    notify(id, 'Account approved', 'Welcome aboard! You can now build packages from VaayuTrip activities and book them, plus flights and hotels.', '/agent');
  }
  if (status === 'suspended') notify(id, 'Account suspended', 'Contact VaayuTrip support for details.', null);
  req.flash('success', 'Agent updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/credit', h((req, res) => {
  const id = num(req.params.id);
  run('UPDATE agencies SET credit_limit = ? WHERE id = ?', Math.max(0, round2(num(req.body.credit_limit, 0))), id);
  notify(id, 'Credit limit updated', `Your credit limit is now ₹${Math.max(0, num(req.body.credit_limit, 0)).toLocaleString('en-IN')}.`, '/agent/wallet');
  req.flash('success', 'Credit limit updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/wallet', h((req, res) => {
  const id = num(req.params.id);
  const amount = round2(num(req.body.amount, 0));
  if (!amount) throw new svc.AppError('Enter a non-zero amount (negative to debit).');
  tx(() => svc.moveWallet(id, amount > 0 ? 'topup' : 'adjustment', amount, str(req.body.ref) || null, str(req.body.note) || 'Adjustment by VaayuTrip'));
  notify(id, amount > 0 ? 'Wallet credited' : 'Wallet debited', `₹${Math.abs(amount).toLocaleString('en-IN')} ${amount > 0 ? 'added to' : 'deducted from'} your wallet.`, '/agent/wallet');
  req.flash('success', 'Wallet updated.');
  res.redirect(`/admin/agents/${id}`);
}));

// ---------- activities ----------

const ACT_FIELDS = ['title', 'city', 'country', 'category', 'duration', 'summary', 'description', 'highlights', 'inclusions', 'exclusions', 'pickup', 'timing',
  'cancellation', 'image_url', 'price_basis', 'group_size', 'net_adult', 'net_child'];

// How many agent packages and bookings use each activity.
const USAGE = `(SELECT COUNT(*) FROM packages p WHERE p.agency_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM json_each(p.details, '$.activities') j WHERE json_extract(j.value, '$.id') = a.id)) AS packages,
   (SELECT COUNT(DISTINCT b.id) FROM quote_items qi JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled' WHERE qi.activity_id = a.id) AS bookings`;

router.get('/activities', h((req, res) => {
  const f = {
    status: ['draft', 'published'].includes(req.query.status) ? req.query.status : '',
    city: str(req.query.city),
    category: CATEGORIES.includes(req.query.category) ? req.query.category : '',
  };
  const where = [['a.status = ?', f.status], ['a.city = ?', f.city], ['a.category = ?', f.category]].filter(([, v]) => v);
  const activities = all(
    `SELECT a.*, ${USAGE} FROM activities a ${where.length ? `WHERE ${where.map(([c]) => c).join(' AND ')}` : ''} ORDER BY a.country != 'India', a.city, a.title`,
    ...where.map(([, v]) => v),
  ).map((a) => ({ ...a, perPerson: netPerPerson(a) }));
  const cities = all('SELECT DISTINCT city FROM activities ORDER BY city').map((r) => r.city);
  res.page('admin/activities', { title: 'Activities', activities, cities, categories: CATEGORIES, f });
}));

const activityForm = (a) => ({ a, categories: CATEGORIES, problems: a.id ? publishProblems(a) : [] });

router.get('/activities/new', (req, res) => {
  res.page('admin/activity-form', { title: 'New activity', ...activityForm({ country: 'India', price_basis: 'per_person', status: 'draft' }) });
});

router.post('/activities', withCover(svc.AppError), h((req, res) => {
  const a = activityFromForm(req.body);
  a.image_url = coverFrom(req, null);
  if (!a.title || !a.city) throw new svc.AppError('Title and city are required.');
  const id = run(
    `INSERT INTO activities (${ACT_FIELDS.join(', ')}, slug) VALUES (${ACT_FIELDS.map(() => '?').join(', ')}, ?)`,
    ...ACT_FIELDS.map((k) => a[k]), uniqueSlug('activities', `${a.title} ${a.city}`),
  ).lastInsertRowid;
  req.flash('success', 'Activity saved as a draft. Publish it to make it available to agents.');
  res.redirect(`/admin/activities/${id}`);
}));

router.get('/activities/:id', h((req, res, next) => {
  const a = one(`SELECT a.*, ${USAGE} FROM activities a WHERE a.id = ?`, num(req.params.id));
  if (!a) return next();
  res.page('admin/activity-form', { title: a.title, ...activityForm(a) });
}));

router.post('/activities/:id', withCover(svc.AppError), h((req, res, next) => {
  const old = one('SELECT * FROM activities WHERE id = ?', num(req.params.id));
  if (!old) return next();
  const a = activityFromForm(req.body);
  a.image_url = coverFrom(req, old.image_url);
  if (!a.title || !a.city) throw new svc.AppError('Title and city are required.');
  run(`UPDATE activities SET ${ACT_FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...ACT_FIELDS.map((k) => a[k]), old.id);
  const problems = publishProblems(a);
  if (old.status === 'published' && problems.length) {
    run("UPDATE activities SET status = 'draft' WHERE id = ?", old.id);
    req.flash('warn', `Activity moved back to draft: ${problems[0]}`);
  } else {
    req.flash('success', 'Activity saved. New quotes use the updated price; quotes already made keep theirs.');
  }
  res.redirect(`/admin/activities/${old.id}`);
}));

router.post('/activities/:id/status', h((req, res, next) => {
  const a = one('SELECT * FROM activities WHERE id = ?', num(req.params.id));
  if (!a) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = publishProblems(a);
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  run("UPDATE activities SET status = ?, updated_at = datetime('now') WHERE id = ?", status, a.id);
  if (status === 'published' && a.status !== 'published') {
    for (const ag of all("SELECT id FROM agencies WHERE status = 'active'")) {
      notify(ag.id, 'New activity', `${a.title} (${a.city}) is available for your quotes and packages.`, `/agent/activities/${a.id}`);
    }
  }
  req.flash('success', status === 'published'
    ? 'Published: agents can now add this activity to quotes and packages.'
    : 'Unpublished: agents can no longer add it, and packages that use it show it as unavailable.');
  res.redirect(`/admin/activities/${a.id}`);
}));

router.post('/activities/:id/duplicate', h((req, res, next) => {
  const a = one('SELECT * FROM activities WHERE id = ?', num(req.params.id));
  if (!a) return next();
  const copy = { ...a, title: `${a.title} (copy)` };
  const id = run(
    `INSERT INTO activities (${ACT_FIELDS.join(', ')}, slug) VALUES (${ACT_FIELDS.map(() => '?').join(', ')}, ?)`,
    ...ACT_FIELDS.map((k) => copy[k]), uniqueSlug('activities', `${copy.title} ${copy.city}`),
  ).lastInsertRowid;
  req.flash('success', 'Copy created as a draft.');
  res.redirect(`/admin/activities/${id}`);
}));

router.post('/activities/:id/delete', h((req, res) => {
  run('DELETE FROM activities WHERE id = ?', num(req.params.id));
  req.flash('success', "Activity deleted. Existing quotes and bookings keep their lines; agents' packages show it as no longer offered.");
  res.redirect('/admin/activities');
}));

// ---------- bookings ----------

router.get('/bookings', h((req, res) => {
  const status = ['confirmed', 'cancel_requested', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const bookings = all(
    `SELECT b.*, a.name AS agency_name, c.name AS customer_name FROM bookings b JOIN agencies a ON a.id = b.agency_id
     LEFT JOIN customers c ON c.id = b.customer_id ${status ? 'WHERE b.status = ?' : ''} ORDER BY b.id DESC`, ...(status ? [status] : []),
  );
  res.page('admin/bookings', { title: 'Bookings', bookings, status });
}));

router.get('/bookings/:id', h((req, res, next) => {
  const booking = one('SELECT b.*, a.name AS agency_name FROM bookings b JOIN agencies a ON a.id = b.agency_id WHERE b.id = ?', num(req.params.id));
  if (!booking) return next();
  const full = booking.quote_id ? svc.getQuote(booking.quote_id) : null;
  const invoices = all('SELECT * FROM invoices WHERE booking_id = ? OR (quote_id = ? AND quote_id IS NOT NULL) ORDER BY id DESC', booking.id, booking.quote_id);
  res.page('admin/booking', { title: `Booking ${booking.code}`, booking, full, invoices });
}));

router.post('/bookings/:id/cancel', h((req, res) => {
  const id = num(req.params.id);
  svc.approveCancellation(id, Math.max(0, num(req.body.refund, 0)));
  req.flash('success', 'Booking cancelled and refund credited to the agent.');
  res.redirect(`/admin/bookings/${id}`);
}));

router.post('/bookings/:id/reject-cancel', h((req, res) => {
  const id = num(req.params.id);
  const b = one('SELECT * FROM bookings WHERE id = ?', id);
  run("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'cancel_requested'", id);
  notify(b.agency_id, 'Cancellation declined', `${b.code}: ${str(req.body.reason) || 'non-refundable as per supplier policy.'}`, `/agent/bookings/${id}`);
  req.flash('success', 'Cancellation request declined.');
  res.redirect(`/admin/bookings/${id}`);
}));

// ---------- wallet top-ups ----------

router.get('/topups', h((req, res) => {
  const requests = all('SELECT t.*, a.name AS agency_name, a.wallet_balance FROM topup_requests t JOIN agencies a ON a.id = t.agency_id ORDER BY t.status = \'pending\' DESC, t.id DESC');
  res.page('admin/topups', { title: 'Top-up requests', requests });
}));

router.post('/topups/:id/approve', h((req, res) => {
  svc.approveTopup(num(req.params.id));
  req.flash('success', 'Top-up approved and wallet credited.');
  res.redirect('/admin/topups');
}));

router.post('/topups/:id/reject', h((req, res) => {
  const r = one("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending'", num(req.params.id));
  if (r) {
    run("UPDATE topup_requests SET status = 'rejected' WHERE id = ?", r.id);
    notify(r.agency_id, 'Top-up not verified', `We couldn't verify your ₹${r.amount.toLocaleString('en-IN')} payment. Contact support with the UTR.`, '/agent/wallet');
  }
  res.redirect('/admin/topups');
}));

// ---------- invoices, notifications, settings ----------

router.get('/invoices', h((req, res) => {
  const kind = ['b2b', 'customer_vaayu', 'customer_agent'].includes(req.query.kind) ? req.query.kind : '';
  const invoices = all(
    `SELECT i.*, a.name AS agency_name FROM invoices i JOIN agencies a ON a.id = i.agency_id ${kind ? 'WHERE i.kind = ?' : ''} ORDER BY i.id DESC`, ...(kind ? [kind] : []),
  ).map((i) => ({ ...i, doc: JSON.parse(i.data) }));
  res.page('admin/invoices', { title: 'Invoices', invoices, kind });
}));

router.get('/invoices/:id', h((req, res, next) => {
  const inv = one('SELECT * FROM invoices WHERE id = ?', num(req.params.id));
  if (!inv) return next();
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, doc: JSON.parse(inv.data), back: '/admin/invoices' }, 'doc');
}));

router.get('/notifications', h((req, res) => {
  const items = all('SELECT * FROM notifications WHERE agency_id IS NULL ORDER BY id DESC LIMIT 100');
  run('UPDATE notifications SET is_read = 1 WHERE agency_id IS NULL');
  res.locals.unread = 0;
  res.page('agent/notifications', { title: 'Notifications', items });
}));

// ---------- offers ----------

router.get('/offers', h((req, res) => {
  const offers = all("SELECT *, (is_active = 1 AND (valid_until IS NULL OR valid_until >= date('now'))) AS live FROM offers ORDER BY id DESC");
  res.page('admin/offers', { title: 'Offers & deals', offers });
}));

router.post('/offers', h((req, res) => {
  const b = req.body;
  const title = str(b.title).slice(0, 120);
  if (!title) throw new svc.AppError('Give the offer a title.');
  // Links stay inside the agent portal so an offer can't send agents to another site.
  const link = str(b.link);
  if (link && !/^\/agent(\/[\w\-/?=&.%]*)?$/.test(link)) throw new svc.AppError('Link must be a page in the agent portal, starting with /agent');
  run('INSERT INTO offers (title, body, code, link, valid_until) VALUES (?, ?, ?, ?, ?)',
    title, str(b.body).slice(0, 400) || null, str(b.code).toUpperCase().slice(0, 30) || null, link || null, /^\d{4}-\d{2}-\d{2}$/.test(b.valid_until) ? b.valid_until : null);
  for (const a of all("SELECT id FROM agencies WHERE status = 'active'")) notify(a.id, 'New offer', title, '/agent/offers');
  req.flash('success', 'Offer published to all active agents.');
  res.redirect('/admin/offers');
}));

router.post('/offers/:id/toggle', h((req, res) => {
  run('UPDATE offers SET is_active = 1 - is_active WHERE id = ?', num(req.params.id));
  res.redirect('/admin/offers');
}));

router.post('/offers/:id/delete', h((req, res) => {
  run('DELETE FROM offers WHERE id = ?', num(req.params.id));
  req.flash('success', 'Offer deleted.');
  res.redirect('/admin/offers');
}));

// ---------- support tickets ----------

router.get('/tickets', h((req, res) => {
  const status = ['open', 'answered', 'closed'].includes(req.query.status) ? req.query.status : '';
  const tickets = all(
    `SELECT t.*, a.name AS agency_name, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages
     FROM tickets t JOIN agencies a ON a.id = t.agency_id ${status ? 'WHERE t.status = ?' : ''}
     ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC`, ...(status ? [status] : []),
  );
  res.page('admin/tickets', { title: 'Support tickets', tickets, status });
}));

router.get('/tickets/:id', h((req, res, next) => {
  const ticket = one('SELECT t.*, a.name AS agency_name, b.code AS booking_code FROM tickets t JOIN agencies a ON a.id = t.agency_id LEFT JOIN bookings b ON b.id = t.booking_id WHERE t.id = ?', num(req.params.id));
  if (!ticket) return next();
  const messages = all('SELECT m.*, u.name AS author FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id', ticket.id);
  res.page('ticket', { title: `${ticket.code} · ${ticket.subject}`, ticket, messages, base: '/admin/tickets', back: '/admin/tickets' });
}));

router.post('/tickets/:id/reply', h((req, res, next) => {
  const ticket = one('SELECT * FROM tickets WHERE id = ?', num(req.params.id));
  if (!ticket) return next();
  const body = str(req.body.body).slice(0, 4000);
  const close = req.body.close === '1';
  if (!body && !close) throw new svc.AppError('Write a reply first.');
  tx(() => {
    if (body) run('INSERT INTO ticket_messages (ticket_id, user_id, from_admin, body) VALUES (?, ?, 1, ?)', ticket.id, req.user.id, body);
    run("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?", close ? 'closed' : 'answered', ticket.id);
    notify(ticket.agency_id, close ? 'Ticket closed' : 'Support replied', `${ticket.code}: ${ticket.subject}`, `/agent/support/${ticket.id}`);
  });
  req.flash('success', close ? 'Ticket closed.' : 'Reply sent.');
  res.redirect(`/admin/tickets/${ticket.id}`);
}));

const SETTING_KEYS = ['company_name', 'legal_name', 'gstin', 'address', 'phone', 'email', 'tax_rate', 'tcs_rate', 'emi_rate'];

router.get('/settings', (req, res) => {
  res.page('admin/settings', { title: 'Settings', keys: SETTING_KEYS, values: getSettings() });
});

router.post('/settings', h((req, res) => {
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) setSetting(k, str(req.body[k]));
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

module.exports = router;
