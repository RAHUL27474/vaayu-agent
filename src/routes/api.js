/**
 * Agent REST API. Authenticate with the agency's key:
 *   Authorization: Bearer vt_live_...
 * Packages are the agency's own published packages; prices are its selling prices.
 */
const express = require('express');
const { one, all, run, notify } = require('../db');
const { num } = require('../util');
const { packageSellPrice } = require('../services');
const { parseDetails, present } = require('../packages');

const router = express.Router();

router.use((req, res, next) => {
  const key = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const agency = key && one("SELECT * FROM agencies WHERE api_key = ? AND status = 'active'", key);
  if (!agency) return res.status(401).json({ error: 'Invalid or missing API key' });
  req.apiAgency = agency;
  next();
});

const publicPackage = (agency, p) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  destination: p.destination,
  nights: p.nights,
  theme: p.theme,
  summary: p.summary,
  image_url: p.image_url,
  international: Boolean(p.is_international),
  price_per_person_from: packageSellPrice(agency, p).sell,
  price_basis: 'per person, two adults sharing a room, before taxes',
  currency: 'INR',
});

// Full package content for agents' own websites. Net rates and hotel prices are deliberately not exposed.
function packageDetail(p) {
  const v = present(p, parseDetails(p.details));
  return {
    route: v.route,
    highlights: v.highlights,
    itinerary: v.days,
    hotels: v.stays,
    inclusions: v.inclusions,
    exclusions: v.exclusions,
    policies: v.policies,
  };
}

router.get('/packages', (req, res) => {
  const rows = all("SELECT * FROM packages WHERE agency_id = ? AND status = 'published' ORDER BY id", req.apiAgency.id);
  res.json({ data: rows.map((p) => publicPackage(req.apiAgency, p)) });
});

router.get('/packages/:slug', (req, res) => {
  const p = one("SELECT * FROM packages WHERE slug = ? AND agency_id = ? AND status = 'published'", req.params.slug, req.apiAgency.id);
  if (!p) return res.status(404).json({ error: 'Package not found' });
  res.json({
    data: {
      ...publicPackage(req.apiAgency, p),
      ...packageDetail(p),
    },
  });
});

router.post('/leads', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.phone) return res.status(422).json({ error: 'name and phone are required' });
  const pkg = b.package_slug ? one('SELECT id, destination FROM packages WHERE slug = ? AND agency_id = ?', String(b.package_slug), req.apiAgency.id) : null;
  const id = run(
    "INSERT INTO leads (agency_id, package_id, name, phone, email, destination, travel_date, pax, budget, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api')",
    req.apiAgency.id, pkg?.id || null, String(b.name), String(b.phone), b.email || null, b.destination || pkg?.destination || null,
    b.travel_date || null, num(b.pax, 0) || null, num(b.budget, 0) || null, b.notes || null,
  ).lastInsertRowid;
  notify(req.apiAgency.id, 'New API lead', `${b.name} (${b.phone}) via API.`, '/agent/leads');
  res.status(201).json({ data: { id, status: 'new' } });
});

router.get('/bookings', (req, res) => {
  const rows = all('SELECT code, title, travel_date, status, total_sell, created_at FROM bookings WHERE agency_id = ? ORDER BY id DESC LIMIT 100', req.apiAgency.id);
  res.json({ data: rows });
});

module.exports = router;
