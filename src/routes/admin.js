const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { one, all, run, tx, notify, audit, getSettings, setSetting } = require('../db');
const { num, round2, hashPassword } = require('../util');
const { requireAdmin, h, idParam, MAX_AMOUNT } = require('../auth');
const svc = require('../services');
const { searchAll } = require('../search');
const phonepe = require('../phonepe');
const payments = require('../payments');
const { invoiceView } = require('../invoice-view');
const { KINDS, marginPct, repriceProducts } = require('../products');
const { KYC_DIR, KYC_FILES, missingKyc, kycLabel, requiredFiles, imageSize } = require('../kyc');
const { restoreFile } = require('../files');
const { paging, pageOf } = require('../paging');

const router = express.Router();
router.param('id', idParam);
router.param('itemId', idParam);
router.use(requireAdmin);
// Menu badges, in one round trip.
router.use(async (req, res, next) => {
  const c = await one("SELECT (SELECT COUNT(*) FROM topup_requests WHERE status = 'pending') AS topups, (SELECT COUNT(*) FROM tickets WHERE status = 'open') AS tickets");
  res.locals.pendingTopups = c.topups;
  res.locals.openTickets = c.tickets;
  next();
});

const str = (v) => String(v ?? '').trim();
const LOG_SQL = `SELECT l.*, u.name AS user_name, a.name AS agency_name FROM audit_log l
  LEFT JOIN users u ON u.id = l.user_id LEFT JOIN agencies a ON a.id = l.agency_id`;

// ---------- dashboard ----------

router.get('/', h(async (req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  // All headline numbers in one query; the lists below run in parallel.
  const statsQuery = one(`SELECT
      (SELECT COUNT(*) FROM agencies WHERE status = 'active') AS agents,
      (SELECT COUNT(*) FROM agencies WHERE status = 'pending') AS "pendingAgents",
      (SELECT COUNT(*) FROM products WHERE status = 'published') AS products,
      (SELECT COUNT(*) FROM products WHERE status = 'draft') AS drafts,
      (SELECT COUNT(*) FROM packages WHERE agency_id IS NOT NULL) AS "agentPackages",
      (SELECT COUNT(*) FROM bookings WHERE status != 'cancelled' AND substr(created_at, 1, 7) = ?) AS bookings,
      (SELECT COALESCE(SUM(total_net), 0) FROM bookings WHERE status != 'cancelled' AND substr(created_at, 1, 7) = ?) AS revenue,
      (SELECT COALESCE(SUM(wallet_balance), 0) FROM agencies) AS "walletFloat",
      (SELECT COALESCE(SUM(credit_used), 0) FROM agencies) AS "creditOut",
      (SELECT COUNT(*) FROM bookings WHERE status = 'cancel_requested') AS "cancelRequests"`, month, month);
  const [stats, bookings, pending, topAgents, topProducts, recentLog] = await Promise.all([
    statsQuery,
    all('SELECT b.*, a.name AS agency_name FROM bookings b JOIN agencies a ON a.id = b.agency_id ORDER BY b.id DESC LIMIT 8'),
    all("SELECT * FROM agencies WHERE status = 'pending' ORDER BY id DESC LIMIT 5"),
    all(
      `SELECT a.id, a.name, a.city, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_net), 0) AS revenue
     FROM agencies a LEFT JOIN bookings b ON b.agency_id = a.id AND b.status != 'cancelled'
     WHERE a.status = 'active' GROUP BY a.id ORDER BY revenue DESC LIMIT 5`,
    ),
    all(
      `SELECT p.id, p.kind, p.title, p.city, COUNT(DISTINCT b.id) AS bookings FROM products p
     LEFT JOIN quote_items qi ON qi.product_id = p.id LEFT JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled'
     GROUP BY p.id ORDER BY bookings DESC, p.id LIMIT 5`,
    ),
    all(`${LOG_SQL} WHERE l.action != 'user.login' ORDER BY l.id DESC LIMIT 8`),
  ]);
  res.page('admin/dashboard', { title: 'Admin dashboard', stats, bookings, pending, topAgents, topProducts, recentLog, kinds: KINDS });
}));

// ---------- agents ----------

router.get('/agents', h(async (req, res) => {
  const status = ['pending', 'active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const p = paging(req);
  const { rows: agents, pager } = pageOf(await all(
    `SELECT a.*, (SELECT COUNT(*) FROM bookings b WHERE b.agency_id = a.id AND b.status != 'cancelled') AS bookings,
       (SELECT u.name FROM users u WHERE u.agency_id = a.id ORDER BY u.id LIMIT 1) AS contact
     FROM agencies a ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC ${p.sql}`, ...(status ? [status] : []), ...p.params,
  ), p);
  res.page('admin/agents', { title: 'Agents', agents: agents.map((a) => ({ ...a, missing: missingKyc(a) })), pager, status });
}));

router.get('/agents/:id', h(async (req, res, next) => {
  const agent = await one('SELECT * FROM agencies WHERE id = ?', num(req.params.id));
  if (!agent) return next();
  const users = await all('SELECT id, name, email, phone, created_at FROM users WHERE agency_id = ?', agent.id);
  const bookings = await all('SELECT * FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const txns = await all('SELECT * FROM wallet_txns WHERE agency_id = ? ORDER BY id DESC LIMIT 20', agent.id);
  const totals = await one("SELECT COUNT(*) AS n, COALESCE(SUM(total_net), 0) AS revenue, COALESCE(SUM(total_sell - total_net - total_cost), 0) AS commission FROM bookings WHERE agency_id = ? AND status != 'cancelled'", agent.id);
  res.page('admin/agent', { title: agent.name, agent, users, bookings, txns, totals, missing: missingKyc(agent) });
}));

// KYC files are private: served only here, inline, from the KYC folder.
// /agents/:id/tax-doc is kept for older links.
router.get(['/agents/:id/kyc/:field', '/agents/:id/tax-doc'], h(async (req, res, next) => {
  const field = req.params.field || 'tax_doc';
  if (!KYC_FILES[field]) return next();
  const a = await one(`SELECT ${field} AS doc FROM agencies WHERE id = ?`, num(req.params.id));
  const file = a && a.doc && path.join(KYC_DIR, path.basename(a.doc));
  if (!file || !await restoreFile(file)) return next();
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  if (req.query.download) return res.download(file, `${field}-${req.params.id}${path.extname(file)}`);
  res.sendFile(file);
}));

// A page around one KYC document: shows images and PDFs inline, with the agency's other documents one click away.
router.get('/agents/:id/kyc/:field/view', h(async (req, res, next) => {
  const field = req.params.field;
  if (!KYC_FILES[field]) return next();
  const agent = await one('SELECT * FROM agencies WHERE id = ?', num(req.params.id));
  if (!agent) return next();
  const label = (f) => kycLabel(f, agent.country).replace(/^your /, 'applicant ').replace(/^./, (c) => c.toUpperCase());
  const tabs = requiredFiles(agent.country).map((f) => ({ field: f, label: label(f), have: Boolean(agent[f]) }));
  const file = agent[field] && path.join(KYC_DIR, path.basename(agent[field]));
  const exists = Boolean(file && await restoreFile(file));
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
router.post('/agents/:id/kyc-reject', h(async (req, res) => {
  const id = num(req.params.id);
  const a = await one('SELECT id, name FROM agencies WHERE id = ?', id);
  if (!a) throw new svc.AppError('Agency not found.');
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) throw new svc.AppError('Give a reason so the agency knows what to fix.');
  await run("UPDATE agencies SET kyc_status = 'rejected', kyc_note = ? WHERE id = ?", reason, id);
  await notify(id, 'KYC documents need attention', `Your verification was not approved: ${reason.replace(/[.!?]?$/, ".")} Please upload corrected documents.`, '/agent/settings#tax');
  await audit(req.user, 'agency.kyc_rejected', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: `${a.name}: KYC rejected (${reason})` });
  req.flash('success', `KYC sent back to ${a.name}.`);
  res.redirect(`/admin/agents/${id}#kyc`);
}));

router.post('/agents/:id/status', h(async (req, res) => {
  const id = num(req.params.id);
  const status = ['active', 'suspended', 'pending'].includes(req.body.status) ? req.body.status : null;
  const kyc = ['verified', 'rejected', 'pending'].includes(req.body.kyc_status) ? req.body.kyc_status : null;
  // Approval needs complete KYC: tax number, certificate, PAN card (India) and the applicant's photo.
  if (kyc === 'verified' || status === 'active') {
    const a = await one('SELECT * FROM agencies WHERE id = ?', id);
    const missing = a ? missingKyc(a) : ['agency'];
    if (missing.length) throw new svc.AppError(`Can't approve yet: the agency still has to provide ${missing.join(', ')}.`);
  }
  if (status) await run('UPDATE agencies SET status = ? WHERE id = ?', status, id);
  if (kyc) await run('UPDATE agencies SET kyc_status = ? WHERE id = ?', kyc, id);
  if (kyc === 'verified' || status === 'active') await run('UPDATE agencies SET kyc_note = NULL WHERE id = ?', id);
  if (status === 'active') {
    const agency = await one('SELECT api_key FROM agencies WHERE id = ?', id);
    if (!agency.api_key) await run('UPDATE agencies SET api_key = ? WHERE id = ?', `vt_live_${crypto.randomBytes(18).toString('hex')}`, id);
    await notify(id, 'Account approved', 'Welcome aboard! You can now build your own packages from VaayuTrip airfares, hotels, activities and more, and book them.', '/agent');
  }
  if (status === 'suspended') await notify(id, 'Account suspended', 'Contact VaayuTrip support for details.', null);
  const name = (await one('SELECT name FROM agencies WHERE id = ?', id))?.name;
  await audit(req.user, 'agency.updated', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: [name, status && `status ${status}`, kyc && `KYC ${kyc}`].filter(Boolean).join(': ') });
  req.flash('success', 'Agent updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/credit', h(async (req, res) => {
  const id = num(req.params.id);
  const limit = round2(num(req.body.credit_limit, NaN));
  if (!(limit >= 0 && limit <= MAX_AMOUNT)) throw new svc.AppError('Enter a credit limit between ₹0 and ₹1 crore.');
  await run('UPDATE agencies SET credit_limit = ? WHERE id = ?', limit, id);
  await notify(id, 'Credit limit updated', `Your credit limit is now ₹${Math.max(0, num(req.body.credit_limit, 0)).toLocaleString('en-IN')}.`, '/agent/wallet');
  await audit(req.user, 'agency.credit_limit', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: `Credit limit set to ₹${Math.max(0, num(req.body.credit_limit, 0)).toLocaleString('en-IN')}` });
  req.flash('success', 'Credit limit updated.');
  res.redirect(`/admin/agents/${id}`);
}));

router.post('/agents/:id/wallet', h(async (req, res) => {
  const id = num(req.params.id);
  const amount = round2(num(req.body.amount, 0));
  if (!amount) throw new svc.AppError('Enter a non-zero amount (negative to debit).');
  if (Math.abs(amount) > MAX_AMOUNT) throw new svc.AppError('That adjustment is too large (limit ₹1 crore).');
  await tx(async () => await svc.moveWallet(id, amount > 0 ? 'topup' : 'adjustment', amount, str(req.body.ref) || null, str(req.body.note) || 'Adjustment by VaayuTrip'));
  await notify(id, amount > 0 ? 'Wallet credited' : 'Wallet debited', `₹${Math.abs(amount).toLocaleString('en-IN')} ${amount > 0 ? 'added to' : 'deducted from'} your wallet.`, '/agent/wallet');
  await audit(req.user, 'wallet.adjusted', { entity: 'agency', id, agencyId: id, link: `/admin/agents/${id}`, summary: `₹${amount.toLocaleString('en-IN')}: ${str(req.body.note) || 'Adjustment by VaayuTrip'}` });
  req.flash('success', 'Wallet updated.');
  res.redirect(`/admin/agents/${id}`);
}));

// ---------- activity log ----------

const LOG_ROLES = ['backend', 'agent', 'admin'];
const LOG_AREAS = {
  product: 'Inventory', package: 'Agent packages', quote: 'Quotes', booking: 'Bookings', agency: 'Agencies',
  topup: 'Wallet top-ups', wallet: 'Wallet', user: 'Users & logins', offer: 'Offers', settings: 'Settings', ticket: 'Support',
};

router.get('/log', h(async (req, res) => {
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
  if (f.from) { where.push('sqldate(l.created_at) >= ?'); params.push(f.from); }
  if (f.to) { where.push('sqldate(l.created_at) <= ?'); params.push(f.to); }
  if (!f.logins && f.area !== 'user') where.push("l.action != 'user.login'");
  const page = Math.max(1, Math.round(num(req.query.page, 1)));
  const rows = await all(`${LOG_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 101 OFFSET ?`, ...params, (page - 1) * 100);
  const users = await all("SELECT id, name, role FROM users WHERE role IN ('admin', 'backend') ORDER BY role, name");
  const agencies = await all('SELECT id, name FROM agencies ORDER BY name');
  res.page('admin/log', {
    title: 'Activity log', entries: rows.slice(0, 100), more: rows.length > 100, page, f, users, agencies, areas: LOG_AREAS, roles: LOG_ROLES,
  });
}));

// ---------- team (admins and the backend team) ----------

router.get('/team', h(async (req, res) => {
  const team = await all(
    `SELECT u.*, (SELECT COUNT(*) FROM audit_log l WHERE l.user_id = u.id AND l.action LIKE 'product.%') AS changes,
       (SELECT MAX(created_at) FROM audit_log l WHERE l.user_id = u.id) AS last_seen
     FROM users u WHERE u.role IN ('admin', 'backend') ORDER BY u.role, u.name`,
  );
  res.page('admin/team', { title: 'Team', team });
}));

router.post('/team', h(async (req, res) => {
  const name = str(req.body.name);
  const email = str(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'backend';
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new svc.AppError('Enter a name and a valid email.');
  if (password.length < 8) throw new svc.AppError('The password must be at least 8 characters.');
  if (await one('SELECT 1 FROM users WHERE email = ?', email)) throw new svc.AppError('Someone already uses that email.');
  const id = (await run('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)', role, name, email, hashPassword(password))).lastInsertRowid;
  await audit(req.user, 'user.created', { entity: 'user', id, summary: `${name} (${role === 'admin' ? 'admin' : 'backend team'})`, link: '/admin/team' });
  req.flash('success', `${name} can now log in at /login with that email and password.`);
  res.redirect('/admin/team');
}));

router.post('/team/:id/toggle', h(async (req, res, next) => {
  const u = await one("SELECT * FROM users WHERE id = ? AND role IN ('admin', 'backend')", num(req.params.id));
  if (!u) return next();
  if (u.id === req.user.id) throw new svc.AppError("You can't switch off your own account.");
  await run('UPDATE users SET is_active = 1 - is_active WHERE id = ?', u.id);
  await audit(req.user, u.is_active ? 'user.deactivated' : 'user.reactivated', { entity: 'user', id: u.id, summary: u.name, link: '/admin/team' });
  req.flash('success', u.is_active ? `${u.name} can no longer log in.` : `${u.name} can log in again.`);
  res.redirect('/admin/team');
}));

router.post('/agents/:id/users/:userId/password', h(async (req, res, next) => {
  const u = await one("SELECT * FROM users WHERE id = ? AND agency_id = ? AND role = 'agent'", num(req.params.userId), num(req.params.id));
  if (!u) return next();
  const password = String(req.body.password || '');
  if (password.length < 8) throw new svc.AppError('The password must be at least 8 characters.');
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  await run('DELETE FROM login_failures WHERE email = ?', u.email);
  await audit(req.user, 'user.password_reset', { entity: 'user', id: u.id, summary: `${u.name} (agency user)`, link: `/admin/agents/${req.params.id}` });
  req.flash('success', `New password set for ${u.name}. Ask them to change it in My account after logging in.`);
  res.redirect(`/admin/agents/${req.params.id}`);
}));

router.post('/team/:id/password', h(async (req, res, next) => {
  const u = await one("SELECT * FROM users WHERE id = ? AND role IN ('admin', 'backend')", num(req.params.id));
  if (!u) return next();
  const password = String(req.body.password || '');
  if (password.length < 8) throw new svc.AppError('The password must be at least 8 characters.');
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  await audit(req.user, 'user.password_reset', { entity: 'user', id: u.id, summary: u.name, link: '/admin/team' });
  req.flash('success', `Password reset for ${u.name}.`);
  res.redirect('/admin/team');
}));

// ---------- bookings ----------

router.get('/bookings', h(async (req, res) => {
  const status = ['confirmed', 'cancel_requested', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const p = paging(req);
  const { rows: bookings, pager } = pageOf(await all(
    `SELECT b.*, a.name AS agency_name, c.name AS customer_name FROM bookings b JOIN agencies a ON a.id = b.agency_id
     LEFT JOIN customers c ON c.id = b.customer_id ${status ? 'WHERE b.status = ?' : ''} ORDER BY b.id DESC ${p.sql}`, ...(status ? [status] : []), ...p.params,
  ), p);
  res.page('admin/bookings', { title: 'Bookings', bookings, pager, status });
}));

router.get('/bookings/:id', h(async (req, res, next) => {
  const booking = await one('SELECT b.*, a.name AS agency_name FROM bookings b JOIN agencies a ON a.id = b.agency_id WHERE b.id = ?', num(req.params.id));
  if (!booking) return next();
  const full = booking.quote_id ? await svc.getQuote(booking.quote_id) : null;
  const invoices = await all('SELECT * FROM invoices WHERE booking_id = ? OR (quote_id = ? AND quote_id IS NOT NULL) ORDER BY id DESC', booking.id, booking.quote_id);
  res.page('admin/booking', { title: `Booking ${booking.code}`, booking, full, invoices });
}));

router.post('/bookings/:id/cancel', h(async (req, res) => {
  const id = num(req.params.id);
  await svc.approveCancellation(id, Math.max(0, num(req.body.refund, 0)));
  const cb = await one('SELECT code, agency_id, refund_amount FROM bookings WHERE id = ?', id);
  await audit(req.user, 'booking.cancelled', { entity: 'booking', id, agencyId: cb.agency_id, link: `/admin/bookings/${id}`, summary: `${cb.code}: refund ₹${(cb.refund_amount || 0).toLocaleString('en-IN')}` });
  req.flash('success', 'Booking cancelled and refund credited to the agent.');
  res.redirect(`/admin/bookings/${id}`);
}));

router.post('/bookings/:id/reject-cancel', h(async (req, res) => {
  const id = num(req.params.id);
  const b = await one('SELECT * FROM bookings WHERE id = ?', id);
  await run("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'cancel_requested'", id);
  await audit(req.user, 'booking.cancel_declined', { entity: 'booking', id, agencyId: b.agency_id, link: `/admin/bookings/${id}`, summary: b.code });
  await notify(b.agency_id, 'Cancellation declined', `${b.code}: ${str(req.body.reason) || 'non-refundable as per supplier policy.'}`, `/agent/bookings/${id}`);
  req.flash('success', 'Cancellation request declined.');
  res.redirect(`/admin/bookings/${id}`);
}));

// ---------- wallet top-ups ----------

router.get('/topups', h(async (req, res) => {
  await payments.settlePending().catch(() => 0);
  const requests = await all('SELECT t.*, a.name AS agency_name, a.wallet_balance FROM topup_requests t JOIN agencies a ON a.id = t.agency_id ORDER BY t.status = \'pending\' DESC, t.id DESC');
  res.page('admin/topups', { title: 'Top-up requests', requests });
}));

router.post('/topups/:id/approve', h(async (req, res) => {
  const t = await one('SELECT agency_id, amount, utr FROM topup_requests WHERE id = ?', num(req.params.id));
  await svc.approveTopup(num(req.params.id));
  await audit(req.user, 'topup.approved', { entity: 'topup', id: num(req.params.id), agencyId: t.agency_id, link: '/admin/topups', summary: `₹${t.amount.toLocaleString('en-IN')} (UTR ${t.utr})` });
  req.flash('success', 'Top-up approved and wallet credited.');
  res.redirect('/admin/topups');
}));

router.post('/topups/:id/reject', h(async (req, res) => {
  const r = await one("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending'", num(req.params.id));
  if (r) {
    await run("UPDATE topup_requests SET status = 'rejected' WHERE id = ?", r.id);
    await audit(req.user, 'topup.rejected', { entity: 'topup', id: r.id, agencyId: r.agency_id, link: '/admin/topups', summary: `₹${r.amount.toLocaleString('en-IN')} (UTR ${r.utr})` });
    await notify(r.agency_id, 'Top-up not verified', `We couldn't verify your ₹${r.amount.toLocaleString('en-IN')} payment. Contact support with the UTR.`, '/agent/wallet');
  }
  res.redirect('/admin/topups');
}));

// ---------- invoices, notifications, settings ----------

router.get('/invoices', h(async (req, res) => {
  const kind = ['b2b', 'customer_vaayu', 'customer_agent'].includes(req.query.kind) ? req.query.kind : '';
  const p = paging(req);
  const page = pageOf(await all(
    `SELECT i.*, a.name AS agency_name FROM invoices i JOIN agencies a ON a.id = i.agency_id ${kind ? 'WHERE i.kind = ?' : ''} ORDER BY i.id DESC ${p.sql}`, ...(kind ? [kind] : []), ...p.params,
  ), p);
  const pager = page.pager;
  const invoices = page.rows.map((i) => ({ ...i, doc: JSON.parse(i.data) }));
  res.page('admin/invoices', { title: 'Invoices', pager, invoices, kind });
}));

router.get('/invoices/:id', h(async (req, res, next) => {
  const inv = await one('SELECT * FROM invoices WHERE id = ?', num(req.params.id));
  if (!inv) return next();
  res.page('invoice', { title: `Invoice ${inv.number}`, inv, ...await invoiceView(inv), back: '/admin/invoices', noindex: true }, 'doc');
}));

router.get('/search', h(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  res.page('search', { title: 'Search', q, groups: q.length >= 2 ? await searchAll(q) : [] });
}));

router.get('/notifications', h(async (req, res) => {
  const items = await all('SELECT * FROM notifications WHERE agency_id IS NULL ORDER BY id DESC LIMIT 100');
  await run('UPDATE notifications SET is_read = 1 WHERE agency_id IS NULL');
  res.locals.unread = 0;
  res.page('agent/notifications', { title: 'Notifications', items });
}));

// ---------- offers ----------

router.get('/offers', h(async (req, res) => {
  const offers = await all("SELECT *, (is_active = 1 AND (valid_until IS NULL OR valid_until >= sqldate('now'))) AS live FROM offers ORDER BY id DESC");
  res.page('admin/offers', { title: 'Offers & deals', offers });
}));

router.post('/offers', h(async (req, res) => {
  const b = req.body;
  const title = str(b.title).slice(0, 120);
  if (!title) throw new svc.AppError('Give the offer a title.');
  // Links stay inside the agent portal so an offer can't send agents to another site.
  const link = str(b.link);
  if (link && !/^\/agent(\/[\w\-/?=&.%]*)?$/.test(link)) throw new svc.AppError('Link must be a page in the agent portal, starting with /agent');
  await run('INSERT INTO offers (title, body, code, link, valid_until) VALUES (?, ?, ?, ?, ?)',
    title, str(b.body).slice(0, 400) || null, str(b.code).toUpperCase().slice(0, 30) || null, link || null, /^\d{4}-\d{2}-\d{2}$/.test(b.valid_until) ? b.valid_until : null);
  for (const a of await all("SELECT id FROM agencies WHERE status = 'active'")) await notify(a.id, 'New offer', title, '/agent/offers');
  await audit(req.user, 'offer.published', { entity: 'offer', summary: title, link: '/admin/offers' });
  req.flash('success', 'Offer published to all active agents.');
  res.redirect('/admin/offers');
}));

router.post('/offers/:id/toggle', h(async (req, res) => {
  await run('UPDATE offers SET is_active = 1 - is_active WHERE id = ?', num(req.params.id));
  res.redirect('/admin/offers');
}));

router.post('/offers/:id/delete', h(async (req, res) => {
  await run('DELETE FROM offers WHERE id = ?', num(req.params.id));
  req.flash('success', 'Offer deleted.');
  res.redirect('/admin/offers');
}));

// ---------- support tickets ----------

router.get('/tickets', h(async (req, res) => {
  const status = ['open', 'answered', 'closed'].includes(req.query.status) ? req.query.status : '';
  const tickets = await all(
    `SELECT t.*, a.name AS agency_name, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages
     FROM tickets t JOIN agencies a ON a.id = t.agency_id ${status ? 'WHERE t.status = ?' : ''}
     ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC`, ...(status ? [status] : []),
  );
  res.page('admin/tickets', { title: 'Support tickets', tickets, status });
}));

router.get('/tickets/:id', h(async (req, res, next) => {
  const ticket = await one('SELECT t.*, a.name AS agency_name, b.code AS booking_code FROM tickets t JOIN agencies a ON a.id = t.agency_id LEFT JOIN bookings b ON b.id = t.booking_id WHERE t.id = ?', num(req.params.id));
  if (!ticket) return next();
  const messages = await all('SELECT m.*, u.name AS author FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id', ticket.id);
  res.page('ticket', { title: `${ticket.code} · ${ticket.subject}`, ticket, messages, base: '/admin/tickets', back: '/admin/tickets' });
}));

router.post('/tickets/:id/reply', h(async (req, res, next) => {
  const ticket = await one('SELECT * FROM tickets WHERE id = ?', num(req.params.id));
  if (!ticket) return next();
  const body = str(req.body.body).slice(0, 4000);
  const close = req.body.close === '1';
  if (!body && !close) throw new svc.AppError('Write a reply first.');
  await tx(async () => {
    if (body) await run('INSERT INTO ticket_messages (ticket_id, user_id, from_admin, body) VALUES (?, ?, 1, ?)', ticket.id, req.user.id, body);
    await run("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?", close ? 'closed' : 'answered', ticket.id);
    await notify(ticket.agency_id, close ? 'Ticket closed' : 'Support replied', `${ticket.code}: ${ticket.subject}`, `/agent/support/${ticket.id}`);
  });
  req.flash('success', close ? 'Ticket closed.' : 'Reply sent.');
  res.redirect(`/admin/tickets/${ticket.id}`);
}));

const MARGIN_KEYS = Object.keys(KINDS).map((k) => `margin_${k}`);
const SETTING_KEYS = ['company_name', 'legal_name', 'gstin', 'address', 'phone', 'email', 'tax_rate', 'tcs_rate', 'emi_rate', 'pg_fee_pct', 'bank_details', 'sac_code', ...MARGIN_KEYS];

router.get('/settings', async (req, res) => {
  const values = await getSettings();
  res.page('admin/settings', { title: 'Settings', phonepe: phonepe.describe(), origin: res.locals.origin, keys: SETTING_KEYS, values, kinds: KINDS, margins: Object.fromEntries(Object.keys(KINDS).map((k) => [k, marginPct(k, values)])) });
});

router.post('/settings', h(async (req, res) => {
  const before = await getSettings();
  for (const k of MARGIN_KEYS) {
    if (req.body[k] === undefined) continue;
    const v = parseFloat(req.body[k]);
    if (!(v >= 0 && v <= 100)) throw new svc.AppError('Margins must be between 0 and 100%.');
    req.body[k] = String(v);
  }
  const changed = SETTING_KEYS.filter((k) => req.body[k] !== undefined && str(req.body[k]) !== (before[k] ?? ''));
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) await setSetting(k, str(req.body[k]));
  // New margins apply to agents' prices right away (quotes already made keep theirs).
  for (const k of changed.filter((x) => MARGIN_KEYS.includes(x))) await repriceProducts(k.replace('margin_', ''));
  if (changed.length) await audit(req.user, 'settings.updated', { entity: 'settings', summary: changed.join(', '), link: '/admin/settings' });
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

module.exports = router;
