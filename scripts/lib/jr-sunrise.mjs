// scripts/lib/jr-sunrise.mjs
// Pure logic for the Sunrise Izumo / Sunrise Seto source (JR West + JR Central,
// Japan). The adapter (scripts/adapters/jr-sunrise.mjs) fetches; everything that
// decides what a page says lives here, so tests run it without a network.
//
// Two things are read nightly from JR's own pages:
//
//   1. The timetable of each train (every stop's time), from JR West's train
//      timetable pages on timetable.jr-odekake.net.
//   2. The berth charges per room type, from JR West's Sunrise pages.
//
// The layout of neither page has been seen from the machine this was written
// on — JR's hosts are unreachable from the dev sandbox, as lefrecce.it and
// europeansleeper.eu were before them — so the parsers are deliberately
// layout-agnostic and the validation is deliberately strict:
//
//   - a page is read as a sequence of text segments in document order, a stop
//     is a segment that IS one of the train's own station names (not one that
//     contains it: 富士 must not match 富士川), and the times after it until the
//     next station-looking segment are that stop's;
//   - a train's scraped timetable is taken whole or not at all: every stop the
//     baseline lists must be found, in order, running forward in time with at
//     most one midnight, and no time may sit more than MAX_DRIFT_MINUTES from
//     the baseline's. JR moved the Tokyo departure by 24 minutes in March 2026;
//     a page that disagrees by hours is another train, not a timetable change.
//
// Taking a stop list from one page and times from another would be a row that
// contradicts itself (CLAUDE.md, "A row describes one train"), which is why a
// train that fails validation keeps the baseline for ALL its stops.

import polyline from "@mapbox/polyline";

/** Largest move, in minutes, a scraped time may make away from the baseline. */
export const MAX_DRIFT_MINUTES = 90;
/** A berth charge further than this from the baseline is a misread, not a fare change. */
export const MAX_ROOM_CHARGE_CHANGE = 0.35;

// ─── Text ────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  yen: "¥",
  ndash: "-",
  mdash: "-",
};

export function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * The page as text segments in document order: one per run of text between
 * tags, entities decoded, full-width digits and colons folded (NFKC), blank
 * runs dropped. A table cell, a link and a <b> each become their own segment,
 * which is what lets a station be matched as a whole segment.
 */
export function htmlSegments(html) {
  const stripped = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "\u0000")
    .replace(/<script[\s\S]*?<\/script>/gi, "\u0000")
    .replace(/<style[\s\S]*?<\/style>/gi, "\u0000")
    .replace(/<[^>]*>/g, "\u0000");
  return stripped
    .split("\u0000")
    .map((s) => decodeEntities(s).normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Fold a station name for comparison: NFKC, Latin diacritics off, lower-case,
 * spaces/hyphens/middle dots off, a trailing 駅 / "station" / "sta." off, and
 * a parenthetical qualifier off ("三ノ宮(JR)" → "三ノ宮").
 */
export function normalizeStationName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s\-‐‑–—・･.]/g, "")
    .replace(/(駅|station|sta)$/u, "");
}

/** stationId for a segment that IS one of the configured station names, else null. */
export function makeStationMatcher(stations) {
  const byName = new Map();
  for (const s of stations ?? []) {
    for (const n of [s.name, ...(s.aliases ?? [])]) {
      const key = normalizeStationName(n);
      if (key) byName.set(key, s.id);
    }
  }
  return (text) => byName.get(normalizeStationName(text)) ?? null;
}

// ─── Times ───────────────────────────────────────────────────────────────────

const ARR = "arr";
const DEP = "dep";

function labelOf(token) {
  if (!token) return null;
  const t = token.toLowerCase().replace(/\.$/, "");
  if (t === "着" || t === "arr" || t === "arrival" || t === "arrive" || t === "arrives") return ARR;
  if (t === "発" || t === "dep" || t === "departure" || t === "depart" || t === "departs") return DEP;
  return null;
}

// "21:26", "21:26発", "着 6:27", "Arr. 06:27", "Departure 21:26", "21時26分発".
const TIME_IN_TEXT =
  /(?:(着|発|arr(?:ival|ives?)?\.?|dep(?:arture|arts?)?\.?)\s*)?(\d{1,2})\s*(?::|時)\s*(\d{2})\s*分?\s*(着|発|arr(?:ival)?\.?|dep(?:arture)?\.?)?/gi;

function hhmm(h, m) {
  const hours = Number(h);
  const minutes = Number(m);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59 || hours > 29) return null;
  return `${String(hours % 24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Every time in a text segment, with the arrival/departure label beside it when there is one. */
export function timesInText(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TIME_IN_TEXT)) {
    const time = hhmm(m[2], m[3]);
    if (!time) continue;
    out.push({ time, label: labelOf(m[4]) ?? labelOf(m[1]) });
  }
  return out;
}

/** "23:59" → 1439. */
export function minutesOf(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// A timetable draws a stop the train passes without calling as レ (or an arrow,
// or a bar). The station is on the page — it is simply not a stop.
const PASS_MARK = /^(?:レ|↓|↑|‖|\||\|\||=|通過|pass(?:es)?|—|-)$/i;

// A segment reading like a station name we do not know: letters, no digits,
// short. It closes the current stop so the times of a station outside this
// train's pattern (Kotohira on an extension night, say) cannot be credited to
// the stop before it.
function looksLikeUnknownStation(seg) {
  return seg.length <= 16 && !/\d/.test(seg) && /[\p{L}]/u.test(seg) && !labelOf(seg) && !PASS_MARK.test(seg);
}

/** Split "東京 21:26発" / "東京発 21:26" / "Tokyo 21:26" into its station and the rest. */
function splitStationSegment(seg, matchStation) {
  const whole = matchStation(seg);
  if (whole) return { station: whole, rest: "" };
  const m = /^(.{1,24}?)\s*(着|発)?\s*(\d{1,2}\s*(?::|時)\s*\d{2}.*)$/u.exec(seg);
  if (!m) return null;
  const station = matchStation(m[1]);
  if (!station) return null;
  return { station, rest: `${m[2] ?? ""}${m[3]}` };
}

/**
 * The page as a list of stop records in document order:
 *   [{ station, times: [{ time, label }], pass }]
 * `station` is a configured station id; unknown stations are not recorded (but
 * close the record before them).
 */
export function extractStopRecords(html, matchStation) {
  const records = [];
  let current = null;
  let pendingLabel = null;
  for (let seg of htmlSegments(html)) {
    const split = splitStationSegment(seg, matchStation);
    if (split) {
      current = { station: split.station, times: [], pass: false };
      records.push(current);
      pendingLabel = null;
      if (!split.rest) continue;
      seg = split.rest;
    }
    if (!current) continue;
    const times = timesInText(seg);
    if (times.length) {
      for (const t of times) {
        current.times.push({ time: t.time, label: t.label ?? pendingLabel });
        pendingLabel = null;
      }
      continue;
    }
    if (labelOf(seg)) {
      pendingLabel = labelOf(seg);
      continue;
    }
    if (PASS_MARK.test(seg)) {
      if (!current.times.length) current.pass = true;
      continue;
    }
    if (looksLikeUnknownStation(seg)) {
      current = null;
      pendingLabel = null;
    }
  }
  return records;
}

/**
 * A record's arrival and departure, given where the stop sits in the train.
 * Labels win; an unlabeled pair reads arrival-then-departure; a lone unlabeled
 * time is the departure everywhere except at the terminus.
 */
export function resolveRecordTimes(times, role) {
  const labeledArr = times.find((t) => t.label === ARR)?.time ?? null;
  const labeledDep = [...times].reverse().find((t) => t.label === DEP)?.time ?? null;
  const plain = times.filter((t) => !t.label).map((t) => t.time);
  let arrival = labeledArr;
  let departure = labeledDep;
  if (plain.length >= 2) {
    arrival ??= plain[0];
    departure ??= plain[plain.length - 1];
  } else if (plain.length === 1) {
    if (role === "terminus") arrival ??= plain[0];
    else if (departure == null) departure = plain[0];
    else arrival ??= plain[0];
  }
  if (role === "origin") arrival = null;
  if (role === "terminus") departure = null;
  return { arrival, departure };
}

/**
 * Find one train's stops in a page's records, in order. Consecutive records of
 * the same station (an arrival row and a departure row) are merged.
 * Returns { stops, problems }; any problem means the page does not describe
 * this train.
 */
export function matchTrainInRecords(records, train) {
  const problems = [];
  const stops = [];
  let from = 0;
  const ids = train.stops.map((s) => s.station);
  ids.forEach((station, i) => {
    const role = i === 0 ? "origin" : i === ids.length - 1 ? "terminus" : "intermediate";
    const idx = records.findIndex(
      (r, j) => j >= from && r.station === station && (r.times.length > 0 || r.pass),
    );
    if (idx < 0) {
      problems.push(`${station} not found`);
      return;
    }
    const times = [...records[idx].times];
    let end = idx + 1;
    while (end < records.length && records[end].station === station) {
      times.push(...records[end].times);
      end++;
    }
    from = end;
    if (!times.length) {
      problems.push(`${station} is shown as passed, not served`);
      return;
    }
    stops.push({ station, ...resolveRecordTimes(times, role) });
  });
  return { stops, problems };
}

/**
 * Whether a scraped stop list can stand for the train: complete, forward in
 * time across at most one midnight, a plausible length, and close to the
 * baseline wherever the baseline states a time. Returns problems (empty = ok).
 */
export function validateScrapedStops(scraped, train, { maxDriftMinutes = MAX_DRIFT_MINUTES } = {}) {
  const problems = [];
  const baseline = train.stops;
  if (scraped.length !== baseline.length) {
    return [`found ${scraped.length} of ${baseline.length} stops`];
  }
  const first = scraped[0];
  const last = scraped[scraped.length - 1];
  if (!first.departure) problems.push(`no departure at ${first.station}`);
  if (!last.arrival) problems.push(`no arrival at ${last.station}`);
  scraped.slice(1, -1).forEach((s) => {
    if (!s.arrival && !s.departure) problems.push(`no time at ${s.station}`);
  });

  // Forward in time, allowing the one midnight a night train crosses.
  const sequence = [];
  for (const s of scraped) {
    if (s.arrival) sequence.push(minutesOf(s.arrival));
    if (s.departure) sequence.push(minutesOf(s.departure));
  }
  let wraps = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] < sequence[i - 1]) wraps++;
  }
  if (wraps > 1) problems.push(`times run backwards (${wraps} day changes)`);
  if (sequence.length >= 2) {
    const total = sequence[sequence.length - 1] - sequence[0] + wraps * 1440;
    if (total < 180 || total > 20 * 60) problems.push(`journey of ${total} minutes is implausible`);
  }

  // Drift against the baseline, wherever the baseline states a time.
  scraped.forEach((s, i) => {
    for (const field of ["arrival", "departure"]) {
      const want = minutesOf(baseline[i]?.[field]);
      const got = minutesOf(s[field]);
      if (want == null || got == null) continue;
      const diff = Math.abs(got - want);
      const circular = Math.min(diff, 1440 - diff);
      if (circular > maxDriftMinutes) {
        problems.push(`${s.station} ${field} ${s[field]} is ${circular} min from the baseline ${baseline[i][field]}`);
      }
    }
  });
  return problems;
}

/** Scrape one train out of one page: { stops } when it validates, else { problems }. */
export function timetableFromPage(html, train, matchStation, opts) {
  const records = extractStopRecords(html, matchStation);
  const { stops, problems } = matchTrainInRecords(records, train);
  if (problems.length) return { problems };
  const invalid = validateScrapedStops(stops, train, opts);
  return invalid.length ? { problems: invalid } : { stops };
}

/** Train-timetable ids linked from a JR West page (e.g. the Sunrise guide). */
export function discoverTimetableIds(html) {
  const ids = new Set();
  for (const m of String(html ?? "").matchAll(/train-timetable\/(\d{2,7})/g)) ids.add(Number(m[1]));
  return [...ids];
}

// ─── Berth charges ───────────────────────────────────────────────────────────

// Longest names first, so "シングルツイン" is never read as "シングル".
export const ROOM_NAMES = [
  ["singleDeluxe", ["シングルデラックス", "single deluxe"]],
  ["sunriseTwin", ["サンライズツイン", "sunrise twin"]],
  ["singleTwin", ["シングルツイン", "single twin"]],
  ["single", ["シングル", "single"]],
  ["solo", ["ソロ", "solo"]],
];

const YEN = /(?:¥\s*([\d,]{3,7})|([\d,]{3,7})\s*(?:円|yen))/i;

function roomOf(seg) {
  const key = normalizeStationName(seg).replace(/[「」『』【】\[\]]/g, "");
  for (const [room, names] of ROOM_NAMES) {
    if (names.some((n) => key === normalizeStationName(n))) return room;
  }
  return null;
}

/**
 * Berth charges found on a page, by room: the first yen amount within the next
 * few segments after a segment that IS a room's name. Nothing is inferred —
 * a room the page does not price is absent.
 */
export function parseRoomCharges(html) {
  const segs = htmlSegments(html);
  const found = {};
  segs.forEach((seg, i) => {
    const room = roomOf(seg);
    if (!room || found[room] != null) return;
    for (const next of segs.slice(i + 1, i + 7)) {
      if (roomOf(next)) break;
      const m = YEN.exec(next);
      if (m) {
        const amount = Number(String(m[1] ?? m[2]).replace(/,/g, ""));
        if (Number.isFinite(amount)) found[room] = amount;
        break;
      }
    }
  });
  return found;
}

/**
 * Which scraped charges to believe: each within MAX_ROOM_CHARGE_CHANGE of the
 * baseline, and the set still in the order the rooms are priced (Solo cheapest,
 * Sunrise Twin — a whole room — dearest). Returns the charges to use plus
 * which rooms came from the page.
 */
export function acceptRoomCharges(parsed, baseline, { maxChange = MAX_ROOM_CHARGE_CHANGE } = {}) {
  const charges = { ...baseline };
  const live = [];
  const rejected = [];
  for (const [room, amount] of Object.entries(parsed ?? {})) {
    const want = baseline?.[room];
    if (!Number.isFinite(want)) continue;
    if (!Number.isFinite(amount) || Math.abs(amount - want) / want > maxChange) {
      rejected.push(`${room} ${amount} (baseline ${want})`);
      continue;
    }
    charges[room] = amount;
    live.push(room);
  }
  const order = ["solo", "single", "singleTwin", "singleDeluxe", "sunriseTwin"];
  for (let i = 1; i < order.length; i++) {
    if (!(charges[order[i]] > charges[order[i - 1]])) {
      return { charges: { ...baseline }, live: [], rejected: [...rejected, `room charges out of order (${order[i - 1]} ≥ ${order[i]})`] };
    }
  }
  return { charges, live, rejected };
}

// ─── Fares ───────────────────────────────────────────────────────────────────

/** "tokyo" + "izumoshi" → "izumoshi|tokyo": a route's fare does not depend on direction. */
export function routeFareKey(a, b) {
  return [a, b].sort().join("|");
}

/**
 * What one traveller pays for the whole route, one way, per way of sleeping:
 * basic fare + limited express charge + berth charge (see the config's own
 * notes). Keys are the ones src/lib/fareClasses.mjs labels.
 */
export function fareForTrain(config, train, roomCharges, { sampledAt } = {}) {
  const origin = train.stops[0]?.station;
  const destination = train.stops[train.stops.length - 1]?.station;
  const base = config?.fares?.routes?.[routeFareKey(origin, destination)]?.ticketAndSleeperExpress;
  if (!Number.isFinite(base)) return null;
  const rc = roomCharges ?? {};
  const classes = {
    nobinobi: base + (config.fares.seatExpressPremium ?? 0),
    soloCabin: base + rc.solo,
    singleCabin: base + rc.single,
    singleTwinCabin: base + rc.singleTwin,
    twinCabinPerPerson: base + Math.round(rc.sunriseTwin / 2),
    deluxeSingleCabin: base + rc.singleDeluxe,
  };
  for (const [k, v] of Object.entries(classes)) if (!Number.isFinite(v)) delete classes[k];
  const entries = Object.entries(classes);
  if (!entries.length) return null;
  const [seatClass, fromPrice] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  return {
    fromPrice,
    currency: config.fares.currency ?? "JPY",
    seatClass,
    classes,
    sampledAt: sampledAt ?? config.fares.checkedAt ?? null,
  };
}

// ─── Geometry ────────────────────────────────────────────────────────────────

/**
 * The line a train is drawn along: its corridors joined, turned to run the
 * train's way, and cut to its first and last stop. Throws on a config whose
 * stops are not all on the path in order — that is an authoring error the
 * scrape must refuse rather than draw.
 */
export function trainPath(config, train) {
  const byId = new Map((config.stations ?? []).map((s) => [s.id, s]));
  const points = [];
  for (const name of train.corridors ?? []) {
    const corridor = config.corridors?.[name];
    if (!Array.isArray(corridor)) throw new Error(`${train.lineName}: unknown corridor "${name}"`);
    corridor.forEach((item, i) => {
      if (i === 0 && typeof item === "string" && points.at(-1)?.id === item) return;
      if (typeof item === "string") {
        const s = byId.get(item);
        if (!s) throw new Error(`${train.lineName}: corridor "${name}" names unknown station "${item}"`);
        points.push({ id: item, lat: s.lat, lon: s.lon });
      } else if (Array.isArray(item) && item.length === 2) {
        points.push({ id: null, lat: item[0], lon: item[1] });
      }
    });
  }
  const stopIds = train.stops.map((s) => s.station);
  let pts = points;
  let a = pts.findIndex((p) => p.id === stopIds[0]);
  let b = pts.findIndex((p) => p.id === stopIds[stopIds.length - 1]);
  if (a < 0 || b < 0) throw new Error(`${train.lineName}: its endpoints are not on its corridors`);
  if (a > b) {
    pts = [...points].reverse();
    a = pts.findIndex((p) => p.id === stopIds[0]);
    b = pts.findIndex((p) => p.id === stopIds[stopIds.length - 1]);
  }
  const slice = pts.slice(a, b + 1);
  let cursor = 0;
  for (const id of stopIds) {
    const at = slice.findIndex((p, i) => i >= cursor && p.id === id);
    if (at < 0) throw new Error(`${train.lineName}: stop "${id}" is not on its corridors in running order`);
    cursor = at + 1;
  }
  return slice.map((p) => [p.lat, p.lon]);
}

/** Structural problems with the config (empty = usable). */
export function validateConfig(config) {
  const problems = [];
  const ids = new Set((config?.stations ?? []).map((s) => s.id));
  for (const s of config?.stations ?? []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) problems.push(`station ${s.id} has no position`);
  }
  const names = new Set();
  for (const t of config?.trains ?? []) {
    if (!t.lineName) problems.push("a train has no lineName");
    if (names.has(t.lineName)) problems.push(`duplicate train ${t.lineName}`);
    names.add(t.lineName);
    if (!Array.isArray(t.stops) || t.stops.length < 2) problems.push(`${t.lineName}: fewer than two stops`);
    for (const s of t.stops ?? []) if (!ids.has(s.station)) problems.push(`${t.lineName}: unknown station ${s.station}`);
    try {
      trainPath(config, t);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (!(config?.trains ?? []).length) problems.push("no trains");
  return problems;
}

// ─── Trains file ─────────────────────────────────────────────────────────────

/**
 * The trains file the rest of the pipeline reads (same shape as every other
 * source: { [lineName]: { lineName, operator, agency_id, frequency, polyline,
 * stations[] } }), from the config plus whatever tonight's scrape confirmed.
 *
 * @param {object} config            data/sources/jr-sunrise.json
 * @param {object} opts
 * @param {object} [opts.timetables] lineName → { stops, url } for trains a page validated
 * @param {object} [opts.roomCharges] berth charges to price with (defaults to the baseline)
 * @param {string} [opts.faresCheckedAt] when those charges were confirmed
 * @param {string} [opts.today]
 */
export function buildSunriseTrains(config, { timetables = {}, roomCharges, faresCheckedAt, today } = {}) {
  const byId = new Map(config.stations.map((s) => [s.id, s]));
  const operator = config.operator ?? {};
  const trains = {};
  for (const train of config.trains) {
    const official = timetables[train.lineName] ?? null;
    const stops = official?.stops ?? train.stops;
    const stations = stops.map((s) => {
      const st = byId.get(s.station);
      return {
        name: st.name,
        location: { latitude: st.lat, longitude: st.lon },
        arrival: s.arrival ?? null,
        departure: s.departure ?? null,
        pickup: true,
        dropoff: true,
      };
    });
    const fare = fareForTrain(config, train, roomCharges ?? config.fares?.roomCharges, {
      sampledAt: faresCheckedAt ?? config.fares?.checkedAt,
    });
    trains[train.lineName] = {
      lineName: train.lineName,
      service: train.service ?? null,
      operator: operator.name ?? "JR West",
      agency_id: operator.agencyId ?? "JRW",
      frequency: train.frequency ?? null,
      polyline: polyline.encode(trainPath(config, train)),
      stations,
      ...(fare ? { fare } : {}),
      // Where tonight's times came from: JR's page (with its address) or the
      // committed baseline, so a stale timetable is visible in the file itself.
      timetable: official
        ? { source: "official", url: official.url ?? null, checkedAt: today ?? null }
        : { source: "baseline", checkedAt: config.baseline?.checkedAt ?? null },
    };
  }
  return trains;
}

/** "2026-09-28" + 3 → "2026-10-01" (UTC calendar arithmetic). */
export function datePlusDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Fill {date} (YYYYMMDD), {isoDate} and {id} in a URL template. */
export function expandUrlTemplate(template, { date, id } = {}) {
  return String(template)
    .replace(/\{date\}/g, String(date ?? "").replace(/-/g, ""))
    .replace(/\{isoDate\}/g, String(date ?? ""))
    .replace(/\{id\}/g, String(id ?? ""));
}
