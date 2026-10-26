/**
 * Sample inventory for flights, hotels, transfers and insurance.
 *
 * Results are generated deterministically from the search parameters so the same
 * search always returns the same options. Replace these functions with calls to a
 * supplier API (TBO, Amadeus, Hotelbeds, ...) when you have credentials; the rest of
 * the app only depends on the shape of the returned objects.
 */
const crypto = require('crypto');

function rng(seed) {
  let h = crypto.createHash('md5').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 2 ** 32;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const roundTo = (n, step) => Math.round(n / step) * step;

const AIRLINES = [
  { code: '6E', name: 'IndiGo' },
  { code: 'AI', name: 'Air India' },
  { code: 'UK', name: 'Air India Express' },
  { code: 'SG', name: 'SpiceJet' },
  { code: 'QP', name: 'Akasa Air' },
];

const CITIES = {
  DEL: 'Delhi', BOM: 'Mumbai', BLR: 'Bengaluru', MAA: 'Chennai', CCU: 'Kolkata', HYD: 'Hyderabad',
  GOI: 'Goa', COK: 'Kochi', JAI: 'Jaipur', SXR: 'Srinagar', IXL: 'Leh', DPS: 'Bali (Denpasar)',
  DXB: 'Dubai', BKK: 'Bangkok', SIN: 'Singapore', MLE: 'Malé', KTM: 'Kathmandu', HKT: 'Phuket',
};

function searchFlights({ from = 'DEL', to = 'GOI', date = '', adults = 1, children = 0 }) {
  from = String(from).toUpperCase().slice(0, 3);
  to = String(to).toUpperCase().slice(0, 3);
  const pax = Math.max(1, Number(adults) + Number(children));
  const r = rng(`${from}${to}${date}`);
  const international = ['DPS', 'DXB', 'BKK', 'SIN', 'MLE', 'KTM', 'HKT'].includes(to) || ['DPS', 'DXB', 'BKK', 'SIN', 'MLE', 'KTM', 'HKT'].includes(from);
  const base = international ? 14000 : 3800;
  const results = [];
  for (let i = 0; i < 8; i++) {
    const airline = pick(r, AIRLINES);
    const depH = 5 + Math.floor(r() * 17);
    const depM = pick(r, [0, 10, 15, 25, 30, 40, 45, 55]);
    const duration = (international ? 240 : 95) + Math.floor(r() * (international ? 300 : 120));
    const stops = r() < 0.65 ? 0 : 1;
    const arr = depH * 60 + depM + duration + stops * 80;
    const fare = roundTo(base * (0.8 + r() * 0.9) * (stops ? 0.88 : 1), 10);
    results.push({
      id: `FL-${from}${to}-${i}`,
      type: 'flight',
      airline: airline.name,
      flightNo: `${airline.code}-${100 + Math.floor(r() * 899)}`,
      from, to,
      fromCity: CITIES[from] || from,
      toCity: CITIES[to] || to,
      date,
      depart: `${String(depH).padStart(2, '0')}:${String(depM).padStart(2, '0')}`,
      arrive: `${String(Math.floor(arr / 60) % 24).padStart(2, '0')}:${String(arr % 60).padStart(2, '0')}`,
      duration: `${Math.floor((duration + stops * 80) / 60)}h ${(duration + stops * 80) % 60}m`,
      stops,
      baggage: international ? '30 kg' : '15 kg',
      refundable: r() < 0.5,
      farePerPax: fare,
      pax,
      net: fare * pax,
    });
  }
  return results.sort((a, b) => a.net - b.net);
}

const HOTEL_WORDS = ['Grand', 'Palm', 'Royal', 'Lagoon', 'Heritage', 'Vista', 'Orchid', 'Sapphire', 'Serene', 'Coral', 'Summit', 'Lotus'];
const HOTEL_TYPES = ['Resort', 'Hotel', 'Suites', 'Retreat', 'Inn', 'Residency'];
const AMENITIES = ['Free WiFi', 'Pool', 'Breakfast included', 'Spa', 'Airport shuttle', 'Gym', 'Beach access', 'Restaurant', 'Bar', 'Parking'];

function searchHotels({ city = 'Goa', checkin = '', nights = 3, rooms = 1 }) {
  nights = Math.max(1, Number(nights) || 1);
  rooms = Math.max(1, Number(rooms) || 1);
  const r = rng(`${String(city).toLowerCase()}${checkin}`);
  const results = [];
  for (let i = 0; i < 9; i++) {
    const stars = pick(r, [3, 3, 4, 4, 4, 5, 5]);
    const rate = roundTo((stars === 5 ? 9000 : stars === 4 ? 5200 : 2800) * (0.75 + r() * 0.8), 50);
    const amenities = AMENITIES.filter(() => r() < 0.45).slice(0, 5);
    results.push({
      id: `HT-${slug(city)}-${i}`,
      type: 'hotel',
      name: `${pick(r, HOTEL_WORDS)} ${pick(r, HOTEL_WORDS)} ${pick(r, HOTEL_TYPES)}`,
      city,
      area: pick(r, ['City centre', 'Beachfront', 'Near airport', 'Old town', 'Hillside', 'Lakeside']),
      stars,
      rating: (3.6 + r() * 1.3).toFixed(1),
      roomType: pick(r, ['Deluxe Room', 'Superior Room', 'Premium Room', 'Garden Villa', 'Sea View Room']),
      meal: pick(r, ['Room only', 'Breakfast', 'Breakfast', 'Half board']),
      amenities: amenities.length ? amenities : ['Free WiFi'],
      refundable: r() < 0.6,
      ratePerNight: rate,
      nights, rooms, checkin,
      net: rate * nights * rooms,
      image: `/cover/${encodeURIComponent(city)}.svg?h=${i}`,
    });
  }
  return results.sort((a, b) => a.net - b.net);
}

function searchTransfers({ city = 'Goa', kind = 'airport', pax = 2 }) {
  const r = rng(`tr${String(city).toLowerCase()}${kind}`);
  const vehicles = [
    { name: 'Sedan (Dzire / Etios)', seats: 3, base: 1400 },
    { name: 'SUV (Ertiga / Innova)', seats: 6, base: 2200 },
    { name: 'Innova Crysta', seats: 6, base: 2900 },
    { name: 'Tempo Traveller', seats: 12, base: 4800 },
  ];
  const mult = kind === 'fullday' ? 2.4 : kind === 'intercity' ? 3.2 : 1;
  return vehicles
    .filter((v) => v.seats >= Number(pax) || v.seats >= 12)
    .map((v, i) => ({
      id: `TR-${slug(city)}-${kind}-${i}`,
      type: 'transfer',
      title: `${v.name} — ${kind === 'airport' ? 'Airport transfer' : kind === 'fullday' ? 'Full-day sightseeing (8h/80km)' : 'Intercity transfer'}`,
      city, kind,
      seats: v.seats,
      net: roundTo(v.base * mult * (0.9 + r() * 0.3), 50),
    }));
}

function insurancePlans({ days = 5, travellers = 2, region = 'domestic' }) {
  days = Math.max(1, Number(days) || 1);
  travellers = Math.max(1, Number(travellers) || 1);
  const intl = region !== 'domestic';
  return [
    { name: 'Basic', cover: intl ? '$50,000 medical' : '₹2 lakh medical', perDay: intl ? 70 : 25 },
    { name: 'Smart', cover: intl ? '$100,000 medical + baggage' : '₹5 lakh medical + trip delay', perDay: intl ? 110 : 40 },
    { name: 'Premium', cover: intl ? '$250,000 medical + cancellation' : '₹10 lakh medical + cancellation', perDay: intl ? 180 : 65 },
  ].map((p, i) => ({
    id: `IN-${region}-${i}`,
    type: 'insurance',
    title: `${p.name} travel insurance (${intl ? 'International' : 'Domestic'})`,
    cover: p.cover,
    days, travellers,
    net: roundTo(p.perDay * days * travellers, 10),
  }));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

module.exports = { searchFlights, searchHotels, searchTransfers, insurancePlans, CITIES };
