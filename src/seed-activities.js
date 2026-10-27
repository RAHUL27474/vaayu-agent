/**
 * Demo activity catalogue for VaayuTrip's destinations: Dubai, Bali, Vietnam, Cambodia, the UK and Europe.
 * Net rates are illustrative estimates in INR; replace them with your contracted rates.
 */
const FREE_24H = 'Free cancellation up to 24 hours before the start time; no refund after that or for no-shows.';
const FREE_48H = 'Free cancellation up to 48 hours before; 50% charge within 48 hours; no refund for no-shows.';
const DATED_TICKET = 'Tickets are dated and non-refundable once issued.';

const pp = (net_adult, net_child = null) => ({ price_basis: 'per_person', net_adult, net_child });
const group = (net_adult, group_size) => ({ price_basis: 'per_group', net_adult, group_size });
const UAE = 'United Arab Emirates';

module.exports = [
  // ---------- Dubai ----------
  {
    title: 'Desert safari with BBQ dinner', city: 'Dubai', country: UAE, category: 'Adventure', duration: '6 hours', ...pp(3900, 3200),
    summary: 'Dune bashing in a 4x4, camel ride, sandboarding and a BBQ dinner with live shows.',
    highlights: 'Dune bashing\nCamel ride and sandboarding\nTanoura and fire shows\nBBQ dinner',
    inclusions: 'Shared 4x4 with hotel pickup\nBBQ dinner and soft drinks\nShows', exclusions: 'Quad biking\nAlcoholic drinks',
    pickup: 'Hotel pickup in Dubai city', timing: 'Daily, pickup 15:00–15:30', cancellation: FREE_24H,
  },
  {
    title: 'Burj Khalifa At the Top, levels 124 and 125', city: 'Dubai', country: UAE, category: 'Attraction tickets', duration: '1.5 hours', ...pp(3400, 2700),
    summary: "Timed entry to the observation decks of the world's tallest building.",
    highlights: 'Levels 124 and 125\nViews over Downtown and the Gulf', inclusions: 'Timed entry ticket (non-prime hours)', exclusions: 'Transfers\nPrime-time surcharge',
    pickup: 'Dubai Mall, lower ground floor', timing: 'Daily, 10:00–22:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Dhow cruise dinner at Dubai Marina', city: 'Dubai', country: UAE, category: 'Cruise', duration: '2 hours', ...pp(2600, 2000),
    summary: 'An evening cruise along the Marina skyline with an international buffet dinner.',
    highlights: 'Marina skyline at night\nBuffet dinner\nLive entertainment', inclusions: 'Cruise\nBuffet dinner\nSoft drinks', exclusions: 'Transfers',
    pickup: 'Dubai Marina Walk jetty', timing: 'Daily, boarding 20:00', cancellation: FREE_24H,
  },
  {
    title: 'Dubai city tour, half day', city: 'Dubai', country: UAE, category: 'Sightseeing tour', duration: '4 hours', ...pp(1600, 1200),
    summary: 'Old Dubai, the creek and souks, Jumeirah Mosque and photo stops at Burj Al Arab and Atlantis.',
    highlights: 'Al Fahidi and abra ride\nGold and spice souks\nBurj Al Arab and Atlantis photo stops',
    inclusions: 'Shared AC coach\nGuide\nAbra ride\nHotel pickup', exclusions: 'Entry tickets\nMeals',
    pickup: 'Hotel pickup in Dubai city', timing: 'Daily, 08:30–12:30', cancellation: FREE_24H,
  },
  {
    title: 'Abu Dhabi day trip with Grand Mosque', city: 'Dubai', country: UAE, category: 'Day trip', duration: '10 hours', ...pp(3200, 2600),
    summary: 'Sheikh Zayed Grand Mosque, Qasr Al Watan exterior, the Corniche and a Ferrari World photo stop.',
    highlights: 'Sheikh Zayed Grand Mosque\nCorniche drive\nFerrari World photo stop', inclusions: 'Shared AC coach\nGuide\nLunch', exclusions: 'Theme park tickets',
    pickup: 'Hotel pickup in Dubai city', timing: 'Daily, 08:00–18:00', cancellation: FREE_24H,
  },
  {
    title: 'Museum of the Future', city: 'Dubai', country: UAE, category: 'Attraction tickets', duration: '2 hours', ...pp(3300, 3300),
    summary: 'Immersive exhibits imagining life in 2071, inside one of the most striking buildings in the world.',
    highlights: 'OSS Hope space station\nThe Heal Institute\nFuture Heroes for children', inclusions: 'Timed entry ticket', exclusions: 'Transfers',
    pickup: 'Museum of the Future, Sheikh Zayed Road', timing: 'Daily, 10:00–21:30', cancellation: DATED_TICKET,
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
  {
    title: 'Ayung river white-water rafting', city: 'Bali', country: 'Indonesia', category: 'Adventure', duration: '5 hours', ...pp(2700, 2100),
    summary: 'Two hours of grade II–III rapids through jungle gorges near Ubud, with lunch.',
    highlights: '12 km of rapids\nWaterfalls and rice-field gorges', inclusions: 'Rafting with guide and safety gear\nLunch\nHotel transfers', exclusions: 'Photos',
    pickup: 'Hotel pickup in south Bali or Ubud', timing: 'Daily, 08:00–13:00', cancellation: FREE_24H,
  },

  // ---------- Vietnam ----------
  {
    title: 'Ha Long Bay day cruise', city: 'Ha Long', country: 'Vietnam', category: 'Cruise', duration: 'Full day', ...pp(4200, 3400),
    summary: 'Cruise among limestone islands with kayaking, Sung Sot cave and a seafood lunch.',
    highlights: 'Sung Sot cave\nKayaking at Luon cave\nTi Top island viewpoint', inclusions: 'Cruise\nLunch\nKayak\nHanoi transfers', exclusions: 'Drinks',
    pickup: 'Hotel pickup in Hanoi Old Quarter', timing: 'Daily, 07:30–20:00', cancellation: FREE_48H,
  },
  {
    title: 'Hanoi street food walk', city: 'Hanoi', country: 'Vietnam', category: 'Food & nightlife', duration: '3 hours', ...pp(2100, 1500),
    summary: 'Eat your way through the Old Quarter with a local guide: pho, bun cha, egg coffee and more.',
    highlights: '8 tastings\nEgg coffee\nTrain Street', inclusions: 'All food tastings\nGuide', exclusions: 'Alcoholic drinks',
    pickup: 'Hoan Kiem Lake, Old Quarter', timing: 'Daily, 17:30–20:30', cancellation: FREE_24H,
  },
  {
    title: 'Cu Chi tunnels half-day tour', city: 'Ho Chi Minh City', country: 'Vietnam', category: 'Culture & heritage', duration: '5 hours', ...pp(1900, 1400),
    summary: 'Crawl through the wartime tunnel network and learn how the villagers lived underground.',
    highlights: 'Ben Dinh tunnels\nTraps and hideouts', inclusions: 'Entry\nGuide\nShared transfers', exclusions: 'Meals',
    pickup: 'Hotel pickup in District 1', timing: 'Daily, 07:30–12:30 or 12:30–17:30', cancellation: FREE_24H,
  },
  {
    title: 'Mekong Delta day trip', city: 'Ho Chi Minh City', country: 'Vietnam', category: 'Day trip', duration: 'Full day', ...pp(2600, 2000),
    summary: 'Boat through the canals of the Mekong, with coconut candy workshops, tropical fruit and a rowboat ride.',
    highlights: 'Sampan rowboat ride\nCoconut candy workshop\nHorse-cart ride', inclusions: 'Boat trips\nLunch\nGuide\nTransfers', exclusions: 'Drinks',
    pickup: 'Hotel pickup in District 1', timing: 'Daily, 07:30–17:30', cancellation: FREE_24H,
  },
  {
    title: 'Ba Na Hills and the Golden Bridge', city: 'Da Nang', country: 'Vietnam', category: 'Attraction tickets', duration: 'Full day', ...pp(4800, 3900),
    summary: 'Cable car up to Ba Na Hills, the Golden Bridge held by giant hands, and the French village.',
    highlights: 'Golden Bridge\nRecord-breaking cable car\nFantasy Park', inclusions: 'Cable car and entry\nBuffet lunch\nShared transfers', exclusions: 'Wax museum',
    pickup: 'Hotel pickup in Da Nang', timing: 'Daily, 08:00–17:00', cancellation: FREE_48H,
  },
  {
    title: 'Hoi An old town and lantern boat ride', city: 'Hoi An', country: 'Vietnam', category: 'Culture & heritage', duration: '3 hours', ...pp(1500, 1000),
    summary: 'Walk the UNESCO old town at dusk and float a lantern on the Thu Bon river.',
    highlights: 'Japanese covered bridge\nAssembly halls\nLantern boat ride', inclusions: 'Old town ticket\nGuide\nBoat ride', exclusions: 'Transfers\nDinner',
    pickup: 'Hoi An old town ticket booth', timing: 'Daily, 16:30–19:30', cancellation: FREE_24H,
  },

  // ---------- Cambodia ----------
  {
    title: 'Angkor Wat sunrise and temples tour', city: 'Siem Reap', country: 'Cambodia', category: 'Culture & heritage', duration: 'Full day', ...group(5200, 4),
    summary: 'Sunrise at Angkor Wat, then Angkor Thom, the Bayon faces and Ta Prohm with a private guide and tuk-tuk.',
    highlights: 'Sunrise at Angkor Wat\nBayon temple\nTa Prohm jungle temple', inclusions: 'Private tuk-tuk and licensed guide (up to 4 guests)\nWater', exclusions: 'Angkor pass (USD 37 pp)\nMeals',
    pickup: 'Any hotel in Siem Reap, 04:45', timing: 'Daily', cancellation: FREE_24H,
  },
  {
    title: 'Tonle Sap floating village boat trip', city: 'Siem Reap', country: 'Cambodia', category: 'Nature & wildlife', duration: '4 hours', ...pp(2300, 1600),
    summary: 'Boat through Kampong Phluk, a village on stilts in the flooded forest of Tonle Sap lake.',
    highlights: 'Stilt village\nFlooded forest by rowboat\nSunset over the lake', inclusions: 'Boat\nGuide\nTransfers', exclusions: 'Rowboat tip',
    pickup: 'Hotel pickup in Siem Reap', timing: 'Daily, 14:00–18:00', cancellation: FREE_24H,
  },
  {
    title: 'Phare, the Cambodian Circus', city: 'Siem Reap', country: 'Cambodia', category: 'Shows & experiences', duration: '1.5 hours', ...pp(1900, 1000),
    summary: 'Acrobatics, theatre and live music by young Cambodian artists.',
    highlights: 'Big-top show\nSupports a local arts school', inclusions: 'Section B ticket', exclusions: 'Transfers',
    pickup: 'Phare big top, Siem Reap', timing: 'Daily, 20:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Phnom Penh city tour', city: 'Phnom Penh', country: 'Cambodia', category: 'Sightseeing tour', duration: '6 hours', ...group(3600, 4),
    summary: 'Royal Palace and Silver Pagoda, the National Museum, Tuol Sleng and the riverside.',
    highlights: 'Royal Palace\nSilver Pagoda\nTuol Sleng museum', inclusions: 'Private car and guide (up to 4 guests)', exclusions: 'Entry fees\nMeals',
    pickup: 'Any hotel in Phnom Penh', timing: 'Daily, 08:30–14:30', cancellation: FREE_24H,
  },

  // ---------- United Kingdom ----------
  {
    title: 'London Eye standard ticket', city: 'London', country: 'United Kingdom', category: 'Attraction tickets', duration: '1 hour', ...pp(3400, 2800),
    summary: "A 30-minute rotation on London's giant observation wheel over the Thames.",
    highlights: 'Views of Big Ben and Parliament\n4D cinema experience', inclusions: 'Standard timed entry', exclusions: 'Fast track',
    pickup: 'London Eye, South Bank', timing: 'Daily, 10:00–20:30', cancellation: DATED_TICKET,
  },
  {
    title: 'Tower of London with Crown Jewels', city: 'London', country: 'United Kingdom', category: 'Culture & heritage', duration: '3 hours', ...pp(3600, 1800),
    summary: 'The Crown Jewels, the White Tower and a Yeoman Warder tour.',
    highlights: 'Crown Jewels\nYeoman Warder tour\nWhite Tower', inclusions: 'Entry ticket', exclusions: 'Transfers',
    pickup: 'Tower of London', timing: 'Tue–Sat 09:00–17:30, Sun–Mon from 10:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Warner Bros. Studio Tour: The Making of Harry Potter', city: 'London', country: 'United Kingdom', category: 'Attraction tickets', duration: '7 hours', ...pp(9800, 9200),
    summary: 'Coach from central London to the studios to walk through the Great Hall, Diagon Alley and the Hogwarts Express.',
    highlights: 'Great Hall\nDiagon Alley\nPlatform 9¾ and the Hogwarts Express', inclusions: 'Studio entry\nReturn coach from central London', exclusions: 'Food\nDigital guide',
    pickup: 'Coach stop near Victoria station', timing: 'Daily, morning and afternoon departures', cancellation: DATED_TICKET,
  },
  {
    title: 'Stonehenge, Windsor and Bath day trip', city: 'London', country: 'United Kingdom', category: 'Day trip', duration: '12 hours', ...pp(11500, 10200),
    summary: 'Windsor Castle, Stonehenge and the Roman Baths in one day by coach with a guide.',
    highlights: 'Windsor Castle\nStonehenge\nRoman Baths', inclusions: 'Coach and guide\nAll three entries', exclusions: 'Lunch',
    pickup: 'Gloucester Road, London', timing: 'Daily, 08:00–20:00', cancellation: FREE_24H,
  },
  {
    title: 'Edinburgh Castle entry', city: 'Edinburgh', country: 'United Kingdom', category: 'Culture & heritage', duration: '2 hours', ...pp(2400, 1500),
    summary: "Scotland's crown jewels, the Stone of Destiny and views over the city from Castle Rock.",
    highlights: 'Honours of Scotland\nStone of Destiny\nOne o’clock gun', inclusions: 'Timed entry ticket', exclusions: 'Audio guide',
    pickup: 'Edinburgh Castle esplanade', timing: 'Daily, 09:30–17:00', cancellation: DATED_TICKET,
  },

  // ---------- Europe ----------
  {
    title: 'Eiffel Tower summit by lift', city: 'Paris', country: 'France', category: 'Attraction tickets', duration: '2 hours', ...pp(3600, 1800),
    summary: 'Lifts to the second floor and the summit, with timed entry.',
    highlights: 'Summit at 276 m\nSecond-floor views', inclusions: 'Summit lift ticket', exclusions: 'Host or guide',
    pickup: 'Eiffel Tower, south pillar', timing: 'Daily, 09:30–22:45', cancellation: DATED_TICKET,
  },
  {
    title: 'Seine river sightseeing cruise', city: 'Paris', country: 'France', category: 'Cruise', duration: '1 hour', ...pp(1500, 700),
    summary: "An hour on the Seine past Notre-Dame, the Louvre and the Musée d'Orsay.",
    highlights: 'Notre-Dame\nLouvre\nEiffel Tower from the water', inclusions: 'Cruise ticket with commentary', exclusions: 'Transfers',
    pickup: 'Port de la Bourdonnais', timing: 'Daily, every 30 minutes 10:00–22:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Disneyland Paris one-day ticket', city: 'Paris', country: 'France', category: 'Attraction tickets', duration: 'Full day', ...pp(7600, 7000),
    summary: 'One day at Disneyland Park or Walt Disney Studios Park.',
    highlights: 'Sleeping Beauty Castle\nParades and fireworks', inclusions: 'One-day, one-park ticket', exclusions: 'Transfers\nMeals',
    pickup: 'Disneyland Paris', timing: 'Daily, 09:30–22:00', cancellation: DATED_TICKET,
  },
  {
    title: 'Jungfraujoch, Top of Europe', city: 'Interlaken', country: 'Switzerland', category: 'Day trip', duration: 'Full day', ...pp(19500, 9800),
    summary: "Cog railway to Europe's highest railway station at 3,454 m, with the Ice Palace and Sphinx terrace.",
    highlights: 'Sphinx observation terrace\nIce Palace\nAletsch glacier views', inclusions: 'Return rail from Interlaken Ost', exclusions: 'Meals',
    pickup: 'Interlaken Ost station', timing: 'Daily, first train 07:05', cancellation: FREE_24H,
  },
  {
    title: 'Mount Titlis with rotating cable car', city: 'Lucerne', country: 'Switzerland', category: 'Day trip', duration: '8 hours', ...pp(13800, 6900),
    summary: 'The Rotair cable car to the glacier, the Cliff Walk and the ice grotto, from Lucerne.',
    highlights: 'Rotair revolving cable car\nTitlis Cliff Walk\nGlacier cave', inclusions: 'Return coach from Lucerne\nCable cars', exclusions: 'Lunch',
    pickup: 'Lucerne, Löwenplatz', timing: 'Daily, 08:30–16:30', cancellation: FREE_24H,
  },
  {
    title: 'Colosseum, Roman Forum and Palatine Hill guided tour', city: 'Rome', country: 'Italy', category: 'Culture & heritage', duration: '3 hours', ...pp(5200, 3600),
    summary: 'Skip-the-line guided tour of the Colosseum and the heart of ancient Rome.',
    highlights: 'Colosseum arena floor views\nRoman Forum\nPalatine Hill', inclusions: 'Entry tickets\nLicensed guide\nHeadsets', exclusions: 'Transfers',
    pickup: 'Near the Colosseum metro station', timing: 'Daily, several start times', cancellation: FREE_24H,
  },
  {
    title: 'Venice gondola ride', city: 'Venice', country: 'Italy', category: 'Shows & experiences', duration: '30 minutes', ...group(8500, 5),
    summary: 'A private gondola through the side canals and under the Rialto bridge.',
    highlights: 'Grand Canal\nRialto bridge\nQuiet side canals', inclusions: 'Private gondola (up to 5 guests)', exclusions: 'Serenade',
    pickup: 'Bacino Orseolo, near St Mark’s Square', timing: 'Daily, 09:00–19:00', cancellation: FREE_24H,
  },
  {
    title: 'Amsterdam canal cruise', city: 'Amsterdam', country: 'Netherlands', category: 'Cruise', duration: '1 hour', ...pp(1700, 1000),
    summary: 'The UNESCO-listed canal ring by glass-topped boat, with audio commentary.',
    highlights: 'Canal ring\nSeven bridges view\nSkinny Bridge', inclusions: 'Cruise ticket', exclusions: 'Drinks',
    pickup: 'Opposite Amsterdam Centraal', timing: 'Daily, every 30 minutes', cancellation: DATED_TICKET,
  },
  {
    title: 'Keukenhof gardens with transfer', city: 'Amsterdam', country: 'Netherlands', category: 'Nature & wildlife', duration: '5 hours', ...pp(4200, 2600),
    summary: 'Seven million tulips in spring, with return coach from Amsterdam.',
    highlights: 'Tulip fields\nWindmill views', inclusions: 'Entry ticket\nReturn coach', exclusions: 'Lunch',
    pickup: 'Amsterdam Museumplein', timing: 'Mid-March to mid-May only', cancellation: DATED_TICKET,
  },
  {
    title: 'Sagrada Família skip-the-line entry', city: 'Barcelona', country: 'Spain', category: 'Attraction tickets', duration: '1.5 hours', ...pp(3100, 3100),
    summary: "Timed entry to Gaudí's basilica with an audio guide.",
    highlights: 'Nativity and Passion facades\nStained-glass interior', inclusions: 'Timed ticket\nAudio guide', exclusions: 'Tower access',
    pickup: 'Sagrada Família, Carrer de la Marina', timing: 'Daily, 09:00–18:00', cancellation: DATED_TICKET,
  },
];
