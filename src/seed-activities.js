/**
 * Demo activity catalogue: tours, tickets and experiences in India and abroad.
 * Net rates are illustrative estimates in INR; replace them with your contracted rates.
 */
const FREE_24H = 'Free cancellation up to 24 hours before the start time; no refund after that or for no-shows.';
const FREE_48H = 'Free cancellation up to 48 hours before; 50% charge within 48 hours; no refund for no-shows.';
const DATED_TICKET = 'Tickets are dated and non-refundable once issued.';

const pp = (net_adult, net_child = null) => ({ price_basis: 'per_person', net_adult, net_child });
const group = (net_adult, group_size) => ({ price_basis: 'per_group', net_adult, group_size });

module.exports = [
  // ---------- Goa ----------
  {
    title: 'North Goa sightseeing tour', city: 'Goa', category: 'Sightseeing tour', duration: '8 hours', ...pp(950, 650),
    summary: 'Forts, beaches and markets of North Goa in an air-conditioned coach with a local guide.',
    highlights: 'Fort Aguada and lighthouse\nCalangute and Baga beaches\nAnjuna flea market (Wednesdays)\nSunset at Chapora Fort',
    inclusions: 'AC coach\nEnglish/Hindi-speaking guide\nHotel pickup and drop in North Goa', exclusions: 'Meals\nEntry and camera fees',
    pickup: 'Hotel pickup in Candolim, Calangute and Baga', timing: 'Daily, 09:00–17:00', cancellation: FREE_24H,
  },
  {
    title: 'Old Goa churches and South Goa tour', city: 'Goa', category: 'Culture & heritage', duration: '8 hours', ...pp(1000, 700),
    summary: 'UNESCO-listed churches of Old Goa, Mangeshi temple and the quiet beaches of the south.',
    highlights: 'Basilica of Bom Jesus\nSe Cathedral\nMangeshi temple\nColva beach',
    inclusions: 'AC coach\nGuide\nHotel pickup and drop', exclusions: 'Meals\nEntry fees',
    pickup: 'Hotel pickup across North and Central Goa', timing: 'Daily except Sunday, 09:00–17:00', cancellation: FREE_24H,
  },
  {
    title: 'Water sports combo at Calangute', city: 'Goa', category: 'Water sports', duration: '3 hours', ...pp(1800, 1500),
    summary: 'Parasailing, jet ski and a banana boat ride with certified operators and life jackets.',
    highlights: 'Parasailing\nJet ski ride (5 minutes)\nBanana boat ride\nBumper ride',
    inclusions: 'All four rides\nLife jackets and safety briefing\nLocker and changing room', exclusions: 'Transfers\nPhotos and videos',
    pickup: 'Meet at Calangute beach water sports point', timing: 'October–May, slots 09:00–16:00 (weather permitting)', cancellation: FREE_24H,
  },
  {
    title: 'Mandovi river sunset cruise', city: 'Goa', category: 'Cruise', duration: '1 hour', ...pp(600, 400),
    summary: 'An evening cruise on the Mandovi with live Goan folk music and dance on deck.',
    highlights: 'Sunset over Panaji\nGoan folk dances\nLive music', inclusions: 'Cruise ticket\nOnboard entertainment', exclusions: 'Food and drinks\nTransfers',
    pickup: 'Santa Monica jetty, Panaji', timing: 'Daily, 18:00 and 19:15', cancellation: DATED_TICKET,
  },
  {
    title: 'Grande Island snorkelling and dolphin trip', city: 'Goa', category: 'Water sports', duration: '7 hours', ...pp(2200, 1800),
    summary: 'Boat trip to Grande Island with dolphin spotting, snorkelling and a seafood lunch.',
    highlights: 'Dolphin spotting\nSnorkelling with gear\nBat cave and Bounty beach', inclusions: 'Boat\nSnorkelling gear\nLunch\nHotel pickup', exclusions: 'Drinks',
    pickup: 'Hotel pickup in South and Central Goa', timing: 'October–May, 08:30–15:30', cancellation: FREE_48H,
  },

  // ---------- Rajasthan ----------
  {
    title: 'Amber Fort and Jaipur city tour, private car with guide', city: 'Jaipur', category: 'Sightseeing tour', duration: 'Full day', ...group(3800, 4),
    summary: 'Amber Fort, City Palace, Jantar Mantar and Hawa Mahal with your own car and licensed guide.',
    highlights: 'Amber Fort\nCity Palace and Jantar Mantar\nHawa Mahal photo stop\nJal Mahal',
    inclusions: 'Private AC car (up to 4 guests)\nLicensed guide\nHotel pickup and drop', exclusions: 'Monument entry fees\nMeals',
    pickup: 'Any hotel in Jaipur', timing: 'Daily, 09:00–17:30', cancellation: FREE_24H,
  },
  {
    title: 'Hot air balloon ride over Amer', city: 'Jaipur', category: 'Adventure', duration: '3 hours', ...pp(11500, 9500),
    summary: 'Float over forts, villages and the Aravalli hills at sunrise, with a celebration on landing.',
    highlights: 'Sunrise flight of about an hour\nViews of Amber Fort\nFlight certificate',
    inclusions: 'Balloon flight\nHotel transfers\nTea and snacks', exclusions: 'Personal expenses',
    pickup: 'Hotel pickup in Jaipur at about 05:30', timing: 'September–March, sunrise flights (weather permitting)', cancellation: FREE_48H,
  },
  {
    title: 'Chokhi Dhani village evening and dinner', city: 'Jaipur', category: 'Food & nightlife', duration: '4 hours', ...pp(1100, 750),
    summary: 'A recreated Rajasthani village with folk dance, puppet shows, camel rides and an unlimited Rajasthani thali.',
    highlights: 'Folk dance and puppetry\nCamel and bullock-cart rides\nRajasthani thali dinner', inclusions: 'Entry\nDinner', exclusions: 'Transfers\nPaid rides inside',
    pickup: 'Chokhi Dhani, Tonk Road', timing: 'Daily, 17:00–23:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Udaipur private city tour', city: 'Udaipur', category: 'Sightseeing tour', duration: '6 hours', ...group(2800, 4),
    summary: 'City Palace, Jagdish Temple, Saheliyon ki Bari and Fateh Sagar Lake with a private car.',
    highlights: 'City Palace\nJagdish Temple\nSaheliyon ki Bari gardens\nFateh Sagar Lake',
    inclusions: 'Private AC car (up to 4 guests)\nGuide\nHotel pickup', exclusions: 'Entry fees\nMeals',
    pickup: 'Any hotel in Udaipur', timing: 'Daily, 09:30–15:30', cancellation: FREE_24H,
  },
  {
    title: 'Lake Pichola sunset boat ride', city: 'Udaipur', category: 'Cruise', duration: '1 hour', ...pp(900, 600),
    summary: 'Boat ride past the Lake Palace and Jag Mandir as the sun sets over the Aravallis.',
    highlights: 'Lake Palace views\nStop at Jag Mandir island', inclusions: 'Boat ticket', exclusions: 'Transfers',
    pickup: 'Rameshwar Ghat jetty, City Palace', timing: 'Daily, sunset departures', cancellation: DATED_TICKET,
  },
  {
    title: 'Taj Mahal sunrise tour with guide', city: 'Agra', category: 'Culture & heritage', duration: '4 hours', ...pp(2100, 1500),
    summary: 'See the Taj Mahal at sunrise with skip-the-line entry and a licensed guide, then Agra Fort.',
    highlights: 'Taj Mahal at sunrise\nAgra Fort\nSkip-the-line entry', inclusions: 'Taj Mahal and Agra Fort tickets\nGuide\nHotel pickup', exclusions: 'Breakfast',
    pickup: 'Hotel pickup in Agra', timing: 'Daily except Friday, from sunrise', cancellation: FREE_24H,
  },

  // ---------- Kerala ----------
  {
    title: 'Alleppey houseboat day cruise', city: 'Alleppey', category: 'Cruise', duration: '6 hours', ...group(7500, 4),
    summary: 'A private houseboat through the backwaters and paddy fields, with a Kerala lunch cooked on board.',
    highlights: 'Vembanad lake\nVillage canals\nKerala lunch on board', inclusions: 'Private houseboat (up to 4 guests)\nWelcome drink\nLunch', exclusions: 'Transfers to the jetty',
    pickup: 'Finishing Point jetty, Alleppey', timing: 'Daily, 11:00–17:00', cancellation: FREE_48H,
  },
  {
    title: 'Munnar tea gardens and Eravikulam park', city: 'Munnar', category: 'Nature & wildlife', duration: 'Full day', ...pp(1400, 900),
    summary: 'Tea museum, Eravikulam National Park (Nilgiri tahr), Mattupetty dam and Echo Point.',
    highlights: 'Tata tea museum\nEravikulam National Park\nMattupetty dam and Echo Point', inclusions: 'Shared AC vehicle\nGuide\nPark entry', exclusions: 'Meals',
    pickup: 'Hotel pickup in Munnar town', timing: 'Daily, 09:00–17:00 (park closed Feb–Mar for calving)', cancellation: FREE_24H,
  },
  {
    title: 'Kathakali performance', city: 'Kochi', category: 'Shows & experiences', duration: '1.5 hours', ...pp(500, 400),
    summary: "Watch the artists' make-up being applied, then a classical Kathakali performance.",
    highlights: 'Live make-up session\nPerformance with explanation in English', inclusions: 'Show ticket', exclusions: 'Transfers',
    pickup: 'Kerala Kathakali Centre, Fort Kochi', timing: 'Daily, make-up 16:00, show 17:00', cancellation: DATED_TICKET,
  },

  // ---------- Kashmir ----------
  {
    title: 'Dal Lake shikara ride', city: 'Srinagar', category: 'Sightseeing tour', duration: '1 hour', ...group(1200, 4),
    summary: 'A private shikara across Dal Lake past floating gardens and markets.',
    highlights: 'Floating gardens\nChar Chinar island\nSunset views', inclusions: 'Private shikara (up to 4 guests)', exclusions: 'Purchases at the floating market',
    pickup: 'Ghat no. 9, Boulevard Road', timing: 'Daily, 08:00–19:00', cancellation: FREE_24H,
  },
  {
    title: 'Gulmarg gondola, phase 1 and 2', city: 'Gulmarg', category: 'Attraction tickets', duration: '3 hours', ...pp(2900),
    summary: "Ride one of the world's highest cable cars to Kongdori and Apharwat peak at 3,980 m.",
    highlights: 'Kongdori meadow (phase 1)\nApharwat peak snow views (phase 2)', inclusions: 'Phase 1 and 2 return tickets', exclusions: 'Transfers\nPony and sledge rides',
    pickup: 'Gondola base station, Gulmarg', timing: 'Daily, 10:00–17:00 (phase 2 weather dependent)', cancellation: DATED_TICKET,
  },
  {
    title: 'Pahalgam valleys tour: Aru, Betaab and Chandanwari', city: 'Pahalgam', category: 'Day trip', duration: 'Full day', ...group(3200, 4),
    summary: 'Local union cab to the three valleys around Pahalgam.',
    highlights: 'Aru valley\nBetaab valley\nChandanwari snow point', inclusions: 'Local cab (up to 4 guests)', exclusions: 'Pony rides\nPark entry',
    pickup: 'Any hotel in Pahalgam', timing: 'Daily, 09:00–17:00', cancellation: FREE_24H,
  },
  {
    title: 'Sonamarg day trip from Srinagar', city: 'Srinagar', category: 'Day trip', duration: 'Full day', ...group(4200, 4),
    summary: 'Drive along the Sindh river to the meadow of gold and the Thajiwas glacier.',
    highlights: 'Sindh river drive\nThajiwas glacier', inclusions: 'Private car (up to 4 guests)\nDriver', exclusions: 'Pony rides\nMeals',
    pickup: 'Any hotel or houseboat in Srinagar', timing: 'Daily, 08:30–18:30', cancellation: FREE_24H,
  },

  // ---------- Himachal and Andaman ----------
  {
    title: 'Solang Valley paragliding', city: 'Manali', category: 'Adventure', duration: '2 hours', ...pp(2800, 2800),
    summary: 'Tandem paragliding with certified pilots over Solang Valley.',
    highlights: 'Tandem flight with a certified pilot\nViews of snow peaks', inclusions: 'Flight\nSafety gear', exclusions: 'Transfers\nGoPro video',
    pickup: 'Solang Valley take-off point', timing: 'Daily, 10:00–16:00 (weather permitting)', cancellation: FREE_24H,
  },
  {
    title: 'Atal Tunnel and Sissu snow day trip', city: 'Manali', category: 'Day trip', duration: 'Full day', ...group(4500, 4),
    summary: 'Through the Atal Tunnel to the snow and waterfalls of Sissu in Lahaul.',
    highlights: 'Atal Tunnel\nSissu waterfall and lake\nSolang Valley stop', inclusions: 'Private car (up to 4 guests)\nPermits', exclusions: 'Snow gear\nMeals',
    pickup: 'Any hotel in Manali', timing: 'Daily, 08:00–18:00 (road conditions permitting)', cancellation: FREE_24H,
  },
  {
    title: 'Beginner scuba dive at Havelock', city: 'Havelock Island', category: 'Water sports', duration: '3 hours', ...pp(5500, 5500),
    summary: 'A guided discover-scuba dive for non-swimmers with a PADI instructor.',
    highlights: 'Coral reef dive to about 8 m\nUnderwater photos', inclusions: 'Instructor\nAll equipment\nPhotos', exclusions: 'Transfers',
    pickup: 'Dive centre, Havelock Island', timing: 'Daily, morning and afternoon slots', cancellation: FREE_48H,
  },
  {
    title: 'Cellular Jail light and sound show', city: 'Port Blair', category: 'Shows & experiences', duration: '1 hour', ...pp(350, 250),
    summary: 'The story of the freedom struggle told at the historic Cellular Jail.',
    highlights: 'Sound and light show\nNational memorial', inclusions: 'Show ticket', exclusions: 'Transfers',
    pickup: 'Cellular Jail, Port Blair', timing: 'Daily, 18:00 (Hindi) and 19:15 (English)', cancellation: DATED_TICKET,
  },

  // ---------- Dubai ----------
  {
    title: 'Desert safari with BBQ dinner', city: 'Dubai', country: 'United Arab Emirates', category: 'Adventure', duration: '6 hours', ...pp(3900, 3200),
    summary: 'Dune bashing in a 4x4, camel ride, sandboarding and a BBQ dinner with live shows.',
    highlights: 'Dune bashing\nCamel ride and sandboarding\nTanoura and fire shows\nBBQ dinner',
    inclusions: 'Shared 4x4 with hotel pickup\nBBQ dinner and soft drinks\nShows', exclusions: 'Quad biking\nAlcoholic drinks',
    pickup: 'Hotel pickup in Dubai city', timing: 'Daily, pickup 15:00–15:30', cancellation: FREE_24H,
  },
  {
    title: 'Burj Khalifa At the Top, levels 124 and 125', city: 'Dubai', country: 'United Arab Emirates', category: 'Attraction tickets', duration: '1.5 hours', ...pp(3400, 2700),
    summary: "Timed entry to the observation decks of the world's tallest building.",
    highlights: 'Levels 124 and 125\nViews over Downtown and the Gulf', inclusions: 'Timed entry ticket (non-prime hours)', exclusions: 'Transfers\nPrime-time surcharge',
    pickup: 'Dubai Mall, lower ground floor', timing: 'Daily, 10:00–22:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Dhow cruise dinner at Dubai Marina', city: 'Dubai', country: 'United Arab Emirates', category: 'Cruise', duration: '2 hours', ...pp(2600, 2000),
    summary: 'An evening cruise along the Marina skyline with an international buffet dinner.',
    highlights: 'Marina skyline at night\nBuffet dinner\nLive entertainment', inclusions: 'Cruise\nBuffet dinner\nSoft drinks', exclusions: 'Transfers',
    pickup: 'Dubai Marina Walk jetty', timing: 'Daily, boarding 20:00', cancellation: FREE_24H,
  },
  {
    title: 'Dubai city tour, half day', city: 'Dubai', country: 'United Arab Emirates', category: 'Sightseeing tour', duration: '4 hours', ...pp(1600, 1200),
    summary: 'Old Dubai, the creek and souks, Jumeirah Mosque and photo stops at Burj Al Arab and Atlantis.',
    highlights: 'Al Fahidi and abra ride\nGold and spice souks\nBurj Al Arab and Atlantis photo stops',
    inclusions: 'Shared AC coach\nGuide\nAbra ride\nHotel pickup', exclusions: 'Entry tickets\nMeals',
    pickup: 'Hotel pickup in Dubai city', timing: 'Daily, 08:30–12:30', cancellation: FREE_24H,
  },
  {
    title: 'Abu Dhabi day trip with Grand Mosque', city: 'Dubai', country: 'United Arab Emirates', category: 'Day trip', duration: '10 hours', ...pp(3200, 2600),
    summary: 'Sheikh Zayed Grand Mosque, Qasr Al Watan exterior, the Corniche and a Ferrari World photo stop.',
    highlights: 'Sheikh Zayed Grand Mosque\nCorniche drive\nFerrari World photo stop', inclusions: 'Shared AC coach\nGuide\nLunch', exclusions: 'Theme park tickets',
    pickup: 'Hotel pickup in Dubai city', timing: 'Daily, 08:00–18:00', cancellation: FREE_24H,
  },

  // ---------- Bali ----------
  {
    title: 'Ubud tour: rice terraces, monkey forest and temples', city: 'Bali', country: 'Indonesia', category: 'Sightseeing tour', duration: 'Full day', ...group(4200, 4),
    summary: 'Private car to Tegalalang rice terraces, the Sacred Monkey Forest, Ubud market and Tirta Empul.',
    highlights: 'Tegalalang rice terraces\nSacred Monkey Forest\nTirta Empul water temple', inclusions: 'Private car (up to 4 guests)\nEnglish-speaking driver', exclusions: 'Entry fees\nMeals',
    pickup: 'Any hotel in south Bali or Ubud', timing: 'Daily, 08:30–17:30', cancellation: FREE_24H,
  },
  {
    title: 'Mount Batur sunrise trek', city: 'Bali', country: 'Indonesia', category: 'Adventure', duration: '8 hours', ...pp(3600, 3000),
    summary: 'Trek up an active volcano in the dark for sunrise above the clouds, with breakfast at the top.',
    highlights: 'Sunrise from 1,717 m\nBreakfast cooked on volcanic steam', inclusions: 'Trekking guide\nBreakfast\nHotel transfers', exclusions: 'Hot springs entry',
    pickup: 'Hotel pickup at about 02:00', timing: 'Daily', cancellation: FREE_48H,
  },
  {
    title: 'Nusa Penida island day trip', city: 'Bali', country: 'Indonesia', category: 'Day trip', duration: 'Full day', ...pp(5800, 4900),
    summary: 'Fast boat to Nusa Penida for Kelingking beach, Broken Beach and Angel’s Billabong.',
    highlights: 'Kelingking T-rex cliff\nBroken Beach\nCrystal Bay', inclusions: 'Return fast boat\nIsland car and driver\nLunch', exclusions: 'Snorkelling',
    pickup: 'Hotel pickup in south Bali', timing: 'Daily, 06:30–18:30 (sea conditions permitting)', cancellation: FREE_48H,
  },
  {
    title: 'Uluwatu temple and Kecak fire dance', city: 'Bali', country: 'Indonesia', category: 'Shows & experiences', duration: '4 hours', ...pp(1900, 1500),
    summary: 'Clifftop Uluwatu temple at sunset followed by the Kecak fire dance.',
    highlights: 'Uluwatu clifftop temple\nKecak dance at sunset', inclusions: 'Temple entry\nKecak ticket\nShared transfers', exclusions: 'Dinner',
    pickup: 'Hotel pickup in south Bali', timing: 'Daily, 15:30–19:30', cancellation: FREE_24H,
  },

  // ---------- Thailand ----------
  {
    title: 'Phi Phi islands by speedboat', city: 'Phuket', country: 'Thailand', category: 'Day trip', duration: '9 hours', ...pp(4100, 3200),
    summary: 'Maya Bay, Pileh Lagoon and snorkelling at Phi Phi by speedboat, with lunch.',
    highlights: 'Maya Bay\nPileh Lagoon\nSnorkelling stops', inclusions: 'Speedboat\nLunch\nSnorkelling gear\nHotel transfers', exclusions: 'National park fee (THB 400)',
    pickup: 'Hotel pickup in Patong, Karon and Kata', timing: 'Daily, 07:30–16:30', cancellation: FREE_24H,
  },
  {
    title: 'Safari World and Marine Park', city: 'Bangkok', country: 'Thailand', category: 'Attraction tickets', duration: 'Full day', ...pp(2900, 2500),
    summary: 'Drive-through safari plus marine park shows, with buffet lunch and transfers.',
    highlights: 'Safari drive\nDolphin and sea lion shows', inclusions: 'Entry\nBuffet lunch\nShared transfers', exclusions: 'Personal expenses',
    pickup: 'Hotel pickup in central Bangkok', timing: 'Daily, 08:00–17:00', cancellation: FREE_24H,
  },
  {
    title: 'Coral Island tour by speedboat', city: 'Pattaya', country: 'Thailand', category: 'Water sports', duration: '6 hours', ...pp(1800, 1500),
    summary: 'Speedboat to Koh Larn with beach time and optional parasailing.',
    highlights: 'Tawaen beach\nParasailing (optional)', inclusions: 'Speedboat\nLunch\nHotel transfers', exclusions: 'Water sports',
    pickup: 'Hotel pickup in Pattaya', timing: 'Daily, 08:00–14:00', cancellation: FREE_24H,
  },

  // ---------- Singapore ----------
  {
    title: 'Universal Studios Singapore', city: 'Singapore', country: 'Singapore', category: 'Attraction tickets', duration: 'Full day', ...pp(6300, 4800),
    summary: 'One-day ticket to Universal Studios Singapore on Sentosa.',
    highlights: 'Seven themed zones\nTransformers and Battlestar Galactica rides', inclusions: 'One-day entry ticket', exclusions: 'Express pass\nTransfers',
    pickup: 'Resorts World Sentosa', timing: 'Daily, 10:00–19:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Gardens by the Bay: Flower Dome and Cloud Forest', city: 'Singapore', country: 'Singapore', category: 'Attraction tickets', duration: '3 hours', ...pp(2000, 1400),
    summary: 'Both conservatories, then the free Supertree light show in the evening.',
    highlights: 'Flower Dome\nCloud Forest waterfall\nSupertree Garden Rhapsody', inclusions: 'Entry to both domes', exclusions: 'OCBC Skyway\nTransfers',
    pickup: 'Gardens by the Bay', timing: 'Daily, 09:00–21:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Night Safari with tram ride', city: 'Singapore', country: 'Singapore', category: 'Nature & wildlife', duration: '4 hours', ...pp(3300, 2300),
    summary: "The world's first nocturnal zoo, with a guided tram ride and walking trails.",
    highlights: 'Tram safari\nCreatures of the Night show', inclusions: 'Entry with tram ride\nShared transfers', exclusions: 'Dinner',
    pickup: 'Hotel pickup in central Singapore', timing: 'Daily, 18:30–23:00', cancellation: FREE_24H,
  },

  // ---------- Vietnam ----------
  {
    title: 'Ha Long Bay day cruise', city: 'Ha Long', country: 'Vietnam', category: 'Cruise', duration: 'Full day', ...pp(4200, 3400),
    summary: 'Cruise among limestone islands with kayaking, Sung Sot cave and a seafood lunch.',
    highlights: 'Sung Sot cave\nKayaking at Luon cave\nTi Top island viewpoint', inclusions: 'Cruise\nLunch\nKayak\nHanoi transfers', exclusions: 'Drinks',
    pickup: 'Hotel pickup in Hanoi Old Quarter', timing: 'Daily, 07:30–20:00', cancellation: FREE_48H,
  },
];
