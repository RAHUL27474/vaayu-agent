/**
 * Activities supplied by VaayuTrip: tours, tickets and experiences at agent net rates.
 * Agents add them to quotes directly or build them into their own packages.
 *
 * Pricing: per_person activities have a net price per adult and per child (2-11 years,
 * empty = adult price; infants are free). per_group activities (private tours, boats,
 * vehicles) have one net price per group of up to group_size guests.
 */
const { one, all } = require('./db');
const { round2 } = require('./util');

const CATEGORIES = [
  'Sightseeing tour', 'Attraction tickets', 'Adventure', 'Water sports', 'Culture & heritage',
  'Nature & wildlife', 'Food & nightlife', 'Shows & experiences', 'Day trip', 'Cruise',
];

const str = (v) => String(v ?? '').trim();
const money = (v) => Math.max(0, round2(parseFloat(v) || 0));
const lines = (v) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

const isInternational = (a) => Boolean(a && a.country && a.country !== 'India');
const childNet = (a) => (a.net_child == null ? a.net_adult : a.net_child);

/** Fields from the admin activity form. */
function activityFromForm(b) {
  const basis = b.price_basis === 'per_group' ? 'per_group' : 'per_person';
  const child = str(b.net_child);
  return {
    title: str(b.title),
    city: str(b.city),
    country: str(b.country) || 'India',
    category: CATEGORIES.includes(b.category) ? b.category : CATEGORIES[0],
    duration: str(b.duration) || null,
    summary: str(b.summary) || null,
    description: str(b.description) || null,
    highlights: str(b.highlights) || null,
    inclusions: str(b.inclusions) || null,
    exclusions: str(b.exclusions) || null,
    pickup: str(b.pickup) || null,
    timing: str(b.timing) || null,
    cancellation: str(b.cancellation) || null,
    image_url: str(b.image_url) || null,
    price_basis: basis,
    group_size: basis === 'per_group' ? Math.max(1, Math.round(parseFloat(b.group_size) || 1)) : null,
    net_adult: money(b.net_adult),
    net_child: basis === 'per_person' && child !== '' ? money(child) : null,
  };
}

function publishProblems(a) {
  const p = [];
  if (!a.title || !a.city) p.push('Add a title and city.');
  if (!(a.net_adult > 0)) p.push(a.price_basis === 'per_group' ? 'Set the net price per group.' : 'Set the net price per adult.');
  if (!a.duration) p.push('Add the duration.');
  return p;
}

/**
 * Quote lines (at VaayuTrip net) for a party. Each line: { type, title, description, net, qty, activityId }.
 * prefix is added to the title, e.g. "Day 2: ".
 */
function activityLines(a, { adults = 2, children = 0 } = {}, prefix = '') {
  const desc = [a.city, a.duration, a.pickup].filter(Boolean).join(' · ');
  const base = { type: 'activity', activityId: a.id };
  if (a.price_basis === 'per_group') {
    const pax = adults + children;
    const groups = Math.max(1, Math.ceil(pax / (a.group_size || 1)));
    return [{ ...base, title: `${prefix}${a.title} (private, up to ${a.group_size} guests)`, description: desc, net: a.net_adult, qty: groups }];
  }
  const out = [];
  if (adults > 0) out.push({ ...base, title: `${prefix}${a.title}: adult`, description: desc, net: a.net_adult, qty: adults });
  if (children > 0 && childNet(a) > 0) out.push({ ...base, title: `${prefix}${a.title}: child`, description: desc, net: childNet(a), qty: children });
  return out;
}

/** Net per person for two adults, as shown on catalogue cards. */
function netPerPerson(a) {
  return a.price_basis === 'per_group' ? round2(a.net_adult * Math.ceil(2 / (a.group_size || 1)) / 2) : a.net_adult;
}

/** Selling price per person for two adults, using the agency's default markup (a flat markup is per booking). */
function sellPerPerson(agency, a) {
  const net = netPerPerson(a);
  return round2(agency.markup_type === 'flat' ? net + agency.markup_value / 2 : net * (1 + agency.markup_value / 100));
}

/** The facts a customer sees about an activity inside an itinerary (no prices). */
function presentActivity(a) {
  return { id: a.id, title: a.title, city: a.city, category: a.category, duration: a.duration, pickup: a.pickup, summary: a.summary };
}

const published = (id) => one("SELECT * FROM activities WHERE id = ? AND status = 'published'", id);

/** Published activities by id, for the given ids. */
function activityMap(ids) {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return new Map();
  return new Map(all(`SELECT * FROM activities WHERE status = 'published' AND id IN (${unique.map(() => '?').join(', ')})`, ...unique).map((a) => [a.id, a]));
}

module.exports = {
  CATEGORIES, activityFromForm, publishProblems, activityLines, netPerPerson, sellPerPerson, presentActivity, activityMap, published,
  isInternational, childNet, lines,
};
