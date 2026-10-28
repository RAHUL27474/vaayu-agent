const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { one, all, run, tx, notify, audit, getSettings, setSetting } = require('../db');
const { num, round2, hashPassword } = require('../util');
const { requireAdmin, h } = require('../auth');
const svc = require('../services');
const { KINDS } = require('../products');
const { KYC_DIR, KYC_FILES, missingKyc, kycLabel, requiredFiles, imageSize } = require('../kyc');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.pendingTopups = one("SELECT COUNT(*) AS n FROM topup_requests WHERE status = 'pending'").n;
  res.locals.openTickets = one("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'").n;
  next();
});

const str = (v) => String(v ?? '').trim();
const LOG_SQL = `SELECT l.*, u.name AS user_name, a.name AS agency_name FROM audit_log l
  LEFT JOIN users u ON u.id = l.user_id LEFT JOIN agencies a ON a.id = l.agency_id`;

// ---------- dashboard ----------

router.get('/', h((req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const stats = {
    agents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'active'").n,
    pendingAgents: one("SELECT COUNT(*) AS n FROM agencies WHERE status = 'pending'").n,
    products: one("SELECT COUNT(*) AS n FROM products WHERE status = 'published'").n,
    drafts: one("SELECT COUNT(*) AS n FROM products WHERE status = 'draft'").n,
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
  const topProducts = all(
    `SELECT p.id, p.kind, p.title, p.city, COUNT(DISTINCT b.id) AS bookings FROM products p
     LEFT JOIN quote_items qi ON qi.product_id = p.id LEFT JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled'
     GROUP BY p.id ORDER BY bookings DESC, p.id LIMIT 5`,
  );
  const recentLog = all(`${LOG_SQL} WHERE l.action != 'user.login' ORDER BY l.id DESC LIMIT 8`);
  res.page('admin/dashboard', { title: 'Admin dashboard', stats, bookings, pending, topAgents, topProducts, recentLog, kinds: KINDS });
}));

// ---------- agents ----------

router.get('/agents', h((req, res) => {
  const status = ['pending', 'active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const agents = all(
    `SELECT a.*, (SELECT COUNT(*) FROM bookings b WHERE b.agency_id = a.id AND b.status != 'cancelled') AS bookings,
       (SELECT u.name FROM users u WHERE u.agency_id = a.id ORDER BY u.id LIMIT 1) AS contact
     FROM agencies a ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC`, ...(status ? [status] : []),
  );
  res.page('admin/agents', { title: 'Agents', agents: agents.map((a) => ({ ...a, missing: missingKyc(a) })), status });
}));

router.get('/agents/:id', h((req, res, next) => {
  const agent = one('SELECT * FROM agencies WHERE id = ?', num(req.params.id));
  if (!agent) return next();
  const users = all('SELECT id, name, email, phone, created_at FROM users WHERE agency_id = ?', agent.id);
  const bookings = all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const txns = all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const totals = one("SELECT COUNT(*) AS n, COALESCE(SUM(total_net), 0) AS revenue, COALESCE(SUM(total_sell - total_net - total_cost), 0) AS commission FROM bookings WHERE agency_id = ? AND status != 'cancelled'", agent.id);
  res.page('admin/agent', { title: agent.name, agent, users, bookings, txns, totals, missing: missingKyc(agent) });
}));

// KYC files are private: served only here, inline, from the KYC folder.
// /agents/:id/tax-doc is kept for older links.
router.get(['/agents/:id/kyc/:field', '/agents/:id/tax-doc'], h((req, res, next) => {
  const field = req.params.field || 'tax_doc';
  if (!KYC_FILES[field]) return next();
  const a = one(`SELECT ${field} AS doc FROM agencies WHERE id = ?`, num(req.params.id));
  const file = a && a.doc && path.join(KYC_DIR, path.basename(a.doc));
  if (!file || !fs.existsSync(file)) return next();
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  if (req.query.download) return res.download(file, `${field}-${req.params.id}${path.extname(file)}`);
  res.sendFile(file);
}));

// A page around one KYC document: shows images and PDFs inline, with the agency's other documents one click away.
router.get('/agents/:id/kyc/:field/view', h((req, res, next) => {
  const field = req.params.field;
  if (!KYC_FILES[field]) return next();
  const agent = one('SELECT * FROM agencies WHERE id = ?', num(req.params.id));
  if (!agent) return next();
  const label = (f) => kycLabel(f, agent.country).replace(/^your /, 'applicant ').replace(/^./, (c) => c.toUpperCase());
  const tabs = requiredFiles(agent.country).map((f) => ({ field: f, label: label(f), have: Boolean(agent[f]) }));
  const file = agent[field] && path.join(KYC_DIR, path.basename(agent[field]));
  const exists = Boolean(file && fs.existsSync(file));
  const ext = exists ? path.extname(file).toLowerCase() : '';
  const size = exists && ext !== '.pdf' ? imageSize(file) : null;
  res.page('admin/kyc-view', {
    title: `${label(field)} · ${agent.name}`, agent, field, label: label(field), tabs, exists,
    kind: ext === '.pdf' ? 'pdf' : 'image', bytes: exists ? fs.statSync(file).size : 0, size,
    tooLarge: Boolean(size && size.width * size.height > 40e6),
    src: `/admin/agents/${agent.id}/kyc/${field}`,
  });
}));

// Send KYC back to the agency with a reason; they fix it from Company & branding → Verification.
router.post('/agents/:id/kyc-reject', h((req, res) => {
  const id = num(req.params.id);
  const a = one('SELECT id, name FROM agencies WHERE id = ?', id);
  if (!a) throw new svc.AppError('Agency not found.');
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) throw new svc.AppError('Give a reason so the agency knows what to fix.');
  run("UPDATE agencies SET kyc_status = 'rejected', kyc_note = ? WHERE id = ?", reason, id);
  notify(id, 'KYC documents need attention', `Your verification was not approved: ${reason.replace(/[.!?]?$/, ".")} Please upload corrected documents.`, '/agent/settings#tax');
  audit(req.user, 'agency.kyc_rejected', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: `${a.name}: KYC rejected (${reason})` });
  req.flash('success', `KYC sent back to ${a.name}.`);
  res.redirect(`/admin/agents/${id}#kyc`);
}));

router.post('/agents/:id/status', h((req, res) => {
  const id = num(req.params.id);
  const status = ['active', 'suspended', 'pending'].includes(req.body.status) ? req.body.status : null;
  const kyc = ['verified', 'rejected', 'pending'].includes(req.body.kyc_status) ? req.body.kyc_status : null;
  // Approval needs complete KYC: tax number, certificate, PAN card (India) and the applicant's photo.
  if (kyc === 'verified' || status === 'active') {
    const a = one('SELECT * FROM agencies WHERE id = ?', id);
    const missing = a ? missingKyc(a) : ['agency'];
    if (missing.length) throw new svc.AppError(`Can't approve yet: the agency still has to provide ${missing.join(', ')}.`);
  }
  if (status) run('UPDATE agencies SET status = ? WHERE id = ?', status, id);
  if (kyc) run('UPDATE agencies SET kyc_status = ? WHERE id = ?', kyc, id);
  if (kyc === 'verified' || status === 'active') run('UPDATE agencies SET kyc_note = NULL WHERE id = ?', id);
  if (status === 'active') {
    const agency = one('SELECT api_key FROM agencies WHERE id = ?', id);
    if (!agency.api_key) run('UPDATE agencies SET api_key = ? WHERE id = ?', `vt_live_${crypto.randomBytes(18).toString('hex')}`, id);
    notify(id, 'Account approved', 'Welcome aboard! You can now build your own packages from VaayuTrip airfares, hotels, activities and more, and book them.', '/agent');
  }
  if (status === 'suspended') notify(id, 'Account suspended', 'Contact VaayuTrip support for details.', null);
  const name = one('SELECT name FROM agencies WHERE id = ?', id)?.name;
  audit(req.user, 'agency.updated', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: [name, status && `status ${status}`, kyc && `KYC ${kyc}`].filter(Boolean).join(': ') });
  req.flash('success', 'Agent updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/credit', h((req, res) => {
  const id = num(req.params.id);
  run('UPDATE agencies SET credit_limit = ? WHERE id = ?', Math.max(0, round2(num(req.body.credit_limit, 0))), id);
  notify(id, 'Credit limit updated', `Your credit limit is now ₹${Math.max(0, num(req.body.credit_limit, 0)).toLocaleString('en-IN')}.`, '/agent/wallet');
  audit(req.user, 'agency.credit_limit', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: `Credit limit set to ₹${Math.max(0, num(req.body.credit_limit, 0)).toLocaleString('en-IN')}` });
  req.flash('success', 'Credit limit updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/wallet', h((req, res) => {
  const id = num(req.params.id);
  const amount = round2(num(req.body.amount, 0));
  if (!amount) throw new svc.AppError('Enter a non-zero amount (negative to debit).');
  tx(() => svc.moveWallet(id, amount > 0 ? 'topup' : 'adjustment', amount, str(req.body.ref) || null, str(req.body.note) || 'Adjustment by VaayuTrip'));
  notify(id, amount > 0 ? 'Wallet credited' : 'Wallet debited', `₹${Math.abs(amount).toLocaleString('en-IN')} ${amount > 0 ? 'added to' : 'deducted from'} your wallet.`, '/agent/wallet');
  audit(req.user, 'wallet.adjusted', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: `₹${amount.toLocaleString('en-IN')}: ${str(req.body.note) || 'Adjustment by VaayuTrip'}` });
  req.flash('success', 'Wallet updated.');
  res.redirect(`/admin/agents/${id}`);
}));

// ---------- activity log ----------

const LOG_ROLES = ['backend', 'agent', 'admin'];
const LOG_AREAS = {
  product: 'Inventory', package: 'Agent packages', quote: 'Quotes', booking: 'Bookings', agency: 'Agencies',
  topup: 'Wallet top-ups', wallet: 'Wallet', user: 'Users & logins', offer: 'Offers', settings: 'Settings', ticket: 'Support',
};

router.get('/log', h((req, res) => {
  const f = {
    role: LOG_ROLES.includes(req.query.role) ? req.query.role : '',
    area: LOG_AREAS[req.query.area] ? req.query.area : '',
    user: num(req.query.user, 0) || '',
    agency: num(req.query.agency, 0) || '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '',
    logins: req.query.logins === '1',
  };
  const where = [];
  const params = [];
  if (f.role) { where.push('l.role = ?'); params.push(f.role); }
  if (f.area) { where.push('l.action LIKE ?'); params.push(`${f.area}.%`); }
  if (f.user) { where.push('l.user_id = ?'); params.push(f.user); }
  if (f.agency) { where.push('l.agency_id = ?'); params.push(f.agency); }
  if (f.from) { where.push('date(l.created_at) >= ?'); params.push(f.from); }
  if (f.to) { where.push('date(l.created_at) <= ?'); params.push(f.to); }
  if (!f.logins && f.area !== 'user') where.push("l.action != 'user.login'");
  const page = Math.max(1, Math.round(num(req.query.page, 1)));
  const rows = all(`${LOG_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 101 OFFSET ?`, ...params, (page - 1) * 100);
  const users = all("SELECT id, name, role FROM users WHERE role IN ('admin', 'backend') ORDER BY role, name");
  const agencies = all('SELECT id, name FROM agencies ORDER BY name');
  res.page('admin/log', {
    title: 'Activity log', entries: rows.slice(0, 100), more: rows.length > 100, page, f, users, agencies, areas: LOG_AREAS, roles: LOG_ROLES,
  });
}));

// ---------- team (admins and the backend team) ----------

router.get('/team', h((req, res) => {
  const team = all(
    `SELECT u.*, (SELECT COUNT(*) FROM audit_log l WHERE l.user_id = u.id AND l.action LIKE 'product.%') AS changes,
       (SELECT MAX(created_at) FROM audit_log l WHERE l.user_id = u.id) AS last_seen
     FROM users u WHERE u.role IN ('admin', 'backend') ORDER BY u.role, u.name`,
  );
  res.page('admin/team', { title: 'Team', team });
}));

router.post('/team', h((req, res) => {
  const name = str(req.body.name);
  const email = str(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'backend';
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new svc.AppError('Enter a name and a valid email.');
  if (password.length < 8) throw new svc.AppError('The password must be at least 8 characters.');
  if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new svc.AppError('Someone already uses that email.');
  const id = run('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)', role, name, email, hashPassword(password)).lastInsertRowid;
  audit(req.user, 'user.created', { entity: 'user', id, summary: `${name} (${role === 'admin' ? 'admin' : 'backend team'})`, link: '/admin/team' });
  req.flash('success', `${name} can now log in at /login with that email and password.`);
  res.redirect('/admin/team');
}));

router.post('/team/:id/toggle', h((req, res, next) => {
  const u = one("SELECT * FROM users WHERE id = ? AND role IN ('admin', 'backend')", num(req.params.id));
  if (!u) return next();
  if (u.id === req.user.id) throw new svc.AppError("You can't switch off your own account.");
  run('UPDATE users SET is_active = 1 - is_active WHERE id = ?', u.id);
  audit(req.user, u.is_active ? 'user.deactivated' : 'user.reactivated', { entity: 'user', id: u.id, summary: u.name, link: '/admin/team' });
  req.flash('success', u.is_active ? `${u.name} can no longer log in.` : `${u.name} can log in again.`);
  res.redirect('/admin/team');
}));

router.post('/team/:id/password', h((req, res, next) => {
  const u = one("SELECT * FROM users WHERE id = ? AND role IN ('admin', 'backend')", num(req.params.id));
  if (!u) return next();
  const password = String(req.body.password || '');
  if (password.length < 8) throw new svc.AppError('The password must be at least 8 characters.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  audit(req.user, 'user.password_reset', { entity: 'user', id: u.id, summary: u.name, link: '/admin/team' });
  req.flash('success', `Password reset for ${u.name}.`);
  res.redirect('/admin/team');
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
  const cb = one('SELECT code, agency_id, refund_amount FROM bookings WHERE id = ?', id);
  audit(req.user, 'booking.cancelled', { entity: 'booking', id, agencyId: cb.agency_id, link: `/admin/bookings/${id}`, summary: `${cb.code}: refund ₹${(cb.refund_amount || 0).toLocaleString('en-IN')}` });
  req.flash('success', 'Booking cancelled and refund credited to the agent.');
  res.redirect(`/admin/bookings/${id}`);
}));

router.post('/bookings/:id/reject-cancel', h((req, res) => {
  const id = num(req.params.id);
  const b = one('SELECT * FROM bookings WHERE id = ?', id);
  run("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'cancel_requested'", id);
  audit(req.user, 'booking.cancel_declined', { entity: 'booking', id, agencyId: b.agency_id, link: `/admin/bookings/${id}`, summary: b.code });
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
  const t = one('SELECT agency_id, amount, utr FROM topup_requests WHERE id = ?', num(req.params.id));
  svc.approveTopup(num(req.params.id));
  audit(req.user, 'topup.approved', { entity: 'topup', id: num(req.params.id), agencyId: t.agency_id, link: '/admin/topups', summary: `₹${t.amount.toLocaleString('en-IN')} (UTR ${t.utr})` });
  req.flash('success', 'Top-up approved and wallet credited.');
  res.redirect('/admin/topups');
}));

router.post('/topups/:id/reject', h((req, res) => {
  const r = one("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending'", num(req.params.id));
  if (r) {
    run("UPDATE topup_requests SET status = 'rejected' WHERE id = ?", r.id);
    audit(req.user, 'topup.rejected', { entity: 'topup', id: r.id, agencyId: r.agency_id, link: '/admin/topups', summary: `₹${r.amount.toLocaleString('en-IN')} (UTR ${r.utr})` });
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
  audit(req.user, 'offer.published', { entity: 'offer', summary: title, link: '/admin/offers' });
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
  const before = getSettings();
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) setSetting(k, str(req.body[k]));
  const changed = SETTING_KEYS.filter((k) => req.body[k] !== undefined && str(req.body[k]) !== (before[k] ?? ''));
  if (changed.length) audit(req.user, 'settings.updated', { entity: 'settings', summary: changed.join(', '), link: '/admin/settings' });
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

module.exports = router;
