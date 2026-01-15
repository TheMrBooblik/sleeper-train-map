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

  // Italy - Rome stations
  // Add both "Roma" and "Rome" variants to handle different naming conventions
  "Roma Termini": { lat: 41.9005, lon: 12.5012 },
  "Rome Termini": { lat: 41.9005, lon: 12.5012 },
  "Roma Tiburtina": { lat: 41.9103, lon: 12.5308 },
  "Rome Tiburtina": { lat: 41.9103, lon: 12.5308 },
  "Roma Ostiense": { lat: 41.8704, lon: 12.4842 },
  "Rome Ostiense": { lat: 41.8704, lon: 12.4842 },
  "Roma Trastevere": { lat: 41.8703, lon: 12.4597 },
  "Rome Trastevere": { lat: 41.8703, lon: 12.4597 },

  // Germany
  "Siegen Hbf": { lat: 50.8711, lon: 8.0264 },
  "Siegburg/Bonn": { lat: 50.794, lon: 7.2026 },
  "Verden (Aller)": { lat: 52.9208, lon: 9.2379 },
};
