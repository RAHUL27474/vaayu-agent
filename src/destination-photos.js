// One photo per destination (home page cards and VaayuTrip/agent packages without their own photo).
// Freely licensed from Wikimedia Commons; the licences need the credit shown on /photo-credits.
const DEST_PHOTOS = {
  "Dubai": {
    "file": "/img/destinations/dubai.jpg",
    "title": "Night view of Dubai from the Burj Khalifa, April 2012 (31004629)",
    "artist": "Khari Ascutia",
    "license": "CC BY 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Night_view_of_Dubai_from_the_Burj_Khalifa,_April_2012_(31004629).jpg"
  },
  "Bali": {
    "file": "/img/destinations/bali.jpg",
    "title": "Brantan Bali Pura-Ulun-Danu-Bratan-01",
    "artist": "CEphoto, Uwe Aranas",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Brantan_Bali_Pura-Ulun-Danu-Bratan-01.jpg"
  },
  "Vietnam": {
    "file": "/img/destinations/vietnam.jpg",
    "title": "Ha Long Bay in 2019",
    "artist": "Taewangkorea",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Ha_Long_Bay_in_2019.jpg"
  },
  "Cambodia": {
    "file": "/img/destinations/cambodia.jpg",
    "title": "Angkor Wat with its reflection",
    "artist": "Satdeep Gill",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Angkor_Wat_with_its_reflection.jpg"
  },
  "United Kingdom": {
    "file": "/img/destinations/united-kingdom.jpg",
    "title": "Tower bridge London Twilight - November 2006",
    "artist": "Diliff",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Tower_bridge_London_Twilight_-_November_2006.jpg"
  },
  "Europe": {
    "file": "/img/destinations/europe.jpg",
    "title": "Eiffel Tower and Pont Alexandre III at night",
    "artist": "Getfunky Paris",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Eiffel_Tower_and_Pont_Alexandre_III_at_night.jpg"
  }
};

const destinationPhoto = (name) => (DEST_PHOTOS[name] ? DEST_PHOTOS[name].file : null);

module.exports = { DEST_PHOTOS, destinationPhoto };
