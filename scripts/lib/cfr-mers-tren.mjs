// scripts/lib/cfr-mers-tren.mjs
// Pure parsing + matching for the official Romanian national timetable
// ("Mersul trenurilor") that CFR Călători publishes as open data on
// data.gov.ro — one XML per licensed carrier per timetable year, valid from
// the second Sunday in December. No network, no fs: the adapter
// (scripts/adapters/cfr.mjs) does the I/O and hands the bytes in here.
//
// What the file is: an attribute-only XML. Each <Tren> (train) carries one or
// more <Trasa> (route variants), each a sequence of <ElementTrasa> segments
// from one station to the next with a departure time at the origin (OraP) and
// an arrival time at the destination (OraS), both in SECONDS since midnight.
// The stop list is therefore rebuilt from consecutive segments: a station is
// a commercial stop when the train dwells there (next departure > arrival) or
// the segment says so. Every field name lives in FIELDS below with the
// alternates seen across timetable years, so a renamed attribute is a one-line
// fix, and the parser reports what it found (tag + attribute census) so the
// nightly log doubles as the probe when a year's file changes shape.
//
// What the file is not: it has no coordinates and no geometry, and it stops at
// the Romanian border. Coordinates come from Back-on-Track's station table
// (1 070 Romanian stops), which is also where the canonical spelling comes
// from — the XML is ASCII-folded ("Bucuresti Nord"), the map is not
// ("București Nord"), and a via station only becomes a map dot when it matches
// a coordinate-bearing stop by name. International trains keep Back-on-Track's
// foreign stretch and get the official Romanian stretch spliced in
// (`coverage: "partial"`).

import zlib from "node:zlib";

// ─── Field map ──────────────────────────────────────────────────────────────
// First name of each list is the one the 2025–2026 file uses; the rest are
// alternates accepted case-insensitively.

export const FIELDS = {
  train: ["Tren", "Train"],
  trainNumber: ["Numar", "NumarTren", "Nr", "Number"],
  trainCategory: ["CategorieTren", "Categorie", "Category"],
  trainOperator: ["Operator", "OperatorFeroviar"],
  route: ["Trasa", "Route"],
  routeType: ["Tip", "TipTrasa"],
  element: ["ElementTrasa", "Element", "Segment"],
  sequence: ["Secventa", "Secv", "Seq"],
  fromName: [
    "DenStaOrigine",
    "DenStaOrig",
    "StatieOrigine",
    "DenumireStatieOrigine",
    "From",
  ],
  toName: [
    "DenStaDestinatie",
    "DenStaDest",
    "StatieDestinatie",
    "DenumireStatieDestinatie",
    "To",
  ],
  fromCode: ["CodStaOrigine", "CodStaOrig", "CodStatieOrigine"],
  toCode: ["CodStaDest", "CodStaDestinatie", "CodStatieDestinatie"],
  departure: ["OraP", "OraPlecare", "Plecare"],
  arrival: ["OraS", "OraSosire", "Sosire"],
  dwell: ["StationareSecunde", "Stationare", "Oprire"],
  stopType: ["TipOprire", "Oprire", "StopType"],
};

// TipOprire values that mean "runs through without a commercial stop". Only
// consulted when the times give no dwell; an unknown value never hides a stop.
const NO_STOP_TYPES = new Set([
  "F",
  "T",
  "N-",
  "X",
  "FARA",
  "FARA OPRIRE",
  "0",
]);

const ENTITY = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function decodeXmlEntities(value) {
  return String(value ?? "").replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (m, e) => {
      if (e[0] === "#") {
        const code =
          e[1].toLowerCase() === "x"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITY[e.toLowerCase()] ?? m;
    },
  );
}

// ─── Minimal attribute-XML tokenizer ────────────────────────────────────────
// The timetable is attribute-only (no text nodes matter), so a regex walk over
// start/empty/end tags is enough and keeps the 30–40 MB file out of any DOM.
const TAG_RE =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR_RE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw)))
    attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  return attrs;
}

/** Case-insensitive attribute read over the FIELDS alternates. */
function attr(attrs, names) {
  for (const n of names) {
    if (attrs[n] != null) return attrs[n];
  }
  const lower = new Map(Object.keys(attrs).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k != null) return attrs[k];
  }
  return null;
}

const isTag = (name, names) =>
  names.some((n) => n.toLowerCase() === name.toLowerCase());

/**
 * "36000" → 36000; "10:00" / "10:00:00" → 36000; blanks → null. Values are
 * seconds since the service day's midnight; >24h is a next-day time.
 */
export function parseTimeSeconds(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** 36000 → "10:00"; 90000 (next day 01:00) → "01:00". */
export function secondsToHHMM(sec) {
  if (!Number.isFinite(sec)) return null;
  const day = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(day / 3600);
  const m = Math.floor((day % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Parse the timetable XML into trains with rebuilt stop lists.
 *
 * @param {string} xml
 * @param {object} [options]
 * @param {Set<string>|string[]|null} [options.onlyNumbers] Train numbers to
 *   keep (bare, as strings). null = everything.
 * @returns {{ trains: Map<string, object[]>, stats: object }}
 *   trains: number → [{ number, category, operator, stops: [{ name, code,
 *   arrival, departure }] }] (one per <Trasa>, longest first);
 *   stats: tag/attribute census for the log.
 */
export function parseMersTrenXml(xml, { onlyNumbers = null } = {}) {
  const wanted = onlyNumbers ? new Set([...onlyNumbers].map(String)) : null;
  const stats = { tags: {}, attrs: {}, trains: 0, routes: 0, elements: 0 };
  const trains = new Map();

  let train = null; // { number, category, operator, routes: [] }
  let route = null; // { type, elements: [] }
  let depth = 0;
  let skipTrain = false;

  const countAttrs = (tag, attrs) => {
    const bucket = (stats.attrs[tag] ??= {});
    for (const k of Object.keys(attrs)) bucket[k] = (bucket[k] ?? 0) + 1;
  };

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(xml))) {
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      depth -= 1;
      if (isTag(name, FIELDS.route) && route && train) {
        train.routes.push(route);
        route = null;
      } else if (isTag(name, FIELDS.train) && train) {
        finishTrain();
      }
      continue;
    }
    stats.tags[name] = (stats.tags[name] ?? 0) + 1;
    const attrs = parseAttrs(rawAttrs);
    if (Object.keys(stats.attrs).length < 40) countAttrs(name, attrs);

    if (isTag(name, FIELDS.train)) {
      stats.trains += 1;
      const number = String(attr(attrs, FIELDS.trainNumber) ?? "").trim();
      skipTrain = wanted ? !wanted.has(number) : false;
      train = skipTrain
        ? null
        : {
            number,
            category: (attr(attrs, FIELDS.trainCategory) ?? "").trim() || null,
            operator: (attr(attrs, FIELDS.trainOperator) ?? "").trim() || null,
            routes: [],
          };
      route = null;
      if (selfClosing) finishTrain();
    } else if (isTag(name, FIELDS.route)) {
      stats.routes += 1;
      if (train) route = { type: attr(attrs, FIELDS.routeType), elements: [] };
      if (selfClosing && route && train) {
        train.routes.push(route);
        route = null;
      }
    } else if (isTag(name, FIELDS.element)) {
      stats.elements += 1;
      if (train) {
        if (!route) route = { type: null, elements: [] };
        route.elements.push({
          seq:
            Number(attr(attrs, FIELDS.sequence)) || route.elements.length + 1,
          from: (attr(attrs, FIELDS.fromName) ?? "").trim(),
          to: (attr(attrs, FIELDS.toName) ?? "").trim(),
          fromCode: attr(attrs, FIELDS.fromCode),
          toCode: attr(attrs, FIELDS.toCode),
          departure: parseTimeSeconds(attr(attrs, FIELDS.departure)),
          arrival: parseTimeSeconds(attr(attrs, FIELDS.arrival)),
          dwell: parseTimeSeconds(attr(attrs, FIELDS.dwell)),
          stopType: attr(attrs, FIELDS.stopType),
        });
      }
    }
    if (!selfClosing) depth += 1;
  }
  if (train) finishTrain();

  function finishTrain() {
    if (route && train) train.routes.push(route);
    route = null;
    if (!train || !train.number) {
      train = null;
      return;
    }
    const variants = train.routes
      .map((r) => stopsFromElements(r.elements))
      .filter((stops) => stops.length >= 2)
      .sort((a, b) => b.length - a.length)
      .map((stops) => ({
        number: train.number,
        category: train.category,
        operator: train.operator,
        stops,
      }));
    if (variants.length) {
      const list = trains.get(train.number) ?? [];
      list.push(...variants);
      trains.set(train.number, list);
    }
    train = null;
  }

  return { trains, stats };
}

/**
 * Segments → commercial stops. A station between two segments is kept when the
 * train dwells there (departure later than arrival), when the segment's dwell
 * field says so, or when the stop type is not a known run-through marker.
 * Endpoints are always kept.
 */
export function stopsFromElements(elements) {
  const segs = [...(elements ?? [])]
    .filter((e) => e && (e.from || e.to))
    .sort((a, b) => a.seq - b.seq);
  if (!segs.length) return [];
  const stops = [];
  const first = segs[0];
  stops.push({
    name: first.from,
    code: first.fromCode ?? null,
    arrival: null,
    departure: first.departure,
  });
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const next = segs[i + 1] ?? null;
    const isLast = !next;
    if (!seg.to) continue;
    if (isLast) {
      stops.push({
        name: seg.to,
        code: seg.toCode ?? null,
        arrival: seg.arrival,
        departure: null,
      });
      break;
    }
    const departure = next.departure;
    const dwellFromTimes =
      Number.isFinite(seg.arrival) && Number.isFinite(departure)
        ? departure - seg.arrival
        : null;
    const stopType = (next.stopType ?? seg.stopType ?? "")
      .toString()
      .trim()
      .toUpperCase();
    const dwell = Number.isFinite(next.dwell) ? next.dwell : dwellFromTimes;
    let isStop;
    if (Number.isFinite(dwell)) isStop = dwell > 0;
    else if (stopType) isStop = !NO_STOP_TYPES.has(stopType);
    else isStop = true;
    if (!isStop) continue;
    stops.push({
      name: seg.to,
      code: seg.toCode ?? null,
      arrival: seg.arrival,
      departure,
    });
  }
  return stops;
}

// ─── Station names ──────────────────────────────────────────────────────────

/**
 * Comparison key for a station name across the XML's ASCII folding and the
 * map's diacritics: "Bucuresti Nord" ≡ "București Nord", "Timisoara Nord" ≡
 * "Timişoara Nord" (cedilla) ≡ "Timișoara Nord" (comma below), "Cluj Napoca"
 * ≡ "Cluj-Napoca". Also drops the "h." (halt) marker and stray punctuation.
 */
export function foldStationName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/ş/g, "s")
    .replace(/ţ/g, "t")
    .replace(/ș/g, "s")
    .replace(/ț/g, "t")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bh\.\s*/g, " ")
    .replace(/\bhm\.\s*/g, " ")
    .replace(/[.,'’"()]/g, " ")
    .replace(/[-–—/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leading city token of a folded name — "ploiesti" for both Ploiești stations. */
export function cityKey(name) {
  return foldStationName(name).split(" ")[0] ?? "";
}

/**
 * Station resolver over Back-on-Track's stop table: folded name → canonical
 * BoT spelling + coordinates. `preferred` (names already used by BoT rows)
 * wins when several stops fold to the same key ("Timişoara Nord" vs
 * "Timișoara Nord"); `overrides` (station-coordinates.json) and `catalog`
 * (the allowlist's own stations) add coordinates BoT lacks.
 *
 * @returns {(name: string) => { name: string, lat: number|null, lon: number|null, known: boolean }}
 */
export function makeCfrStationIndex({
  botStops = {},
  preferred = [],
  overrides = {},
  catalog = {},
  countries = ["RO", "MD", "HU", "BG", "UA", "RS"],
} = {}) {
  const wantedCountries = countries ? new Set(countries) : null;
  const index = new Map();
  const preferredKeys = new Set((preferred ?? []).map(foldStationName));
  const add = (name, lat, lon, priority) => {
    const key = foldStationName(name);
    if (!key) return;
    const current = index.get(key);
    if (!current || priority > current.priority)
      index.set(key, { name, lat, lon, priority });
  };
  for (const stop of Object.values(botStops ?? {})) {
    if (
      !stop?.stop_name ||
      !Number.isFinite(stop?.stop_lat) ||
      !Number.isFinite(stop?.stop_lon)
    )
      continue;
    const inRegion =
      !wantedCountries ||
      !stop.stop_country ||
      wantedCountries.has(stop.stop_country);
    const key = foldStationName(stop.stop_name);
    // Preferred (row-referenced) spellings first, then in-region stops, then
    // the rest — so a Bulgarian "Roman" never outranks Romania's.
    const priority =
      preferredKeys.has(key) && preferred.includes(stop.stop_name)
        ? 3
        : inRegion
          ? 2
          : 1;
    add(stop.stop_name, stop.stop_lat, stop.stop_lon, priority);
  }
  for (const [name, c] of Object.entries(catalog ?? {})) {
    if (Number.isFinite(c?.lat) && Number.isFinite(c?.lon))
      add(name, c.lat, c.lon, 4);
  }
  // Overrides only correct coordinates of a name we already know, or add a
  // brand-new name; they never rename.
  for (const [name, c] of Object.entries(overrides ?? {})) {
    if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon)) continue;
    const key = foldStationName(name);
    const current = index.get(key);
    if (current) index.set(key, { ...current, lat: c.lat, lon: c.lon });
    else index.set(key, { name, lat: c.lat, lon: c.lon, priority: 0 });
  }
  return (name) => {
    const raw = String(name ?? "").trim();
    const hit = index.get(foldStationName(raw));
    if (hit) return { name: hit.name, lat: hit.lat, lon: hit.lon, known: true };
    return { name: raw, lat: null, lon: null, known: false };
  };
}

// ─── Matching official trains to Back-on-Track rows ─────────────────────────

/** "IRN 1954/R 8824" → ["1954", "8824"]; "IRN / IC 78" → ["78"]; "401" → ["401"]. */
export function trainNumbersFromLabel(label) {
  const out = [];
  for (const m of String(label ?? "").matchAll(/\d{1,6}/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Whether a Back-on-Track row is (co-)operated by the agency we enrich. */
export function rowInAgency(route, agencyPattern = "CFR") {
  const raw = (route?.bot_agency_id || route?.agency_id || "").toString();
  return raw
    .split(/[\/,+&]/)
    .map((s) => s.trim())
    .some((a) => a.toUpperCase() === String(agencyPattern).toUpperCase());
}

const sameStation = (a, b) => {
  const fa = foldStationName(a);
  const fb = foldStationName(b);
  return !!fa && fa === fb;
};
const sameCity = (a, b) => {
  const ca = cityKey(a);
  const cb = cityKey(b);
  return !!ca && ca === cb;
};

/** Legs whose end meets the next one's start, glued into one stop list. */
function stitchLegs(legs) {
  if (!legs.length) return null;
  let stops = [...legs[0].stops];
  for (const leg of legs.slice(1)) {
    const last = stops[stops.length - 1];
    const first = leg.stops[0];
    if (!sameStation(last.name, first.name) && !sameCity(last.name, first.name))
      return null;
    // Junction: keep the arrival of the incoming leg and the departure of the
    // outgoing one.
    stops[stops.length - 1] = {
      ...last,
      departure: first.departure ?? last.departure,
    };
    stops = stops.concat(leg.stops.slice(1));
  }
  return stops;
}

/**
 * Pick the official stop list for one direction of a Back-on-Track row.
 *
 * Strategies, in order:
 *   1. full — one XML train (or the label's legs stitched at their junction)
 *      whose endpoints are the row's endpoints (station, else city);
 *   2. partial — the XML covers the Romanian stretch only: its origin is the
 *      row's origin and its last stop is one of the row's via stations (or
 *      the mirror). The official stretch replaces that part of BoT's chain and
 *      BoT's remainder is kept, so the row still reaches Budapest.
 *
 * @param {{origin: string, destination: string, via: string}} rowDir
 * @param {string[]} numbers  From trainNumbersFromLabel, in label order
 * @param {Map<string, object[]>} xmlTrains  parseMersTrenXml().trains
 * @returns {{ stops: object[], coverage: "full"|"partial", numbers: string[] }|null}
 */
export function matchOfficialStops(rowDir, numbers, xmlTrains) {
  const { origin, destination, via } = rowDir;
  if (!origin || !destination) return null;
  const viaList = String(via ?? "")
    .split(" - ")
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = [origin, ...viaList, destination];
  const variants = (n) => xmlTrains.get(String(n)) ?? [];
  const endpointsMatch = (stops) => {
    const first = stops[0]?.name;
    const last = stops[stops.length - 1]?.name;
    return (
      (sameStation(first, origin) || sameCity(first, origin)) &&
      (sameStation(last, destination) || sameCity(last, destination))
    );
  };

  // 1a. Any single numbered train that runs the whole corridor.
  for (const n of numbers) {
    for (const v of variants(n)) {
      if (endpointsMatch(v.stops))
        return { stops: v.stops, coverage: "full", numbers: [n] };
    }
  }
  // 1b. Label legs stitched in label order (through cars: "IRN 1954/R 8824").
  if (numbers.length >= 2) {
    const legs = numbers.map((n) => variants(n)[0]).filter(Boolean);
    if (legs.length === numbers.length) {
      for (const ordered of [legs, [...legs].reverse()]) {
        const stitched = stitchLegs(ordered);
        if (stitched && endpointsMatch(stitched)) {
          return {
            stops: stitched,
            coverage: "full",
            numbers: ordered.map((l) => l.number),
          };
        }
      }
    }
  }
  // 2. Partial coverage: the official list ends (or starts) at a station BoT
  //    lists on the way — splice it into BoT's chain.
  for (const n of numbers) {
    for (const v of variants(n)) {
      const first = v.stops[0]?.name;
      const last = v.stops[v.stops.length - 1]?.name;
      const idxOf = (name) =>
        chain.findIndex((c) => sameStation(c, name) || sameCity(c, name));
      const startsAtOrigin =
        sameStation(first, origin) || sameCity(first, origin);
      const endsAtDest =
        sameStation(last, destination) || sameCity(last, destination);
      if (startsAtOrigin && !endsAtDest) {
        const cut = idxOf(last);
        if (cut > 0 && cut < chain.length - 1) {
          const rest = chain
            .slice(cut + 1)
            .map((name) => ({
              name,
              code: null,
              arrival: null,
              departure: null,
            }));
          return {
            stops: [...v.stops, ...rest],
            coverage: "partial",
            numbers: [n],
          };
        }
      } else if (endsAtDest && !startsAtOrigin) {
        const cut = idxOf(first);
        if (cut > 0 && cut < chain.length - 1) {
          const head = chain
            .slice(0, cut)
            .map((name) => ({
              name,
              code: null,
              arrival: null,
              departure: null,
            }));
          return {
            stops: [...head, ...v.stops],
            coverage: "partial",
            numbers: [n],
          };
        }
      }
    }
  }
  return null;
}

/**
 * Build the trains-file dict (keyed by Back-on-Track's own trip labels, so the
 * enrichment's exact-key match finds them) from the parsed XML and the rows in
 * scope.
 *
 * @param {object} args
 * @param {Map<string, object[]>} args.xmlTrains
 * @param {Record<string, object>} args.viewMap  Back-on-Track rows
 * @param {(name: string) => {name: string, lat: number|null, lon: number|null, known: boolean}} args.resolveStation
 * @param {string} args.today  YYYY-MM-DD, for the THH:MM datetimes
 * @param {string} [args.agencyPattern="CFR"]
 * @param {{label: string, numbers?: string[], origin?: string, destination?: string}[]} [args.extraTrains]
 *   Trains BoT does not list (become synthetic rows via the registry config).
 * @param {number} [args.minStops=3]  An official list shorter than this is
 *   worse than what BoT has and is not emitted.
 * @returns {{ trains: Record<string, object>, report: object }}
 */
export function buildCfrTrains({
  xmlTrains,
  viewMap,
  resolveStation,
  today,
  agencyPattern = "CFR",
  agencyId = "CFR",
  operatorName = "CFR Călători",
  extraTrains = [],
  minStops = 3,
}) {
  const trains = {};
  const report = {
    matched: [],
    partial: [],
    unmatched: [],
    skippedShort: [],
    unknownStations: new Set(),
  };

  const toStations = (stops) =>
    stops.map((s) => {
      const r = resolveStation(s.name);
      if (!r.known) report.unknownStations.add(s.name);
      return {
        id: s.code ?? null,
        name: r.name,
        location:
          Number.isFinite(r.lat) && Number.isFinite(r.lon)
            ? { latitude: r.lat, longitude: r.lon }
            : null,
        arrival: Number.isFinite(s.arrival)
          ? `${today}T${secondsToHHMM(s.arrival)}:00`
          : null,
        departure: Number.isFinite(s.departure)
          ? `${today}T${secondsToHHMM(s.departure)}:00`
          : null,
        pickup: true,
        dropoff: true,
      };
    });

  const emit = (label, match, meta) => {
    if (match.stops.length < minStops) {
      report.skippedShort.push(label);
      return;
    }
    trains[label] = {
      lineName: label,
      operator: operatorName,
      agency_id: agencyId,
      timetableSource: "data.gov.ro",
      coverage: match.coverage,
      officialNumbers: match.numbers,
      stations: toStations(match.stops),
      polyline: null,
      ...meta,
    };
    (match.coverage === "partial" ? report.partial : report.matched).push(
      label,
    );
  };

  for (const route of Object.values(viewMap ?? {})) {
    if (!rowInAgency(route, agencyPattern)) continue;
    for (const d of [0, 1]) {
      const label = (route[`trip_short_name_${d}`] ?? "").toString().trim();
      if (!label || trains[label]) continue;
      const numbers = trainNumbersFromLabel(label);
      if (!numbers.length) continue;
      const match = matchOfficialStops(
        {
          origin: route[`origin_trip_${d}`],
          destination: route[`destination_trip_${d}`],
          via: route[`via_${d}`],
        },
        numbers,
        xmlTrains,
      );
      if (!match) {
        report.unmatched.push(label);
        continue;
      }
      emit(label, match, { botRouteId: route.route_id ?? null });
    }
  }

  for (const extra of extraTrains ?? []) {
    const label = String(extra?.label ?? "").trim();
    if (!label || trains[label]) continue;
    const numbers = extra.numbers?.length
      ? extra.numbers.map(String)
      : trainNumbersFromLabel(label);
    const legs = numbers.map((n) => xmlTrains.get(n)?.[0]).filter(Boolean);
    if (!legs.length) {
      report.unmatched.push(label);
      continue;
    }
    const stops = legs.length === 1 ? legs[0].stops : stitchLegs(legs);
    if (!stops) {
      report.unmatched.push(label);
      continue;
    }
    if (extra.origin && extra.destination) {
      const m = matchOfficialStops(
        { origin: extra.origin, destination: extra.destination, via: "" },
        numbers,
        xmlTrains,
      );
      if (!m) {
        report.unmatched.push(label);
        continue;
      }
      emit(label, { ...m }, { frequency: extra.frequency ?? null });
    } else {
      emit(
        label,
        { stops, coverage: "full", numbers },
        { frequency: extra.frequency ?? null },
      );
    }
  }

  report.unknownStations = [...report.unknownStations].sort();
  return { trains, report };
}

// ─── data.gov.ro (CKAN) resource selection ──────────────────────────────────

/** Timetable year label for a date: 2026-09-03 → "2025-2026" (changes 2nd Sunday of Dec). */
export function timetableYearLabel(date = new Date()) {
  const y = date.getUTCFullYear();
  const dec = new Date(Date.UTC(y, 11, 1));
  const secondSunday = 1 + ((7 - dec.getUTCDay()) % 7) + 7;
  const change = new Date(Date.UTC(y, 11, secondSunday));
  return date >= change ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/**
 * Pick the resource to download from a CKAN package_show payload: a timetable
 * file (XML, or a zip of one), preferring the current timetable year in its
 * name, else the most recently modified. Returns null when nothing fits.
 *
 * @param {object} packageShow  The JSON body of /api/3/action/package_show
 * @param {{ now?: Date }} [options]
 * @returns {{ url: string, name: string, format: string, lastModified: string|null }|null}
 */
export function pickTimetableResource(packageShow, { now = new Date() } = {}) {
  const resources =
    packageShow?.result?.resources ?? packageShow?.resources ?? [];
  const candidates = resources
    .filter((r) => r?.url)
    .map((r) => {
      const format = String(r.format ?? "").toUpperCase();
      const url = String(r.url);
      const name = String(r.name ?? "");
      const isXml = format === "XML" || /\.xml(\?|$)/i.test(url);
      const isZip = format === "ZIP" || /\.zip(\?|$)/i.test(url);
      return {
        url,
        name,
        format: isXml ? "XML" : isZip ? "ZIP" : format || null,
        lastModified:
          r.last_modified ?? r.metadata_modified ?? r.created ?? null,
        ok: isXml || isZip,
      };
    })
    .filter((r) => r.ok);
  if (!candidates.length) return null;
  const year = timetableYearLabel(now);
  const [y1, y2] = year.split("-");
  const yearRe = new RegExp(
    `${y1}\\D{0,3}${y2}|${y1.slice(2)}\\D{0,3}${y2.slice(2)}`,
  );
  const score = (r) => {
    let s = 0;
    if (yearRe.test(r.name) || yearRe.test(r.url)) s += 100;
    if (r.format === "XML") s += 10;
    return s;
  };
  candidates.sort((a, b) => {
    const d = score(b) - score(a);
    if (d) return d;
    return Date.parse(b.lastModified ?? 0) - Date.parse(a.lastModified ?? 0);
  });
  const { ok, ...best } = candidates[0];
  return best;
}

/** Decode the raw bytes honouring the XML declaration's encoding. */
// The committed copy of the timetable is gzipped (the raw national file is far
// too big to hold in git uncompressed) while a downloaded one is not, so the
// bytes decide rather than the filename — a caller should not have to know
// which of the two it is holding.
function gunzipIfNeeded(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return zlib.gunzipSync(bytes);
  }
  return bytes;
}

export function decodeXmlBytes(buffer) {
  const bytes = gunzipIfNeeded(buffer);
  const head = bytes.subarray(0, 200).toString("latin1");
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  const enc = (m?.[1] ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** One-paragraph census for the log, so a changed file shape is diagnosable. */
export function describeParseStats(stats) {
  const tags = Object.entries(stats?.tags ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  const attrs = Object.entries(stats?.attrs ?? {})
    .slice(0, 6)
    .map(([tag, a]) => `${tag}{${Object.keys(a).slice(0, 14).join(",")}}`)
    .join(" ");
  return `trains=${stats?.trains ?? 0} routes=${stats?.routes ?? 0} elements=${stats?.elements ?? 0}; tags: ${tags}; attrs: ${attrs}`;
}
