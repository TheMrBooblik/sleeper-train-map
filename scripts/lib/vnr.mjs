// scripts/lib/vnr.mjs
// Vietnam Railways night trains: the pure half of scripts/adapters/vnr.mjs.
//
// The source is VNR's own times-and-fares site, giotaugiave.dsvn.vn ("Thông
// tin giờ tàu giá vé"): an ASP.NET WebForms app, one search form per line —
// giotau/* answers a train's timetable for a date (every stop with its
// kilometre post, date, departure and arrival), giave/* the fare of every
// kind of place on a train between two stations for a date. The forms post
// back (__VIEWSTATE, __EVENTVALIDATION) over txtNgayDi (dd-mm-yyyy), ddlChieu
// (1 = outbound, 0 = return), ddlMacTau (train id), ddlGaDi/ddlGaDen
// (stations) and btnTraTim (search). No captcha, no login; the first probe
// run (2026-10-21) read them from a GitHub runner.
//
// Everything here works on page text, so tests/verify-vnr.mjs runs it against
// answers the probe captured. dsvn.vn, the ticket shop, is deliberately not
// read: its API answers are encoded and it carries reCAPTCHA and browser
// fingerprinting, and this map never works around either.

import polyline from "@mapbox/polyline";
import { haversineKm } from "./sibling-path.mjs";
import { buildRailGraph, routeThroughStops } from "./rail-graph.mjs";

// ─── Page reading ───────────────────────────────────────────────────────────

export const decodeHtml = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ecirc;/g, "ê")
    .replace(/&ocirc;/g, "ô")
    .replace(/&aacute;/g, "á")
    .replace(/&amp;/g, "&");

const attr = (tag, name) => decodeHtml(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "");

/** The page's form: its inputs and its selects with their options. */
export function parseAspForm(html) {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(String(html ?? ""))?.[1] ?? "";
  const inputs = [];
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    inputs.push({ type: (attr(m[0], "type") || "text").toLowerCase(), name: attr(m[0], "name"), value: attr(m[0], "value") });
  }
  const selects = [];
  for (const m of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
      value: attr(o[1], "value"),
      text: decodeHtml(o[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      selected: /\bselected\b/i.test(o[1]),
    }));
    selects.push({ name: attr(m[1], "name"), options });
  }
  return { inputs, selects };
}

/** A select by the tail of its name ("ddlMacTau"). */
export const selectNamed = (form, tail) => form?.selects?.find((s) => s.name.endsWith(`$${tail}`) || s.name === tail) ?? null;
export const selectedOption = (select) => select?.options.find((o) => o.selected) ?? select?.options[0] ?? null;

/**
 * The fields a browser posts for this form: its hidden inputs, the date, and
 * each select's selected (or first) option — then `overrides`, by the tail
 * of a field's name ({ ddlMacTau: "9175" }) or its full name.
 */
export function formFields(form, overrides = {}) {
  const fields = {};
  for (const i of form.inputs) {
    if (!i.name || /Login/i.test(i.name)) continue;
    if (i.type === "hidden" || /txtNgay/i.test(i.name)) fields[i.name] = i.value;
  }
  for (const s of form.selects) {
    if (!s.name || /Login/i.test(s.name)) continue;
    fields[s.name] = selectedOption(s)?.value ?? "";
  }
  const button = form.inputs.find((i) => i.type === "submit" && /btnTraTim/i.test(i.name));
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "search") {
      if (button && value) fields[button.name] = button.value;
      continue;
    }
    const full = Object.keys(fields).find((k) => k === key || k.endsWith(`$${key}`)) ?? key;
    fields[full] = value;
  }
  return fields;
}

/** Every table as rows of cell texts. */
export function tablesOf(html) {
  const out = [];
  for (const t of String(html ?? "").matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        decodeHtml(c[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
      ),
    );
    if (rows.length) out.push(rows);
  }
  return out;
}

const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐðÐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** "22:7" → "22:07"; null for anything that is not a clock. */
export function clock(value) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}`;
}

/** "23-10-2026" → "2026-10-23". */
export function isoDate(value) {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(String(value ?? "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * A giotau answer → the train's stops, or null when the page carries no
 * timetable table. The table reads "Ga đi | Cự ly | Ngày đi | Giờ đi | Giờ
 * đến": station, kilometre post, the date of that row, departure, arrival —
 * departure BEFORE arrival, which is easy to read the wrong way round. A row's
 * date is its departure's; an arrival later in the day than its departure
 * (23:58 in, 00:05 out) was the evening before.
 *
 * Each stop carries `day` (whole days after the first departure's date) and
 * `minutes` (minutes after the first departure), so a 33-hour journey keeps
 * its length.
 */
export function parseTimetable(html) {
  for (const rows of tablesOf(html)) {
    const header = rows.findIndex((r) => r.some((c) => /^Ga/i.test(c)) && r.some((c) => /Cự ly/i.test(c)) && r.some((c) => /Giờ đi/i.test(c)));
    if (header < 0) continue;
    const h = rows[header].map((c) => fold(c));
    const col = {
      name: h.findIndex((c) => c.startsWith("ga")),
      km: h.findIndex((c) => c.includes("cu ly")),
      date: h.findIndex((c) => c.includes("ngay")),
      dep: h.findIndex((c) => c.includes("gio di")),
      arr: h.findIndex((c) => c.includes("gio den")),
    };
    if (Object.values(col).some((i) => i < 0)) return null;
    const stops = [];
    for (const r of rows.slice(header + 1)) {
      const name = r[col.name];
      const date = isoDate(r[col.date]);
      const dep = clock(r[col.dep]);
      const arr = clock(r[col.arr]);
      if (!name || !date || !dep || !arr) continue;
      stops.push({ name, km: Number(r[col.km]), date, dep, arr });
    }
    if (stops.length < 2) return null;
    const first = stops[0];
    const t0 = dayNumber(first.date) * 1440 + minutesOf(first.dep);
    const out = stops.map((s) => {
      const depAt = dayNumber(s.date) * 1440 + minutesOf(s.dep);
      let arrAt = dayNumber(s.date) * 1440 + minutesOf(s.arr);
      if (arrAt > depAt) arrAt -= 1440;
      return { name: s.name, km: Number.isFinite(s.km) ? s.km : null, date: s.date, departure: s.dep, arrival: s.arr, depMinutes: depAt - t0, arrMinutes: arrAt - t0 };
    });
    // A timetable runs forward: a stop timed before the one above it is a
    // misread, not a train.
    for (let i = 1; i < out.length; i++) if (out[i].arrMinutes < out[i - 1].depMinutes) return null;
    return { firstDate: first.date, stops: out };
  }
  return null;
}

/**
 * A giave answer → [{ code, label, price }] (VND), or null when the page has
 * no fare table. The table reads "| Loại chỗ | Giá vé": VNR's code for the
 * place (AnLT1, BnLT3M, NML…), what it is, and "2.096.000 ₫", insurance and
 * VAT included (the page says so under the table).
 */
export function parseFares(html) {
  for (const rows of tablesOf(html)) {
    const header = rows.findIndex((r) => r.some((c) => /Loại chỗ/i.test(c)) && r.some((c) => /Giá vé/i.test(c)));
    if (header < 0) continue;
    const h = rows[header].map((c) => fold(c));
    const labelCol = h.findIndex((c) => c.includes("loai cho"));
    const priceCol = h.findIndex((c) => c.includes("gia ve"));
    const codeCol = labelCol > 0 ? 0 : -1;
    const out = [];
    for (const r of rows.slice(header + 1)) {
      const digits = String(r[priceCol] ?? "").replace(/[^\d]/g, "");
      const price = digits ? Number(digits) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({ code: codeCol >= 0 ? r[codeCol] : "", label: r[labelCol] ?? "", price });
    }
    return out;
  }
  return null;
}

// ─── Fares ──────────────────────────────────────────────────────────────────

/**
 * A place → our class key, or null for anything that is not a berth. VNR's
 * codes read A/B (soft/hard), n (nằm, a berth), L (air-conditioned), then the
 * tier; the label says the compartment size and tier in words, which is what
 * this goes by. Seats (Ngồi…, Ghế phụ), standing (Không chỗ) and the
 * international through-car berths (LVQT, sold for China) are left out.
 */
export function berthClass({ code = "", label = "" }) {
  const l = fold(label);
  if (!/(^|\b)(nam|khoang|giuong|tang \d)/.test(l) || /\bngoi\b|ghe|khong cho/.test(l)) return null;
  if (/lvqt/.test(l)) return null;
  const fan = /^[AB]n(?!L)/.test(code);
  const tier = Number(/tang (\d)/.exec(l)?.[1] ?? NaN);
  const beds = Number(/(\d)\s*giuong/.exec(l)?.[1] ?? NaN);
  let key = null;
  if (beds === 2) key = /vip/.test(l) ? "vnrSoft2Vip" : "vnrSoft2";
  else if (beds === 3) key = "vnrSoft3";
  else if (beds === 4) key = tier === 1 ? "vnrSoft4Lower" : tier === 2 ? "vnrSoft4Upper" : "vnrSoft4";
  else if (beds === 6) key = tier === 1 ? "vnrHard6Lower" : tier === 2 ? "vnrHard6Middle" : tier === 3 ? "vnrHard6Upper" : "vnrHard6";
  if (!key) return null;
  return fan ? `${key}Fan` : key;
}

/** Fare rows → { classKey: cheapest VND } for berths only. */
export function berthFares(rows) {
  if (!Array.isArray(rows)) return null;
  const classes = {};
  for (const row of rows) {
    const key = berthClass(row);
    if (!key) continue;
    if (classes[key] == null || row.price < classes[key]) classes[key] = row.price;
  }
  return classes;
}

/** { classes } → the fare record a trains file carries, or null for no berth. */
export function fareRecord(classes, { sampledAt, travelDate }) {
  const entries = Object.entries(classes ?? {}).filter(([, v]) => Number.isFinite(v));
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return {
    fromPrice: entries[0][1],
    currency: "VND",
    seatClass: entries[0][0],
    classes: Object.fromEntries(entries),
    sampledAt,
    travelDate,
  };
}

// ─── Which trains ───────────────────────────────────────────────────────────

/** Minutes from the first departure to the last arrival. */
export const journeyMinutes = (tt) => tt.stops[tt.stops.length - 1].arrMinutes;

/** Nights a timetable spans: dates crossed between first departure and last arrival. */
export function nightsOf(tt) {
  const last = tt.stops[tt.stops.length - 1];
  const lastArrivalDay = Math.floor((dayNumber(tt.firstDate) * 1440 + minutesOf(tt.stops[0].departure) + last.arrMinutes) / 1440);
  return lastArrivalDay - dayNumber(tt.firstDate);
}

/**
 * Whether a train is one of ours: it runs through a night and takes at least
 * `minMinutes`. Every VNR train that does both carries sleeper coaches, and
 * the fare pass checks it actually sells a berth.
 */
export function isNightTrain(tt, { minMinutes = 300, exclude = [] } = {}, name = "") {
  if (!tt || exclude.includes(name)) return false;
  return nightsOf(tt) >= 1 && journeyMinutes(tt) >= minMinutes;
}

/** "SE1" → { prefix: "SE", number: 1 }. */
export function splitTrainName(name) {
  const m = /^([A-ZĐ]+)(\d+)$/i.exec(String(name ?? "").trim());
  return m ? { prefix: m[1].toUpperCase(), number: Number(m[2]) } : null;
}

/** Outbound/return pairs in file order: odd n with n+1 of the same prefix, unless `pairs` says otherwise. */
export function pairOrder(names, pairs = {}) {
  const set = new Set(names);
  const explicit = Object.fromEntries(Object.entries(pairs).filter(([k]) => !k.startsWith("_")));
  const partnerOf = (n) => {
    if (explicit[n]) return explicit[n];
    const s = splitTrainName(n);
    return s && s.number % 2 === 1 ? `${s.prefix}${s.number + 1}` : null;
  };
  const returnOf = new Map(Object.entries(explicit).map(([out, ret]) => [ret, out]));
  const key = (n) => {
    const s = splitTrainName(n);
    return s ? [s.prefix, s.number] : [n, 0];
  };
  const sorted = [...names].sort((a, b) => {
    const [pa, na] = key(a);
    const [pb, nb] = key(b);
    return pa === pb ? na - nb : pa < pb ? -1 : 1;
  });
  const out = [];
  const seen = new Set();
  for (const n of sorted) {
    if (seen.has(n)) continue;
    if (returnOf.has(n) && set.has(returnOf.get(n))) continue;
    const s = splitTrainName(n);
    // An even number whose odd partner is listed waits for it.
    if (!explicit[n] && s && s.number % 2 === 0 && set.has(`${s.prefix}${s.number - 1}`)) continue;
    out.push(n);
    seen.add(n);
    const p = partnerOf(n);
    if (p && set.has(p) && !seen.has(p)) {
      out.push(p);
      seen.add(p);
    }
  }
  return out;
}

/** "Daily" for a train the config lists as running every day, else null (unknown). */
export const frequencyFor = (config, name) => (config?.frequency?.daily ?? []).includes(name) ? "Daily" : null;

/**
 * Trains with the same stops at the same times are one train sold under two
 * numbers — on 2026-10-21 the site listed JSE17/JSE18 beside SE17/SE18 with
 * identical timetables, and only the J numbers had fares. Keep the one with a
 * fare, else the shorter name. `found` is name → { timetable, fare }.
 */
export function dropDuplicateTimetables(found, log = () => {}) {
  const byKey = new Map();
  for (const [name, f] of found) {
    const key = f.timetable.stops.map((s) => `${s.name}@${s.departure}/${s.arrival}`).join(">");
    const other = byKey.get(key);
    if (!other) {
      byKey.set(key, name);
      continue;
    }
    const better = (a, b) => (!!found.get(a).fare !== !!found.get(b).fare ? (found.get(a).fare ? a : b) : a.length <= b.length ? a : b);
    const keep = better(other, name);
    const drop = keep === name ? other : name;
    byKey.set(key, keep);
    log(`${drop}: same stops and times as ${keep} — kept ${keep}${found.get(keep).fare ? " (the one with fares)" : ""}`);
  }
  const kept = new Set(byKey.values());
  return new Map([...found].filter(([name]) => kept.has(name)));
}

// ─── Positions ──────────────────────────────────────────────────────────────

/** One spelling per station. */
export function makeStationNamer(stationNames = {}) {
  const table = new Map(Object.entries(stationNames).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k.trim().toLowerCase(), v]));
  return (name) => {
    const clean = String(name ?? "").replace(/\s+/g, " ").trim();
    return table.get(clean.toLowerCase()) ?? clean;
  };
}

/** A station name as OSM and VNR might both write it: no "Ga ", no diacritics, no "station". */
export function stationKey(name) {
  return fold(name)
    .replace(/^ga\s+/, "")
    .replace(/\b(railway\s+)?station\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// How far from where we expect a station an OSM station of the same name may
// be and still be taken as it. The anchors are a town's station as published
// (well within this), an interpolated position can be several km off along a
// curving line, and two Vietnamese stations sharing a name are much farther
// apart than this.
export const OSM_MATCH_KM = 25;

/**
 * Where each station is: OpenStreetMap's station of that name nearest where
 * we expect it, else the anchor, else a point interpolated by kilometre post
 * between the nearest anchored stations on the same train.
 *
 * @param {{name: string, km: number|null}[][]} trains  each train's stops (map names)
 * @param {Record<string, {lat: number, lon: number}>} anchors
 * @param {Array<[string, string|null, string|null, number, number]>|null} osmStations
 * @returns {Map<string, {lat: number, lon: number, source: "osm"|"anchor"|"interpolated"}>}
 */
export function stationPositions(trains, anchors, osmStations = null, log = () => {}) {
  const expected = new Map();
  for (const [name, a] of Object.entries(anchors ?? {})) {
    if (!name.startsWith("_") && Number.isFinite(a?.lat)) expected.set(name, { lat: a.lat, lon: a.lon, source: "anchor" });
  }
  for (const stops of trains) {
    stops.forEach((s, i) => {
      if (expected.has(s.name) || !Number.isFinite(s.km)) return;
      let before = null;
      let after = null;
      for (let j = i - 1; j >= 0 && !before; j--) if (expected.get(stops[j].name)?.source === "anchor" && Number.isFinite(stops[j].km)) before = stops[j];
      for (let j = i + 1; j < stops.length && !after; j++) if (expected.get(stops[j].name)?.source === "anchor" && Number.isFinite(stops[j].km)) after = stops[j];
      if (!before || !after || after.km === before.km) return;
      const f = (s.km - before.km) / (after.km - before.km);
      const a = expected.get(before.name);
      const b = expected.get(after.name);
      expected.set(s.name, { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, source: "interpolated" });
    });
  }
  const byKey = new Map();
  for (const rec of osmStations ?? []) {
    const [name, nameVi, nameEn, lat, lon] = rec;
    for (const n of new Set([name, nameVi, nameEn].filter(Boolean).map(stationKey))) {
      if (!byKey.has(n)) byKey.set(n, []);
      byKey.get(n).push({ lat, lon });
    }
  }
  const out = new Map();
  for (const [name, at] of expected) {
    const candidates = byKey.get(stationKey(name)) ?? [];
    let best = null;
    for (const c of candidates) {
      const d = haversineKm([at.lat, at.lon], [c.lat, c.lon]);
      if (d <= OSM_MATCH_KM && (!best || d < best.d)) best = { ...c, d };
    }
    if (best) {
      if (at.source === "anchor" && best.d > 3) log(`${name}: OSM puts it ${best.d.toFixed(1)} km from its anchor — taking OSM's`);
      out.set(name, { lat: best.lat, lon: best.lon, source: "osm" });
    } else {
      out.set(name, at);
    }
  }
  return out;
}

// ─── The trains file ────────────────────────────────────────────────────────

/**
 * How long a train the site stopped answering for is carried from last
 * night's file: a timetable nobody has confirmed for a month is no longer one
 * to publish (the same 30 days SRT and fares.mjs keep).
 */
export const CARRY_MAX_DAYS = 30;

/**
 * Build the trains file entries.
 *
 * @param {object} args
 * @param {object} args.config            data/sources/vnr-sleepers.json
 * @param {Map<string, {timetable: object, fare?: object|null}>|null} args.found  tonight's night trains by name (null: site unreachable)
 * @param {Map<string, {lat, lon, source}>} args.positions
 * @param {Set<string>} [args.carry]      names to take from last night's file when tonight did not read them
 * @param {object} [args.previous]        last night's trains, by name
 * @param {[number, number][][]|null} [args.osmTrack]
 */
export function buildVnrTrains({ config, found, carry = new Set(), positions, previous = {}, today, travelDate, osmTrack = null, log = () => {} }) {
  const namer = makeStationNamer(config.stationNames);
  const operator = config.operator ?? {};
  const graphs = osmTrack?.length ? [["osm", buildRailGraph(osmTrack, { joinMeters: 30 })]] : [];
  const memo = new Map();
  const fresh = (t) => {
    const at = Date.parse(`${t?.timetable?.checkedAt ?? ""}T00:00:00Z`);
    return Number.isFinite(at) && (Date.parse(`${today}T00:00:00Z`) - at) / 86_400_000 <= CARRY_MAX_DAYS;
  };
  const prev = new Map();
  for (const [name, t] of Object.entries(previous ?? {})) {
    if (fresh(t)) prev.set(name, t);
    else log(`${name}: last confirmed ${t?.timetable?.checkedAt ?? "never"}, over ${CARRY_MAX_DAYS} days ago — no longer carried`);
  }
  const names = found ? [...new Set([...found.keys(), ...[...carry].filter((n) => prev.has(n))])] : [...prev.keys()];
  const trains = {};
  for (const name of pairOrder(names, config.pairs)) {
    const live = found?.get(name) ?? null;
    if (!live) {
      const carried = prev.get(name);
      if (carried) trains[name] = { ...carried, timetable: { ...carried.timetable, source: "previous" } };
      continue;
    }
    const stops = live.timetable.stops.map((s) => ({ ...s, name: namer(s.name) }));
    const missing = stops.filter((s) => !positions.get(s.name));
    if (missing.length) {
      log(`${name}: no position for ${missing.map((s) => s.name).join(", ")} — those stops are left off the line`);
    }
    const placed = stops.filter((s) => positions.get(s.name));
    if (placed.length < 2 || placed[0] !== stops[0] || placed.at(-1) !== stops.at(-1)) {
      log(`${name}: an end has no position — left out`);
      continue;
    }
    const points = placed.map((s) => [positions.get(s.name).lat, positions.get(s.name).lon]);
    const routed = routeThroughStops(points, graphs, () => null, memo);
    const geometry = routed.sources.reduce((acc, src) => ({ ...acc, [src]: (acc[src] ?? 0) + 1 }), {});
    let encoded = polyline.encode(routed.path);
    // A night without OSM must not make a line worse than last night's.
    const before = prev.get(name);
    const sameStops = before?.stations?.map((s) => s.name).join(">") === placed.map((s) => s.name).join(">");
    if (sameStops && (geometry.chord ?? 0) > (before.geometry?.chord ?? Infinity) && before.polyline) {
      encoded = before.polyline;
      Object.assign(geometry, before.geometry, { carried: true });
    }
    if (geometry.chord) log(`${name}: ${geometry.chord} of ${routed.sources.length} gap(s) drawn straight — no track found between those stops`);
    const last = placed.length - 1;
    const stations = placed.map((s, i) => ({
      name: s.name,
      location: { latitude: positions.get(s.name).lat, longitude: positions.get(s.name).lon },
      ...(Number.isFinite(s.km) ? { km: s.km } : {}),
      arrival: i === 0 ? null : s.arrival,
      departure: i === last ? null : s.departure,
      // Whole days after the first departure's date, so a stop list can say
      // "+1" and a 33-hour journey is not read as 9 hours (the planner and
      // the connection pages measure a ride between two stops from these).
      arrivalDay: i === 0 ? null : dayOf(stops[0], s.arrMinutes),
      departureDay: i === last ? null : dayOf(stops[0], s.depMinutes),
      pickup: true,
      dropoff: true,
    }));
    trains[name] = {
      lineName: name,
      trainNo: name,
      operator: operator.name ?? "Vietnam Railways",
      agency_id: operator.agencyId ?? "VNR",
      frequency: frequencyFor(config, name),
      durationMinutes: journeyMinutes(live.timetable),
      nights: nightsOf(live.timetable),
      polyline: encoded,
      geometry,
      stations,
      ...(live.fare ? { fare: live.fare } : before?.fare ? { fare: before.fare } : {}),
      timetable: { source: "official", checkedAt: today, travelDate },
      positions: Object.fromEntries(
        Object.entries(placed.reduce((acc, s) => ({ ...acc, [positions.get(s.name).source]: (acc[positions.get(s.name).source] ?? 0) + 1 }), {})),
      ),
    };
  }
  return trains;
}

/** Days after the first departure's date of a moment `minutes` after it. */
const dayOf = (first, minutes) => Math.floor((minutesOf(first.departure) + minutes) / 1440);

/** Whether two positions are one station (for tests and sanity checks). */
export const sameStation = (a, b) => haversineKm([a.lat, a.lon], [b.lat, b.lon]) <= 3;

