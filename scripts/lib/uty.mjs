// scripts/lib/uty.mjs
// Uzbekistan Railways (O'zbekiston temir yo'llari, UTY) night trains: the pure
// half of scripts/adapters/uty.mjs.
//
// The source is UTY's own ticket shop, eticket.uzrailpass.uz (eticket.railway.uz
// answers every path with a 301 to it since October 2026), and only the call
// its page makes before anyone logs in: POST /api/v3/handbook/trains/list,
// every train between two stations on a date, with its departure and arrival
// there, the train's own two ends, and the tariff in so'm of every place on
// sale per car type. The route call (handbook/trains/route) and the station
// boards answer 401 without a login, so a train's stop list is never read
// whole; it is built from searches instead:
//
//   A night train answers a search between two stations exactly when it
//   serves both. Every domestic night train calls at Toshkent Janubiy (the
//   probe of 2026-10-25 asked the city code, Markaziy and Janubiy separately),
//   so a search from the hub to every station in the config, and from every
//   station back, gives each train every configured station it serves and the
//   official time there: the arrival on the far side of the hub, the departure
//   on the near side. Stations the config does not list are not on the stop
//   list — a coarse one, never an invented one.
//
// Searches between a train's own two ends over seven consecutive dates give
// its days (the search date is the departure date at the first station) and
// the fare of the whole journey.
//
// Everything here works on the shop's JSON, so tests/verify-uty.mjs runs it
// against answers the probe captured.

import polyline from "@mapbox/polyline";
import { buildRailGraph, routeThroughStops } from "./rail-graph.mjs";

// ─── Reading answers ────────────────────────────────────────────────────────

const CYRILLIC = {
  а: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", қ: "q",
  л: "l", м: "m", н: "n", о: "o", ў: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ҳ: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * A station name reduced to compare: lower case, Cyrillic spelled in Uzbek
 * Latin, every apostrophe, space, hyphen and digit gone. The shop spells one
 * station several ways ("Toshkent janubiy", "Toshkkent  janubiy", "XIVA",
 * "ХИВА", "Qung'irot"), so ends are matched on this and an alias list.
 */
export function foldName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (c) => CYRILLIC[c] ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

/** "01.11.2026 21:13" → { date: "2026-11-01", minutes: 1273, abs } (abs: minutes since 1970, Tashkent clock). */
export function parseDateTime(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const date = `${m[3]}-${m[2]}-${m[1]}`;
  const minutes = Number(m[4]) * 60 + Number(m[5]);
  const day = Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  if (!Number.isFinite(day) || minutes >= 1440) return null;
  return { date, minutes, abs: day * 1440 + minutes };
}

/** The train number's digits: "080Ф" → "080". The letter after them changes by direction and date. */
export const trainDigits = (number) => /^\d+/.exec(String(number ?? ""))?.[0] ?? null;

/**
 * Car types that sell a place to lie down, and the fare class each becomes.
 * Umumiy (an unreserved common car) and O'rindiqli (seats) are never priced:
 * this map shows berths, and a seat price on a sleeper card is the wrong number.
 */
export const BERTH_CAR_TYPES = {
  plaskartli: "utyPlatskart",
  kupe: "utyKupe",
  sv: "utySv",
  lyuks: "utyLux",
};

const berthClassOf = (carType) => BERTH_CAR_TYPES[foldName(carType)] ?? null;

/** Every train in one search answer, read into the shape the builder uses. */
export function readSearch(answer) {
  const trains = answer?.data?.directions?.forward?.trains;
  if (!Array.isArray(trains)) return [];
  const out = [];
  for (const t of trains) {
    const number = String(t?.number ?? "").trim();
    const dep = parseDateTime(t?.departureDate);
    const arr = parseDateTime(t?.arrivalDate);
    if (!trainDigits(number) || !dep || !arr || arr.abs <= dep.abs) continue;
    const cars = Array.isArray(t.cars) ? t.cars : [];
    const classes = {};
    let berthCars = 0;
    for (const car of cars) {
      const key = berthClassOf(car?.type);
      if (!key) continue;
      berthCars++;
      for (const tariff of Array.isArray(car.tariffs) ? car.tariffs : []) {
        const v = Number(tariff?.tariff);
        if (Number.isFinite(v) && v > 0 && (classes[key] == null || v < classes[key])) classes[key] = v;
      }
    }
    out.push({
      number,
      type: t.type ?? null,
      brand: t.brand ?? null,
      originName: t.originRoute?.depStationName?.trim() ?? null,
      terminusName: t.originRoute?.arvStationName?.trim() ?? null,
      fromCode: t.subRoute?.depStationCode ?? null,
      toCode: t.subRoute?.arvStationCode ?? null,
      dep,
      arr,
      hasCars: cars.length > 0,
      berthCars,
      classes,
    });
  }
  return out;
}

// ─── Stations ───────────────────────────────────────────────────────────────

/** config.stations → { byCode, byFold } — a station's code, name, position and spellings. */
export function stationIndex(config) {
  const byCode = new Map();
  const byFold = new Map();
  for (const s of config.stations ?? []) {
    byCode.set(String(s.code), s);
    for (const alias of [s.name, ...(s.aliases ?? [])]) byFold.set(foldName(alias), s);
  }
  return { byCode, byFold };
}

/** The configured station a name in an answer means, or null. */
export const stationNamed = (index, name) => index.byFold.get(foldName(name)) ?? null;

// ─── Building trains ────────────────────────────────────────────────────────

/**
 * One train's stop list from the hub searches of one date.
 *
 * `obs` are the train's appearances in searches hub → X (an arrival at X after
 * the hub) and X → hub (a departure from X before it). Each gives the time at
 * X and at the hub in the same answer, so the stops are ordered by their
 * distance in minutes from the hub and need no date of their own; the whole
 * run is then laid out from the first station's clock.
 *
 * @returns {{ stops: {code, name, arrMinutes: number|null, depMinutes: number|null}[], originClock: number } | { error: string }}
 */
export function stopsFromObservations(obs, { hub, index }) {
  const before = new Map(); // code → minutes before the hub arrival (dep at X)
  const after = new Map(); // code → minutes after the hub departure (arr at X)
  let hubArr = null;
  let hubDep = null;
  for (const o of obs) {
    if (o.toCode === hub && o.fromCode !== hub) {
      before.set(o.fromCode, o.arr.abs - o.dep.abs);
      hubArr = o.arr.minutes;
    } else if (o.fromCode === hub && o.toCode !== hub) {
      after.set(o.toCode, o.arr.abs - o.dep.abs);
      hubDep = o.dep.minutes;
    }
  }
  const head = [...before].sort((a, b) => b[1] - a[1]);
  const tail = [...after].sort((a, b) => a[1] - b[1]);
  if (!head.length && hubDep == null) return { error: "never seen leaving the hub or arriving at it" };
  // The hub's own dwell, from its two clocks (a train that starts or ends
  // there has one of them).
  const dwell = hubArr != null && hubDep != null ? (hubDep - hubArr + 1440) % 1440 : 0;
  const lead = head.length ? head[0][1] : 0;
  const stops = [];
  for (const [code, mins] of head) stops.push({ code, depMinutes: lead - mins, arrMinutes: null });
  stops.push({ code: hub, arrMinutes: head.length ? lead : null, depMinutes: hubDep != null ? lead + dwell : null });
  for (const [code, mins] of tail) stops.push({ code, arrMinutes: lead + dwell + mins, depMinutes: null });
  if (stops.length < 2) return { error: "one station only" };
  const originClock = head.length ? (hubArr - lead + 1440 * 2) % 1440 : hubDep;
  const named = stops.map((s) => ({ ...s, name: index.byCode.get(s.code)?.name ?? null }));
  const unknown = named.filter((s) => !s.name).map((s) => s.code);
  if (unknown.length) return { error: `stations not in the config: ${unknown.join(", ")}` };
  return { stops: named, originClock };
}

const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Weekdays (Mon = 0) of the dates a train ran on, as the trains files spell them. */
export function serviceDays(dates) {
  const on = new Set(dates.map((d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
  if (!on.size) return null;
  if (on.size === 7) return "Daily";
  return [...on].sort((a, b) => a - b).map((i) => SHORT[i]).join(", ");
}

/** { classKey: so'm } → the fare record a trains file carries, or null when no berth is priced. */
export function fareRecord(classes, { sampledAt, travelDate }) {
  const entries = Object.entries(classes ?? {}).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return { fromPrice: entries[0][1], currency: "UZS", seatClass: entries[0][0], classes: Object.fromEntries(entries), sampledAt, travelDate };
}

/**
 * Outbound and return in file order, because appendSyntheticRoutes pairs each
 * train with the first reverse one after it: one number's two directions
 * (080Ф / 080Ь), else an odd number and the even one after it (125 / 126).
 */
export function pairOrder(trains) {
  const list = [...trains].sort((a, b) => Number(trainDigits(a.number)) - Number(trainDigits(b.number)) || a.number.localeCompare(b.number));
  const reverseOf = (a, b) => a.originCode === b.terminusCode && a.terminusCode === b.originCode;
  const out = [];
  const used = new Set();
  for (const t of list) {
    if (used.has(t.number)) continue;
    out.push(t);
    used.add(t.number);
    const d = Number(trainDigits(t.number));
    const partner =
      list.find((o) => !used.has(o.number) && Number(trainDigits(o.number)) === d && reverseOf(t, o)) ??
      list.find((o) => !used.has(o.number) && d % 2 === 1 && Number(trainDigits(o.number)) === d + 1 && reverseOf(t, o));
    if (partner) {
      out.push(partner);
      used.add(partner.number);
    }
  }
  return out;
}

/**
 * How long a train the shop stopped answering for is carried from last
 * night's file (the 30 days SRT, VNR and fares.mjs keep).
 */
export const CARRY_MAX_DAYS = 30;

const clock = (m) => {
  const v = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};

/**
 * The trains file entries.
 *
 * @param {object} args
 * @param {object} args.config            data/sources/uty-sleepers.json
 * @param {Map<string, object>|null} args.found  tonight's night trains by number: { stops, originClock, originCode, terminusCode, frequency, fare, brand } (null: shop unreachable)
 * @param {object} [args.previous]        last night's trains, by name
 * @param {[number, number][][]|null} [args.osmTrack]
 */
export function buildUtyTrains({ config, found, previous = {}, today, travelDate, osmTrack = null, log = () => {} }) {
  const index = stationIndex(config);
  const operator = config.operator ?? {};
  const graphs = osmTrack?.length ? [["osm", buildRailGraph(osmTrack, { joinMeters: config.osmJoinMeters ?? 60 })]] : [];
  const memo = new Map();
  const fresh = (t) => {
    const at = Date.parse(`${t?.timetable?.checkedAt ?? ""}T00:00:00Z`);
    return Number.isFinite(at) && (Date.parse(`${today}T00:00:00Z`) - at) / 86_400_000 <= CARRY_MAX_DAYS;
  };
  const prev = new Map(Object.values(previous ?? {}).filter(fresh).map((t) => [t.trainNo, t]));
  const trains = {};
  const live = found ? [...found.values()] : [];
  const liveNumbers = new Set(live.map((t) => t.number));
  // A train tonight's searches did not reach is carried as it was.
  const carried = [...prev.values()].filter((t) => !liveNumbers.has(t.trainNo));
  const ordered = pairOrder([
    ...live,
    ...carried.map((t) => ({ number: t.trainNo, originCode: t.originCode, terminusCode: t.terminusCode, carried: t })),
  ]);
  for (const t of ordered) {
    if (t.carried) {
      trains[t.carried.lineName] = { ...t.carried, timetable: { ...t.carried.timetable, source: "previous" } };
      continue;
    }
    const placed = t.stops.map((s) => ({ ...s, station: index.byCode.get(s.code) }));
    const points = placed.map((s) => [s.station.lat, s.station.lon]);
    let encoded;
    let geometry;
    if (graphs.length) {
      const routed = routeThroughStops(points, graphs, () => null, memo);
      geometry = routed.sources.reduce((acc, src) => ({ ...acc, [src]: (acc[src] ?? 0) + 1 }), {});
      encoded = polyline.encode(routed.path);
    } else {
      geometry = { chord: points.length - 1 };
      encoded = polyline.encode(points);
    }
    // A night without OSM must not make a line worse than last night's.
    const before = prev.get(t.number);
    const sameStops = before?.stations?.map((s) => s.name).join(">") === placed.map((s) => s.station.name).join(">");
    if (sameStops && (geometry.chord ?? 0) > (before.geometry?.chord ?? Infinity) && before.polyline) {
      encoded = before.polyline;
      geometry = { ...before.geometry, carried: true };
    }
    if (geometry.chord) log(`${t.number}: ${geometry.chord} of ${points.length - 1} gap(s) drawn straight — no track found between those stops`);
    const last = placed.length - 1;
    const at = (m) => (m == null ? { time: null, day: null } : { time: clock(t.originClock + m), day: Math.floor((t.originClock + m) / 1440) });
    const stations = placed.map((s, i) => {
      // A stop carries the one time the shop states for it: the departure on
      // the near side of the hub, the arrival beyond it (the hub has both).
      const a = i === 0 ? { time: null, day: null } : at(s.arrMinutes);
      const d = i === last ? { time: null, day: null } : at(s.depMinutes);
      return {
        name: s.station.name,
        location: { latitude: s.station.lat, longitude: s.station.lon },
        code: s.code,
        arrival: a.time,
        departure: d.time,
        arrivalDay: a.day,
        departureDay: d.day,
        pickup: true,
        dropoff: true,
      };
    });
    const durationMinutes = placed[last].arrMinutes - placed[0].depMinutes;
    const fare = t.fare ?? before?.fare ?? null;
    trains[t.number] = {
      lineName: t.number,
      trainNo: t.number,
      operator: operator.name ?? "Uzbekistan Railways",
      agency_id: operator.agencyId ?? "UTY",
      ...(t.brand ? { brand: t.brand } : {}),
      originCode: t.originCode,
      terminusCode: t.terminusCode,
      frequency: t.frequency ?? before?.frequency ?? null,
      durationMinutes,
      nights: stations[last].arrivalDay,
      polyline: encoded,
      geometry,
      stations,
      ...(fare ? { fare } : {}),
      timetable: { source: "official", checkedAt: today, travelDate: t.travelDate ?? travelDate },
    };
  }
  return trains;
}

/**
 * Whether an assembled train is a night train with berths: through a night,
 * at least `minMinutes` long, and a berth car on sale in some answer tonight
 * (or last night). A train sold out in every answer has no car list at all;
 * it is kept when its brand is one the config names as a sleeper service.
 */
export function isNightSleeper(t, { minMinutes = 300, sleeperBrands = [] } = {}, previousHadBerths = false) {
  const first = t.stops[0];
  const last = t.stops.at(-1);
  const minutes = last.arrMinutes - first.depMinutes;
  if (!(minutes >= minMinutes)) return { keep: false, why: `${minutes} min` };
  if (Math.floor((t.originClock + last.arrMinutes) / 1440) < 1) return { keep: false, why: "arrives the same day" };
  if (t.berthCars > 0 || previousHadBerths) return { keep: true };
  if (!t.anyCars && sleeperBrands.map(foldName).includes(foldName(t.brand))) return { keep: true, why: "sold out tonight, sleeper brand" };
  return { keep: false, why: t.anyCars ? "seats only" : "no car list" };
}

// ─── The shop ───────────────────────────────────────────────────────────────

export const SHOP = "https://eticket.uzrailpass.uz";
const FETCH_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The shop's public search, asked as its own page asks it: the token call the
 * page makes on load (GET /api/v1/csrf-token sets the XSRF-TOKEN cookie, sent
 * back as X-XSRF-TOKEN), then the search POST. An honest User-Agent, one
 * request at a time, `spacingMs` apart, at most `maxRequests` a night. A block
 * (detectBlock: 403/429/451, a challenge page) ends the night: the shop's 429
 * is its own "user_blocked", and this map never works around one. A 403 that
 * is Spring Security's missing-token message is the token having lapsed: the
 * token call is made once more and the search retried once.
 */
export function makeUtyClient({ base = SHOP, fetchImpl = fetch, spacingMs = 1_500, maxRequests = 400, detectBlock, userAgent, log = () => {} }) {
  const cookies = new Map();
  let blocked = null;
  let requests = 0;
  let opened = false;
  const remember = (res) => {
    const lines = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  async function call(pathname, json = null) {
    if (blocked) throw new Error(`blocked: ${blocked.reason}`);
    if (requests >= maxRequests) throw new Error(`request budget of ${maxRequests} spent`);
    await sleep(spacingMs);
    requests += 1;
    const headers = {
      "User-Agent": userAgent,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "uz",
      "X-Custom-Language": "uz",
      "device-type": "BROWSER",
      Origin: base,
      Referer: `${base}/uz/home`,
    };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookies.has("XSRF-TOKEN")) headers["X-XSRF-TOKEN"] = decodeURIComponent(cookies.get("XSRF-TOKEN"));
    if (json) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(`${base}${pathname}`, {
      method: json ? "POST" : "GET",
      headers,
      body: json ? JSON.stringify(json) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    remember(res);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }
  const isCsrfRefusal = (r) => r.status === 403 && /csrf token/i.test(r.text) && !/<html/i.test(r.text);
  async function open() {
    const r = await call("/api/v1/csrf-token");
    if (r.status >= 400) {
      const block = detectBlock({ status: r.status, headers: r.headers, body: r.text }, { expectJson: true });
      if (block) {
        blocked = block;
        throw new Error(`blocked: ${block.reason}`);
      }
      throw new Error(`csrf-token: HTTP ${r.status}`);
    }
    if (!cookies.has("XSRF-TOKEN")) log("the token call set no XSRF-TOKEN cookie; searching without one");
    opened = true;
  }
  /** Every train between two stations on a date (YYYY-MM-DD), read by readSearch. */
  async function search(from, to, date) {
    if (!opened) await open();
    const body = { directions: { forward: { date, depStationCode: from, arvStationCode: to } } };
    let r = await call("/api/v3/handbook/trains/list", body);
    if (isCsrfRefusal(r)) {
      await open();
      r = await call("/api/v3/handbook/trains/list", body);
    }
    if (r.status >= 500) {
      log(`search ${from} → ${to} ${date}: HTTP ${r.status}, retrying once`);
      r = await call("/api/v3/handbook/trains/list", body);
    }
    const block = detectBlock({ status: r.status, headers: r.headers, body: r.text }, { expectJson: true });
    if (block) {
      blocked = block;
      throw new Error(`blocked: ${block.reason}`);
    }
    if (r.status === 204 || !r.text) return [];
    if (r.status >= 400) throw new Error(`search ${from} → ${to} ${date}: HTTP ${r.status}`);
    let answer;
    try {
      answer = JSON.parse(r.text);
    } catch {
      throw new Error(`search ${from} → ${to} ${date}: not JSON`);
    }
    if (answer?.error) throw new Error(`search ${from} → ${to} ${date}: ${JSON.stringify(answer.error).slice(0, 200)}`);
    // The station codes are the ones asked about, whatever the answer echoes:
    // a search from the city code would otherwise read as a third station.
    return readSearch(answer).map((t) => ({ ...t, fromCode: from, toCode: to, date }));
  }
  return {
    search,
    get requests() {
      return requests;
    },
    get blocked() {
      return blocked;
    },
  };
}

// ─── One night ──────────────────────────────────────────────────────────────

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The dates whose hub searches give tonight's stop lists. A search is dated
 * by the departure at its first station, so one run's stations before
 * midnight and after it answer on two consecutive dates: every sweep reads a
 * date and the one after it, and a train running on the first gets its whole
 * stop list. A train is only in the answers of a date it runs, so the first
 * night (no previous file) reads `firstDates` + 1 consecutive dates; after
 * that two a night, rotating through the week, and a train not seen keeps its
 * stop list from last night's file (carried up to CARRY_MAX_DAYS).
 */
export function sweepDates({ today, offsetDays = 7, hasPrevious, firstDates = 3 }) {
  const d0 = addDays(today, offsetDays);
  if (!hasPrevious) return Array.from({ length: firstDates + 1 }, (_, i) => addDays(d0, i));
  const dayIndex = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);
  const start = addDays(d0, dayIndex % 7);
  return [start, addDays(start, 1)];
}

/**
 * Tonight's night trains from the shop: hub sweep for stop lists, week sweep
 * between each train's own ends for its days and fare. Returns the trains by
 * number (see buildUtyTrains) plus what the run saw, for the log.
 */
export async function readNight({ client, config, today, offsetDays = 7, previous = {}, log = () => {} }) {
  const index = stationIndex(config);
  const hub = String(config.hub);
  const hasPrevious = Object.keys(previous ?? {}).length > 0;
  const dates = sweepDates({ today, offsetDays, hasPrevious, firstDates: config.firstSweepDates ?? 3 });
  const cache = new Map();
  let failures = 0;
  const ask = async (from, to, date) => {
    const key = `${from}>${to}@${date}`;
    if (cache.has(key)) return cache.get(key);
    let result = null;
    try {
      result = await client.search(from, to, date);
    } catch (err) {
      if (client.blocked) throw err;
      failures++;
      log(err.message);
    }
    cache.set(key, result);
    return result;
  };

  // 1. Hub sweep: every configured station, both ways, on each sweep date.
  const obsByTrain = new Map(); // number → date → obs[]
  for (const date of dates) {
    for (const s of config.stations ?? []) {
      const code = String(s.code);
      if (code === hub) continue;
      for (const [from, to] of [[hub, code], [code, hub]]) {
        for (const o of (await ask(from, to, date)) ?? []) {
          if (!obsByTrain.has(o.number)) obsByTrain.set(o.number, new Map());
          const byDate = obsByTrain.get(o.number);
          if (!byDate.has(date)) byDate.set(date, []);
          byDate.get(date).push(o);
        }
      }
    }
  }

  // 2. Each train's stop list, from every sweep date together: a station's
  // minutes to the hub are the same on every run, so answers about two runs
  // of one train complete each other.
  const prevByNumber = new Map(Object.values(previous ?? {}).map((t) => [t.trainNo, t]));
  const assembled = new Map();
  const skipped = [];
  for (const [number, byDate] of obsByTrain) {
    const date = [...byDate.keys()].sort()[0];
    const all = [...byDate.values()].flat();
    const obs = all;
    const built = stopsFromObservations(obs, { hub, index });
    if (built.error) {
      skipped.push(`${number} (${built.error})`);
      continue;
    }
    const sample = obs[0];
    const origin = stationNamed(index, sample.originName);
    const terminus = stationNamed(index, sample.terminusName);
    if (origin?.code !== built.stops[0].code || terminus?.code !== built.stops.at(-1).code) {
      skipped.push(`${number} (${sample.originName} → ${sample.terminusName}: an end is not a configured station)`);
      continue;
    }
    const t = {
      number,
      brand: sample.brand,
      date,
      stops: built.stops,
      originClock: built.originClock,
      originCode: origin.code,
      terminusCode: terminus.code,
      berthCars: all.reduce((n, o) => n + o.berthCars, 0),
      anyCars: all.some((o) => o.hasCars),
    };
    const verdict = isNightSleeper(t, config, prevByNumber.get(number)?.fare != null);
    if (!verdict.keep) {
      skipped.push(`${number} (${verdict.why})`);
      continue;
    }
    if (verdict.why) log(`${number}: ${verdict.why}`);
    assembled.set(number, t);
  }

  // 3. Week sweep between each train's own ends (tonight's and last night's):
  // the dates it leaves its first station on, and the whole journey's fare.
  const pairs = new Map();
  for (const t of assembled.values()) pairs.set(`${t.originCode}>${t.terminusCode}`, [t.originCode, t.terminusCode]);
  for (const t of prevByNumber.values()) if (t.originCode && t.terminusCode) pairs.set(`${t.originCode}>${t.terminusCode}`, [t.originCode, t.terminusCode]);
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, offsetDays + i));
  const runs = new Map(); // number → { dates: [], answered: n, fare }
  for (const [from, to] of pairs.values()) {
    let answered = 0;
    const seen = new Map();
    for (const date of week) {
      const result = await ask(from, to, date);
      if (!result) continue;
      answered++;
      for (const o of result) {
        if (!seen.has(o.number)) seen.set(o.number, []);
        seen.get(o.number).push(o);
      }
    }
    for (const [number, list] of seen) {
      const r = { dates: list.map((o) => o.date), answered, fare: null, travelDate: null };
      // A class sold out on the nearest date is priced from the next date
      // that sells it: the tariff is per class and distance, so each class
      // keeps the figure of the nearest date it is on sale.
      const classes = {};
      let travelDate = null;
      for (const o of [...list].sort((x, y) => x.date.localeCompare(y.date))) {
        for (const [key, value] of Object.entries(o.classes)) {
          if (classes[key] == null) {
            classes[key] = value;
            travelDate ??= o.date;
          } else if (classes[key] !== value) {
            log(`${number}: ${key} ${classes[key]} on the nearest date, ${value} on ${o.date}`);
          }
        }
      }
      if (travelDate) {
        r.fare = fareRecord(classes, { sampledAt: today, travelDate });
        r.travelDate = travelDate;
      }
      runs.set(`${number}@${from}>${to}`, r);
    }
  }
  const found = new Map();
  for (const t of assembled.values()) {
    const r = runs.get(`${t.number}@${t.originCode}>${t.terminusCode}`);
    found.set(t.number, {
      ...t,
      frequency: r && r.answered === week.length ? serviceDays(r.dates) : null,
      fare: r?.fare ?? null,
      travelDate: t.date,
    });
  }
  // A carried train's days and fare are refreshed by the week sweep too.
  const refreshed = new Map();
  for (const t of prevByNumber.values()) {
    if (found.has(t.trainNo)) continue;
    const r = runs.get(`${t.trainNo}@${t.originCode}>${t.terminusCode}`);
    if (r) refreshed.set(t.trainNo, { frequency: r.answered === week.length ? serviceDays(r.dates) : t.frequency, fare: r.fare ?? t.fare ?? null });
  }
  return { found, refreshed, dates, skipped, failures, requests: client.requests };
}
