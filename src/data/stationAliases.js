/**
 * Maps NightJet German station names → canonical Back-on-Track station names.
 * Keys are lowercase; use resolveCanonicalStationName() for lookups.
 *
 * Canonical = the form used by Back-on-Track (usually local language but
 * internationally recognised, e.g. "Venezia Santa Lucia" not "Venedig Santa Lucia").
 */
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
};

/**
 * Resolve a station name to its canonical Back-on-Track form.
 * Returns the original name unchanged when no alias is found.
 *
 * @param {string} name - Raw station name from any data source
 * @returns {string} Canonical station name
 */
export function resolveCanonicalStationName(name) {
  if (!name) return name;
  return STATION_ALIASES[name.toLowerCase().trim()] ?? name;
}
