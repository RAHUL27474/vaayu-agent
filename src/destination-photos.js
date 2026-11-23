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

// One landmark photo per city, for hotels and activities without their own photo (same source and credit rules).
const CITY_PHOTOS = {
  "Amsterdam": {
    "file": "/img/cities/amsterdam.jpg",
    "title": "Colorful canal houses at golden hour in Damrak avenue Amsterdam the Netherlands",
    "artist": "Basile Morin",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Colorful_canal_houses_at_golden_hour_in_Damrak_avenue_Amsterdam_the_Netherlands.jpg"
  },
  "Barcelona": {
    "file": "/img/cities/barcelona.jpg",
    "title": "View Park Guell Sagrada",
    "artist": "Danbu14",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:View_Park_Guell_Sagrada.jpg"
  },
  "Da Nang": {
    "file": "/img/cities/da-nang.jpg",
    "title": "Golden Bridge at Ba Na Hills 20250718",
    "artist": "DvTor8303",
    "license": "CC0",
    "source": "https://commons.wikimedia.org/wiki/File:Golden_Bridge_at_Ba_Na_Hills_20250718.jpg"
  },
  "Edinburgh": {
    "file": "/img/cities/edinburgh.jpg",
    "title": "Castle, City of Edinburgh (IMG 20190628 180330)",
    "artist": "Matti Blume",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Castle,_City_of_Edinburgh_(IMG_20190628_180330).jpg"
  },
  "Ha Long": {
    "file": "/img/cities/ha-long.jpg",
    "title": "Traditional junk, Halong Bay, Quang Ninh, Vietnam - Vịnh Hạ Long, Quảng Ninh, Việt Nam (10226220073)",
    "artist": "Romain Pontida",
    "license": "CC BY-SA 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Traditional_junk,_Halong_Bay,_Quang_Ninh,_Vietnam_-_V%E1%BB%8Bnh_H%E1%BA%A1_Long,_Qu%E1%BA%A3ng_Ninh,_Vi%E1%BB%87t_Nam_(10226220073).jpg"
  },
  "Hanoi": {
    "file": "/img/cities/hanoi.jpg",
    "title": "Hanoi - Turtle Tower (Tháp Rùa), Hoàn Kiếm Lake",
    "artist": "P. Hughes",
    "license": "CC BY 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Hanoi_-_Turtle_Tower_(Th%C3%A1p_R%C3%B9a),_Ho%C3%A0n_Ki%E1%BA%BFm_Lake.jpg"
  },
  "Ho Chi Minh City": {
    "file": "/img/cities/ho-chi-minh-city.jpg",
    "title": "Saigon at Blue Hour",
    "artist": "Radek Kucharski",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Saigon_at_Blue_Hour.jpg"
  },
  "Hoi An": {
    "file": "/img/cities/hoi-an.jpg",
    "title": "Hội An, Museum of Trade Ceramics, 2020-01 CN-02",
    "artist": "Steffen Schmitz (more photos)",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:H%E1%BB%99i_An,_Museum_of_Trade_Ceramics,_2020-01_CN-02.jpg"
  },
  "Interlaken": {
    "file": "/img/cities/interlaken.jpg",
    "title": "Lake Thun and Interlaken View from Harder Kulm (Ank Kumar) 01",
    "artist": "Ank Kumar",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Lake_Thun_and_Interlaken_View_from_Harder_Kulm_(Ank_Kumar)_01.jpg"
  },
  "London": {
    "file": "/img/cities/london.jpg",
    "title": "Big Ben at sunset - 2014-10-27 17-30",
    "artist": "Colin",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Big_Ben_at_sunset_-_2014-10-27_17-30.jpg"
  },
  "Lucerne": {
    "file": "/img/cities/lucerne.jpg",
    "title": "CH.LU.Luzern Kapellbrücke 01 16x9-R 16384x9216",
    "artist": "Roy Egloff NOTE: This image is a panorama consisting of mult",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:CH.LU.Luzern_Kapellbr%C3%BCcke_01_16x9-R_16384x9216.jpg"
  },
  "Paris": {
    "file": "/img/cities/paris.jpg",
    "title": "Louvre Pyramid and Cour Napoléon in Paris, July 2026 02",
    "artist": "Dev Jadiya",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Louvre_Pyramid_and_Cour_Napol%C3%A9on_in_Paris,_July_2026_02.jpg"
  },
  "Phnom Penh": {
    "file": "/img/cities/phnom-penh.jpg",
    "title": "2016 Phnom Penh, Pałac Królewski, Preah Tineang Phhochani (14)",
    "artist": "Marcin Konsek",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:2016_Phnom_Penh,_Pa%C5%82ac_Kr%C3%B3lewski,_Preah_Tineang_Phhochani_(14).jpg"
  },
  "Rome": {
    "file": "/img/cities/rome.jpg",
    "title": "Colosseum in Rome (3)",
    "artist": "Tournasol7",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Colosseum_in_Rome_(3).jpg"
  },
  "Siem Reap": {
    "file": "/img/cities/siem-reap.jpg",
    "title": "Bayon temple 02",
    "artist": "Krzysztof Golik",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Bayon_temple_02.jpg"
  },
  "Venice": {
    "file": "/img/cities/venice.jpg",
    "title": "Ponte di Rialto Venice 1",
    "artist": "kallerna",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Ponte_di_Rialto_Venice_1.jpg"
  }
};

const destinationPhoto = (name) => (DEST_PHOTOS[name] ? DEST_PHOTOS[name].file : null);
// A city's own photo; Dubai and Bali are both a city and a destination.
const cityPhoto = (city) => (CITY_PHOTOS[city] ? CITY_PHOTOS[city].file : destinationPhoto(city));

module.exports = { DEST_PHOTOS, CITY_PHOTOS, destinationPhoto, cityPhoto };
