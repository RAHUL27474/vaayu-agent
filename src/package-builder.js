// The package builder, shared by agents (their own packages) and the backend team (VaayuTrip packages, which have
// no agency: agency_id IS NULL). Agents sell VaayuTrip packages as they are, or copy one into My packages.
const { one, all, run, getSettings } = require('./db');
const { uniqueSlug, num } = require('./util');
const { emptyDetails, fromPrice, publishProblems } = require('./packages');
const { cardPrice, describe, tierPrices } = require('./products');

const str = (v) => String(v ?? '').trim();
const PKG_CORE = ['title', 'destination', 'nights', 'theme', 'summary', 'inclusions', 'exclusions', 'image_url', 'is_international', 'departure_city'];

// Prices shown to the backend team: agents' net, no markup.
const NET_ONLY = { markup_type: 'percent', markup_value: 0, markup_by_kind: null };

// Catalogue cards: the agency's tier price (settings needed for it), its default markup, and a one-line description.
const withPrices = (agency, settings) => (raw) => { const p = tierPrices(agency, raw, settings); return { ...p, price: cardPrice(agency, p), line: describe(p) }; };

/** New draft package for an agency, or a VaayuTrip package when agency is null. */
async function insertPackage(agency, core, details, status = 'draft') {
  const row = { nights: 3, ...core, is_international: 1 };
  return (await run(
    `INSERT INTO packages (${PKG_CORE.join(', ')}, details, slug, agency_id, status) VALUES (${PKG_CORE.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    ...PKG_CORE.map((k) => row[k] ?? null), JSON.stringify(details), await uniqueSlug('packages', row.title), agency ? agency.id : null, status,
  )).lastInsertRowid;
}

function newPackageDetails() {
  const d = emptyDetails();
  d.days = [{ title: 'Arrival', description: '', meals: { b: false, l: false, d: true }, overnight: '' }];
  d.policies.cancellation = [{ days: 30, percent: 10 }, { days: 15, percent: 25 }, { days: 7, percent: 50 }, { days: 0, percent: 100 }];
  d.policies.child = 'Infants below 2 years travel free. Children 2–11 years pay the child price for activities. 12 years and above: adult price.';
  d.policies.notes = 'Hotel check-in 14:00, check-out 11:00. Valid government photo ID required for all travellers. Activity timings may change with weather and local conditions.';
  return d;
}

// Every published product, for the builder's pickers and for validating the form.
const productCatalogue = async () => new Map((await all("SELECT * FROM products WHERE status = 'published' ORDER BY kind, country, city, title")).map((p) => [p.id, p]));

function packageCore(b, d) {
  const routeNights = d.route.reduce((s, r) => s + r.nights, 0);
  return {
    title: str(b.title),
    destination: str(b.destination),
    nights: routeNights || Math.max(1, Math.round(num(b.nights, 1))),
    theme: str(b.theme) || null,
    summary: str(b.summary) || null,
    inclusions: str(b.inclusions) || null,
    exclusions: str(b.exclusions) || null,
    // Every VaayuTrip destination is abroad, so TCS applies on customer invoices.
    is_international: 1,
    departure_city: str(b.departure_city) || null,
  };
}

/** Locals for views/agent/package-form.ejs. agency prices the pickers (NET_ONLY for the backend team). */
async function builderData(agency, pkg, details, { KINDS, MEAL_PLANS, STAY_TYPES, EXTRA_TYPES }) {
  const catalogue = await productCatalogue();
  return {
    pkg, d: details, catalogue: [...catalogue.values()].map(withPrices(agency, await getSettings())), kinds: KINDS, mealPlans: MEAL_PLANS, stayTypes: STAY_TYPES, extraTypes: EXTRA_TYPES,
    problems: pkg.id ? publishProblems(pkg, details) : [],
    from: pkg.id ? await fromPrice(agency, pkg, details) : null,
  };
}

/** A published VaayuTrip package. */
const vaayuPackage = (id) => one("SELECT * FROM packages WHERE id = ? AND agency_id IS NULL AND status = 'published'", id);

module.exports = { PKG_CORE, NET_ONLY, withPrices, insertPackage, newPackageDetails, productCatalogue, packageCore, builderData, vaayuPackage };
