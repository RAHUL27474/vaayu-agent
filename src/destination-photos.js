// One photo per destination (home page, packages without their own photo) and per city
// (hotels and activities without their own photo). VaayuTrip's own photos; Paris, Rome and Venice
// are public domain / CC0 from Wikimedia Commons, so no credit line is needed anywhere.
const DEST_PHOTOS = {
  "Dubai": "/img/destinations/dubai.jpg",
  "Bali": "/img/destinations/bali.jpg",
  "Vietnam": "/img/destinations/vietnam.jpg",
  "Cambodia": "/img/destinations/cambodia.jpg",
  "United Kingdom": "/img/destinations/united-kingdom.jpg",
  "Europe": "/img/destinations/europe.jpg"
};

const CITY_PHOTOS = {
  "Amsterdam": "/img/cities/amsterdam.jpg",
  "Barcelona": "/img/cities/barcelona.jpg",
  "Da Nang": "/img/cities/da-nang.jpg",
  "Edinburgh": "/img/cities/edinburgh.jpg",
  "Ha Long": "/img/cities/ha-long.jpg",
  "Hanoi": "/img/cities/hanoi.jpg",
  "Ho Chi Minh City": "/img/cities/ho-chi-minh-city.jpg",
  "Hoi An": "/img/cities/hoi-an.jpg",
  "Interlaken": "/img/cities/interlaken.jpg",
  "London": "/img/cities/london.jpg",
  "Lucerne": "/img/cities/lucerne.jpg",
  "Phnom Penh": "/img/cities/phnom-penh.jpg",
  "Siem Reap": "/img/cities/siem-reap.jpg",
  "Paris": "/img/cities/paris.jpg",
  "Rome": "/img/cities/rome.jpg",
  "Venice": "/img/cities/venice.jpg"
};

const V = '?v=2'; // bump when photos change, so browsers fetch the new ones
const destinationPhoto = (name) => (DEST_PHOTOS[name] ? DEST_PHOTOS[name] + V : null);
// A city's own photo; Dubai and Bali are both a city and a destination.
const cityPhoto = (name) => (CITY_PHOTOS[name] ? CITY_PHOTOS[name] + V : destinationPhoto(name));

module.exports = { DEST_PHOTOS, CITY_PHOTOS, destinationPhoto, cityPhoto };
