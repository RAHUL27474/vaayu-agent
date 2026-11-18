/**
 * VaayuTrip's inventory: activities, hotels, airfares, transfers, visas and travel insurance in its
 * destinations (Dubai, Bali, Vietnam, Cambodia, the UK and Europe). The backend team enters it in the
 * backend portal; agents add items to quotes or build their own packages from them. VaayuTrip sells
 * no packages of its own.
 *
 * Pricing (all net to the agent, in INR):
 *   per_person      net per adult, per child 2-11 (empty = adult price) and per infant (empty = free)
 *   per_group       one net price per group/vehicle of up to group_size guests (private tours, cars, boats)
 *   per_room_night  hotels: net per room per night
 * Kind-specific facts (hotel room and meal plan, flight schedule, visa processing time…) live in details (JSON).
 *
 * VaayuTrip's margin: the backend team enters what VaayuTrip pays (cost_*). Agents see and pay net_* =
 * cost + VaayuTrip's margin for that kind of service (admin settings; default hotels 3%, activities and
 * transfers 5%), rounded to whole rupees. net_* is stored, so everything agent-facing reads it directly.
 */
const { one, all, run, getSettings } = require('./db');
const { round2 } = require('./util');
const { kindRates, markupRule } = require('./pricing');

const DESTINATIONS = {
  Dubai: ['United Arab Emirates'],
  Bali: ['Indonesia'],
  Vietnam: ['Vietnam'],
  Cambodia: ['Cambodia'],
  'United Kingdom': ['United Kingdom'],
  Europe: ['France', 'Italy', 'Switzerland', 'Netherlands', 'Spain', 'Austria', 'Germany', 'Czech Republic', 'Belgium', 'Greece', 'Portugal'],
};
const PRODUCT_COUNTRIES = Object.values(DESTINATIONS).flat();
// Travel insurance plans can cover every destination at once.
const ALL_DESTINATIONS = 'All destinations';
const validCountry = (country, kind) => PRODUCT_COUNTRIES.includes(country) || (kind === 'insurance' && country === ALL_DESTINATIONS);
const destinationOf = (country) => Object.keys(DESTINATIONS).find((d) => DESTINATIONS[d].includes(country)) || null;

const MEAL_PLANS = { EP: 'Room only', CP: 'Breakfast', MAP: 'Breakfast & dinner', AP: 'All meals', AI: 'All inclusive' };

/**
 * Each kind: labels, the URL segment agents use (/agent/<path>), allowed price bases, categories,
 * and the kind-specific detail fields shown in the backend form ([key, label, type, options]).
 */
const KINDS = {
  activity: {
    label: 'Activity', plural: 'Activities', path: 'activities', icon: 'ticket', basis: ['per_person', 'per_group'],
    categories: ['Sightseeing tour', 'Attraction tickets', 'Adventure', 'Water sports', 'Culture & heritage', 'Nature & wildlife', 'Food & nightlife', 'Shows & experiences', 'Day trip', 'Cruise'],
    fields: [],
  },
  hotel: {
    label: 'Hotel', plural: 'Hotels', path: 'hotels', icon: 'bed', basis: ['per_room_night'],
    categories: ['Hotel', 'Resort', 'Villa', 'Boutique hotel', 'Apartment'],
    fields: [['stars', 'Stars', 'select', ['3', '4', '5']], ['room', 'Room type', 'text'], ['mealPlan', 'Meal plan', 'select', Object.keys(MEAL_PLANS)],
      ['area', 'Area / address', 'text'], ['maxGuests', 'Max guests per room', 'number']],
  },
  flight: {
    label: 'Airfare', plural: 'Airfares', path: 'flights', icon: 'plane', basis: ['per_person'],
    categories: ['Economy', 'Premium economy', 'Business'],
    fields: [['airline', 'Airline', 'text'], ['flightNo', 'Flight no.', 'text'], ['from', 'From (airport code)', 'text'], ['to', 'To (airport code)', 'text'],
      ['depart', 'Departs', 'time'], ['arrive', 'Arrives', 'time'], ['trip', 'Fare type', 'select', ['oneway', 'return']],
      ['returnFlightNo', 'Return flight no.', 'text'], ['returnDepart', 'Return departs', 'time'], ['returnArrive', 'Return arrives', 'time'],
      ['baggage', 'Baggage', 'text'], ['stops', 'Stops', 'select', ['Non-stop', '1 stop', '2 stops']], ['refundable', 'Refundable', 'select', ['No', 'Yes']]],
  },
  transfer: {
    label: 'Transfer', plural: 'Transfers', path: 'transfers', icon: 'car', basis: ['per_group', 'per_person'],
    categories: ['Airport transfer', 'Intercity transfer', 'Car with driver', 'Rail', 'Ferry'],
    fields: [['vehicle', 'Vehicle / class', 'text'], ['luggage', 'Luggage allowed', 'text']],
  },
  visa: {
    label: 'Visa', plural: 'Visas', path: 'visas', icon: 'passport', basis: ['per_person'],
    categories: ['e-Visa', 'Visa on arrival', 'Sticker visa', 'Visa assistance'],
    fields: [['processing', 'Processing time', 'text'], ['validity', 'Validity / stay', 'text'], ['entries', 'Entries', 'select', ['Single', 'Multiple']],
      ['documents', 'Documents needed', 'textarea']],
  },
  insurance: {
    label: 'Insurance', plural: 'Travel insurance', path: 'insurance', icon: 'shield', basis: ['per_person'],
    categories: ['Basic', 'Standard', 'Premium'],
    fields: [['cover', 'Medical cover', 'text'], ['maxDays', 'Trip length covered', 'text'], ['benefits', 'Other benefits', 'textarea']],
  },
};
const KIND_BY_PATH = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.path, k]));
const BASIS_LABELS = { per_person: 'Per person', per_group: 'Per group / vehicle', per_room_night: 'Per room per night' };

const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, round2(parseFloat(v) || 0));
const lines = (v) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function parseProductDetails(json) {
  try { return json ? JSON.parse(json) : {}; } catch { return {}; }
}

/** Fields from the backend product form, for one kind. */
function productFromForm(b, kind) {
  const cfg = KINDS[kind];
  const basis = cfg.basis.includes(b.price_basis) ? b.price_basis : cfg.basis[0];
  const optional = (v) => (str(v) === '' ? null : money(v));
  const details = {};
  for (const [key, , type] of cfg.fields) {
    const v = str(b[`d_${key}`]);
    if (v !== '') details[key] = type === 'number' ? Math.max(0, Math.round(Number(v) || 0)) : key === 'from' || key === 'to' ? v.toUpperCase().slice(0, 3) : v;
  }
  return {
    kind,
    title: str(b.title),
    city: str(b.city),
    country: validCountry(b.country, kind) ? b.country : '',
    category: cfg.categories.includes(b.category) ? b.category : cfg.categories[0],
    duration: str(b.duration) || null,
    summary: str(b.summary) || null,
    description: str(b.description) || null,
    highlights: str(b.highlights) || null,
    inclusions: str(b.inclusions) || null,
    exclusions: str(b.exclusions) || null,
    pickup: str(b.pickup) || null,
    timing: str(b.timing) || null,
    cancellation: str(b.cancellation) || null,
    price_basis: basis,
    group_size: basis === 'per_group' ? Math.max(1, Math.round(parseFloat(b.group_size) || 1)) : null,
    net_adult: money(b.net_adult),
    net_child: basis === 'per_person' ? optional(b.net_child) : null,
    net_infant: basis === 'per_person' ? optional(b.net_infant) : null,
    details: JSON.stringify(details),
  };
}

/** Problems that stop a product from being published to agents. */
function publishProblems(p) {
  const d = parseProductDetails(p.details);
  const out = [];
  if (!p.title || !p.city) out.push('Add a title and city.');
  if (!validCountry(p.country, p.kind)) out.push(`Choose a country in one of our destinations (${Object.keys(DESTINATIONS).join(', ')}).`);
  if (!(p.net_adult > 0)) out.push('Set the net price.');
  if (p.kind === 'activity' && !p.duration) out.push('Add the duration.');
  if (p.kind === 'hotel' && !d.room) out.push('Add the room type.');
  if (p.kind === 'flight' && !(d.airline && d.from && d.to)) out.push('Add the airline and the from/to airports.');
  return out;
}

const childNet = (p) => (p.net_child == null ? p.net_adult : p.net_child);

/** One-line description of a product for quotes and cards. */
function describe(p) {
  const d = parseProductDetails(p.details);
  if (p.kind === 'hotel') return [`${d.stars ? `${d.stars}★ ` : ''}${d.room || 'Room'}`, MEAL_PLANS[d.mealPlan] || d.mealPlan, p.city].filter(Boolean).join(' · ');
  if (p.kind === 'flight') {
    const out = `${d.airline || ''} ${d.flightNo || ''} ${d.from || ''}→${d.to || ''} ${d.depart || ''}`.replace(/\s+/g, ' ').trim();
    const back = d.trip === 'return' ? `, return ${d.returnFlightNo || ''} ${d.to || ''}→${d.from || ''} ${d.returnDepart || ''}`.replace(/\s+/g, ' ') : '';
    return [`${out}${back}`, p.category, d.baggage].filter(Boolean).join(' · ');
  }
  if (p.kind === 'visa') return [p.category, d.validity, d.processing && `processing ${d.processing}`].filter(Boolean).join(' · ');
  if (p.kind === 'insurance') return [d.cover, d.maxDays].filter(Boolean).join(' · ');
  if (p.kind === 'transfer') return [d.vehicle, p.city].filter(Boolean).join(' · ');
  return [p.city, p.duration, p.pickup].filter(Boolean).join(' · ');
}

/**
 * Quote lines (at VaayuTrip net) for a party { adults, children, infants, rooms, nights }.
 * Each line: { type, title, description, net, qty, productId }. prefix goes before the title, e.g. "Day 2: ".
 */
// ---------- seasons and sold-out dates ----------
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const listOf = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const covers = (r, date) => r.from <= date && date <= r.to;
/** The season (with its surcharge %) a travel date falls in, if any. */
const seasonOn = (p, date) => (date ? listOf(p.seasons).find((s) => covers(s, date)) || null : null);
/** The sold-out range a travel date falls in, if any. */
const soldOutOn = (p, date) => (date ? listOf(p.blackouts).find((s) => covers(s, date)) || null : null);
/** Season and sold-out rows from the backend form (up to 6 of each); bad rows are dropped. */
function seasonsFromForm(b) {
  const seasons = [];
  const blackouts = [];
  for (let i = 0; i < 6; i++) {
    const [from, to] = [str(b[`s_from_${i}`]), str(b[`s_to_${i}`])];
    const pct = Math.round(parseFloat(b[`s_pct_${i}`]) * 10) / 10;
    if (ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to && Number.isFinite(pct) && pct !== 0 && pct >= -50 && pct <= 300) {
      seasons.push({ from, to, pct, label: str(b[`s_label_${i}`]).slice(0, 40) || (pct > 0 ? 'Peak season' : 'Offer') });
    }
    const [bf, bt] = [str(b[`b_from_${i}`]), str(b[`b_to_${i}`])];
    if (ISO_DAY.test(bf) && ISO_DAY.test(bt) && bf <= bt) blackouts.push({ from: bf, to: bt, label: str(b[`b_label_${i}`]).slice(0, 40) || 'Sold out' });
  }
  const byFrom = (a, c) => a.from.localeCompare(c.from);
  return { seasons: seasons.length ? JSON.stringify(seasons.sort(byFrom)) : null, blackouts: blackouts.length ? JSON.stringify(blackouts.sort(byFrom)) : null };
}

/**
 * Lines for a product and party. With party.date (travel date, YYYY-MM-DD) the season surcharge applies and lines
 * on a sold-out date carry soldOut: { from, to, label }.
 */
function productLines(p, party = {}, prefix = '') {
  const adults = party.adults ?? 2;
  const children = party.children || 0;
  const infants = party.infants || 0;
  const date = ISO_DAY.test(party.date || '') ? party.date : null;
  const season = seasonOn(p, date);
  const closed = soldOutOn(p, date);
  const f = season ? 1 + season.pct / 100 : 1;
  const adj = (n) => (n == null ? n : Math.round(n * f));
  const note = season ? ` · ${season.label} ${season.pct > 0 ? '+' : ''}${season.pct}%` : '';
  const base = { type: p.kind, productId: p.id, description: describe(p) + note, ...(closed ? { soldOut: closed } : {}) };
  p = season ? { ...p, net_adult: adj(p.net_adult), net_child: adj(p.net_child), net_infant: adj(p.net_infant) } : p;
  if (p.price_basis === 'per_room_night') {
    const rooms = Math.max(1, party.rooms || Math.ceil(adults / 2));
    const nights = Math.max(1, party.nights || 1);
    return [{ ...base, title: `${prefix}${p.title}: ${nights} night${nights > 1 ? 's' : ''} × ${rooms} room${rooms > 1 ? 's' : ''}`, net: p.net_adult, qty: rooms * nights }];
  }
  if (p.price_basis === 'per_group') {
    const groups = Math.max(1, Math.ceil((adults + children) / (p.group_size || 1)));
    return [{ ...base, title: `${prefix}${p.title} (private, up to ${p.group_size} guests)`, net: p.net_adult, qty: groups }];
  }
  const out = [];
  if (adults > 0) out.push({ ...base, title: `${prefix}${p.title}: adult`, net: p.net_adult, qty: adults });
  if (children > 0 && childNet(p) > 0) out.push({ ...base, title: `${prefix}${p.title}: child`, net: childNet(p), qty: children });
  if (infants > 0 && p.net_infant > 0) out.push({ ...base, title: `${prefix}${p.title}: infant`, net: p.net_infant, qty: infants });
  return out;
}

const UNIT_LABELS = { per_person: 'per adult', per_room_night: 'per room / night' };
/** Catalogue card price: net per unit and what the agent earns with their default markup. */
function cardPrice(agency, p) {
  const unit = p.price_basis === 'per_group' ? `per group of ${p.group_size}` : UNIT_LABELS[p.price_basis];
  const rule = markupRule(agency, p.kind);
  if (rule.type === 'flat') return { net: p.net_adult, unit, earn: rule.value, earnLabel: 'You earn per booking' };
  return { net: p.net_adult, unit, earn: round2((p.net_adult * rule.value) / 100), earnLabel: `You earn ${unit}` };
}

/** What a customer sees about a product inside an itinerary (no prices). */
function presentProduct(p, entry = {}) {
  return {
    id: p.id, kind: p.kind, kindLabel: KINDS[p.kind].label, title: p.title, city: p.city, country: p.country,
    category: p.category, duration: p.duration, pickup: p.pickup, summary: p.summary, nights: entry.nights || null,
    details: parseProductDetails(p.details),
  };
}

const publishedProduct = async (id, kind) => await one(
  `SELECT * FROM products WHERE id = ? AND status = 'published'${kind ? ' AND kind = ?' : ''}`, ...(kind ? [id, kind] : [id]),
);

/** Published products by id, for the given ids. */
async function productMap(ids) {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return new Map();
  return new Map((await all(`SELECT * FROM products WHERE status = 'published' AND id IN (${unique.map(() => '?').join(', ')})`, ...unique)).map((p) => [p.id, p]));
}

const markupNumber = (v) => {
  const n = Number(String(v ?? '').trim());
  return String(v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.min(1e7, Math.round(n * 100) / 100) : null;
};

/** Agent settings form → per-service defaults (markup_type_<kind> % or ₹, markup_<kind> value; blank = overall default). */
function kindMarkupsFromForm(b) {
  const rates = {};
  for (const k of Object.keys(KINDS)) {
    const value = markupNumber(b[`markup_${k}`]);
    if (value === null) continue;
    rates[k] = { type: b[`markup_type_${k}`] === 'flat' ? 'flat' : 'percent', value: b[`markup_type_${k}`] === 'flat' ? value : Math.min(500, value) };
  }
  return Object.keys(rates).length ? JSON.stringify(rates) : null;
}

/**
 * Quote form → the quote's per-service markups. A ticked "use my default" box (use_default_<kind>) takes the
 * agency's current default for that service; unticked, the agent's own % or ₹ is stored as custom.
 */
function quoteKindMarkupsFromForm(b, agency) {
  const defaults = kindRates(agency);
  const rates = {};
  for (const k of Object.keys(KINDS)) {
    const own = markupNumber(b[`markup_${k}`]);
    if (!b[`use_default_${k}`] && own !== null) {
      rates[k] = { type: b[`markup_type_${k}`] === 'flat' ? 'flat' : 'percent', value: own, custom: true };
    } else if (defaults[k]) {
      rates[k] = { type: defaults[k].type, value: defaults[k].value };
    }
  }
  return Object.keys(rates).length ? JSON.stringify(rates) : null;
}
const kindMarkups = kindRates;

// ---------- VaayuTrip's margin ----------

const DEFAULT_MARGINS = { hotel: 3, activity: 5, transfer: 5, flight: 0, visa: 0, insurance: 0 };
const marginKey = (kind) => `margin_${kind}`;

/** VaayuTrip's margin in % for a kind of service. */
function marginPct(kind, settings) {
  const v = parseFloat(settings[marginKey(kind)]);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MARGINS[kind] ?? 0;
}
const withMargin = (cost, pct) => (cost == null ? null : Math.round(cost * (1 + pct / 100)));

const TIERS = { standard: 'Standard', silver: 'Silver', gold: 'Gold' };
/** Percentage points of VaayuTrip's margin an agency's tier saves it (0 for standard). */
function tierDiscount(agency, settings) {
  const t = agency && agency.rate_tier;
  if (t !== 'silver' && t !== 'gold') return 0;
  const v = parseFloat(settings[`tier_${t}_pct`]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
/**
 * A product priced for an agency's tier: net = cost × (1 + (margin − tier discount)). Products without a stored
 * cost, and standard agencies, keep the published net.
 */
function tierPrices(agency, p, settings) {
  const d = settings ? tierDiscount(agency, settings) : 0;
  if (!d || !p || p.cost_adult == null) return p;
  const pct = Math.max(0, marginPct(p.kind, settings) - d);
  return { ...p, net_adult: withMargin(p.cost_adult, pct), net_child: withMargin(p.cost_child, pct), net_infant: withMargin(p.cost_infant, pct) };
}

/** Product fields from the backend form (net_* = what VaayuTrip pays) → stored fields: cost_* and agents' net_*. */
function priceForAgents(p, settings) {
  const pct = marginPct(p.kind, settings);
  return {
    ...p,
    cost_adult: p.net_adult, cost_child: p.net_child, cost_infant: p.net_infant,
    net_adult: withMargin(p.net_adult, pct), net_child: withMargin(p.net_child, pct), net_infant: withMargin(p.net_infant, pct),
  };
}

/** Recomputes agents' prices from costs, for one kind or all (after a margin change). */
async function repriceProducts(kind = null) {
  const settings = await getSettings();
  for (const k of kind ? [kind] : Object.keys(KINDS)) {
    const f = 1 + marginPct(k, settings) / 100;
    await run(
      `UPDATE products SET net_adult = ROUND(cost_adult * ?), net_child = ROUND(cost_child * ?), net_infant = ROUND(cost_infant * ?)
       WHERE kind = ? AND cost_adult IS NOT NULL`, f, f, f, k,
    );
  }
}

/** One-time move for inventory entered before margins existed: its prices become costs, agents' prices get the margin. */
async function ensureProductCosts() {
  const moved = await run('UPDATE products SET cost_adult = net_adult, cost_child = net_child, cost_infant = net_infant WHERE cost_adult IS NULL');
  if (moved.changes) await repriceProducts();
  return moved.changes;
}

module.exports = {
  DEFAULT_MARGINS, marginPct, kindMarkupsFromForm, quoteKindMarkupsFromForm, kindMarkups, priceForAgents, repriceProducts, ensureProductCosts,
  DESTINATIONS, PRODUCT_COUNTRIES, ALL_DESTINATIONS, MEAL_PLANS, KINDS, KIND_BY_PATH, BASIS_LABELS,
  seasonOn, soldOutOn, seasonsFromForm, listOf, TIERS, tierDiscount, tierPrices,
  destinationOf, parseProductDetails, productFromForm, publishProblems, describe, productLines, cardPrice, presentProduct,
  publishedProduct, productMap, childNet, lines,
};
