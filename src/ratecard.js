/**
 * Reads the VaayuTrip rate card workbook (tabs Hotels, Activities, Transfers and an optional
 * Currency tab) into backend product fields, ready for productFromForm.
 *
 *   Hotels      wide format: Group Name / Location / Name / Star / Room, then one column per
 *               season × meal plan (season name row, date row, meal plan row), then Currency.
 *               Blank Location / Name / Star / Currency mean "same as above". A Name of "Extras"
 *               starts the extra-bed block of the hotel above. One product per room × season × meal plan.
 *   Activities  City, Basis (PVT/SIC/Per Person/Per Group), Activity Name, Operating Time, Category,
 *               Adult Cost, Child Cost (7-11), Child Cost (4-6), Notes, Currency.
 *   Transfers   City, Transfer / Route, Type, Vehicle, Basis (Per Vehicle/Per Person/Per KM), Cost,
 *               Child Cost, Notes, Currency, USD (used instead of Cost when filled).
 *   Currency    code → rate to AED. Costs in another currency are converted to INR through AED.
 */
const { KINDS, MEAL_PLANS, PRODUCT_COUNTRIES, DESTINATIONS } = require('./products');

const str = (v) => String(v ?? '').trim();
const amount = (v) => {
  const s = str(v).replace(/,/g, '');
  return s === '' || !Number.isFinite(Number(s)) ? null : Number(s);
};
const fmt = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

const sheetNamed = (book, name) => book.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
/** True when the workbook looks like a rate card rather than the plain import template. */
const isRateCard = (book) => ['hotels', 'activities', 'transfers'].some((n) => sheetNamed(book, n));

/** Index of the first header row (a row containing a cell matching `test`) and a column finder for it. */
function header(rows, test) {
  const at = rows.findIndex((r) => r.some((c) => test.test(str(c))));
  if (at < 0) return null;
  const cells = rows[at].map((c) => str(c).toLowerCase());
  const col = (re) => cells.findIndex((c) => re.test(c));
  return { at, col };
}

/** Currency code → INR per unit, from the Currency tab (rates to AED). INR is always 1. */
function currencyRates(book) {
  const toAed = {};
  for (const r of (sheetNamed(book, 'currency') || { rows: [] }).rows) {
    const code = str(r[0]).toUpperCase();
    const rate = amount(r[1]);
    if (/^[A-Z]{3}$/.test(code) && rate > 0) toAed[code] = rate;
  }
  return { toAed, inr: (cost, cur) => {
    const code = str(cur).toUpperCase() || 'INR';
    if (code === 'INR') return { value: Math.round(cost) };
    const rate = code === 'AED' ? 1 : toAed[code];
    if (!rate) return { error: `there is no ${code} rate on the Currency tab` };
    if (!toAed.INR) return { error: `add INR with its rate to AED on the Currency tab so ${code} can be converted to ₹` };
    return { value: Math.round((cost * rate) / toAed.INR) };
  } };
}

/**
 * Country of a city: the last part of a "City, State, Country" location if it is one of ours,
 * a city we already have inventory in, a destination named after the city (Dubai, Bali), or the
 * fallback chosen on the upload screen.
 */
function countryResolver(knownCities, fallback) {
  const aliases = { uae: 'United Arab Emirates', uk: 'United Kingdom', 'great britain': 'United Kingdom', england: 'United Kingdom' };
  const pick = (name) => {
    const n = str(name).toLowerCase();
    return PRODUCT_COUNTRIES.find((c) => c.toLowerCase() === n) || aliases[n] || null;
  };
  return (city, location) => {
    const parts = str(location).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const c = pick(parts[parts.length - 1]);
      return c ? { country: c } : { error: `"${parts[parts.length - 1]}" is not one of our destination countries` };
    }
    const key = str(city).toLowerCase();
    if (knownCities[key]) return { country: knownCities[key] };
    const dest = Object.keys(DESTINATIONS).find((d) => d.toLowerCase() === key && DESTINATIONS[d].length === 1);
    if (dest) return { country: DESTINATIONS[dest][0] };
    if (pick(city)) return { country: pick(city) };
    if (fallback) return { country: fallback };
    return { error: `we don't know which country ${city} is in; choose a country on the upload screen` };
  };
}

/** Vehicle / group capacity from text like "Up to 3 pax", "10 pax", "7 seater". */
const capacityFrom = (...texts) => {
  for (const t of texts) {
    const m = str(t).match(/(?:up to\s*)?(\d{1,3})\s*(?:pax|people|persons|guests|seater|seats)\b/i) || str(t).match(/up to\s*(\d{1,3})/i);
    if (m) return Number(m[1]);
  }
  return null;
};
const durationFrom = (text) => {
  const m = str(text).match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)\b/i);
  return m ? `${m[1]} hours` : null;
};

function activityCategory(text) {
  const t = str(text).toLowerCase();
  const map = [[/ticket|entry|admission/, 'Attraction tickets'], [/water|snorkel|dive|scuba/, 'Water sports'], [/cruise|dhow/, 'Cruise'],
    [/adventure|safari|quad|zip/, 'Adventure'], [/culture|heritage|temple|museum/, 'Culture & heritage'], [/nature|wildlife|zoo|park/, 'Nature & wildlife'],
    [/food|dinner|night|bar/, 'Food & nightlife'], [/day trip|excursion/, 'Day trip'], [/show|experience/, 'Shows & experiences'], [/tour|sightseeing|city/, 'Sightseeing tour']];
  return (map.find(([re]) => re.test(t)) || [null, KINDS.activity.categories[0]])[1];
}
function transferCategory(text) {
  const t = str(text).toLowerCase();
  if (/airport/.test(t)) return 'Airport transfer';
  if (/intercity|km|route/.test(t)) return 'Intercity transfer';
  if (/rail|train/.test(t)) return 'Rail';
  if (/ferry|boat|speedboat/.test(t)) return 'Ferry';
  return 'Car with driver';
}

function readHotels(sheet, ctx) {
  const rows = sheet.rows;
  const h = header(rows, /^room$/i);
  if (!h) return;
  const cols = { group: h.col(/^group/), location: h.col(/^location/), name: h.col(/^(hotel )?name/), star: h.col(/^star/), room: h.col(/^room$/) };
  // Meal plan row: the first row under the header with a CP/MAP/... cell.
  const mealAt = rows.findIndex((r, i) => i > h.at && r.some((c) => MEAL_PLANS[str(c).toUpperCase()]));
  if (mealAt < 0) return ctx.skip('Hotels', h.at + 1, 'no meal plan row (CP / MAP …) under the header.');
  const meals = rows[mealAt];
  const currencyCol = meals.findIndex((c) => /currency/i.test(str(c)));
  const rateCols = [];
  let season = '';
  let dates = '';
  for (let j = cols.room + 1; j < meals.length; j++) {
    if (str(rows[h.at][j])) season = str(rows[h.at][j]);
    for (let i = h.at + 1; i < mealAt; i++) if (str(rows[i][j])) dates = str(rows[i][j]);
    const meal = str(meals[j]).toUpperCase();
    if (MEAL_PLANS[meal]) rateCols.push({ j, meal, season: [season, dates].filter(Boolean).join(': ') });
  }

  const last = { location: '', name: '', star: '', currency: '' };
  const hotels = [];
  let hotel = null;
  for (let i = mealAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    for (const k of ['location', 'name', 'star']) if (cols[k] >= 0 && str(r[cols[k]])) last[k] = str(r[cols[k]]);
    if (currencyCol >= 0 && str(r[currencyCol])) last.currency = str(r[currencyCol]);
    const room = str(r[cols.room]);
    if (!room) continue;
    if (/^extras?$/i.test(last.name)) {
      if (!hotel) { ctx.skip('Hotels', line, 'extras row without a hotel above it.'); continue; }
      for (const rc of rateCols) {
        const cost = amount(r[rc.j]);
        if (cost == null) continue;
        const inr = ctx.money.inr(cost, last.currency);
        if (inr.error) { ctx.skip('Hotels', line, `${room}: ${inr.error}.`); continue; }
        hotel.extras.push({ season: rc.season, meal: rc.meal, text: `${room}: ${fmt(inr.value)} per night` });
      }
      continue;
    }
    const city = last.location.split(',')[0].trim();
    if (!hotel || hotel.name !== last.name || hotel.location !== last.location) hotels.push(hotel = { name: last.name, location: last.location, extras: [], items: [] });
    const where = ctx.country(city, last.location);
    if (where.error) { ctx.skip('Hotels', line, `${where.error}.`, last.name); continue; }
    const occupancy = room.match(/\((\d)\s*P\)/i);
    for (const rc of rateCols) {
      const cost = amount(r[rc.j]);
      if (cost == null) continue;
      const inr = ctx.money.inr(cost, last.currency);
      if (inr.error) { ctx.skip('Hotels', line, `${last.name} ${room}: ${inr.error}.`); continue; }
      const item = {
        kind: 'hotel', title: last.name, city, country: where.country, category: 'Hotel', price_basis: 'per_room_night', net_adult: inr.value,
        summary: rc.season ? `Rate valid ${rc.season}` : null,
        d_stars: last.star, d_room: room, d_mealPlan: rc.meal, d_area: last.location, d_maxGuests: occupancy ? occupancy[1] : '',
        d_season: rc.season, source: `${cost} ${str(last.currency).toUpperCase() || 'INR'}`,
      };
      hotel.items.push(item);
      ctx.add(item, line);
    }
  }
  // Extras apply to every room of their hotel with the same season and meal plan.
  for (const ht of hotels) {
    for (const item of ht.items) {
      const extras = ht.extras.filter((x) => x.season === item.d_season && x.meal === item.d_mealPlan).map((x) => x.text);
      if (extras.length) item.description = `Extras: ${extras.join('; ')}.`;
    }
  }
}

function readActivities(sheet, ctx) {
  const rows = sheet.rows;
  const h = header(rows, /activity name/i);
  if (!h) return;
  const c = { city: h.col(/^city/), basis: h.col(/^basis/), name: h.col(/activity name/), time: h.col(/operating|timing|time/), category: h.col(/^category/),
    adult: h.col(/adult/), child: h.col(/child.*7|child.*1\.4|^child cost/), young: h.col(/child.*4\s*-\s*6/), notes: h.col(/^notes?/), currency: h.col(/currency/) };
  for (let i = h.at + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const get = (k) => (c[k] >= 0 ? str(r[c[k]]) : '');
    const name = get('name');
    const city = get('city');
    if (!name && !city) continue;
    if (!name || !city) { ctx.skip('Activities', line, 'City and Activity Name are required.'); continue; }
    const where = ctx.country(city, '');
    if (where.error) { ctx.skip('Activities', line, `${where.error}.`, name); continue; }
    const adult = amount(get('adult'));
    if (adult == null) { ctx.skip('Activities', line, `${name}: Adult Cost is required.`); continue; }
    const cur = get('currency');
    const conv = (v) => (v == null ? { value: null } : ctx.money.inr(v, cur));
    const [a, ch, yg] = [conv(adult), conv(amount(get('child'))), conv(c.young >= 0 && c.young !== c.child ? amount(get('young')) : null)];
    const err = [a, ch, yg].find((x) => x.error);
    if (err) { ctx.skip('Activities', line, `${name}: ${err.error}.`); continue; }
    const basis = get('basis');
    const perGroup = /group|vehicle/i.test(basis);
    const label = /^pvt$/i.test(basis) ? 'Private' : /^sic$/i.test(basis) ? 'Shared, SIC' : '';
    const notes = get('notes');
    const item = {
      kind: 'activity', title: label ? `${name} (${label})` : name, city, country: where.country, category: activityCategory(`${get('category')} ${name}`),
      duration: durationFrom(notes), timing: get('time') || null, summary: notes || null,
      description: yg.value != null ? `Children 4-6 years: ${fmt(yg.value)}.` : null,
      price_basis: perGroup ? 'per_group' : 'per_person', group_size: perGroup ? capacityFrom(notes) : null,
      net_adult: a.value, net_child: perGroup ? null : ch.value, source: `${adult} ${cur.toUpperCase() || 'INR'}`,
    };
    if (perGroup && !item.group_size) ctx.note(`Activities row ${line}: ${name} has no group size in Notes ("Up to N pax"); set it before publishing.`);
    ctx.add(item, line);
  }
}

function readTransfers(sheet, ctx) {
  const rows = sheet.rows;
  const h = header(rows, /transfer|route/i);
  if (!h) return;
  const c = { city: h.col(/^city/), route: h.col(/transfer|route/), type: h.col(/^type/), vehicle: h.col(/^vehicle/), basis: h.col(/^basis/),
    cost: h.col(/^cost/), child: h.col(/child/), notes: h.col(/^notes?/), currency: h.col(/currency/), usd: h.col(/^usd$/) };
  for (let i = h.at + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const get = (k) => (c[k] >= 0 ? str(r[c[k]]) : '');
    const route = get('route');
    const city = get('city');
    if (!route && !city) continue;
    if (!route || !city) { ctx.skip('Transfers', line, 'City and Transfer / Route are required.'); continue; }
    const basis = get('basis');
    if (/km/i.test(basis)) { ctx.skip('Transfers', line, `${route}: per-km rates aren't supported yet; enter it as a fixed price per vehicle for a set route.`); continue; }
    const where = ctx.country(city, '');
    if (where.error) { ctx.skip('Transfers', line, `${where.error}.`, route); continue; }
    const usd = amount(get('usd'));
    const cost = usd ?? amount(get('cost'));
    const cur = usd != null ? 'USD' : get('currency');
    if (cost == null) { ctx.skip('Transfers', line, `${route}: Cost is required.`); continue; }
    const net = ctx.money.inr(cost, cur);
    const child = amount(get('child')) == null ? { value: null } : ctx.money.inr(amount(get('child')), cur);
    const err = [net, child].find((x) => x.error);
    if (err) { ctx.skip('Transfers', line, `${route}: ${err.error}.`); continue; }
    const perPerson = /person|pax/i.test(basis) || (!basis && /sic|shared/i.test(get('type')));
    const vehicle = [get('type'), get('vehicle')].filter(Boolean).join(' ');
    const notes = get('notes');
    const item = {
      kind: 'transfer', title: vehicle ? `${route} (${vehicle})` : route, city, country: where.country, category: transferCategory(route),
      summary: notes || null, price_basis: perPerson ? 'per_person' : 'per_group', group_size: perPerson ? null : capacityFrom(notes, get('type'), get('vehicle')),
      net_adult: net.value, net_child: perPerson ? child.value : null, d_vehicle: vehicle, source: `${cost} ${cur.toUpperCase() || 'INR'}`,
    };
    if (!perPerson && !item.group_size) ctx.note(`Transfers row ${line}: ${route} has no vehicle capacity in Notes ("Up to N pax"); set it before publishing.`);
    ctx.add(item, line);
  }
}

/**
 * Items (product form fields plus `line` and `source`) from a rate card workbook.
 * knownCities: lower-case city → country from existing inventory. fallbackCountry: chosen on the upload screen.
 */
function readRateCard(book, { knownCities = {}, fallbackCountry = '' } = {}) {
  const items = [];
  const skipped = [];
  const notes = [];
  const ctx = {
    items,
    money: currencyRates(book),
    country: countryResolver(knownCities, PRODUCT_COUNTRIES.includes(fallbackCountry) ? fallbackCountry : ''),
    add: (item, line) => { item.line = line; items.push(item); },
    skip: (tab, line, why, subject) => skipped.push({ tab, line, why, subject }),
    note: (text) => notes.push(text),
  };
  for (const [name, read] of [['hotels', readHotels], ['activities', readActivities], ['transfers', readTransfers]]) {
    const sheet = sheetNamed(book, name);
    if (sheet) read(sheet, ctx);
  }
  // Rows skipped for the same reason are reported once: "Hotels rows 9, 10, 11 (Golden Star, White Yak): …".
  const groups = new Map();
  for (const s of skipped) {
    const key = `${s.tab}\n${s.why}`;
    if (!groups.has(key)) groups.set(key, { ...s, lines: [], subjects: new Set() });
    groups.get(key).lines.push(s.line);
    if (s.subject) groups.get(key).subjects.add(s.subject);
  }
  const messages = [...groups.values()].map((g) => `${g.tab} row${g.lines.length > 1 ? 's' : ''} ${g.lines.join(', ')}${g.subjects.size ? ` (${[...g.subjects].join(', ')})` : ''}: ${g.why}`);
  return { items, skipped: messages, skippedRows: skipped.length, notes };
}

module.exports = { readRateCard, isRateCard };
