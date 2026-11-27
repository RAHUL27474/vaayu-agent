/**
 * Backend portal (/backend): where VaayuTrip's backend team enters the inventory agents build packages
 * from (activities, hotels, airfares, transfers, visas, insurance). Admins can use it too, and every
 * change is recorded in the admin's activity log.
 */
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, notify, audit, getSettings } = require('../db');
const { num, uniqueSlug } = require('../util');
const { requireBackend, h, idParam } = require('../auth');
const svc = require('../services');
const {
  KINDS, DESTINATIONS, PRODUCT_COUNTRIES, ALL_DESTINATIONS, BASIS_LABELS, MEAL_PLANS, productFromForm, publishProblems, parseProductDetails, describe, seasonsFromForm, listOf,
  priceForAgents, marginPct, productMap,
} = require('../products');
const { withCover, coverFrom } = require('../photos');
const { readXlsx, XlsxError } = require('../xlsx');
const { paging, pageOf } = require('../paging');
const { readRateCard, isRateCard } = require('../ratecard');

const router = express.Router();
router.param('id', idParam);
router.param('itemId', idParam);
router.use(requireBackend);
router.use(async (req, res, next) => {
  const c = await one("SELECT (SELECT COUNT(*)::int FROM enquiries WHERE status = 'new') AS enq, (SELECT COUNT(*)::int FROM quotes WHERE approval_status = 'requested') AS req");
  res.locals.newEnquiries = c.enq;
  res.locals.pendingRequests = c.req;
  res.locals.kindsNav = KINDS;
  res.locals.listOf = listOf;
  res.locals.navKind = KINDS[req.query.kind] ? req.query.kind : '';
  next();
});

const str = (v) => String(v ?? '').trim();
const FIELDS = ['kind', 'title', 'city', 'country', 'category', 'duration', 'summary', 'description', 'highlights', 'inclusions', 'exclusions', 'pickup',
  'timing', 'cancellation', 'image_url', 'price_basis', 'group_size', 'cost_adult', 'cost_child', 'cost_infant', 'net_adult', 'net_child', 'net_infant', 'details'];
const link = (id) => `/backend/products/${id}`;

// p: product fields as the backend enters them (net_* = what VaayuTrip pays); agents' prices get the margin.
async function insertProduct(entered, user) {
  const p = priceForAgents(entered, await getSettings());
  return (await run(
    `INSERT INTO products (${FIELDS.join(', ')}, slug, created_by, updated_by) VALUES (${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`,
    ...FIELDS.map((k) => p[k] ?? null), await uniqueSlug('products', `${p.title} ${p.city}`), user.id, user.id,
  )).lastInsertRowid;
}

// ---------- dashboard ----------

router.get('/', h(async (req, res) => {
  const [counts, byCountry, recent, draftRows] = await Promise.all([
    all("SELECT kind, COUNT(*) FILTER (WHERE status = 'published') AS live, COUNT(*) FILTER (WHERE status = 'draft') AS drafts FROM products GROUP BY kind"),
    all("SELECT country, kind, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY country, kind"),
    all(
      `SELECT p.id, p.kind, p.title, p.city, p.status, p.updated_at, u.name AS updated_by_name FROM products p
       LEFT JOIN users u ON u.id = p.updated_by ORDER BY p.updated_at DESC, p.id DESC LIMIT 10`,
    ),
    all("SELECT * FROM products WHERE status = 'draft' ORDER BY updated_at DESC LIMIT 50"),
  ]);
  const byKind = Object.fromEntries(counts.map((c) => [c.kind, c]));
  // Live products per destination and kind, so the team can see gaps in coverage.
  const coverage = Object.fromEntries(Object.keys(DESTINATIONS).map((d) => [d, {}]));
  for (const r of byCountry) {
    // Plans for all destinations (insurance) count everywhere.
    const dests = r.country === ALL_DESTINATIONS ? Object.keys(DESTINATIONS) : Object.keys(DESTINATIONS).filter((d) => DESTINATIONS[d].includes(r.country));
    for (const dest of dests) coverage[dest][r.kind] = (coverage[dest][r.kind] || 0) + r.n;
  }
  const drafts = draftRows.map((p) => ({ ...p, problems: publishProblems(p) }));
  res.page('backend/dashboard', { title: 'Backend dashboard', byKind, coverage, recent, drafts, kinds: KINDS, destinations: Object.keys(DESTINATIONS) });
}));

// ---------- products ----------

router.get('/products', h(async (req, res) => {
  const f = {
    kind: KINDS[req.query.kind] ? req.query.kind : '',
    status: ['draft', 'published'].includes(req.query.status) ? req.query.status : '',
    dest: DESTINATIONS[req.query.dest] ? req.query.dest : '',
    q: str(req.query.q),
  };
  const where = [];
  const params = [];
  if (f.kind) { where.push('p.kind = ?'); params.push(f.kind); }
  if (f.status) { where.push('p.status = ?'); params.push(f.status); }
  if (f.dest) { where.push(`p.country IN (${DESTINATIONS[f.dest].map(() => '?').join(', ')})`); params.push(...DESTINATIONS[f.dest]); }
  if (f.q) { where.push('(p.title ILIKE ? OR p.city ILIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  const p = paging(req);
  const rows = (await all(
    `SELECT p.*, u.name AS updated_by_name,
       (SELECT COUNT(DISTINCT b.id) FROM quote_items qi JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled' WHERE qi.product_id = p.id) AS bookings
     FROM products p LEFT JOIN users u ON u.id = p.updated_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.kind, p.country, p.city, p.title, p.id ${p.sql}`, ...params, ...p.params,
  )).map((x) => ({ ...x, line: describe(x) }));
  const { rows: products, pager } = pageOf(rows, p);
  res.page('backend/products', { title: f.kind ? KINDS[f.kind].plural : 'All inventory', products, pager, f, kinds: KINDS, destinations: Object.keys(DESTINATIONS), basisLabels: BASIS_LABELS });
}));

const formData = (p) => ({
  p, d: parseProductDetails(p.details), cfg: KINDS[p.kind], kinds: KINDS, countries: PRODUCT_COUNTRIES, destinations: DESTINATIONS,
  basisLabels: BASIS_LABELS, mealPlans: MEAL_PLANS, problems: p.id ? publishProblems(p) : [], marginPct,
});
// Cities already in the inventory, so typing one fills in its country.
const cityList = () => all('SELECT city, MIN(country) AS country FROM products GROUP BY city ORDER BY city');

// ---------- booking requests (approve before the agent pays) ----------
router.get('/booking-requests', h(async (req, res) => {
  const show = ['requested', 'approved', 'rejected'].includes(req.query.show) ? req.query.show : 'requested';
  const rows = await all(
    `SELECT q.id, q.code, q.title, q.travel_date, q.adults, q.children, q.approval_status, q.approval_net, q.approval_requested_at, q.approval_decided_at, q.approval_until,
       a.name AS agency, u.name AS requested_by, d.name AS decided_by
     FROM quotes q JOIN agencies a ON a.id = q.agency_id LEFT JOIN users u ON u.id = q.approval_requested_by LEFT JOIN users d ON d.id = q.approval_decided_by
     WHERE q.approval_status = ? ORDER BY ${show === 'requested' ? 'q.approval_requested_at ASC' : 'q.approval_decided_at DESC'} LIMIT 200`, show,
  );
  const counts = Object.fromEntries((await all("SELECT approval_status AS s, COUNT(*)::int AS n FROM quotes WHERE approval_status IS NOT NULL GROUP BY approval_status")).map((r) => [r.s, r.n]));
  res.page('backend/booking-requests', { title: 'Booking requests', rows, counts, show });
}));

router.get('/booking-requests/:id', h(async (req, res, next) => {
  const full = await svc.getQuote(num(req.params.id));
  if (!full || !full.quote.approval_status) return next();
  const q = full.quote;
  const agency = await one('SELECT id, name, phone, email, city FROM agencies WHERE id = ?', q.agency_id);
  const people = await all('SELECT id, name FROM users WHERE id IN (?, ?)', q.approval_requested_by || 0, q.approval_decided_by || 0);
  const nameOf = (id) => (people.find((p) => p.id === id) || {}).name;
  const booking = await one('SELECT id, code FROM bookings WHERE quote_id = ? ORDER BY id DESC', q.id);
  res.page('backend/booking-request', { title: `Booking request: ${q.title}`, ...full, reqAgency: agency, nameOf, booking, netChanged: Math.abs((q.approval_net || 0) - full.priced.net) > 0.009 });
}));

router.post('/booking-requests/:id/decide', h(async (req, res, next) => {
  const full = await svc.getQuote(num(req.params.id));
  if (!full || !full.quote.approval_status) return next();
  const q = full.quote;
  if (['booked', 'cancelled'].includes(q.status)) throw new svc.AppError('This quote is already booked or cancelled.');
  const approve = req.body.decision === 'approve';
  const note = String(req.body.note || '').trim().slice(0, 800) || null;
  if (!approve && !note) throw new svc.AppError('Tell the agent why: write a short reason before rejecting.');
  const hours = [12, 24, 48, 72].includes(Number(req.body.hours)) ? Number(req.body.hours) : 24;
  await run(`UPDATE quotes SET approval_status = ?, approval_net = ?, approval_decided_at = datetime('now'), approval_decided_by = ?, approval_note = ?,
    approval_until = ${approve ? `datetime('now', '+${hours} hours')` : 'NULL'} WHERE id = ?`, approve ? 'approved' : 'rejected', full.priced.net, req.user.id, note, q.id);
  await notify(q.agency_id, approve ? 'Booking request approved' : 'Booking request not approved',
    approve ? `${q.title}: confirmed by VaayuTrip operations. Pay within ${hours} hours to book it.${note ? ` Note: ${note}` : ''}` : `${q.title}: ${note}`,
    `/agent/quotes/${q.id}`);
  await audit(req.user, approve ? 'booking.request_approved' : 'booking.request_rejected', { entity: 'quote', id: q.id, agencyId: q.agency_id, summary: `${q.title} (${q.code})${note ? `: ${note}` : ''}`, link: `/backend/booking-requests/${q.id}` });
  req.flash('success', approve ? 'Approved. The agent has been notified and can pay now.' : 'Rejected. The agent has been told why.');
  res.redirect('/backend/booking-requests');
}));

// ---------- website enquiries ----------
const ENQ_STATUSES = ['new', 'contacted', 'converted', 'closed'];
const ENQ_TOPIC_LABEL = { partner: 'Partner agency', trip: 'Trip or group quote', other: 'Other' };

router.get('/enquiries', h(async (req, res) => {
  const status = ENQ_STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = str(req.query.q).slice(0, 60);
  const mine = req.query.mine === '1';
  const where = [];
  const params = [];
  if (status) { where.push('e.status = ?'); params.push(status); } else if (!q) where.push("e.status IN ('new', 'contacted')");
  if (q) { where.push('(e.name ILIKE ? OR e.phone ILIKE ? OR e.email ILIKE ? OR e.company ILIKE ? OR e.city ILIKE ?)'); params.push(...Array(5).fill(`%${q}%`)); }
  if (mine) { where.push('e.assigned_to = ?'); params.push(req.user.id); }
  const [rows, countRows, dueRow] = await Promise.all([
    all(
      `SELECT e.*, u.name AS assignee FROM enquiries e LEFT JOIN users u ON u.id = e.assigned_to
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (e.status = 'new') DESC, e.created_at DESC LIMIT 200`, ...params,
    ),
    all('SELECT status, COUNT(*)::int AS n FROM enquiries GROUP BY status'),
    one("SELECT COUNT(*)::int AS n FROM enquiries WHERE status IN ('new', 'contacted') AND follow_up_on IS NOT NULL AND follow_up_on <= sqldate('now')"),
  ]);
  const counts = Object.fromEntries(countRows.map((r) => [r.status, r.n]));
  const due = dueRow.n;
  res.page('backend/enquiries', { title: 'Enquiries', rows, counts, due, status, q, mine, statuses: ENQ_STATUSES, topics: ENQ_TOPIC_LABEL });
}));

router.get('/enquiries/:id', h(async (req, res, next) => {
  const e = await one('SELECT e.*, u.name AS assignee FROM enquiries e LEFT JOIN users u ON u.id = e.assigned_to WHERE e.id = ?', num(req.params.id));
  if (!e) return next();
  const team = await all("SELECT id, name FROM users WHERE role IN ('backend', 'admin') AND is_active = 1 ORDER BY name");
  const history = await all("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'enquiry' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 20", e.id).catch(() => []);
  res.page('backend/enquiry', { title: `Enquiry: ${e.name}`, e, team, history, statuses: ENQ_STATUSES, topics: ENQ_TOPIC_LABEL });
}));

router.post('/enquiries/:id', h(async (req, res, next) => {
  const e = await one('SELECT * FROM enquiries WHERE id = ?', num(req.params.id));
  if (!e) return next();
  const b = req.body;
  const status = ENQ_STATUSES.includes(b.status) ? b.status : e.status;
  const assignee = b.assigned_to === 'me' ? req.user.id : num(b.assigned_to, 0) || null;
  const follow = /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_on || '') ? b.follow_up_on : null;
  const note = String(b.team_note ?? '').trim().slice(0, 3000) || null;
  await run("UPDATE enquiries SET status = ?, assigned_to = ?, follow_up_on = ?, team_note = ?, updated_at = datetime('now') WHERE id = ?", status, assignee, follow, note, e.id);
  const changes = [status !== e.status && `status ${e.status} → ${status}`, assignee !== e.assigned_to && 'assignee changed', follow !== e.follow_up_on && `follow-up ${follow || 'cleared'}`, note !== e.team_note && 'note updated'].filter(Boolean);
  if (changes.length) await audit(req.user, 'enquiry.updated', { entity: 'enquiry', id: e.id, summary: `${e.name}: ${changes.join(', ')}`, link: `/backend/enquiries/${e.id}` });
  req.flash('success', 'Enquiry updated.');
  res.redirect(b.back === 'list' ? '/backend/enquiries' : `/backend/enquiries/${e.id}`);
}));

router.get('/products/new', h(async (req, res) => {
  const kind = KINDS[req.query.kind] ? req.query.kind : 'activity';
  // After "Save & add another" the city and country carry over to the next item.
  const city = String(req.query.city || '').slice(0, 80);
  const country = PRODUCT_COUNTRIES.includes(req.query.country) || req.query.country === ALL_DESTINATIONS ? req.query.country : '';
  res.page('backend/product-form', {
    title: `New ${KINDS[kind].label.toLowerCase()}`,
    ...formData({ kind, status: 'draft', price_basis: KINDS[kind].basis[0], details: '{}', city, country }),
    cityList: await cityList(), navKind: kind,
  });
}));

router.post('/products', withCover(svc.AppError), h(async (req, res) => {
  const kind = KINDS[req.body.kind] ? req.body.kind : 'activity';
  const p = { ...productFromForm(req.body, kind), image_url: coverFrom(req, null) };
  if (!p.title || !p.city) throw new svc.AppError('Title and city are required.');
  const id = await insertProduct(p, req.user);
  const sb = seasonsFromForm(req.body);
  await run('UPDATE products SET seasons = ?, blackouts = ? WHERE id = ?', sb.seasons, sb.blackouts, id);
  await audit(req.user, 'product.created', { entity: 'product', id, summary: `${KINDS[kind].label}: ${p.title} (${p.city})`, link: link(id) });
  if (req.body.after === 'new') {
    req.flash('success', `${p.title} saved as a draft. Add the next one.`);
    return res.redirect(`/backend/products/new?${new URLSearchParams({ kind, city: p.city, country: p.country || '' })}`);
  }
  req.flash('success', `${KINDS[kind].label} saved as a draft. Publish it to make it available to agents.`);
  res.redirect(link(id));
}));

const ownedProduct = async (req) => await one('SELECT * FROM products WHERE id = ?', num(req.params.id));

router.get('/products/:id', h(async (req, res, next) => {
  const p = await one(
    `SELECT p.*, c.name AS created_by_name, u.name AS updated_by_name,
       (SELECT COUNT(*) FROM packages k WHERE k.agency_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(CASE WHEN k.details LIKE '{%' THEN (CASE WHEN jsonb_typeof(k.details::jsonb -> 'items') = 'array' THEN k.details::jsonb -> 'items' END) END, '[]'::jsonb)) j
            WHERE j ->> 'id' = p.id::text)) AS packages,
       (SELECT COUNT(DISTINCT b.id) FROM quote_items qi JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled' WHERE qi.product_id = p.id) AS bookings
     FROM products p LEFT JOIN users c ON c.id = p.created_by LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = ?`, num(req.params.id),
  );
  if (!p) return next();
  const history = await all("SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entity = 'product' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 20", p.id);
  res.page('backend/product-form', { title: p.title, ...formData(p), cityList: await cityList(), history, navKind: p.kind });
}));

router.post('/products/:id', withCover(svc.AppError), h(async (req, res, next) => {
  const old = await ownedProduct(req);
  if (!old) return next();
  const p = priceForAgents({ ...productFromForm(req.body, old.kind), image_url: coverFrom(req, old.image_url) }, await getSettings());
  if (!p.title || !p.city) throw new svc.AppError('Title and city are required.');
  const keys = FIELDS.filter((k) => k !== 'kind');
  await run(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => p[k]), req.user.id, old.id);
  const sb = seasonsFromForm(req.body);
  if (sb.seasons !== old.seasons || sb.blackouts !== old.blackouts) {
    await run('UPDATE products SET seasons = ?, blackouts = ? WHERE id = ?', sb.seasons, sb.blackouts, old.id);
    await audit(req.user, 'product.seasons', { entity: 'product', id: old.id, summary: `${p.title}: seasons/sold-out dates updated`, link: link(old.id) });
  }
  const priceChanged = ['cost_adult', 'cost_child', 'cost_infant', 'price_basis', 'group_size'].some((k) => (old[k] ?? null) !== (p[k] ?? null));
  await audit(req.user, priceChanged ? 'product.price_changed' : 'product.updated', {
    entity: 'product', id: old.id, link: link(old.id),
    summary: priceChanged ? `${p.title}: cost ₹${old.cost_adult} → ₹${p.cost_adult} (agents ₹${old.net_adult} → ₹${p.net_adult})` : p.title,
  });
  const problems = publishProblems({ ...p, kind: old.kind });
  if (old.status === 'published' && problems.length) {
    await run("UPDATE products SET status = 'draft' WHERE id = ?", old.id);
    await audit(req.user, 'product.unpublished', { entity: 'product', id: old.id, summary: `${p.title} (incomplete: ${problems[0]})`, link: link(old.id) });
    req.flash('warn', `Moved back to draft: ${problems[0]}`);
  } else {
    req.flash('success', 'Saved. New quotes use the updated price; quotes already made keep theirs.');
  }
  res.redirect(link(old.id));
}));

router.post('/products/:id/status', h(async (req, res, next) => {
  const p = await ownedProduct(req);
  if (!p) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = publishProblems(p);
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  if (status !== p.status) {
    await run("UPDATE products SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", status, req.user.id, p.id);
    await audit(req.user, status === 'published' ? 'product.published' : 'product.unpublished', { entity: 'product', id: p.id, summary: `${KINDS[p.kind].label}: ${p.title}`, link: link(p.id) });
    if (status === 'published') {
      for (const ag of await all("SELECT id FROM agencies WHERE status = 'active'")) {
        await notify(ag.id, `New ${KINDS[p.kind].label.toLowerCase()}`, `${p.title} (${p.city}) is available for your quotes and packages.`, `/agent/${KINDS[p.kind].path}/${p.id}`);
      }
    }
  }
  req.flash('success', status === 'published' ? 'Published: agents can now add it to quotes and packages.' : 'Unpublished: agents can no longer add it, and packages using it show a warning.');
  res.redirect(link(p.id));
}));

router.post('/products/:id/duplicate', h(async (req, res, next) => {
  const p = await ownedProduct(req);
  if (!p) return next();
  const id = await insertProduct({ ...p, title: `${p.title} (copy)`, net_adult: p.cost_adult, net_child: p.cost_child, net_infant: p.cost_infant }, req.user);
  await audit(req.user, 'product.created', { entity: 'product', id, summary: `Copy of ${p.title}`, link: link(id) });
  req.flash('success', 'Copy created as a draft.');
  res.redirect(link(id));
}));

router.post('/products/:id/delete', h(async (req, res, next) => {
  const p = await ownedProduct(req);
  if (!p) return next();
  await run('DELETE FROM products WHERE id = ?', p.id);
  await audit(req.user, 'product.deleted', { entity: 'product', id: p.id, summary: `${KINDS[p.kind].label}: ${p.title} (${p.city})` });
  req.flash('success', "Deleted. Existing quotes and bookings keep their lines; agents' packages show it as no longer offered.");
  res.redirect(`/backend/products?kind=${p.kind}`);
}));

// ---------- bulk import ----------

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const IMPORT_COLUMNS = ['kind', 'title', 'city', 'country', 'category', 'duration', 'summary', 'description', 'highlights', 'inclusions', 'exclusions',
  'pickup', 'timing', 'cancellation', 'price_basis', 'group_size', 'net_adult', 'net_child', 'net_infant'];
const DETAIL_COLUMNS = [...new Set(Object.values(KINDS).flatMap((k) => k.fields.map(([key]) => `d_${key}`)))];

router.get('/import', (req, res) => {
  res.page('backend/import', { title: 'Import inventory', kinds: KINDS, columns: IMPORT_COLUMNS, detailColumns: DETAIL_COLUMNS, countries: PRODUCT_COUNTRIES, basisLabels: BASIS_LABELS });
});

router.get('/import/template.csv', (req, res) => {
  const header = [...IMPORT_COLUMNS, ...DETAIL_COLUMNS];
  const example = { kind: 'activity', title: 'Example: Desert safari', city: 'Dubai', country: 'United Arab Emirates', category: 'Adventure', duration: '6 hours', price_basis: 'per_person', net_adult: '3900', net_child: '3200' };
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vaayutrip-inventory-template.csv"' });
  res.send(`${header.join(',')}\r\n${header.map((k) => example[k] || '').join(',')}\r\n`);
});

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
const isXlsx = (file) => file.buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1'));

// Same item on a re-uploaded rate card: same kind, city and name (and for hotels the same room, meal plan and season).
async function sameProduct(p) {
  const d = parseProductDetails(p.details);
  return (await all('SELECT id, details FROM products WHERE kind = ? AND lower(city) = lower(?) AND title = ?', p.kind, p.city, p.title)).find((r) => {
    if (p.kind !== 'hotel') return true;
    const o = parseProductDetails(r.details);
    return o.room === d.room && o.mealPlan === d.mealPlan && (o.season || '') === (d.season || '');
  });
}

/** VaayuTrip rate card workbook (Hotels / Activities / Transfers / Currency tabs): adds new items as drafts, updates rates of matching ones. */
async function importRateCard(req, res, book) {
  const settings = await getSettings();
  const knownCities = Object.fromEntries((await all('SELECT DISTINCT lower(city) AS city, country FROM products')).map((r) => [r.city, r.country]));
  const { items, skipped, skippedRows, notes } = readRateCard(book, { knownCities, fallbackCountry: req.body.country });
  let added = 0;
  let updated = 0;
  await tx(async () => {
    for (const item of items) {
      const p = priceForAgents(productFromForm(item, item.kind), settings);
      // Keep what the form fields can't hold: the hotel season and the rate as written on the card.
      p.details = JSON.stringify({ ...parseProductDetails(p.details), ...(item.d_season ? { season: item.d_season } : {}), rateCard: item.source });
      if (item.group_size == null && p.price_basis === 'per_group') p.group_size = 1;
      const old = await sameProduct(p);
      if (old) {
        // Rates always come from the card; text the card leaves blank keeps what the team wrote.
        const text = ['duration', 'timing', 'summary', 'description'];
        const rates = ['category', 'price_basis', 'group_size', 'cost_adult', 'cost_child', 'cost_infant', 'net_adult', 'net_child', 'net_infant', 'details'];
        await run(`UPDATE products SET ${[...text.map((k) => `${k} = COALESCE(?, ${k})`), ...rates.map((k) => `${k} = ?`)].join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          ...[...text, ...rates].map((k) => p[k] ?? null), req.user.id, old.id);
        updated++;
      } else {
        await insertProduct({ ...p, net_adult: p.cost_adult, net_child: p.cost_child, net_infant: p.cost_infant, image_url: null }, req.user);
        added++;
      }
    }
  });
  await audit(req.user, 'product.imported', { entity: 'product', summary: `Rate card: ${added} new draft(s), ${updated} updated${skippedRows ? `, skipped ${skippedRows}` : ''}`, link: '/backend/products?status=draft' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const done = [added && `${plural(added, 'new item')} added as drafts`, updated && `${plural(updated, 'existing item')} updated with the new rates`].filter(Boolean);
  if (done.length) req.flash('success', `Rate card imported: ${done.join(', ')}.`);
  if (!items.length && !skipped.length) req.flash('warn', 'No rows found. Fill the Hotels, Activities or Transfers tab below its header row.');
  const issues = [...skipped, ...notes];
  if (issues.length) req.flash('warn', `${skippedRows ? `Skipped ${skippedRows} row${skippedRows === 1 ? '' : 's'}. ` : ''}${issues.slice(0, 6).join(' ')}${issues.length > 6 ? ` … and ${issues.length - 6} more.` : ''}`);
  res.redirect(added || updated ? '/backend/products?status=draft' : '/backend/import');
}

router.post('/import', (req, res, next) => importUpload(req, res, (err) => next(err ? new svc.AppError('The file must be a CSV or Excel (.xlsx) file under 5 MB.') : undefined)), h(async (req, res) => {
  if (!req.file) throw new svc.AppError('Choose a CSV or Excel file to import.');
  let rows;
  if (isXlsx(req.file)) {
    let book;
    try { book = readXlsx(req.file.buffer); } catch (e) {
      throw new svc.AppError(e instanceof XlsxError ? e.message : 'Could not read this Excel file. Save it again as .xlsx and retry.');
    }
    if (isRateCard(book)) return await importRateCard(req, res, book);
    rows = book[0].rows;
  } else if (/\.xls$/i.test(req.file.originalname)) {
    throw new svc.AppError('This is an old-style .xls file. In Excel choose File → Save As → Excel Workbook (.xlsx), then upload that.');
  } else rows = parseCsv(req.file.buffer.toString('utf8').replace(/^﻿/, ''));
  if (rows.length < 2) throw new svc.AppError('The file has no rows under the header.');
  const header = rows[0].map((h2) => h2.trim().toLowerCase());
  const skipped = [];
  let added = 0;
  await tx(async () => {
    for (const [i, cells] of rows.slice(1).entries()) {
      const r = Object.fromEntries(header.map((k, j) => [k, (cells[j] || '').trim()]));
      const line = i + 2;
      if (!KINDS[r.kind]) { skipped.push(`Row ${line}: kind must be one of ${Object.keys(KINDS).join(', ')}.`); continue; }
      // Multi-line fields can be written with " | " between lines in a spreadsheet.
      for (const k of ['highlights', 'inclusions', 'exclusions']) if (r[k]) r[k] = r[k].split(/\s*\|\s*/).join('\n');
      const p = productFromForm(r, r.kind);
      if (!p.title || !p.city) { skipped.push(`Row ${line}: title and city are required.`); continue; }
      if (!p.country) { skipped.push(`Row ${line}: "${r.country}" is not one of our destination countries.`); continue; }
      await insertProduct({ ...p, image_url: null }, req.user);
      added++;
    }
  });
  await audit(req.user, 'product.imported', { entity: 'product', summary: `Imported ${added} product(s) as drafts${skipped.length ? `, skipped ${skipped.length}` : ''}`, link: '/backend/products?status=draft' });
  if (added) req.flash('success', `Imported ${added} product${added > 1 ? 's' : ''} as drafts. Review and publish them below.`);
  if (skipped.length) req.flash('warn', `Skipped ${skipped.length}: ${skipped.slice(0, 5).join(' ')}${skipped.length > 5 ? ' …' : ''}`);
  res.redirect(added ? '/backend/products?status=draft' : '/backend/import');
}));

// ---------- VaayuTrip packages (agency_id IS NULL): ready-made trips agents sell or copy ----------

const pkgBuilder = require('../package-builder');
const pkgs = require('../packages');
const builderOpts = { KINDS, MEAL_PLANS: pkgs.MEAL_PLANS, STAY_TYPES: pkgs.STAY_TYPES, EXTRA_TYPES: pkgs.EXTRA_TYPES };
const vaayuPkg = (id) => one('SELECT * FROM packages WHERE id = ? AND agency_id IS NULL', num(id));

router.get('/packages', h(async (req, res) => {
  const rows = await all(`SELECT p.*, (SELECT COUNT(*) FROM quotes q WHERE q.package_id = p.id) AS quotes, (SELECT COUNT(*) FROM packages c WHERE c.copied_from = p.id) AS copies,
    (SELECT COUNT(*) FROM package_departures d WHERE d.package_id = p.id AND d.depart_on >= sqldate('now')) AS departures
    FROM packages p WHERE p.agency_id IS NULL ORDER BY p.updated_at DESC`);
  const details = rows.map((p) => pkgs.parseDetails(p.details));
  const products = await productMap(details.flatMap(pkgs.itemIds)); // one query for every package's services
  const packages = await Promise.all(rows.map(async (p, i) => {
    const d = details[i];
    return { ...p, price: await pkgs.fromPrice(pkgBuilder.NET_ONLY, p, d, products), services: d.items.length, problems: pkgs.publishProblems(p, d) };
  }));
  res.page('backend/packages', { title: 'VaayuTrip packages', packages });
}));

router.get('/packages/new', h(async (req, res) => {
  res.page('agent/package-form', { title: 'New VaayuTrip package', formBase: '/backend/packages', ...await pkgBuilder.builderData(pkgBuilder.NET_ONLY, { nights: 3, status: 'draft', destination: str(req.query.destination), title: '' }, pkgBuilder.newPackageDetails(), builderOpts) });
}));

router.post('/packages', withCover(svc.AppError), h(async (req, res) => {
  const details = pkgs.detailsFromForm(req.body, await pkgBuilder.productCatalogue());
  const core = { ...pkgBuilder.packageCore(req.body, details), image_url: coverFrom(req, null) };
  if (!core.title || !core.destination) throw new svc.AppError('Give the package a name and destination.');
  const id = await pkgBuilder.insertPackage(null, core, details);
  await audit(req.user, 'vaayu_package.created', { entity: 'package', id, summary: core.title, link: `/backend/packages/${id}/edit` });
  req.flash('success', 'Package saved as a draft. Publish it to show it to agents.');
  res.redirect(`/backend/packages/${id}/edit`);
}));

router.get('/packages/:id/edit', h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  res.page('agent/package-form', { title: `Edit ${pkg.title}`, formBase: '/backend/packages', ...await pkgBuilder.builderData(pkgBuilder.NET_ONLY, pkg, pkgs.parseDetails(pkg.details), builderOpts) });
}));

router.post('/packages/:id', withCover(svc.AppError), h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  const details = pkgs.detailsFromForm(req.body, await pkgBuilder.productCatalogue());
  const core = { ...pkgBuilder.packageCore(req.body, details), image_url: coverFrom(req, pkg.image_url) };
  if (!core.title || !core.destination) throw new svc.AppError('Give the package a name and destination.');
  await run(`UPDATE packages SET ${pkgBuilder.PKG_CORE.map((k) => `${k} = ?`).join(', ')}, details = ?, updated_at = datetime('now') WHERE id = ?`,
    ...pkgBuilder.PKG_CORE.map((k) => core[k]), JSON.stringify(details), pkg.id);
  await audit(req.user, 'vaayu_package.updated', { entity: 'package', id: pkg.id, summary: core.title, link: `/backend/packages/${pkg.id}/edit` });
  const problems = pkgs.publishProblems(core, details);
  if (pkg.status === 'published' && problems.length) {
    await run("UPDATE packages SET status = 'draft' WHERE id = ?", pkg.id);
    req.flash('warn', `Package hidden from agents: ${problems[0]}`);
  } else {
    req.flash('success', 'Package saved.');
  }
  res.redirect('/backend/packages');
}));

router.post('/packages/:id/status', h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = pkgs.publishProblems(pkg, pkgs.parseDetails(pkg.details));
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  await run("UPDATE packages SET status = ?, updated_at = datetime('now') WHERE id = ?", status, pkg.id);
  await audit(req.user, status === 'published' ? 'vaayu_package.published' : 'vaayu_package.unpublished', { entity: 'package', id: pkg.id, summary: pkg.title, link: '/backend/packages' });
  if (status === 'published') {
    for (const a of await all("SELECT id FROM agencies WHERE status = 'active'")) await notify(a.id, 'New VaayuTrip package', `${pkg.title} (${pkg.nights}N ${pkg.destination}) is ready to sell.`, `/agent/vaayutrip-packages/${pkg.id}`);
  }
  req.flash('success', status === 'published' ? 'Published: agents can now sell it.' : 'Hidden from agents. Quotes already made keep their copy.');
  res.redirect('/backend/packages');
}));

router.get('/packages/:id/departures', h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  res.page('backend/departures', { title: `Departures · ${pkg.title}`, pkg, departures: await svc.departuresOf(pkg.id, { upcoming: false }) });
}));

router.post('/packages/:id/departures', h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  const seats = Math.round(num(req.body.seats, 0));
  const dates = String(req.body.dates || '').split(/[\s,]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!dates.length || !(seats > 0 && seats <= 999)) throw new svc.AppError('Pick at least one date and 1–999 seats.');
  for (const d of dates) {
    await run('INSERT INTO package_departures (package_id, depart_on, seats, note) VALUES (?, ?, ?, ?) ON CONFLICT (package_id, depart_on) DO UPDATE SET seats = excluded.seats, note = excluded.note',
      pkg.id, d, seats, str(req.body.note).slice(0, 80) || null);
  }
  await audit(req.user, 'vaayu_package.departures', { entity: 'package', id: pkg.id, summary: `${pkg.title}: ${dates.join(', ')} · ${seats} seats`, link: `/backend/packages/${pkg.id}/departures` });
  req.flash('success', `${dates.length} departure${dates.length === 1 ? '' : 's'} saved with ${seats} seats.`);
  res.redirect(`/backend/packages/${pkg.id}/departures`);
}));

router.post('/packages/:id/departures/:depId/delete', h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  await run('DELETE FROM package_departures WHERE id = ? AND package_id = ?', num(req.params.depId), pkg.id);
  req.flash('success', 'Departure removed. Bookings already made stay as they are.');
  res.redirect(`/backend/packages/${pkg.id}/departures`);
}));

router.post('/packages/:id/delete', h(async (req, res, next) => {
  const pkg = await vaayuPkg(req.params.id);
  if (!pkg) return next();
  await run('DELETE FROM packages WHERE id = ?', pkg.id);
  await audit(req.user, 'vaayu_package.deleted', { entity: 'package', id: pkg.id, summary: pkg.title, link: '/backend/packages' });
  req.flash('success', 'Package deleted. Agents\' copies and quotes keep theirs.');
  res.redirect('/backend/packages');
}));

module.exports = router;
module.exports.parseCsv = parseCsv;
