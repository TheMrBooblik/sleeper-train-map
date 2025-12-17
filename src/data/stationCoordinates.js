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
  "Stainach-Irdning": { lat: 47.52946, lon: 14.106571 },
  "Schwarzach-St.Veit": { lat: 47.31875, lon: 13.154265 },
  "St. Valentin": { lat: 48.17866, lon: 14.522561 },
  Vöcklabruck: { lat: 48.0099, lon: 13.66375 },

  // Czech Republic
  "Ústí nad Labem hl.n.": { lat: 50.659881, lon: 14.044687 },
};
