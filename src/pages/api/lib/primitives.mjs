// lib/primitives.mjs
// Pure, dependency-free helpers shared by the live API routes and the
// build-time canonicalize script. ESM (.mjs) so raw `node` can import it
// without transpilation; `.mjs` is not in Next's default pageExtensions, so
// this file is never exposed as an API route.
//
// Single source of truth — the legacy locations re-export from here:
//   src/lib/trainOperatorsFilter.js  → isTrain4you, TRAIN4YOU_AGENCY_ID
//   src/data/stationAliases.js       → STATION_ALIASES, resolveCanonicalStationName
//   src/pages/api/trains.js          → route-id / view-map activity helpers

// ─── Active-record filter ──────────────────────────────────────────────────

export function isActiveRecord(record) {
  return (record?.is_active || "Y").toString().toUpperCase() !== "N";
}

// ─── Train4you (Urlaubs-Express / UEX) detection ────────────────────────────

export const TRAIN4YOU_AGENCY_ID = "UEX";

const TRAIN4YOU_PATTERNS = [
  /train\s*4\s*you/i,
  /train4you/i,
  /vertriebs\s*gmbh/i,
  /t4y\s*\d*/i,
  /^\s*T4Y\s+/i,
];

export function isTrain4you(item = {}, tripName = "") {
  const agencyId = (item?.agency_id || "").toString().trim();
  if (agencyId === TRAIN4YOU_AGENCY_ID) {
    return true;
  }

  const name =
    tripName || item?.trip_short_name || item?.route_short_name || "";
  const operator = (item?.operator || "").toString();
  const combined = `${name} ${operator}`.toLowerCase();
  return TRAIN4YOU_PATTERNS.some(
    (re) => re.test(combined) || re.test(name) || re.test(operator),
  );
}

// ─── Station name aliases (NightJet German names → canonical BoT names) ──────

export const STATION_ALIASES = {
  // ── Italy: NightJet uses German city names ────────────────────────────────
  "venedig santa lucia":              "Venezia Santa Lucia",
  "venedig mestre":                   "Venezia Mestre",
  "rom termini":                      "Roma Termini",
  "rom tiburtina":                    "Roma Tiburtina",
  "rom ostiense":                     "Roma Ostiense",
  "rom trastevere":                   "Roma Trastevere",
  "mailand centrale":                 "Milano Centrale",
  "mailand porta garibaldi":          "Milano Porta Garibaldi",
  "mailand rogoredo":                 "Milano Rogoredo",
  "florenz santa maria novella":      "Firenze Santa Maria Novella",
  "florenz rifredi":                  "Firenze Rifredi",
  "neapel centrale":                  "Napoli Centrale",
  "genua piazza principe":            "Genova Piazza Principe",
  "genua sampierdarena":              "Genova Sampierdarena",
  "triest centrale":                  "Trieste Centrale",
  "turin porta nuova":                "Torino Porta Nuova",
  "turin porta susa":                 "Torino Porta Susa",
  "florenz campo di marte":            "Firenze Campo di Marte",
  // ── Belgium: NightJet uses German "Brüssel" ────────────────────────────────
  "brüssel midi":                     "Bruxelles Midi",
  "brüssel nord":                     "Bruxelles Nord",
  "brüssel central":                  "Bruxelles Central",
  "brüssel zentral":                  "Bruxelles Central",
  // ── Poland: NightJet uses German "Warschau"/"Krakau" ─────────────────────
  "warschau hbf":                     "Warszawa Centralna",
  "warschau wschodnia":               "Warszawa Wschodnia",
  "warschau zachodnia":               "Warszawa Zachodnia",
  "warschau centralna":               "Warszawa Centralna",
  "krakau glowny":                    "Kraków Główny",
  "krakau hauptbahnhof":              "Kraków Główny",
  // ── Short German city forms used when NightJet API only has a city-level name
  "venedig":                          "Venezia",
  "mailand":                          "Milano",
  "florenz":                          "Firenze",
  "neapel":                           "Napoli",
  "genua":                            "Genova",
  "triest":                           "Trieste",
  "rom":                              "Roma",
  "turin":                            "Torino",
  // ── Polish/Czech: NJ uses ASCII/unaccented names, BoT uses local diacritics ──
  // Bug-causing: both NJ and BoT have non-deleted routes through these stations
  // with different names → duplicate city entries + duplicate overlapping markers.
  "kattowitz":                        "Katowice",
  "sosnowiec glowny":                 "Sosnowiec Główny",
  "przemysl gl.":                     "Przemyśl Gł.",
  "rzeszow gl.":                      "Rzeszow Gł.",
  "opoczno poludniowe":               "Opoczno Południe",
  "rybnik(pl)":                       "Rybnik",
  "breclav":                          "Břeclav",
  "bohumin":                          "Bohumín",
  // ── Czech cities: NightJet uses German names ──────────────────────────────────
  // "Hbf" = Hauptbahnhof = Czech "hl.n." (hlavní nádraží) = main station.
  // Map to canonical BoT forms so NJ and BoT stops share one city dict entry.
  "pardubice hbf":                        "Pardubice hl.n.",
  "brünn hbf":                            "Brno hl.n.",
  "prag hbf":                             "Praha hl.n.",
  "prag-holesovice":                      "Praha-Holešovice",
  // ── RegioJet (Czech/Slovak GTFS names) ──────────────────────────────────────
  // Applied after normalizeRjGtfsName() strips ", žst." / ", Hlavní nádraží" etc.
  "čop":                              "Chop",
  "krakov hlavní nádraží":            "Kraków Gł.",
  "řešov hlavní nádraží":             "Rzeszow Gł.",
  "přemyšl hlavní nádraží":           "Przemyśl Gł.",
  // Via-only stations on the same routes (no double-marker, but wrong display name)
  "myslowice":                        "Mysłowice",
  "przemysl zasanie":                 "Przemyśl Zasanie",
  "krakow plaszow":                   "Kraków Płaszów",
  "jaroslaw":                         "Jarosław",
  "lancut":                           "Łańcut",
  "dabrowa gornicza":                 "Dąbrowa Górnicza",
  "wloszczowa polnoc":                "Włoszczowa Północ",
  "sedziszow malopolski":             "Sędziszów Małopolski",
  "debica":                           "Dębica",
  "raciborz":                         "Racibórz",
};

export function resolveCanonicalStationName(name) {
  if (!name) return name;
  return STATION_ALIASES[name.toLowerCase().trim()] ?? name;
}

// ─── view_ontd_map row activity (trips.json is authoritative per service) ────

export function routeIdsReferencedInTrips(trips) {
  const ids = new Set();
  for (const t of Object.values(trips || {})) {
    if (t?.route_id != null) ids.add(String(t.route_id));
  }
  return ids;
}

export function routeIdsFromFilteredTrips(filteredTrips) {
  const ids = new Set();
  for (const t of Object.values(filteredTrips || {})) {
    if (t?.route_id != null) ids.add(String(t.route_id));
  }
  return ids;
}

export function keepViewMapRowForTripActivity(
  routeRowAllowed,
  routeId,
  referencedIds,
  visibleIds,
) {
  if (!routeRowAllowed) return false;
  if (routeId == null) return true;
  const rid = String(routeId);
  if (!referencedIds.has(rid)) return true;
  return visibleIds.has(rid);
}
