/**
 * Detailed holiday packages: structure, form parsing and price calculation.
 *
 * A package's details are stored as one JSON document (packages.details):
 *   route        [{ city, nights }]
 *   highlights   [string]
 *   gallery      [url]
 *   days         [{ title, description, meals: { b, l, d }, overnight, optional }]
 *   stays        [{ category, city, hotel, stars, type, room, mealPlan, nights }]
 *   flights      [{ leg, day, airline, flightNo, from, to, depart, arrive, cabin, baggage }]
 *   flightFares  { adult, child, infant }       net per person for all flight legs together
 *   flightsDefault  true when quotes should include flights unless the agent removes them
 *   rates        [{ category, from, to, twin, triple, single, cwb, cnb, infant }]
 *                net land cost per person (hotels, transfers, sightseeing) for a date range
 *   addons       [{ type, title, description, basis: per_person | per_booking, optional, net }]
 *   departures   [{ date, seats, booked }]   only for fixed-departure packages
 *   policies     { advancePercent, balanceDays, payment, cancellation: [{ days, percent }], child, notes, terms }
 */
const { round2 } = require('./util');

const CATEGORIES = ['Standard', 'Deluxe', 'Premium', 'Luxury'];
const MEAL_PLANS = {
  EP: 'Room only (EP)',
  CP: 'Breakfast (CP)',
  MAP: 'Breakfast + dinner (MAP)',
  AP: 'All meals (AP)',
};
const STAY_TYPES = ['Hotel', 'Resort', 'Houseboat', 'Villa', 'Camp', 'Homestay', 'Cruise'];
const ADDON_TYPES = ['activity', 'transfer', 'visa', 'insurance', 'meal', 'other'];
const PACKAGE_TYPES = { customizable: 'Customisable (any date)', fixed: 'Fixed departure (group)' };

const MAX_ADULTS_PER_ROOM = 3;

function emptyDetails() {
  return {
    route: [], highlights: [], gallery: [], days: [], stays: [], flights: [],
    flightFares: { adult: 0, child: 0, infant: 0 }, flightsDefault: false,
    rates: [], addons: [], departures: [],
    policies: { advancePercent: 25, balanceDays: 15, payment: '', cancellation: [], child: '', notes: '', terms: '' },
  };
}

function parseDetails(json) {
  const base = emptyDetails();
  if (!json) return base;
  let d;
  try { d = JSON.parse(json); } catch { return base; }
  return { ...base, ...d, flightFares: { ...base.flightFares, ...d.flightFares }, policies: { ...base.policies, ...d.policies } };
}

// ---------- form parsing ----------

const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, round2(parseFloat(v) || 0));
const int = (v, min = 0) => Math.max(min, Math.round(parseFloat(v) || 0));
const lines = (v) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
// qs turns rows[0][x] into an array, but switches to an object after 20 rows; accept both.
const rows = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const dateOrEmpty = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : '');

/** Builds a details document from the admin package form. */
function detailsFromForm(b) {
  const d = emptyDetails();
  d.highlights = lines(b.highlights);
  d.gallery = lines(b.gallery).filter((u) => /^https?:\/\//i.test(u) || u.startsWith('/'));
  d.route = rows(b.route).map((r) => ({ city: str(r.city), nights: int(r.nights) })).filter((r) => r.city);
  d.days = rows(b.days)
    .map((r) => ({
      title: str(r.title),
      description: str(r.description),
      meals: { b: Boolean(r.b), l: Boolean(r.l), d: Boolean(r.d) },
      overnight: str(r.overnight),
      optional: str(r.optional),
    }))
    .filter((r) => r.title || r.description);
  d.stays = rows(b.stays)
    .map((r) => ({
      category: CATEGORIES.includes(r.category) ? r.category : 'Standard',
      city: str(r.city),
      hotel: str(r.hotel),
      stars: Math.min(5, int(r.stars)),
      type: STAY_TYPES.includes(r.type) ? r.type : 'Hotel',
      room: str(r.room),
      mealPlan: MEAL_PLANS[r.mealPlan] ? r.mealPlan : 'CP',
      nights: int(r.nights, 1),
    }))
    .filter((r) => r.city && r.hotel);
  d.flights = rows(b.flights)
    .map((r) => ({
      leg: ['onward', 'return', 'internal'].includes(r.leg) ? r.leg : 'onward',
      day: int(r.day, 1),
      airline: str(r.airline),
      flightNo: str(r.flightNo).toUpperCase(),
      from: str(r.from).toUpperCase().slice(0, 3),
      to: str(r.to).toUpperCase().slice(0, 3),
      depart: str(r.depart),
      arrive: str(r.arrive),
      cabin: str(r.cabin) || 'Economy',
      baggage: str(r.baggage),
    }))
    .filter((r) => r.from && r.to);
  d.flightFares = { adult: money(b.fare_adult), child: money(b.fare_child), infant: money(b.fare_infant) };
  d.flightsDefault = Boolean(b.flights_default) && d.flightFares.adult > 0;
  d.rates = rows(b.rates)
    .map((r) => ({
      category: CATEGORIES.includes(r.category) ? r.category : 'Standard',
      from: dateOrEmpty(r.from),
      to: dateOrEmpty(r.to),
      twin: money(r.twin), triple: money(r.triple), single: money(r.single),
      cwb: money(r.cwb), cnb: money(r.cnb), infant: money(r.infant),
    }))
    .filter((r) => r.twin > 0);
  d.addons = rows(b.addons)
    .map((r) => ({
      type: ADDON_TYPES.includes(r.type) ? r.type : 'other',
      title: str(r.title),
      description: str(r.description),
      basis: r.basis === 'per_booking' ? 'per_booking' : 'per_person',
      optional: r.optional !== '0',
      net: money(r.net),
    }))
    .filter((r) => r.title);
  d.departures = rows(b.departures)
    .map((r) => ({ date: dateOrEmpty(r.date), seats: int(r.seats), booked: int(r.booked) }))
    .filter((r) => r.date)
    .sort((x, y) => x.date.localeCompare(y.date));
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

/** Problems that stop a package from being published. */
function publishProblems(pkg, d) {
  const p = [];
  if (!d.rates.length) p.push('Add at least one land rate (twin sharing price per person).');
  if (!d.days.length) p.push('Add the day-wise itinerary.');
  if (!d.stays.length) p.push('Add hotels for at least one category.');
  const rateCats = new Set(d.rates.map((r) => r.category));
  for (const c of rateCats) if (!d.stays.some((s) => s.category === c)) p.push(`Add hotels for the ${c} category (it has rates).`);
  if (pkg.package_type === 'fixed' && !d.departures.length) p.push('Fixed-departure packages need at least one departure date.');
  return p;
}

// ---------- pricing ----------

function categoriesOf(d) {
  const have = new Set(d.rates.map((r) => r.category));
  return CATEGORIES.filter((c) => have.has(c));
}

function rateFor(d, category, date) {
  const candidates = d.rates.filter((r) => r.category === category);
  if (!candidates.length) return null;
  if (!date) return candidates.reduce((a, b) => (b.twin < a.twin ? b : a));
  return candidates.find((r) => (!r.from || date >= r.from) && (!r.to || date <= r.to)) || null;
}

/** Lowest per-person net (twin sharing, cheapest category/season, plus flights if included by default). */
function fromPrice(d) {
  if (!d.rates.length) return 0;
  const land = Math.min(...d.rates.map((r) => r.twin));
  const mandatory = d.addons.filter((a) => !a.optional).reduce((s, a) => s + (a.basis === 'per_person' ? a.net : a.net / 2), 0);
  return round2(land + mandatory + (d.flightsDefault ? d.flightFares.adult : 0));
}

/** Splits adults across rooms as evenly as possible: { single, twin, triple } room counts. */
function occupancy(adults, rooms) {
  const out = { single: 0, twin: 0, triple: 0 };
  if (rooms < 1 || adults < rooms) return { ...out, error: 'Each room needs at least one adult.' };
  const base = Math.floor(adults / rooms);
  const extra = adults % rooms;
  const sizes = [...Array(rooms)].map((_, i) => base + (i < extra ? 1 : 0));
  if (sizes.some((n) => n > MAX_ADULTS_PER_ROOM)) return { ...out, error: `Maximum ${MAX_ADULTS_PER_ROOM} adults per room; add a room.` };
  for (const n of sizes) out[{ 1: 'single', 2: 'twin', 3: 'triple' }[n]]++;
  return out;
}

function normalizeOptions(d, o = {}) {
  const cats = categoriesOf(d);
  const opts = {
    category: cats.includes(o.category) ? o.category : cats[0],
    date: dateOrEmpty(o.date),
    rooms: int(o.rooms ?? 1, 1),
    adults: int(o.adults ?? 2, 1),
    cwb: int(o.cwb),
    cnb: int(o.cnb),
    infants: int(o.infants),
    withFlights: o.withFlights === undefined ? d.flightsDefault : Boolean(o.withFlights) && d.flightFares.adult > 0,
    addons: [].concat(o.addons || []).map(Number).filter((i) => Number.isInteger(i) && d.addons[i]),
  };
  return opts;
}

/**
 * Prices a package for a party. Returns quote lines at net cost plus a breakdown.
 * Errors (no rate for the date, too many adults per room, sold-out departure) are returned, not thrown.
 */
function calcPackage(pkg, d, rawOpts) {
  const o = normalizeOptions(d, rawOpts);
  const errors = [];
  const rate = o.category ? rateFor(d, o.category, o.date) : null;
  if (!o.category) errors.push('This package has no rates yet.');
  else if (!rate) errors.push(`No ${o.category} rates for ${o.date}. Pick a date within the package's seasons.`);

  const occ = occupancy(o.adults, o.rooms);
  if (occ.error) errors.push(occ.error);
  if (o.cwb > o.rooms * 2) errors.push('Maximum 2 children with an extra bed per room.');

  let departure = null;
  if (pkg.package_type === 'fixed') {
    departure = d.departures.find((x) => x.date === o.date) || null;
    if (!departure) errors.push('Choose one of the fixed departure dates.');
    else if (departure.seats - departure.booked < o.adults + o.cwb + o.cnb) errors.push(`Only ${departure.seats - departure.booked} seats left on ${o.date}.`);
  }

  const lines = [];
  const stays = d.stays.filter((s) => s.category === o.category);
  const hotelSummary = stays.map((s) => `${s.city}: ${s.hotel} (${s.nights}N, ${s.mealPlan})`).join('; ');
  const pax = o.adults + o.cwb + o.cnb;

  if (rate && !occ.error) {
    const land = (label, unit, qty) => {
      if (qty > 0 && unit > 0) lines.push({ type: 'hotel', title: `${pkg.title} — ${o.category} land package: ${label}`, description: hotelSummary, net: unit, qty });
    };
    land('adult, twin sharing', rate.twin, occ.twin * 2);
    land('adult, triple sharing', rate.triple || rate.twin, occ.triple * 3);
    land('adult, single room', rate.single || rate.twin, occ.single);
    land('child with bed', rate.cwb, o.cwb);
    land('child without bed', rate.cnb, o.cnb);
    land('infant', rate.infant, o.infants);
  }

  if (o.withFlights) {
    const sectors = [...new Set(d.flights.map((f) => `${f.from}→${f.to}`))].join(', ') || 'as per itinerary';
    const desc = d.flights.map((f) => `${f.airline} ${f.flightNo} ${f.from}-${f.to} ${f.depart}`).join(' · ');
    const fare = (label, unit, qty) => {
      if (qty > 0 && unit > 0) lines.push({ type: 'flight', title: `Airfare ${sectors}: ${label}`, description: desc, net: unit, qty });
    };
    fare('adult', d.flightFares.adult, o.adults);
    fare('child', d.flightFares.child || d.flightFares.adult, o.cwb + o.cnb);
    fare('infant', d.flightFares.infant, o.infants);
  }

  d.addons.forEach((a, i) => {
    if (a.optional && !o.addons.includes(i)) return;
    const qty = a.basis === 'per_person' ? pax : 1;
    if (qty > 0) lines.push({ type: a.type, title: a.title, description: [a.description, a.basis === 'per_person' ? 'per person' : 'per booking'].filter(Boolean).join(' · '), net: a.net, qty });
  });

  const net = round2(lines.reduce((s, l) => s + l.net * l.qty, 0));
  return {
    options: o, errors, rate, occupancy: occ, departure, lines, net, pax,
    perPerson: pax ? round2(net / pax) : 0,
    categories: categoriesOf(d),
  };
}

/** The display view of a package for one hotel category (used by package pages and partials/package-full). */
function present(pkg, d, category, withFlights = true) {
  return {
    packageId: pkg.id,
    title: pkg.title,
    destination: pkg.destination,
    nights: pkg.nights,
    packageType: pkg.package_type,
    international: Boolean(pkg.is_international),
    departureCity: pkg.departure_city,
    image: pkg.image_url,
    gallery: d.gallery,
    summary: pkg.summary,
    route: d.route,
    highlights: d.highlights,
    days: d.days,
    stays: d.stays.filter((s) => s.category === (category || categoriesOf(d)[0])),
    flights: withFlights ? d.flights : [],
    inclusions: lines(pkg.inclusions),
    exclusions: lines(pkg.exclusions),
    policies: d.policies,
  };
}

/** Everything a quote needs to show the package to the customer, frozen at quote time. */
function snapshot(pkg, d, calc) {
  return {
    ...present(pkg, d, calc.options.category, calc.options.withFlights),
    party: {
      category: calc.options.category,
      date: calc.options.date,
      rooms: calc.options.rooms,
      adults: calc.options.adults,
      cwb: calc.options.cwb,
      cnb: calc.options.cnb,
      infants: calc.options.infants,
      occupancy: calc.occupancy,
      withFlights: calc.options.withFlights,
    },
  };
}

module.exports = {
  CATEGORIES, MEAL_PLANS, STAY_TYPES, ADDON_TYPES, PACKAGE_TYPES,
  emptyDetails, parseDetails, detailsFromForm, publishProblems, categoriesOf, fromPrice, calcPackage, snapshot, present, occupancy,
};
