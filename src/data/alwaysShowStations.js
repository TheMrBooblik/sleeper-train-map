/**
 * Stations that stay visible when zoomed out.
 *
 * Why this list exists:
 * - The zoomed-out map uses grid thinning to reduce marker density.
 * - Some major cities should still be visible even when thinning is active.
 * - This list is intentionally manual so we can tune it quickly over time.
 *
 * Notes:
 * - Keep names in the same form as station ids where possible.
 * - Name matching is normalized later with normalizeStationNameForLookup().
 */
export const alwaysShowStations = [
  "Amsterdam Centraal",
  "Athina",
  "Barcelona Sants",
  "Beograd Centar",
  "Berlin Hbf",
  "Bratislava hl.st.",
  "Brno hl.n.",
  "Bruxelles-Midi",
  "Budapest Keleti",
  "București Nord",
  "Düsseldorf Hbf",
  "Frankfurt*",
  "Frankfurt(Main)Süd",
  "Hamburg Hbf",
  "Köbenhavn H",
  "Köln Hbf",
  "Kraków Główny",
  "Ljubljana",
  "Madrid Chamartín",
  "Milano Centrale",
  "München Hbf",
  "Paris Gare de l'Est",
  "Praha hl.n.",
  "Roma Termini",
  "Sofia",
  "Warszawa Centralna",
  "Wien Hbf",
  "Zagreb Glavni kolodvor",
  "Zürich HB",
];
