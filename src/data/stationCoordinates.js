/**
 * Custom station coordinates database
 *
 * This file contains manually verified coordinates for train stations.
 * These coordinates take priority over coordinates from Open Night Train Database
 * because the database sometimes contains incorrect coordinates.
 *
 * Format: { "Station Name": { lat: number, lon: number } }
 */

export const stationCoordinates = {
  // Stations with corrected coordinates (Open Night Train Database has incorrect coordinates for these)

  // Austria
  Rankweil: { lat: 47.271967, lon: 9.637455 },
  "Stainach-Irdning": { lat: 47.52946, lon: 14.106571 },
  Schladming: { lat: 47.393842, lon: 13.678135 },
  "Schwarzach-St.Veit": { lat: 47.31875, lon: 13.154265 },
  "St. Valentin": { lat: 48.17866, lon: 14.522561 },
  Vöcklabruck: { lat: 48.0099, lon: 13.66375 },

  // Bulgaria
  Burgas: { lat: 42.490711, lon: 27.472588 },
  // Roman stations exist in both Bulgaria and Romania
  // Both are added to ensure both appear in stops even if API returns only one
  "Roman (Bulgaria)": { lat: 43.154514, lon: 23.921453 },
  Roman: { lat: 46.9346624, lon: 26.9199022 },
  Byala: { lat: 43.4688687, lon: 25.6693882 },
  Cerovo: { lat: 43.0038202, lon: 23.3494061 },
  Dobrich: { lat: 43.5661751, lon: 27.8156075 },
  Donchevo: { lat: 43.5183981, lon: 27.7680854 },
  "General Kiselovo": { lat: 43.4431373, lon: 27.5967086 },
  Oborishte: { lat: 43.4561214, lon: 27.6479988 },
  Sadov: { lat: 42.1309, lon: 24.9395 },
  Yastrebovo: { lat: 43.7478405, lon: 26.1253795 },
  Zlatica: { lat: 42.71598295, lon: 24.1264484 },

  // Czech Republic
  "Ústí nad Labem hl.n.": { lat: 50.659881, lon: 14.044687 },

  // Latvia — Back-on-Track once shipped a garbage string for stop_lon here; override with a real point near RIX / Rail Baltica plans
  "Rīga Airport (Rail Baltica)": { lat: 56.92235, lon: 23.97085 },

  // Italy - Rome stations
  // Add both "Roma" and "Rome" variants to handle different naming conventions.
  // BoT GTFS assigns wildly wrong coordinates (pointing to Germany/Belgium) to Rome's
  // suburban commuter stations — override all of them here.
  "Roma Termini": { lat: 41.9005, lon: 12.5012 },
  "Rome Termini": { lat: 41.9005, lon: 12.5012 },
  "Roma Tiburtina": { lat: 41.9103, lon: 12.5308 },
  "Rome Tiburtina": { lat: 41.9103, lon: 12.5308 },
  "Roma Ostiense": { lat: 41.8704, lon: 12.4842 },
  "Rome Ostiense": { lat: 41.8704, lon: 12.4842 },
  "Roma Trastevere": { lat: 41.8630, lon: 12.4621 },
  "Rome Trastevere": { lat: 41.8630, lon: 12.4621 },
  // Suburban/commuter stations — BoT coordinates are completely wrong for these
  "Roma Aurelia": { lat: 41.8882, lon: 12.4302 },
  "Roma Balduina": { lat: 41.9206, lon: 12.4441 },
  "Roma Laziali": { lat: 41.8903, lon: 12.5195 },
  "Roma Monte Mario": { lat: 41.9316, lon: 12.4430 },
  "Roma Nomentana": { lat: 41.9002, lon: 12.5340 },
  "Roma Porta San Paolo": { lat: 41.8660, lon: 12.4746 },
  "Roma Prenestina": { lat: 41.8871, lon: 12.5534 },
  "Roma San Filippo Neri": { lat: 41.8964, lon: 12.4697 },
  "Roma San Pietro": { lat: 41.8991, lon: 12.4574 },
  "Roma Tuscolana": { lat: 41.8869, lon: 12.5355 },

  // Germany
  "Siegen Hbf": { lat: 50.8711, lon: 8.0264 },
  "Siegburg/Bonn": { lat: 50.794, lon: 7.2026 },
  "Verden (Aller)": { lat: 52.9208, lon: 9.2379 },
    
  // Norway
  Dale: { lat: 60.5863, lon: 5.8158 }, 
  Sandvika: { lat: 59.8928, lon: 10.5257 },    

  // Turkey
  Konya: { lat: 37.8666, lon: 32.4764 },
    
  // Ukraine
  "Kyiv Pasazhyrskyi": { lat: 50.4402, lon: 30.4888 },
  "Kropyvnytskyi": { lat: 48.5236, lon: 32.2607 },  
  "Voznesens'k": { lat: 47.5606, lon: 31.3162 },  
  Kodyma: { lat: 48.0897, lon: 29.1202 },  
  Zhmerynka: { lat: 49.0354, lon: 28.1124 },
  // Popilnia: { lat: 49.8907, lon: 29.3374 },
  "Koziatyn I": { lat: 49.7086, lon: 28.8292 },
  // Uladivka: { lat: 49.5081, lon: 28.1966 },
  Khmilnyk: { lat: 49.5592, lon: 27.9845 },
  "Starokostiantyniv II": { lat: 49.7436, lon: 27.2143 },
  // Adampil: { lat: 49.6695, lon: 27.6702 },
  // Krasyliv: { lat: 49.6698, lon: 27.0131 },
  Hrechany: { lat: 49.4417, lon: 26.9305 },
  // Yarmolyntsi: { lat: 49.1789, lon: 26.8042 },
  // Dunaivtsi: { lat: 49.0223, lon: 26.8399 },
  Balyn: { lat: 48.9066, lon: 26.6346 },
  "Kamianets-Podilskyi": { lat: 48.6833, lon: 26.5833 },
  // Shepetivka: { lat: 50.2000, lon: 27.0577 },
  Berdychiv: { lat: 49.8947, lon: 28.5862 },
  // Zdolbuniv: { lat: 50.5137, lon: 26.2475 }    
};