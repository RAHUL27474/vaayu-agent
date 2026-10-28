/**
 * Backend portal (/backend): where VaayuTrip's backend team enters the inventory agents build packages
 * from (activities, hotels, airfares, transfers, visas, insurance). Admins can use it too, and every
 * change is recorded in the admin's activity log.
 */
const express = require('express');
const multer = require('multer');
const { one, all, run, tx, notify, audit } = require('../db');
const { num, uniqueSlug } = require('../util');
const { requireBackend, h } = require('../auth');
const svc = require('../services');
const {
  KINDS, DESTINATIONS, PRODUCT_COUNTRIES, ALL_DESTINATIONS, BASIS_LABELS, MEAL_PLANS, productFromForm, publishProblems, parseProductDetails, describe,
} = require('../products');
const { withCover, coverFrom } = require('../photos');
const { readXlsx, XlsxError } = require('../xlsx');
const { readRateCard, isRateCard } = require('../ratecard');

const router = express.Router();
router.use(requireBackend);
router.use((req, res, next) => {
  res.locals.kindsNav = KINDS;
  res.locals.navKind = KINDS[req.query.kind] ? req.query.kind : '';
  next();
});

const str = (v) => String(v ?? '').trim();
const FIELDS = ['kind', 'title', 'city', 'country', 'category', 'duration', 'summary', 'description', 'highlights', 'inclusions', 'exclusions', 'pickup',
  'timing', 'cancellation', 'image_url', 'price_basis', 'group_size', 'net_adult', 'net_child', 'net_infant', 'details'];
const link = (id) => `/backend/products/${id}`;

function insertProduct(p, user) {
  return run(
    `INSERT INTO products (${FIELDS.join(', ')}, slug, created_by, updated_by) VALUES (${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`,
    ...FIELDS.map((k) => p[k] ?? null), uniqueSlug('products', `${p.title} ${p.city}`), user.id, user.id,
  ).lastInsertRowid;
}

// ---------- dashboard ----------

router.get('/', h((req, res) => {
  const counts = all("SELECT kind, SUM(status = 'published') AS live, SUM(status = 'draft') AS drafts FROM products GROUP BY kind");
  const byKind = Object.fromEntries(counts.map((c) => [c.kind, c]));
  // Live products per destination and kind, so the team can see gaps in coverage.
  const coverage = Object.fromEntries(Object.keys(DESTINATIONS).map((d) => [d, {}]));
  for (const r of all("SELECT country, kind, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY country, kind")) {
    // Plans for all destinations (insurance) count everywhere.
    const dests = r.country === ALL_DESTINATIONS ? Object.keys(DESTINATIONS) : Object.keys(DESTINATIONS).filter((d) => DESTINATIONS[d].includes(r.country));
    for (const dest of dests) coverage[dest][r.kind] = (coverage[dest][r.kind] || 0) + r.n;
  }
  const recent = all(
    `SELECT p.id, p.kind, p.title, p.city, p.status, p.updated_at, u.name AS updated_by_name FROM products p
     LEFT JOIN users u ON u.id = p.updated_by ORDER BY p.updated_at DESC, p.id DESC LIMIT 10`,
  );
  const drafts = all("SELECT * FROM products WHERE status = 'draft' ORDER BY updated_at DESC LIMIT 50")
    .map((p) => ({ ...p, problems: publishProblems(p) }));
  res.page('backend/dashboard', { title: 'Backend dashboard', byKind, coverage, recent, drafts, kinds: KINDS, destinations: Object.keys(DESTINATIONS) });
}));

// ---------- products ----------

router.get('/products', h((req, res) => {
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
  if (f.q) { where.push('(p.title LIKE ? OR p.city LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  const products = all(
    `SELECT p.*, u.name AS updated_by_name,
       (SELECT COUNT(DISTINCT b.id) FROM quote_items qi JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled' WHERE qi.product_id = p.id) AS bookings
     FROM products p LEFT JOIN users u ON u.id = p.updated_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.kind, p.country, p.city, p.title`, ...params,
  ).map((p) => ({ ...p, line: describe(p) }));
  res.page('backend/products', { title: f.kind ? KINDS[f.kind].plural : 'All inventory', products, f, kinds: KINDS, destinations: Object.keys(DESTINATIONS), basisLabels: BASIS_LABELS });
}));

const formData = (p) => ({
  p, d: parseProductDetails(p.details), cfg: KINDS[p.kind], kinds: KINDS, countries: PRODUCT_COUNTRIES, destinations: DESTINATIONS,
  basisLabels: BASIS_LABELS, mealPlans: MEAL_PLANS, problems: p.id ? publishProblems(p) : [],
});

router.get('/products/new', (req, res) => {
  const kind = KINDS[req.query.kind] ? req.query.kind : 'activity';
  res.page('backend/product-form', { title: `New ${KINDS[kind].label.toLowerCase()}`, ...formData({ kind, status: 'draft', price_basis: KINDS[kind].basis[0], details: '{}' }), navKind: kind });
});

router.post('/products', withCover(svc.AppError), h((req, res) => {
  const kind = KINDS[req.body.kind] ? req.body.kind : 'activity';
  const p = { ...productFromForm(req.body, kind), image_url: coverFrom(req, null) };
  if (!p.title || !p.city) throw new svc.AppError('Title and city are required.');
  const id = insertProduct(p, req.user);
  audit(req.user, 'product.created', { entity: 'product', id, summary: `${KINDS[kind].label}: ${p.title} (${p.city})`, link: link(id) });
  req.flash('success', `${KINDS[kind].label} saved as a draft. Publish it to make it available to agents.`);
  res.redirect(link(id));
}));

const ownedProduct = (req) => one('SELECT * FROM products WHERE id = ?', num(req.params.id));

router.get('/products/:id', h((req, res, next) => {
  const p = one(
    `SELECT p.*, c.name AS created_by_name, u.name AS updated_by_name,
       (SELECT COUNT(*) FROM packages k WHERE k.agency_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(k.details, '$.items') j WHERE json_extract(j.value, '$.id') = p.id)) AS packages,
       (SELECT COUNT(DISTINCT b.id) FROM quote_items qi JOIN bookings b ON b.quote_id = qi.quote_id AND b.status != 'cancelled' WHERE qi.product_id = p.id) AS bookings
     FROM products p LEFT JOIN users c ON c.id = p.created_by LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = ?`, num(req.params.id),
  );
  if (!p) return next();
  const history = all("SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entity = 'product' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 20", p.id);
  res.page('backend/product-form', { title: p.title, ...formData(p), history, navKind: p.kind });
}));

router.post('/products/:id', withCover(svc.AppError), h((req, res, next) => {
  const old = ownedProduct(req);
  if (!old) return next();
  const p = { ...productFromForm(req.body, old.kind), image_url: coverFrom(req, old.image_url) };
  if (!p.title || !p.city) throw new svc.AppError('Title and city are required.');
  const keys = FIELDS.filter((k) => k !== 'kind');
  run(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => p[k]), req.user.id, old.id);
  const priceChanged = ['net_adult', 'net_child', 'net_infant', 'price_basis', 'group_size'].some((k) => (old[k] ?? null) !== (p[k] ?? null));
  audit(req.user, priceChanged ? 'product.price_changed' : 'product.updated', {
    entity: 'product', id: old.id, link: link(old.id),
    summary: priceChanged ? `${p.title}: net ₹${old.net_adult} → ₹${p.net_adult}` : p.title,
  });
  const problems = publishProblems({ ...p, kind: old.kind });
  if (old.status === 'published' && problems.length) {
    run("UPDATE products SET status = 'draft' WHERE id = ?", old.id);
    audit(req.user, 'product.unpublished', { entity: 'product', id: old.id, summary: `${p.title} (incomplete: ${problems[0]})`, link: link(old.id) });
    req.flash('warn', `Moved back to draft: ${problems[0]}`);
  } else {
    req.flash('success', 'Saved. New quotes use the updated price; quotes already made keep theirs.');
  }
  res.redirect(link(old.id));
}));

router.post('/products/:id/status', h((req, res, next) => {
  const p = ownedProduct(req);
  if (!p) return next();
  const status = req.body.status === 'published' ? 'published' : 'draft';
  if (status === 'published') {
    const problems = publishProblems(p);
    if (problems.length) throw new svc.AppError(`Can't publish yet: ${problems.join(' ')}`);
  }
  if (status !== p.status) {
    run("UPDATE products SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", status, req.user.id, p.id);
    audit(req.user, status === 'published' ? 'product.published' : 'product.unpublished', { entity: 'product', id: p.id, summary: `${KINDS[p.kind].label}: ${p.title}`, link: link(p.id) });
    if (status === 'published') {
      for (const ag of all("SELECT id FROM agencies WHERE status = 'active'")) {
        notify(ag.id, `New ${KINDS[p.kind].label.toLowerCase()}`, `${p.title} (${p.city}) is available for your quotes and packages.`, `/agent/${KINDS[p.kind].path}/${p.id}`);
      }
    }
  }
  req.flash('success', status === 'published' ? 'Published: agents can now add it to quotes and packages.' : 'Unpublished: agents can no longer add it, and packages using it show a warning.');
  res.redirect(link(p.id));
}));

router.post('/products/:id/duplicate', h((req, res, next) => {
  const p = ownedProduct(req);
  if (!p) return next();
  const id = insertProduct({ ...p, title: `${p.title} (copy)` }, req.user);
  audit(req.user, 'product.created', { entity: 'product', id, summary: `Copy of ${p.title}`, link: link(id) });
  req.flash('success', 'Copy created as a draft.');
  res.redirect(link(id));
}));

router.post('/products/:id/delete', h((req, res, next) => {
  const p = ownedProduct(req);
  if (!p) return next();
  run('DELETE FROM products WHERE id = ?', p.id);
  audit(req.user, 'product.deleted', { entity: 'product', id: p.id, summary: `${KINDS[p.kind].label}: ${p.title} (${p.city})` });
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
function sameProduct(p) {
  const d = parseProductDetails(p.details);
  return all('SELECT id, details FROM products WHERE kind = ? AND lower(city) = lower(?) AND title = ?', p.kind, p.city, p.title).find((r) => {
    if (p.kind !== 'hotel') return true;
    const o = parseProductDetails(r.details);
    return o.room === d.room && o.mealPlan === d.mealPlan && (o.season || '') === (d.season || '');
  });
}

/** VaayuTrip rate card workbook (Hotels / Activities / Transfers / Currency tabs): adds new items as drafts, updates rates of matching ones. */
function importRateCard(req, res, book) {
  const knownCities = Object.fromEntries(all('SELECT DISTINCT lower(city) AS city, country FROM products').map((r) => [r.city, r.country]));
  const { items, skipped, skippedRows, notes } = readRateCard(book, { knownCities, fallbackCountry: req.body.country });
  let added = 0;
  let updated = 0;
  tx(() => {
    for (const item of items) {
      const p = productFromForm(item, item.kind);
      // Keep what the form fields can't hold: the hotel season and the rate as written on the card.
      p.details = JSON.stringify({ ...parseProductDetails(p.details), ...(item.d_season ? { season: item.d_season } : {}), rateCard: item.source });
      if (item.group_size == null && p.price_basis === 'per_group') p.group_size = 1;
      const old = sameProduct(p);
      if (old) {
        // Rates always come from the card; text the card leaves blank keeps what the team wrote.
        const text = ['duration', 'timing', 'summary', 'description'];
        const rates = ['category', 'price_basis', 'group_size', 'net_adult', 'net_child', 'net_infant', 'details'];
        run(`UPDATE products SET ${[...text.map((k) => `${k} = COALESCE(?, ${k})`), ...rates.map((k) => `${k} = ?`)].join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
          ...[...text, ...rates].map((k) => p[k] ?? null), req.user.id, old.id);
        updated++;
      } else {
        insertProduct({ ...p, image_url: null }, req.user);
        added++;
      }
    }
  });
  audit(req.user, 'product.imported', { entity: 'product', summary: `Rate card: ${added} new draft(s), ${updated} updated${skippedRows ? `, skipped ${skippedRows}` : ''}`, link: '/backend/products?status=draft' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const done = [added && `${plural(added, 'new item')} added as drafts`, updated && `${plural(updated, 'existing item')} updated with the new rates`].filter(Boolean);
  if (done.length) req.flash('success', `Rate card imported: ${done.join(', ')}.`);
  if (!items.length && !skipped.length) req.flash('warn', 'No rows found. Fill the Hotels, Activities or Transfers tab below its header row.');
  const issues = [...skipped, ...notes];
  if (issues.length) req.flash('warn', `${skippedRows ? `Skipped ${skippedRows} row${skippedRows === 1 ? '' : 's'}. ` : ''}${issues.slice(0, 6).join(' ')}${issues.length > 6 ? ` … and ${issues.length - 6} more.` : ''}`);
  res.redirect(added || updated ? '/backend/products?status=draft' : '/backend/import');
}

router.post('/import', (req, res, next) => importUpload(req, res, (err) => next(err ? new svc.AppError('The file must be a CSV or Excel (.xlsx) file under 5 MB.') : undefined)), h((req, res) => {
  if (!req.file) throw new svc.AppError('Choose a CSV or Excel file to import.');
  let rows;
  if (isXlsx(req.file)) {
    let book;
    try { book = readXlsx(req.file.buffer); } catch (e) {
      throw new svc.AppError(e instanceof XlsxError ? e.message : 'Could not read this Excel file. Save it again as .xlsx and retry.');
    }
    if (isRateCard(book)) return importRateCard(req, res, book);
    rows = book[0].rows;
  } else if (/\.xls$/i.test(req.file.originalname)) {
    throw new svc.AppError('This is an old-style .xls file. In Excel choose File → Save As → Excel Workbook (.xlsx), then upload that.');
  } else rows = parseCsv(req.file.buffer.toString('utf8').replace(/^﻿/, ''));
  if (rows.length < 2) throw new svc.AppError('The file has no rows under the header.');
  const header = rows[0].map((h2) => h2.trim().toLowerCase());
  const skipped = [];
  let added = 0;
  tx(() => {
    rows.slice(1).forEach((cells, i) => {
      const r = Object.fromEntries(header.map((k, j) => [k, (cells[j] || '').trim()]));
      const line = i + 2;
      if (!KINDS[r.kind]) return skipped.push(`Row ${line}: kind must be one of ${Object.keys(KINDS).join(', ')}.`);
      // Multi-line fields can be written with " | " between lines in a spreadsheet.
      for (const k of ['highlights', 'inclusions', 'exclusions']) if (r[k]) r[k] = r[k].split(/\s*\|\s*/).join('\n');
      const p = productFromForm(r, r.kind);
      if (!p.title || !p.city) return skipped.push(`Row ${line}: title and city are required.`);
      if (!p.country) return skipped.push(`Row ${line}: "${r.country}" is not one of our destination countries.`);
      insertProduct({ ...p, image_url: null }, req.user);
      added++;
    });
  });
  audit(req.user, 'product.imported', { entity: 'product', summary: `Imported ${added} product(s) as drafts${skipped.length ? `, skipped ${skipped.length}` : ''}`, link: '/backend/products?status=draft' });
  if (added) req.flash('success', `Imported ${added} product${added > 1 ? 's' : ''} as drafts. Review and publish them below.`);
  if (skipped.length) req.flash('warn', `Skipped ${skipped.length}: ${skipped.slice(0, 5).join(' ')}${skipped.length > 5 ? ' …' : ''}`);
  res.redirect(added ? '/backend/products?status=draft' : '/backend/import');
}));

module.exports = router;
module.exports.parseCsv = parseCsv;
