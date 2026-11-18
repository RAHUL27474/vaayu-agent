/**
 * Holiday packages built by agents. VaayuTrip sells no packages: agents combine VaayuTrip's inventory
 * (activities, hotels, airfares, transfers, visas, insurance) with their own hotels and services.
 *
 * A package's details are stored as one JSON document (packages.details):
 *   route        [{ city, nights }]
 *   highlights   [string]
 *   days         [{ title, description, meals: { b, l, d }, overnight }]
 *   items        [{ day, id, kind, title, nights }]   VaayuTrip products by day number; nights for hotels.
 *                The title is kept so a withdrawn product can still be named.
 *   stays        [{ source, city, hotel, type, stars, room, mealPlan, nights, cost, price }]
 *                hotels not booked through VaayuTrip. source 'agent': the agent books it, per room per night
 *                cost = what the agent pays (private), price = what the customer pays (0 = not charged
 *                separately). source 'client': the traveller arranges it; listed in the itinerary, never priced.
 *                (Hotels from VaayuTrip are items of kind 'hotel'; presented with source 'vaayu'.)
 *   extras       [{ type, title, description, basis: per_person | per_booking, cost, price }]
 *                the agent's own services, with the agent's cost and customer price
 *   policies     { advancePercent, balanceDays, payment, cancellation: [{ days, percent }], child, notes, terms }
 *
 * VaayuTrip products are bought at net and marked up with the quote's markup. Stays and extras are the
 * agent's own services: they go on quotes at the agent's price and on the agent's branded invoice.
 */
const { round2 } = require('./util');
const { getSettings } = require('./db');
const { priceQuote } = require('./pricing');
const { productMap, productLines, presentProduct, parseProductDetails, KINDS, tierPrices, tierDiscount, activeTier } = require('./products');

const MEAL_PLANS = {
  EP: 'Room only (EP)',
  CP: 'Breakfast (CP)',
  MAP: 'Breakfast + dinner (MAP)',
  AP: 'All meals (AP)',
  AI: 'All inclusive (AI)',
};
const STAY_TYPES = ['Hotel', 'Resort', 'Villa', 'Boutique hotel', 'Apartment', 'Houseboat', 'Cruise'];
/** Who provides a hotel in a package. */
const STAY_SOURCES = { vaayu: 'From VaayuTrip', agent: 'Your own', client: "Customer's own" };
const EXTRA_TYPES = { transfer: 'Transfer / cab', meal: 'Meals', guide: 'Guide', visa: 'Visa', insurance: 'Insurance', flight: 'Flight', other: 'Other' };

function emptyDetails() {
  return {
    route: [], highlights: [], days: [], items: [], stays: [], extras: [],
    policies: { advancePercent: 25, balanceDays: 15, payment: '', cancellation: [], child: '', notes: '', terms: '' },
  };
}

function parseDetails(json) {
  const base = emptyDetails();
  if (!json) return base;
  let d;
  try { d = JSON.parse(json); } catch { return base; }
  // Packages saved before other product kinds existed listed only activities.
  const items = d.items || (d.activities || []).map((a) => ({ ...a, kind: 'activity' }));
  return { ...base, ...d, items, policies: { ...base.policies, ...d.policies } };
}

const itemIds = (d) => d.items.map((x) => x.id);

// ---------- form parsing ----------

const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, round2(parseFloat(v) || 0));
const int = (v, min = 0) => Math.max(min, Math.round(parseFloat(v) || 0));
const lines = (v) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
// qs turns rows[0][x] into an array, but switches to an object after 20 rows; accept both.
const rows = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const dateOrEmpty = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : '');

/** Builds a details document from the package builder form. Product titles and kinds come from the catalogue. */
function detailsFromForm(b, catalogue) {
  const d = emptyDetails();
  d.highlights = lines(b.highlights);
  d.route = rows(b.route).map((r) => ({ city: str(r.city), nights: int(r.nights) })).filter((r) => r.city);
  d.days = rows(b.days)
    .map((r) => ({
      title: str(r.title),
      description: str(r.description),
      meals: { b: Boolean(r.b), l: Boolean(r.l), d: Boolean(r.d) },
      overnight: str(r.overnight),
    }))
    .filter((r) => r.title || r.description);
  d.items = rows(b.items)
    .map((r) => ({ day: int(r.day, 1), id: int(r.id), nights: int(r.nights, 1) }))
    .filter((r) => catalogue.has(r.id))
    .map((r) => {
      const p = catalogue.get(r.id);
      return { day: r.day, id: r.id, kind: p.kind, title: p.title, ...(p.kind === 'hotel' ? { nights: r.nights } : {}) };
    })
    .sort((x, y) => x.day - y.day);
  d.stays = rows(b.stays)
    .map((r) => ({
      source: r.source === 'client' ? 'client' : 'agent',
      city: str(r.city),
      hotel: str(r.hotel),
      type: STAY_TYPES.includes(r.type) ? r.type : 'Hotel',
      stars: Math.min(5, int(r.stars)),
      room: str(r.room),
      mealPlan: MEAL_PLANS[r.mealPlan] ? r.mealPlan : 'CP',
      nights: int(r.nights, 1),
      cost: r.source === 'client' ? 0 : money(r.cost),
      price: r.source === 'client' ? 0 : money(r.price),
    }))
    .filter((r) => r.city && r.hotel);
  d.extras = rows(b.extras)
    .map((r) => ({
      type: EXTRA_TYPES[r.type] ? r.type : 'other',
      title: str(r.title),
      description: str(r.description),
      basis: r.basis === 'per_booking' ? 'per_booking' : 'per_person',
      cost: money(r.cost),
      price: money(r.price),
    }))
    .filter((r) => r.title);
  d.policies = {
    advancePercent: Math.min(100, int(b.advance_percent)),
    balanceDays: int(b.balance_days),
    payment: str(b.payment_terms),
    cancellation: rows(b.cancel)
      .filter((r) => str(r.percent) !== '')
      .map((r) => ({ days: int(r.days), percent: Math.min(100, int(r.percent)) }))
      .sort((x, y) => y.days - x.days),
    child: str(b.child_policy),
    notes: str(b.important_notes),
    terms: str(b.terms),
  };
  return d;
}

// ---------- pricing ----------

function normalizeParty(o = {}) {
  const adults = int(o.adults ?? 2, 1);
  return {
    adults,
    children: int(o.children),
    infants: int(o.infants),
    rooms: o.rooms === undefined || str(o.rooms) === '' ? Math.ceil(adults / 2) : int(o.rooms, 1),
    date: dateOrEmpty(o.date),
  };
}

/**
 * Prices a package for a party ({ adults, children, infants, rooms, date }).
 * Lines: { type, title, description, supplier: vaayu | agent, net, sell, cost, qty, productId }.
 * Products withdrawn from the catalogue are skipped and reported in warnings.
 */
async function calcPackage(pkg, d, rawParty, products, agency = null) {
  products = products || await productMap(itemIds(d));
  // An agency's rate tier lowers VaayuTrip's margin on its prices.
  if (agency) {
    const settings = await getSettings();
    if (tierDiscount(agency, settings) > 0) products = new Map([...products].map(([id, p]) => [id, tierPrices(agency, p, settings)]));
  }
  const o = normalizeParty(rawParty);
  const errors = [];
  const warnings = [];
  if (o.rooms > o.adults) errors.push('Each room needs at least one adult.');
  const pax = o.adults + o.children;
  const lines = [];

  for (const entry of d.items) {
    const p = products.get(entry.id);
    if (!p) {
      warnings.push(`${entry.title} is no longer offered by VaayuTrip; replace it in the package.`);
      continue;
    }
    // The date this item happens: the travel date plus its day in the itinerary.
    let day = '';
    if (o.date) {
      const t = new Date(`${o.date}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + (entry.day || 1) - 1);
      day = t.toISOString().slice(0, 10);
    }
    const itemLines = productLines(p, { ...o, nights: entry.nights, date: day }, `Day ${entry.day}: `);
    if (itemLines.some((l) => l.soldOut)) errors.push(`${p.title} is sold out on ${day} (${itemLines[0].soldOut.label}). Pick another date or replace it.`);
    for (const l of itemLines) lines.push({ ...l, supplier: 'vaayu', sell: null });
  }
  for (const s of d.stays) {
    if (s.source === 'client' || !(s.price > 0)) continue;
    lines.push({
      type: 'hotel', supplier: 'agent', net: 0, sell: s.price, cost: s.cost || 0, qty: s.nights * o.rooms,
      title: `${s.hotel}, ${s.city}: ${s.room || 'room'}, ${MEAL_PLANS[s.mealPlan] || s.mealPlan}`,
      description: `${s.nights} night${s.nights > 1 ? 's' : ''} × ${o.rooms} room${o.rooms > 1 ? 's' : ''}`,
    });
  }
  for (const x of d.extras) {
    if (!(x.price > 0)) continue;
    lines.push({
      type: x.type, supplier: 'agent', net: 0, sell: x.price, cost: x.cost || 0, qty: x.basis === 'per_person' ? pax : 1,
      title: x.title, description: [x.description, x.basis === 'per_person' ? 'per person' : 'per booking'].filter(Boolean).join(' · '),
    });
  }
  return { options: o, errors, warnings, lines, pax };
}

/** Totals for calculated lines under a markup ({ markup_type, markup_value }), as priceQuote returns them. */
function priceLines(markup, lines) {
  return priceQuote(markup, lines.map((l) => ({ ...l, net_price: l.net, sell_price: l.sell })));
}

/** Per person for two adults in one room, with the agency's default markup: { net, sell, earning }. */
async function fromPrice(agency, pkg, d, products) {
  const calc = await calcPackage(pkg, d, { adults: 2, rooms: 1 }, products, agency);
  const priced = priceLines(agency, calc.lines);
  const out = { net: round2(priced.net / 2), sell: round2(priced.sell / 2), earning: round2(priced.commission / 2), was: null, tier: null };
  // With a tier discount, also the standard net it beats.
  if (agency && !agency.noTier && tierDiscount(agency, await getSettings()) > 0) {
    const std = priceLines(agency, (await calcPackage(pkg, d, { adults: 2, rooms: 1 }, products, null)).lines);
    if (std.net > priced.net) Object.assign(out, { was: round2(std.net / 2), tier: activeTier(agency, await getSettings()).tier });
  }
  return out;
}

/** Problems that keep a package off the agent's website and API. */
function publishProblems(pkg, d) {
  const p = [];
  if (!pkg.title || !pkg.destination) p.push('Add a name and destination.');
  if (!d.days.length) p.push('Add the day-wise itinerary.');
  if (!d.items.length) p.push('Add at least one VaayuTrip service (activity, hotel, airfare, transfer…).');
  return p;
}

/** The display view of a package, used by package pages, quotes and agent websites (partials/package-full). */
async function present(pkg, d, products) {
  products = products || await productMap(itemIds(d));
  const live = d.items.filter((x) => products.has(x.id)).map((x) => ({ entry: x, p: products.get(x.id) }));
  const dayCount = Math.max(d.days.length, ...d.items.map((x) => x.day), 0);
  const days = [...Array(dayCount)].map((_, i) => ({
    ...(d.days[i] || { title: `Day ${i + 1}`, description: '', meals: {}, overnight: '' }),
    items: live.filter(({ entry }) => entry.day === i + 1).map(({ entry, p }) => presentProduct(p, entry)),
  }));
  const vaayuStays = live.filter(({ p }) => p.kind === 'hotel').map(({ entry, p }) => {
    const x = parseProductDetails(p.details);
    return { source: 'vaayu', city: p.city, hotel: p.title, type: p.category || 'Hotel', stars: Number(x.stars) || 0, room: x.room || '', mealPlan: x.mealPlan || 'CP', nights: entry.nights || 1 };
  });
  const flights = live.filter(({ p }) => p.kind === 'flight').flatMap(({ entry, p }) => {
    const x = parseProductDetails(p.details);
    const out = [{ leg: 'onward', day: entry.day, airline: x.airline, flightNo: x.flightNo, from: x.from, to: x.to, depart: x.depart, arrive: x.arrive, cabin: p.category, baggage: x.baggage }];
    if (x.trip === 'return') {
      out.push({ leg: 'return', day: pkg.nights + 1, airline: x.airline, flightNo: x.returnFlightNo, from: x.to, to: x.from, depart: x.returnDepart, arrive: x.returnArrive, cabin: p.category, baggage: x.baggage });
    }
    return out;
  });
  return {
    packageId: pkg.id,
    title: pkg.title,
    destination: pkg.destination,
    nights: pkg.nights,
    international: Boolean(pkg.is_international),
    departureCity: pkg.departure_city,
    image: pkg.image_url,
    summary: pkg.summary,
    route: d.route,
    highlights: d.highlights,
    days,
    stays: [...vaayuStays, ...d.stays.map(({ price, cost, ...s }) => ({ ...s, source: s.source || 'agent' }))],
    flights,
    inclusions: lines(pkg.inclusions),
    exclusions: lines(pkg.exclusions),
    policies: d.policies,
  };
}

/** Everything a quote needs to show the package to the customer, frozen at quote time. */
async function snapshot(pkg, d, calc, products) {
  return { ...await present(pkg, d, products), party: calc.options };
}

module.exports = {
  MEAL_PLANS, STAY_TYPES, STAY_SOURCES, EXTRA_TYPES, KINDS,
  emptyDetails, parseDetails, itemIds, detailsFromForm, normalizeParty, calcPackage, priceLines, fromPrice, publishProblems, present, snapshot,
};
