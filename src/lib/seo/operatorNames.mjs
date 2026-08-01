/**
 * Curated operator display names and URL slugs for SEO pages.
 *
 * Kept in a .mjs file so the raw-node verify suites can import the table
 * without pulling in operators.js (which uses an extensionless ./slugify
 * import that Node cannot resolve outside Next's bundler).
 *
 * Seeded from the human-readable comments in
 * src/components/Map/utils/operatorColors.js plus registry labels.
 * Names are chosen to read well in SEO titles such as
 * "{name} Night Train Routes & Destinations".
 *
 * agency_id is frequently compound ("PKP/ČD", "TCDD/BDŽ/CFR") — always run
 * it through splitAgencyIds() before looking an operator up here.
 *
 * @type {Record<string, { name: string, slug: string }>}
 */
export const OPERATORS = {
  // Central / Eastern Europe
  RJ: { name: "RegioJet", slug: "regiojet" },
  "ČD": { name: "Czech Railways", slug: "czech-railways" },
  ZSSK: { name: "ZSSK", slug: "zssk" },
  PKP: { name: "PKP Intercity", slug: "pkp-intercity" },
  "MÁV": { name: "MÁV-START", slug: "mav-start" },
  CFR: { name: "CFR Călători", slug: "cfr-calatori" },
  ATC: { name: "Astra Trans Carpatic", slug: "astra-trans-carpatic" },
  "HŽPP": { name: "Croatian Railways", slug: "croatian-railways" },
  // Leo Express night train Przemyśl ↔ Frankfurt (BoT agency_id "LE")
  LE: { name: "Leo Express", slug: "leo-express" },

  // Western Europe
  "ÖBB": { name: "Nightjet", slug: "nightjet" },
  SNCF: { name: "SNCF", slug: "sncf" },
  FS: { name: "Trenitalia", slug: "trenitalia" },
  ES: { name: "European Sleeper", slug: "european-sleeper" },
  CS: { name: "Caledonian Sleeper", slug: "caledonian-sleeper" },
  GWR: { name: "Great Western Railway", slug: "great-western-railway" },
  MT: { name: "Midnight Trains", slug: "midnight-trains" },

  // Scandinavia
  SJ: { name: "SJ", slug: "sj" },
  SJN: { name: "SJ Nord", slug: "sj-nord" },
  ST: { name: "Snälltåget", slug: "snalltaget" },
  VY: { name: "Vy", slug: "vy" },
  GA: { name: "Go-Ahead Nordic", slug: "go-ahead-nordic" },
  VR: { name: "VR", slug: "vr" },
  RDC: { name: "RDC / BahnTouristikExpress", slug: "rdc" },

  // Southeast Europe / Balkans
  "BDŽ": { name: "Bulgarian Railways", slug: "bulgarian-railways" },
  "ŽPCG": { name: "Montenegro Railways", slug: "montenegro-railways" },
  "ŽS": { name: "Serbian Railways", slug: "serbian-railways" },

  // Other
  TCDD: { name: "Turkish State Railways", slug: "tcdd" },
  UZ: { name: "Ukrainian Railways", slug: "ukrainian-railways" },
  CFM: { name: "Moldovan Railways", slug: "moldovan-railways" },
  OTE: { name: "Optima Tours", slug: "optima-tours" },
  UEX: { name: "Urlaubs-Express", slug: "urlaubs-express" },

  // China
  CR: { name: "China Railway", slug: "china-railway" },

  // Caucasus
  GR: { name: "Georgian Railway", slug: "georgian-railway" },
  ADY: { name: "Azerbaijan Railways", slug: "azerbaijan-railways" },
  SCR: { name: "South Caucasus Railway", slug: "south-caucasus-railway" },

  // North America
  AMTK: { name: "Amtrak", slug: "amtrak" },
  VIA: { name: "VIA Rail", slug: "via-rail" },
};
