/**
 * Holiday packages built by agents from VaayuTrip activities plus their own hotels and services.
 *
 * A package's details are stored as one JSON document (packages.details):
 *   route        [{ city, nights }]
 *   highlights   [string]
 *   days         [{ title, description, meals: { b, l, d }, overnight }]
 *   activities   [{ day, id, title }]      VaayuTrip activities by day number (title kept for when one is withdrawn)
 *   stays        [{ city, hotel, type, stars, room, mealPlan, nights, cost, price }]
 *                hotels the agent arranges, per room per night: cost = what the agent pays (private),
 *                price = what the customer pays (0 = not charged separately)
 *   extras       [{ type, title, description, basis: per_person | per_booking, cost, price }]
 *                the agent's own services (transfers, meals, guide, visa…), with the agent's cost and customer price
 *   policies     { advancePercent, balanceDays, payment, cancellation: [{ days, percent }], child, notes, terms }
 *
 * Activities are bought from VaayuTrip at net and marked up with the quote's markup. Hotels and
 * extras are the agent's own services: they go on quotes at the agent's price and on the agent's
 * branded invoice.
 */
const { round2 } = require('./util');
const { priceQuote } = require('./pricing');
const { activityMap, activityLines, presentActivity } = require('./activities');

const MEAL_PLANS = {
  EP: 'Room only (EP)',
  CP: 'Breakfast (CP)',
  MAP: 'Breakfast + dinner (MAP)',
  AP: 'All meals (AP)',
};
const STAY_TYPES = ['Hotel', 'Resort', 'Houseboat', 'Villa', 'Camp', 'Homestay', 'Cruise'];
const EXTRA_TYPES = { transfer: 'Transfer / cab', meal: 'Meals', guide: 'Guide', visa: 'Visa', insurance: 'Insurance', flight: 'Flight', other: 'Other' };

function emptyDetails() {
  return {
    route: [], highlights: [], days: [], activities: [], stays: [], extras: [],
    policies: { advancePercent: 25, balanceDays: 15, payment: '', cancellation: [], child: '', notes: '', terms: '' },
  };
}

function parseDetails(json) {
  const base = emptyDetails();
  if (!json) return base;
  let d;
  try { d = JSON.parse(json); } catch { return base; }
  return { ...base, ...d, policies: { ...base.policies, ...d.policies } };
}

// ---------- form parsing ----------

const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, round2(parseFloat(v) || 0));
const int = (v, min = 0) => Math.max(min, Math.round(parseFloat(v) || 0));
const lines = (v) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
// qs turns rows[0][x] into an array, but switches to an object after 20 rows; accept both.
const rows = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const dateOrEmpty = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : '');

/** Builds a details document from the package builder form. Activity titles come from the catalogue. */
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
  d.activities = rows(b.activities)
    .map((r) => ({ day: int(r.day, 1), id: int(r.id) }))
    .filter((r) => catalogue.has(r.id))
    .map((r) => ({ ...r, title: catalogue.get(r.id).title }))
    .sort((x, y) => x.day - y.day);
  d.stays = rows(b.stays)
    .map((r) => ({
      city: str(r.city),
      hotel: str(r.hotel),
      type: STAY_TYPES.includes(r.type) ? r.type : 'Hotel',
      stars: Math.min(5, int(r.stars)),
      room: str(r.room),
      mealPlan: MEAL_PLANS[r.mealPlan] ? r.mealPlan : 'CP',
      nights: int(r.nights, 1),
      cost: money(r.cost),
      price: money(r.price),
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
    rooms: o.rooms === undefined || str(o.rooms) === '' ? Math.ceil(adults / 2) : int(o.rooms, 1),
    date: dateOrEmpty(o.date),
  };
}

/**
 * Prices a package for a party ({ adults, children, rooms, date }).
 * Lines: { type, title, description, supplier: vaayu | agent, net, sell, cost, qty, activityId }.
 * Activities withdrawn from the catalogue are skipped and reported in warnings.
 */
function calcPackage(pkg, d, rawParty, acts = activityMap(d.activities.map((a) => a.id))) {
  const o = normalizeParty(rawParty);
  const errors = [];
  const warnings = [];
  if (o.rooms > o.adults) errors.push('Each room needs at least one adult.');
  const pax = o.adults + o.children;
  const lines = [];

  for (const entry of d.activities) {
    const a = acts.get(entry.id);
    if (!a) {
      warnings.push(`${entry.title} is no longer offered by VaayuTrip; replace it in the package.`);
      continue;
    }
    for (const l of activityLines(a, o, `Day ${entry.day}: `)) lines.push({ ...l, supplier: 'vaayu', sell: null });
  }
  for (const s of d.stays) {
    if (!(s.price > 0)) continue;
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
function fromPrice(agency, pkg, d, acts) {
  const calc = calcPackage(pkg, d, { adults: 2, rooms: 1 }, acts);
  const priced = priceLines(agency, calc.lines);
  return { net: round2(priced.net / 2), sell: round2(priced.sell / 2), earning: round2(priced.commission / 2) };
}

/** Problems that keep a package off the agent's website and API. */
function publishProblems(pkg, d) {
  const p = [];
  if (!pkg.title || !pkg.destination) p.push('Add a name and destination.');
  if (!d.days.length) p.push('Add the day-wise itinerary.');
  if (!d.activities.length) p.push('Add at least one VaayuTrip activity.');
  return p;
}

/** The display view of a package, used by package pages, quotes and agent websites (partials/package-full). */
function present(pkg, d, acts = activityMap(d.activities.map((a) => a.id))) {
  const dayCount = Math.max(d.days.length, ...d.activities.map((a) => a.day), 0);
  const days = [...Array(dayCount)].map((_, i) => ({
    ...(d.days[i] || { title: `Day ${i + 1}`, description: '', meals: {}, overnight: '' }),
    activities: d.activities.filter((a) => a.day === i + 1 && acts.has(a.id)).map((a) => presentActivity(acts.get(a.id))),
  }));
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
    stays: d.stays.map(({ price, cost, ...s }) => s),
    flights: [],
    inclusions: lines(pkg.inclusions),
    exclusions: lines(pkg.exclusions),
    policies: d.policies,
  };
}

/** Everything a quote needs to show the package to the customer, frozen at quote time. */
function snapshot(pkg, d, calc, acts) {
  return { ...present(pkg, d, acts), party: calc.options };
}

module.exports = {
  MEAL_PLANS, STAY_TYPES, EXTRA_TYPES,
  emptyDetails, parseDetails, detailsFromForm, normalizeParty, calcPackage, priceLines, fromPrice, publishProblems, present, snapshot,
};
