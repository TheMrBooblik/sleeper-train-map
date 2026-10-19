// scripts/lib/jr-sunrise.mjs
// Pure logic for the Sunrise Izumo / Sunrise Seto source (JR West + JR Central,
// Japan). The adapter (scripts/adapters/jr-sunrise.mjs) fetches; everything that
// decides what a page says lives here, so tests run it without a network.
//
// Two things are read nightly from JR West's own documents:
//
//   1. The timetable of each train (every stop's time), from the Sunrise
//      timetable PDF the guide page links (read as positioned lines by
//      scripts/lib/pdf-lines.mjs).
//   2. The berth charges per room type, from JR West's Sunrise pages.
//
// JR's hosts are unreachable from the dev sandbox, so the layouts were learned
// from the "Probe JR Sunrise source" workflow, and the validation is strict:
// a train's timetable is taken whole or not at all — every stop the baseline
// lists must be found, in order, running forward in time with at most one
// midnight, and no time may sit more than MAX_DRIFT_MINUTES from the
// baseline's. JR moved the Tokyo departure by 24 minutes in March 2026; a
// column that disagrees by hours is another train, not a timetable change.
//
// JR West's per-train timetable pages (timetable.jr-odekake.net) were the first
// source tried and are gone from here: no JR page links to them, so their ids
// could not be found, and the two seeded by hand were other trains.
//
// Taking a stop list from one source and times from another would be a row that
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

function hhmm(h, m) {
  const hours = Number(h);
  const minutes = Number(m);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59 || hours > 29) return null;
  return `${String(hours % 24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "23:59" → 1439. */
export function minutesOf(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
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
 * Find one train's stops in a column's records, in order. Consecutive records of
 * the same station (an arrival row and a departure row) are merged.
 * Returns { stops, problems }; any problem means the column does not describe
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

// ─── JR West's timetable PDF ─────────────────────────────────────────────────
//
// The Sunrise guide links one PDF (pdf/jikokuhyo.pdf) holding all four trains:
// two tables side by side, each headed by a 列車番号 row whose train-number
// cells mark the columns. Per row, the station name sits left of the first
// column, spaced out character by character ("東  京  発"), with a trailing
// 発 / 着 / 〃 saying whether the times from here on are departures or
// arrivals (〃 = as above). A time is three or four digits ("2126", "054");
// anything else in a column (a glyph for "passes", "not on this route", blank)
// is not a stop. Read as positioned lines (scripts/lib/pdf-lines.mjs) on
// 2026-10-19; the layout, not the content, is what this depends on.

const PDF_NUMBER_HEADER = "列車番号";
const PDF_TRAIN_NUMBER = /^\d{3,5}[A-Z]$/;
const PDF_TIME = /^(\d{1,2})(\d{2})$/;
const PDF_COLUMN_SLACK = 6;

/** "2126" → "21:26", "054" → "00:54"; anything else → null. */
export function pdfTime(token) {
  const m = PDF_TIME.exec(String(token ?? "").trim());
  return m && String(token).trim().length >= 3 ? hhmm(m[1], m[2]) : null;
}

/**
 * The PDF's columns as stop records, one list per column:
 *   [{ x, header, records: [{ station, times: [{ time, label }], pass: false }] }]
 * Stations are matched with `matchStation`; rows naming no configured station
 * are skipped but still carry the 発/着 state down the table.
 */
export function pdfColumns(pages, matchStation) {
  const columns = [];
  for (const lines of pages ?? []) {
    const headerAt = lines.findIndex((l) => l.cells.some((c) => c.text.replace(/\s+/g, "") === PDF_NUMBER_HEADER));
    if (headerAt < 0) continue;
    const header = lines[headerAt];
    const halves = header.cells
      .filter((c) => c.text.replace(/\s+/g, "") === PDF_NUMBER_HEADER)
      .map((c) => c.x)
      .sort((a, b) => a - b);
    halves.forEach((start, h) => {
      const end = halves[h + 1] ?? Infinity;
      const cols = header.cells.filter((c) => c.x > start && c.x < end && PDF_TRAIN_NUMBER.test(c.text));
      if (!cols.length) return;
      const nameLimit = Math.min(...cols.map((c) => c.x)) - 3;
      const half = cols.map((c) => ({ x: c.x, header: c.text, records: [] }));
      let label = null;
      for (const line of lines.slice(headerAt + 1)) {
        const mine = line.cells.filter((c) => c.x >= start - 2 && c.x < end - 2);
        const text = mine.filter((c) => c.x < nameLimit).map((c) => c.text).join("").replace(/\s+/g, "");
        const mark = /[発着〃]$/.exec(text)?.[0] ?? null;
        const station = matchStation(mark ? text.slice(0, -1) : text);
        if (!station) continue;
        if (mark === "発") label = DEP;
        else if (mark === "着") label = ARR;
        for (const col of half) {
          const cell = mine.find((c) => Math.abs(c.x - col.x) <= PDF_COLUMN_SLACK && pdfTime(c.text));
          if (cell) col.records.push({ station, times: [{ time: pdfTime(cell.text), label }], pass: false });
        }
      }
      columns.push(...half);
    });
  }
  return columns;
}

/**
 * Each configured train's timetable from the PDF: the first column whose
 * records hold every one of the train's stops, in order, with plausible times
 * . A column's header is not
 * trusted to name its train: the Izumo column is headed 5031M, the number it
 * runs under while coupled to the Seto.
 * Returns { timetables: { lineName: { stops, column } }, problems: { lineName: [..] } }.
 */
export function timetablesFromPdf(pages, config, matchStation, opts) {
  const columns = pdfColumns(pages, matchStation);
  const timetables = {};
  const problems = {};
  for (const train of config.trains) {
    const tried = [];
    for (const [i, col] of columns.entries()) {
      const { stops, problems: missing } = matchTrainInRecords(col.records, train);
      const invalid = missing.length ? missing : validateScrapedStops(stops, train, opts);
      if (!invalid.length) {
        timetables[train.lineName] = { stops, column: i };
        break;
      }
      tried.push(`column ${i} (${col.header}): ${invalid.slice(0, 2).join(", ")}`);
    }
    if (!timetables[train.lineName]) problems[train.lineName] = columns.length ? tried : ["no timetable columns in the PDF"];
  }
  return { timetables, problems, columns: columns.length };
}

/**
 * Every link on a page as { href, text }, hrefs made absolute against
 * `baseUrl`. The text is the anchor's own, tags stripped — enough to tell a
 * "サンライズ出雲" link from the rest of a station's departures.
 */
export function extractLinks(html, baseUrl) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href;
    try {
      href = new URL(decodeEntities(m[1]), baseUrl).href;
    } catch {
      continue;
    }
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ href, text });
  }
  return out;
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
      // Where tonight's times came from: JR West's PDF (with its address) or the
      // committed baseline, so a stale timetable is visible in the file itself.
      timetable: official
        ? { source: "official", url: official.url ?? null, checkedAt: today ?? null }
        : { source: "baseline", checkedAt: config.baseline?.checkedAt ?? null },
    };
  }
  return trains;
}
