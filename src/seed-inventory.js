/**
 * Demo inventory as the backend team would enter it: activities plus hotels, airfares, transfers, visas
 * and travel insurance for Dubai, Bali, Vietnam, Cambodia, the UK and Europe.
 * Hotel names are made up; flight numbers, schedules and all net rates are illustrative estimates in INR.
 */
const ACTIVITIES = require('./seed-activities');

const UAE = 'United Arab Emirates';
const hotel = (title, city, country, category, stars, room, mealPlan, net, extra = {}) => ({
  kind: 'hotel', title, city, country, category, price_basis: 'per_room_night', net_adult: net,
  details: { stars: String(stars), room, mealPlan, maxGuests: 3, ...extra.details },
  pickup: 'Check-in 15:00, check-out 12:00', cancellation: 'Free cancellation up to 7 days before check-in; first night charged after that.',
  summary: extra.summary, highlights: extra.highlights, inclusions: mealPlan === 'CP' ? 'Daily breakfast\nWi-Fi' : 'Wi-Fi',
});
const fare = (title, city, country, d, adult, child, infant, category = 'Economy') => ({
  kind: 'flight', title, city, country, category, price_basis: 'per_person', net_adult: adult, net_child: child, net_infant: infant,
  details: { stops: 'Non-stop', refundable: 'No', ...d },
  cancellation: 'Cancellation and date changes as per airline fare rules; VaayuTrip service fee ₹500 per ticket.',
  timing: d.days || 'Daily',
});
const transfer = (title, city, country, category, vehicle, basis, net, size, duration) => ({
  kind: 'transfer', title, city, country, category, duration, price_basis: basis, net_adult: net, group_size: basis === 'per_group' ? size : null,
  details: { vehicle, luggage: basis === 'per_group' ? `${size} medium suitcases` : 'As per operator' },
  cancellation: 'Free cancellation up to 24 hours before pickup.',
});
const visa = (title, city, country, category, net, child, d) => ({
  kind: 'visa', title, city, country, category, price_basis: 'per_person', net_adult: net, net_child: child, details: d,
  cancellation: 'Non-refundable once submitted to the embassy or portal. Approval is at the authority\'s discretion.',
});
const plan = (title, city, category, net, child, d) => ({
  kind: 'insurance', title, city, country: 'All destinations', category, price_basis: 'per_person', net_adult: net, net_child: child, details: d,
  cancellation: 'Full refund if cancelled before the policy start date.',
});

module.exports = [
  ...ACTIVITIES.map((a) => ({ kind: 'activity', ...a })),

  // ---------- hotels (net per room per night) ----------
  hotel('Al Barsha Grand Hotel', 'Dubai', UAE, 'Hotel', 4, 'Family room', 'CP', 6200, { summary: 'Near Mall of the Emirates and the metro, with a rooftop pool.' }),
  hotel('Marina Bay View Hotel', 'Dubai', UAE, 'Hotel', 5, 'Deluxe sea-view room', 'CP', 11500, { summary: 'Five-star tower on Dubai Marina, steps from the beach and the dhow cruise jetty.' }),
  hotel('Jungle Pool Villas Ubud', 'Bali', 'Indonesia', 'Villa', 4, 'One-bedroom private pool villa', 'CP', 9000, { summary: 'Private pool villas over the Ayung valley, 10 minutes from Ubud centre.', details: { area: 'Ubud' } }),
  hotel('Seminyak Sands Resort', 'Bali', 'Indonesia', 'Resort', 4, 'Deluxe ocean-view room', 'CP', 6600, { summary: 'Beachfront resort in Seminyak with three pools.', details: { area: 'Seminyak' } }),
  hotel('Kuta Beach Inn', 'Bali', 'Indonesia', 'Hotel', 3, 'Twin room', 'CP', 2800, { summary: 'Simple, clean rooms two minutes from Kuta beach.', details: { area: 'Kuta' } }),
  hotel('Old Quarter Boutique Hotel', 'Hanoi', 'Vietnam', 'Boutique hotel', 4, 'Deluxe room', 'CP', 3900, { summary: 'In the heart of the Old Quarter, near Hoan Kiem Lake.' }),
  hotel('My Khe Beach Hotel', 'Da Nang', 'Vietnam', 'Hotel', 4, 'Sea-view room', 'CP', 4400, { summary: 'Across the road from My Khe beach, 30 minutes from Hoi An.' }),
  hotel('Saigon Riverside Hotel', 'Ho Chi Minh City', 'Vietnam', 'Hotel', 4, 'Superior room', 'CP', 4200, { summary: 'District 1 on the Saigon river, walking distance to Ben Thanh market.' }),
  hotel('Angkor Garden Resort', 'Siem Reap', 'Cambodia', 'Resort', 4, 'Pool-view room', 'CP', 4300, { summary: 'Garden resort 10 minutes from Pub Street and 15 from Angkor Wat.' }),
  hotel('Riverside Palace Hotel', 'Phnom Penh', 'Cambodia', 'Hotel', 4, 'Deluxe room', 'CP', 4000, { summary: 'On Sisowath Quay, near the Royal Palace.' }),
  hotel('Kensington Park Hotel', 'London', 'United Kingdom', 'Hotel', 4, 'Double room', 'CP', 15800, { summary: 'Victorian townhouse hotel near Gloucester Road tube, close to the museums.' }),
  hotel('Old Town Grand Hotel', 'Edinburgh', 'United Kingdom', 'Hotel', 4, 'Double room', 'CP', 12800, { summary: 'Just off the Royal Mile, a short walk to the castle.' }),
  hotel('Hôtel Rive Gauche', 'Paris', 'France', 'Hotel', 4, 'Family room', 'CP', 16500, { summary: 'Left Bank hotel 10 minutes from the Eiffel Tower.' }),
  hotel('Alpenblick Hotel', 'Interlaken', 'Switzerland', 'Hotel', 4, 'Mountain-view room', 'CP', 15200, { summary: 'Views of the Jungfrau, 5 minutes from Interlaken Ost station.' }),
  hotel('Lakeside Lucerne Hotel', 'Lucerne', 'Switzerland', 'Hotel', 4, 'Double room', 'CP', 14800, { summary: 'On the lake promenade near the Chapel Bridge.' }),
  hotel('Hotel Colosseo Roma', 'Rome', 'Italy', 'Hotel', 4, 'Double room', 'CP', 12500, { summary: 'Ten minutes on foot from the Colosseum.' }),
  hotel('Canal House Amsterdam', 'Amsterdam', 'Netherlands', 'Boutique hotel', 4, 'Canal-view room', 'CP', 14000, { summary: 'Seventeenth-century canal house in the Jordaan.' }),
  hotel('Barcelona Gothic Hotel', 'Barcelona', 'Spain', 'Hotel', 4, 'Double room', 'CP', 11800, { summary: 'In the Gothic Quarter, near La Rambla.' }),

  // ---------- airfares (net per person) ----------
  fare('Delhi–Dubai return, Emirates', 'Dubai', UAE, { airline: 'Emirates', flightNo: 'EK 511', from: 'DEL', to: 'DXB', depart: '04:20', arrive: '06:35', trip: 'return', returnFlightNo: 'EK 510', returnDepart: '22:15', returnArrive: '03:30', baggage: '30 kg + 7 kg cabin' }, 24000, 19500, 3000),
  fare('Mumbai–Dubai return, IndiGo', 'Dubai', UAE, { airline: 'IndiGo', flightNo: '6E 1451', from: 'BOM', to: 'DXB', depart: '09:40', arrive: '11:20', trip: 'return', returnFlightNo: '6E 1452', returnDepart: '12:30', returnArrive: '17:05', baggage: '30 kg + 7 kg cabin' }, 18500, 16000, 2500),
  fare('Delhi–Bali return via Singapore, Singapore Airlines', 'Bali', 'Indonesia', { airline: 'Singapore Airlines', flightNo: 'SQ 403', from: 'DEL', to: 'DPS', depart: '23:00', arrive: '12:15', trip: 'return', returnFlightNo: 'SQ 942', returnDepart: '12:25', returnArrive: '23:45', baggage: '30 kg + 7 kg cabin', stops: '1 stop' }, 42000, 36000, 5000),
  fare('Mumbai–Bali return, IndiGo', 'Bali', 'Indonesia', { airline: 'IndiGo', flightNo: '6E 1603', from: 'BOM', to: 'DPS', depart: '01:30', arrive: '10:55', trip: 'return', returnFlightNo: '6E 1604', returnDepart: '12:10', returnArrive: '17:40', baggage: '30 kg + 7 kg cabin' }, 33000, 29000, 4000),
  fare('Delhi–Hanoi return, VietJet', 'Hanoi', 'Vietnam', { airline: 'VietJet Air', flightNo: 'VJ 896', from: 'DEL', to: 'HAN', depart: '23:55', arrive: '05:50', trip: 'return', returnFlightNo: 'VJ 895', returnDepart: '19:25', returnArrive: '22:55', baggage: '20 kg + 7 kg cabin' }, 21000, 18500, 3000),
  fare('Hanoi–Da Nang, Vietnam Airlines', 'Da Nang', 'Vietnam', { airline: 'Vietnam Airlines', flightNo: 'VN 157', from: 'HAN', to: 'DAD', depart: '09:00', arrive: '10:20', trip: 'oneway', baggage: '23 kg + 10 kg cabin' }, 4200, 3600, 800),
  fare('Da Nang–Ho Chi Minh City, Vietnam Airlines', 'Ho Chi Minh City', 'Vietnam', { airline: 'Vietnam Airlines', flightNo: 'VN 117', from: 'DAD', to: 'SGN', depart: '11:00', arrive: '12:25', trip: 'oneway', baggage: '23 kg + 10 kg cabin' }, 4100, 3500, 800),
  fare('Ho Chi Minh City–Delhi, VietJet (flight home)', 'Ho Chi Minh City', 'Vietnam', { airline: 'VietJet Air', flightNo: 'VJ 895', from: 'SGN', to: 'DEL', depart: '19:20', arrive: '23:30', trip: 'oneway', baggage: '20 kg + 7 kg cabin' }, 14500, 12500, 2000),
  fare('Delhi–Siem Reap return via Bangkok, Thai Airways', 'Siem Reap', 'Cambodia', { airline: 'Thai Airways', flightNo: 'TG 316', from: 'DEL', to: 'REP', depart: '00:05', arrive: '09:40', trip: 'return', returnFlightNo: 'TG 2591', returnDepart: '19:15', returnArrive: '23:55', baggage: '30 kg + 7 kg cabin', stops: '1 stop' }, 32000, 27000, 4000),
  fare('Siem Reap–Phnom Penh, Cambodia Angkor Air', 'Phnom Penh', 'Cambodia', { airline: 'Cambodia Angkor Air', flightNo: 'K6 106', from: 'REP', to: 'PNH', depart: '10:30', arrive: '11:20', trip: 'oneway', baggage: '20 kg + 7 kg cabin' }, 6000, 5200, 900),
  fare('Delhi–London return, Air India', 'London', 'United Kingdom', { airline: 'Air India', flightNo: 'AI 161', from: 'DEL', to: 'LHR', depart: '14:05', arrive: '18:55', trip: 'return', returnFlightNo: 'AI 162', returnDepart: '21:00', returnArrive: '10:40', baggage: '2 × 23 kg + 7 kg cabin' }, 62000, 52000, 7000),
  fare('Mumbai–London return, British Airways', 'London', 'United Kingdom', { airline: 'British Airways', flightNo: 'BA 138', from: 'BOM', to: 'LHR', depart: '02:25', arrive: '07:35', trip: 'return', returnFlightNo: 'BA 137', returnDepart: '11:20', returnArrive: '01:50', baggage: '1 × 23 kg + 23 kg cabin' }, 68000, 58000, 8000),
  fare('Delhi–Paris return, Air France', 'Paris', 'France', { airline: 'Air France', flightNo: 'AF 225', from: 'DEL', to: 'CDG', depart: '00:40', arrive: '06:35', trip: 'return', returnFlightNo: 'AF 226', returnDepart: '10:30', returnArrive: '23:05', baggage: '1 × 23 kg + 12 kg cabin' }, 58000, 49000, 6500),
  fare('Zurich–Delhi, Swiss (flight home)', 'Zurich', 'Switzerland', { airline: 'Swiss', flightNo: 'LX 146', from: 'ZRH', to: 'DEL', depart: '13:05', arrive: '00:30', trip: 'oneway', baggage: '1 × 23 kg + 8 kg cabin' }, 36000, 30000, 4500),

  // ---------- transfers ----------
  transfer('Dubai airport to hotel, private sedan', 'Dubai', UAE, 'Airport transfer', 'Toyota Camry or similar', 'per_group', 2200, 3, '30–45 minutes'),
  transfer('Dubai airport to hotel, private van', 'Dubai', UAE, 'Airport transfer', 'Toyota Hiace (up to 7)', 'per_group', 3600, 7, '30–45 minutes'),
  transfer('Bali airport to hotel, private car', 'Bali', 'Indonesia', 'Airport transfer', 'Toyota Avanza or similar', 'per_group', 1500, 4, '30–90 minutes'),
  transfer('Ubud to Seminyak, private car', 'Bali', 'Indonesia', 'Intercity transfer', 'Toyota Avanza or similar', 'per_group', 1600, 4, '1.5 hours'),
  transfer('Hanoi airport to Old Quarter, private car', 'Hanoi', 'Vietnam', 'Airport transfer', 'Sedan or 7-seater', 'per_group', 1500, 4, '45 minutes'),
  transfer('Siem Reap airport to hotel, private car', 'Siem Reap', 'Cambodia', 'Airport transfer', 'Sedan', 'per_group', 1700, 3, '50 minutes'),
  transfer('Heathrow to central London, private car', 'London', 'United Kingdom', 'Airport transfer', 'Mercedes E-Class or similar', 'per_group', 7500, 3, '1 hour'),
  transfer('LNER train London to Edinburgh', 'London', 'United Kingdom', 'Rail', 'Standard class, reserved seat', 'per_person', 7800, null, '4.5 hours'),
  transfer('Eurostar London to Paris', 'London', 'United Kingdom', 'Rail', 'Standard class', 'per_person', 9500, null, '2 h 20 min'),
  transfer('Paris CDG to hotel, private car', 'Paris', 'France', 'Airport transfer', 'Mercedes E-Class or similar', 'per_group', 6800, 3, '1 hour'),
  transfer('Swiss Travel Pass, 4 days, 2nd class', 'Interlaken', 'Switzerland', 'Rail', 'Unlimited trains, buses and boats', 'per_person', 22000, null, '4 days'),

  // ---------- visas ----------
  visa('UAE 30-day tourist visa', 'Dubai', UAE, 'e-Visa', 6900, 6900, { processing: '3–4 working days', validity: '30 days stay, valid 58 days', entries: 'Single', documents: 'Passport front and back\nPhotograph on white background\nConfirmed return ticket' }),
  visa('Indonesia e-visa on arrival', 'Bali', 'Indonesia', 'Visa on arrival', 3100, 3100, { processing: 'Instant to 2 days', validity: '30 days, extendable once', entries: 'Single', documents: 'Passport valid 6 months\nReturn ticket' }),
  visa('Vietnam e-visa, 30 days', 'Hanoi', 'Vietnam', 'e-Visa', 2200, 2200, { processing: '3–5 working days', validity: '30 days', entries: 'Single', documents: 'Passport scan\nPhotograph' }),
  visa('Cambodia e-visa, 30 days', 'Siem Reap', 'Cambodia', 'e-Visa', 2700, 2700, { processing: '3 working days', validity: '30 days, valid 90 days', entries: 'Single', documents: 'Passport scan\nPhotograph' }),
  visa('UK Standard Visitor visa (fee and appointment)', 'London', 'United Kingdom', 'Sticker visa', 14500, 14500, { processing: '15 working days after biometrics', validity: 'Up to 6 months', entries: 'Multiple', documents: 'Passport and old passports\nBank statements (6 months)\nITR (3 years)\nLeave letter or business proof\nHotel and flight bookings' }),
  visa('Schengen tourist visa via France (fee and appointment)', 'Paris', 'France', 'Sticker visa', 9200, 5200, { processing: '15 working days after biometrics', validity: 'As per itinerary', entries: 'Multiple', documents: 'Passport\nBank statements (3 months)\nITR (2 years)\nTravel insurance (€30,000)\nHotel and flight bookings' }),

  // ---------- travel insurance ----------
  plan('Asia & Middle East travel insurance, Standard', 'Asia & Middle East', 'Standard', 750, 750, { cover: 'USD 50,000 medical', maxDays: 'Trips up to 15 days', benefits: 'Baggage loss USD 500\nTrip delay USD 100' }),
  plan('Worldwide travel insurance incl. UK & Schengen, Standard', 'Worldwide incl. UK & Schengen', 'Standard', 1600, 1600, { cover: 'USD 100,000 medical (meets Schengen €30,000)', maxDays: 'Trips up to 15 days', benefits: 'Baggage loss USD 750\nTrip cancellation USD 1,000' }),
  plan('Worldwide travel insurance, Premium', 'Worldwide incl. UK & Schengen', 'Premium', 2600, 2600, { cover: 'USD 250,000 medical', maxDays: 'Trips up to 30 days', benefits: 'Trip cancellation USD 3,000\nPassport loss\nAdventure sports cover' }),
].map((p) => ({ ...p, details: JSON.stringify(p.details || {}) }));
