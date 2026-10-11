// scripts/lib/nj-fare-check.mjs
// Checking the Nightjet fare calendar against the source it was read from.
// The product owner compared our calendar with ÖBB's shop and found figures
// that did not match; whether that is our reading, our staleness, or
// nightjet.com and the shop disagreeing can only be settled by asking again
// and putting the answers side by side. This module is the pure half of that
// check (scripts/probe-nj-fares.mjs does the asking): which stored nights to
// re-ask about, how to read an answer independently of the nightly reader,
// what each difference is called, the summary maths, a robots.txt reading,
// the ÖBB shop's request bodies and offer shape, the dated shop link, and the
// report's table, CSV and markdown.
//
// The calendar night it reads is the shared contract written by
// scripts/lib/nj-fares.mjs:
//   { classes: { couchette?, sleeperBed? }, checkedAt, dep?, arr?, seat?,
//     offers?: { couchette?, sleeperBed? } }
//   | { none: true, checkedAt, reason?: "noBerth" | "noJourney", seat? }
// `seat` is a verification figure only — never a class, never a fare.
//
// Dependency-free apart from the nightly reader it cross-checks. Covered by
// tests/verify-nj-fare-check.mjs.

import { journeysFromOffers, pricingEnds, viennaDateTime } from "./nj-fares.mjs";

export const NJ_ROBOTS_URL = "https://www.nightjet.com/robots.txt";
export const SHOP_BASE = "https://shop.oebbtickets.at";
export const SHOP_PATHS = {
  robots: "/robots.txt",
  token: "/api/domain/v1/anonymousToken",
  init: "/api/domain/v1/initUserData",
  timetable: "/api/hafas/v4/timetable",
  offers: "/api/offer/v6/offers",
};

/** The product token our User-Agent leads with, for a robots.txt group of our own. */
export const ROBOTS_AGENT = "pingwi";

/**
 * How far ahead a night is, in the buckets the summary reports exact-match
 * shares by. Near nights move fastest (Sparschiene quotas sell out), so a
 * stale near night and a stale far one say different things.
 */
export const LEAD_BUCKETS = [
  { label: "1–3", min: 1, max: 3 },
  { label: "4–7", min: 4, max: 7 },
  { label: "8–14", min: 8, max: 14 },
  { label: "15–21", min: 15, max: 21 },
  { label: "22–42", min: 22, max: 42 },
];

/**
 * The EuroNight trains run with partner railways. Their berth prices do not
 * sit on ÖBB's x4.90 / x9.90 ladder (EN 40458/40459 sell a sleeper at €296–340
 * and never a couchette), so a figure not ending in .9 is expected there and a
 * surprise anywhere else.
 */
export const DEFAULT_PARTNER_TRAINS = [
  "EN 40457", "EN 40476", "EN 40462", "EN 40467", "EN 50462", "EN 40458", "EN 40459",
];

/**
 * Trains that leave the same minute under two numbers and are coupled for part
 * of the way. Their calendars disagree in a way worth seeing side by side:
 * NJ 40421 (Amsterdam → Wien) had no berth on any night while NJ 421
 * (Amsterdam → Innsbruck) priced every one, and NJ 493 beside NJ 40491 the same.
 */
export const DEFAULT_COUPLED_PAIRS = [
  ["NJ 40421", "NJ 421"],
  ["NJ 493", "NJ 40491"],
];

export const DEFAULT_CHECK_CONFIG = {
  disputed: [],
  maxRequests: 60,
  spacingSeconds: 2,
  perLeadBucket: 2,
  repeats: 3,
  repeatMinGapSeconds: 300,
  anomaliesPerKind: 4,
  seatLevelMax: 39.9,
  partnerTrains: DEFAULT_PARTNER_TRAINS,
  coupledPairs: DEFAULT_COUPLED_PAIRS,
  nightsPerCoupledPair: 2,
  // Off unless the committed config turns it on: asking the shop's API is a
  // decision for the owner, not a default.
  shop: { enabled: false, maxTrainNights: 3, spacingSeconds: 5 },
};

/** Names of the flags a sampled night can carry, as the report prints them. */
export const FLAGS = {
  leAtOrBelowSe: "LE<=SE",
  beBelowLe: "BE<LE",
  depNotNight: "DEP≠NIGHT",
  depMoved: "DEP-MOVED",
  pricedToNone: "PRICED→NONE",
  noneToPriced: "NONE→PRICED",
  deltaCouchette: "Δc",
  deltaSleeper: "Δs",
  notSparschiene: "NOT-SPARSCHIENE",
  non9: "NON-.9",
  repeatDiff: "REPEAT-DIFF",
  readerDiff: "READER≠",
  storedLeSe: "STORED-LE<=SE",
  shopDiff: "SHOP≠LIVE",
  error: "ERR",
};

/** Response headers that say whether an answer was cached, and by whom. */
export const EVIDENCE_HEADERS = [
  "date", "cache-control", "age", "etag", "last-modified", "server", "via",
  "x-cache", "cf-cache-status", "cf-ray", "cf-mitigated", "x-azure-ref", "x-msedge-ref", "content-type",
];

// Headers whose value is different on every response by design; the summary
// counts them rather than listing their values.
const PER_RESPONSE_HEADERS = new Set(["date", "cf-ray", "x-azure-ref", "x-msedge-ref", "etag"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

// ── Dates ────────────────────────────────────────────────────────────────────

/** Today's date in Vienna — the calendar's own day — at an instant. */
export function viennaToday(ms) {
  return viennaDateTime(ms)?.slice(0, 10) ?? null;
}

export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both ISO dates); null when either is unreadable. */
export function daysBetween(a, b) {
  if (!ISO_DATE.test(String(a ?? "")) || !ISO_DATE.test(String(b ?? ""))) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** The lead bucket's label for a night `lead` days ahead ("43+" past the calendar). */
export function leadBucket(lead) {
  if (!Number.isFinite(lead) || lead < 1) return "past";
  return LEAD_BUCKETS.find((b) => lead >= b.min && lead <= b.max)?.label ?? "43+";
}

// ── Sampling ─────────────────────────────────────────────────────────────────

/**
 * FNV-1a, 32-bit. Seeded with the date, it orders candidates the same way on
 * every rerun that day — so a second run re-asks the nights the first one did
 * and the two can be compared — and differently the next day.
 */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cents = (v) => Math.round(v * 100);
const samePrice = (a, b) => (a == null && b == null) || (a != null && b != null && cents(a) === cents(b));

/**
 * The committed check config with the defaults filled in. Never throws: an
 * entry it cannot use is reported in `problems`, because a typo in the owner's
 * list of disputed nights must not cost the rest of the report.
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const problems = [];
  const positive = (key, fallback) => {
    const v = src[key];
    if (v == null) return fallback;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    problems.push(`${key}: ${JSON.stringify(v)} is not a number ≥ 0 — using ${fallback}`);
    return fallback;
  };
  const disputed = [];
  for (const [i, d] of (Array.isArray(src.disputed) ? src.disputed : []).entries()) {
    const train = typeof d?.train === "string" ? d.train.trim().replace(/\s+/g, " ") : "";
    const date = String(d?.date ?? "");
    if (!train || !ISO_DATE.test(date)) {
      problems.push(`disputed[${i}]: needs "train" and a "date" as YYYY-MM-DD — skipped`);
      continue;
    }
    const shop = d.shop && typeof d.shop === "object"
      ? {
          price: parseOfferPrice(d.shop.price),
          product: d.shop.product ?? null,
          compartment: d.shop.compartment ?? null,
          seenAt: d.shop.seenAt ?? null,
        }
      : null;
    disputed.push({ train, date, shop, note: d.note ?? null });
  }
  const pairs = Array.isArray(src.coupledPairs)
    ? src.coupledPairs.filter((p) => Array.isArray(p) && p.length === 2 && p.every((k) => typeof k === "string"))
    : DEFAULT_CHECK_CONFIG.coupledPairs;
  const shopSrc = src.shop && typeof src.shop === "object" ? src.shop : {};
  const shopNumber = (key) => {
    const v = shopSrc[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_CHECK_CONFIG.shop[key];
  };
  return {
    disputed,
    maxRequests: positive("maxRequests", DEFAULT_CHECK_CONFIG.maxRequests),
    spacingSeconds: positive("spacingSeconds", DEFAULT_CHECK_CONFIG.spacingSeconds),
    perLeadBucket: positive("perLeadBucket", DEFAULT_CHECK_CONFIG.perLeadBucket),
    repeats: positive("repeats", DEFAULT_CHECK_CONFIG.repeats),
    repeatMinGapSeconds: positive("repeatMinGapSeconds", DEFAULT_CHECK_CONFIG.repeatMinGapSeconds),
    anomaliesPerKind: positive("anomaliesPerKind", DEFAULT_CHECK_CONFIG.anomaliesPerKind),
    seatLevelMax: positive("seatLevelMax", DEFAULT_CHECK_CONFIG.seatLevelMax),
    nightsPerCoupledPair: positive("nightsPerCoupledPair", DEFAULT_CHECK_CONFIG.nightsPerCoupledPair),
    partnerTrains: Array.isArray(src.partnerTrains) ? src.partnerTrains.map(String) : DEFAULT_CHECK_CONFIG.partnerTrains,
    coupledPairs: pairs,
    seed: typeof src.seed === "string" && src.seed ? src.seed : null,
    shop: {
      enabled: shopSrc.enabled === true,
      maxTrainNights: shopNumber("maxTrainNights"),
      spacingSeconds: shopNumber("spacingSeconds"),
    },
    problems,
  };
}

/** One stored calendar night in the probe's terms. */
export function storedNight(entry) {
  if (!entry || typeof entry !== "object") return { status: "missing" };
  const base = { checkedAt: entry.checkedAt ?? null, seat: num(entry.seat) };
  if (entry.none) return { ...base, status: "none", reason: entry.reason ?? null };
  const classes = entry.classes ?? {};
  const couchette = num(classes.couchette);
  const sleeperBed = num(classes.sleeperBed);
  if (couchette == null && sleeperBed == null) return { ...base, status: "none", reason: null };
  return {
    ...base,
    status: "priced",
    couchette,
    sleeperBed,
    offers: entry.offers && typeof entry.offers === "object" ? entry.offers : {},
    dep: entry.dep ?? null,
    arr: entry.arr ?? null,
  };
}

/** Every stored night after `today`, per train, with its lead. */
export function storedNights(trains, today) {
  const out = [];
  for (const key of Object.keys(trains ?? {}).sort()) {
    const nights = trains[key]?.fareCalendar?.nights ?? {};
    for (const night of Object.keys(nights).sort()) {
      if (!ISO_DATE.test(night) || night <= today) continue;
      out.push({ key, night, lead: daysBetween(today, night), stored: storedNight(nights[night]) });
    }
  }
  return out;
}

const endsInNine = (price) => cents(price) % 100 === 90;

/**
 * The stored nights whose figures look wrong on their face, by kind. Each is a
 * hypothesis the live answer can confirm or retire:
 *   leAtOrBelowSeat  a couchette at or below the same night's seat price — the
 *                    owner's "is this a seat price?" exactly (needs `seat`)
 *   seatLevel        a couchette at a seat's price (≤ €39.9)
 *   sleeperBelowCouchette  a bed cheaper than a couchette that night
 *   sleeperOnly      a bed and no couchette (the grid then shows a bed's price)
 *   partnerPricing   a partner EuroNight's figure off the .9 ladder
 */
export function findAnomalies(trains, { today, seatLevelMax = 39.9, partnerTrains = DEFAULT_PARTNER_TRAINS } = {}) {
  const partner = new Set(partnerTrains);
  const kinds = { leAtOrBelowSeat: [], seatLevel: [], sleeperBelowCouchette: [], sleeperOnly: [], partnerPricing: [] };
  for (const { key, night, stored } of storedNights(trains, today)) {
    if (stored.status !== "priced") continue;
    const { couchette: c, sleeperBed: s, seat } = stored;
    if (c != null && seat != null && c <= seat) kinds.leAtOrBelowSeat.push({ key, night, detail: `couchette ${c} ≤ seat ${seat}` });
    if (c != null && c <= seatLevelMax) kinds.seatLevel.push({ key, night, detail: `couchette ${c}` });
    if (c != null && s != null && s < c) kinds.sleeperBelowCouchette.push({ key, night, detail: `bed ${s} < couchette ${c}` });
    if (c == null && s != null) kinds.sleeperOnly.push({ key, night, detail: `bed ${s}, no couchette` });
    if (partner.has(key)) {
      const off = [c, s].filter((v) => v != null && !endsInNine(v));
      if (off.length) kinds.partnerPricing.push({ key, night, detail: `${off.join(", ")} off the .9 ladder` });
    }
  }
  return kinds;
}

export const ANOMALY_LABELS = {
  leAtOrBelowSeat: "couchette ≤ seat",
  seatLevel: "couchette at seat level",
  sleeperBelowCouchette: "bed < couchette",
  sleeperOnly: "bed only",
  partnerPricing: "partner pricing",
};

const pricedSame = (a, b) =>
  a.status === b.status && samePrice(a.couchette ?? null, b.couchette ?? null) && samePrice(a.sleeperBed ?? null, b.sleeperBed ?? null);

/** The nights both trains of a coupled pair carry, and whether they disagree. */
export function coupledNights(trains, [a, b], { today }) {
  const nightsA = trains?.[a]?.fareCalendar?.nights ?? {};
  const nightsB = trains?.[b]?.fareCalendar?.nights ?? {};
  return Object.keys(nightsA)
    .filter((night) => ISO_DATE.test(night) && night > today && nightsB[night])
    .sort()
    .map((night) => {
      const sa = storedNight(nightsA[night]);
      const sb = storedNight(nightsB[night]);
      return { night, a: sa, b: sb, differs: !pricedSame(sa, sb) };
    });
}

/**
 * Up to `limit` items, spread across trains: in hash order, the first night of
 * each distinct train before any train's second, so one train with forty odd
 * nights cannot fill a kind on its own.
 */
export function pickSpread(items, limit, { seed, salt = "" }) {
  const ordered = [...items].sort(
    (x, y) => hash32(`${seed}|${salt}|${x.key}|${x.night}`) - hash32(`${seed}|${salt}|${y.key}|${y.night}`)
      || (x.key + x.night < y.key + y.night ? -1 : 1),
  );
  const out = [];
  const taken = new Set();
  while (out.length < limit && taken.size < ordered.length) {
    const used = new Set();
    for (const [i, item] of ordered.entries()) {
      if (out.length >= limit) break;
      if (taken.has(i) || used.has(item.key)) continue;
      taken.add(i);
      used.add(item.key);
      out.push(item);
    }
  }
  return out;
}

/**
 * Which nights to ask nightjet.com about, in order of priority:
 *   A  every disputed night the owner listed (config.disputed)
 *   B  anomalies (findAnomalies, per kind up to anomaliesPerKind across
 *      distinct trains) and coupled pairs on the same night
 *   C  a stratified spread: perLeadBucket priced nights per lead bucket, on
 *      distinct trains, by a hash seeded with the date
 *   D  `repeats` of the C requests asked again at the end, to see whether an
 *      answer is stable
 * A (train, night) picked twice is asked once and carries both reasons. The
 * whole run makes at most config.maxRequests requests to nightjet.com,
 * robots.txt included; what that cap drops is returned in `dropped`, so the
 * report can say what was not asked rather than leave it to be noticed.
 */
export function planSample(trains, config, { today }) {
  const seed = config.seed ?? today;
  const budget = Math.max(0, Math.floor(config.maxRequests) - 1);
  const requests = [];
  const byNight = new Map();
  const dropped = [];
  const droppedByNight = new Map();
  const notes = [];
  const storedOf = (key, night) => storedNight(trains?.[key]?.fareCalendar?.nights?.[night]);

  const add = (group, key, night, reason) => {
    const id = `${key}|${night}`;
    const existing = byNight.get(id) ?? droppedByNight.get(id);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return byNight.has(id) ? existing : null;
    }
    if (!pricingEnds(trains?.[key])) {
      notes.push(`${key} ${night} (${reason}): ${trains?.[key] ? "no 7-digit station id at one end" : "not in the trains file"} — cannot be asked`);
      return null;
    }
    const lead = daysBetween(today, night);
    const request = { id: requests.length + 1, group, key, night, lead, bucket: leadBucket(lead), reasons: [reason] };
    if (requests.length >= budget) {
      request.id = null;
      dropped.push(request);
      droppedByNight.set(id, request);
      return null;
    }
    requests.push(request);
    byNight.set(id, request);
    return request;
  };

  // A. The owner's own examples come first: they are the complaint.
  for (const d of config.disputed ?? []) {
    if (d.date <= today) {
      notes.push(`${d.train} ${d.date} (disputed): not after today (${today}) — the train has left, nothing to ask`);
      continue;
    }
    add("A", d.train, d.date, "disputed");
  }

  // B. Anomalies, each kind spread across trains.
  const anomalies = findAnomalies(trains, {
    today, seatLevelMax: config.seatLevelMax, partnerTrains: config.partnerTrains,
  });
  const anomalyCounts = {};
  for (const [kind, items] of Object.entries(anomalies)) {
    anomalyCounts[kind] = items.length;
    for (const item of pickSpread(items, config.anomaliesPerKind, { seed, salt: kind })) {
      add("B", item.key, item.night, ANOMALY_LABELS[kind]);
    }
  }
  for (const pair of config.coupledPairs ?? []) {
    const nights = coupledNights(trains, pair, { today });
    anomalyCounts[`coupled ${pair[0]} / ${pair[1]}`] = nights.filter((n) => n.differs).length;
    // Nights the two disagree on are the question; the rest only fill in.
    const ordered = [...nights].sort(
      (x, y) => Number(y.differs) - Number(x.differs)
        || hash32(`${seed}|pair|${pair.join("+")}|${x.night}`) - hash32(`${seed}|pair|${pair.join("+")}|${y.night}`),
    );
    for (const n of ordered.slice(0, config.nightsPerCoupledPair)) {
      add("B", pair[0], n.night, `coupled with ${pair[1]}`);
      add("B", pair[1], n.night, `coupled with ${pair[0]}`);
    }
  }

  // C. A spread no hypothesis chose: priced nights, per lead bucket, distinct trains.
  const spreadTrains = new Set();
  const spread = [];
  const priced = storedNights(trains, today).filter((n) => {
    const id = `${n.key}|${n.night}`;
    return n.stored.status === "priced" && !byNight.has(id) && !droppedByNight.has(id) && pricingEnds(trains[n.key]);
  });
  for (const bucket of LEAD_BUCKETS) {
    const pool = priced
      .filter((n) => n.lead >= bucket.min && n.lead <= bucket.max)
      .sort((x, y) => hash32(`${seed}|C|${x.key}|${x.night}`) - hash32(`${seed}|C|${y.key}|${y.night}`));
    let picked = 0;
    for (const n of pool) {
      if (picked >= config.perLeadBucket) break;
      if (spreadTrains.has(n.key)) continue;
      spreadTrains.add(n.key);
      picked++;
      const r = add("C", n.key, n.night, `spread ${bucket.label}`);
      if (r) spread.push(r);
    }
    if (picked < config.perLeadBucket) {
      notes.push(`spread ${bucket.label}: ${picked} of ${config.perLeadBucket} nights — no more priced nights on other trains`);
    }
  }

  // D. A few of the spread asked again at the end.
  const repeatOf = [...spread]
    .sort((x, y) => hash32(`${seed}|D|${x.key}|${x.night}`) - hash32(`${seed}|D|${y.key}|${y.night}`))
    .slice(0, config.repeats);
  for (const original of repeatOf) {
    const request = {
      id: requests.length + 1, group: "D", key: original.key, night: original.night, lead: original.lead,
      bucket: original.bucket, reasons: [`repeat of #${original.id}`], repeatOf: original.id,
    };
    if (requests.length >= budget) dropped.push({ ...request, id: null });
    else requests.push(request);
  }

  return {
    today, seed, budget, requests, dropped, notes, anomalyCounts,
    stored: Object.fromEntries(requests.map((r) => [r.id, storedOf(r.key, r.night)])),
  };
}

// ── Reading an answer ────────────────────────────────────────────────────────

/**
 * A price as nightjet.com or the shop may write it: 119.9, "119.90",
 * "119,90", "€ 1.119,90". The last of "," and "." is the decimal separator;
 * a lone "," with one or two digits after it is a decimal comma, and a lone
 * "." followed by groups of exactly three digits is a thousands point. null
 * for anything else, zero and negatives included — a price of nothing is not a
 * price.
 */
export function parseOfferPrice(value) {
  let n = null;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    let s = value.replace(/[^\d.,-]/g, "");
    const comma = s.lastIndexOf(",");
    const dot = s.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      s = comma > dot ? s.replaceAll(".", "").replace(",", ".") : s.replaceAll(",", "");
    } else if (comma >= 0) {
      s = /,\d{1,2}$/.test(s) && s.indexOf(",") === comma ? s.replace(",", ".") : s.replaceAll(",", "");
    } else if (dot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replaceAll(".", "");
    }
    n = s ? Number(s) : null;
  }
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** "Sparschiene inkl. Reservierung" → "Sparschiene": the product, not the reservation. */
export function productName(name) {
  if (name == null) return null;
  const s = String(name).replace(/\s+inkl\.?\s+reservierung\s*$/i, "").trim();
  return s || null;
}

export const isSparschiene = (product) => /^sparschiene\b/i.test(String(product ?? ""));

/**
 * bestOffers, every class kept: { se, le, be } as { price, name, product } or
 * null, plus any key we do not know. Unlike the nightly reader, the seat is
 * kept — the check needs it to say whether a couchette is above it.
 */
export function readBestOffers(bestOffers) {
  const out = { se: null, le: null, be: null, other: [] };
  if (!bestOffers || typeof bestOffers !== "object") return out;
  for (const [rawKey, offer] of Object.entries(bestOffers)) {
    const key = rawKey.toLowerCase();
    if (!["se", "le", "be"].includes(key)) {
      out.other.push(rawKey);
      continue;
    }
    const price = parseOfferPrice(offer?.price);
    if (price == null) continue;
    if (out[key] && out[key].price <= price) continue;
    const name = offer?.name == null ? null : String(offer.name);
    out[key] = { price, name, product: productName(name) };
  }
  return out;
}

/**
 * What one answer says about the night asked about:
 *   priced      a journey that night with a couchette or a bed
 *   none        noBerth: a journey that night selling neither;
 *               noJourney: the first journey is a later night, or none at all
 *   unreadable  not a journey list, departures that cannot be read, or only
 *               journeys before the night asked (the search did not read the
 *               moment as assumed — the nightly pass refuses those too)
 * Departure and arrival are Vienna wall clock, "2026-10-20T19:08".
 */
export function liveNight(body, night) {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && body.bestOffers ? [body] : null;
  if (!rows) return { status: "unreadable", note: `not a journey list (${describeShape(body)})` };
  const journeys = rows.map((row) => ({
    dep: viennaDateTime(row?.departure),
    arr: viennaDateTime(row?.arrival),
    offers: readBestOffers(row?.bestOffers),
  }));
  const readable = journeys.filter((j) => j.dep);
  const base = { journeys: rows.length, unreadableJourneys: rows.length - readable.length };
  if (!readable.length && rows.length) {
    return { ...base, status: "unreadable", note: `${rows.length} journey(s), no readable departure` };
  }
  const same = readable.find((j) => j.dep.slice(0, 10) === night);
  if (same) {
    const { se, le, be, other } = same.offers;
    const classes = {};
    if (le) classes.couchette = le.price;
    if (be) classes.sleeperBed = be.price;
    const priced = Object.keys(classes).length > 0;
    return {
      ...base,
      status: priced ? "priced" : "none",
      reason: priced ? null : "noBerth",
      dep: same.dep,
      arr: same.arr && same.arr > same.dep ? same.arr : null,
      depNight: night,
      classes,
      se, le, be, other,
    };
  }
  const later = readable.filter((j) => j.dep.slice(0, 10) > night);
  if (later.length) {
    return {
      ...base, status: "none", reason: "noJourney", depNight: later[0].dep.slice(0, 10), firstDep: later[0].dep,
      note: `next journey ${later[0].dep}`,
    };
  }
  if (readable.length) {
    return {
      ...base, status: "unreadable", depNight: readable[0].dep.slice(0, 10), firstDep: readable[0].dep,
      note: `only journeys before ${night} (${readable.map((j) => j.dep).join(", ")})`,
    };
  }
  return { ...base, status: "none", reason: "noJourney", note: "nothing on sale from this night on" };
}

/**
 * What the nightly reader (journeysFromOffers) makes of the same answer for
 * the same night, so the check also says whether the reader that writes the
 * calendar agrees with this independent reading.
 */
export function nightlyReading(body, night) {
  try {
    const answer = journeysFromOffers(body);
    const n = answer.nights[night];
    return { classes: n ? { ...n.classes } : null };
  } catch (err) {
    return { error: err.message };
  }
}

function describeShape(body) {
  if (body === null) return "null";
  if (Array.isArray(body)) return `[${body.length} items]`;
  if (typeof body === "object") return `{ ${Object.keys(body).slice(0, 6).join(", ")} }`;
  return typeof body;
}

// ── Comparing ────────────────────────────────────────────────────────────────

const delta = (live, stored) => (live != null && stored != null ? Math.round((live - stored) * 100) / 100 : null);

/**
 * Stored against live for one night: the flags, the per-class deltas (live
 * minus stored), the stored check's age, and whether the night matches
 * exactly — the same status and, where priced, the same couchette and bed to
 * the cent. `exact` is null when there is nothing to compare (no live reading,
 * or no stored entry).
 */
export function compareNight({ key, night, stored, live, today, partnerTrains = DEFAULT_PARTNER_TRAINS, reader = null }) {
  const flags = [];
  const ageDays = stored?.checkedAt ? daysBetween(stored.checkedAt, today) : null;
  if (stored?.status === "priced" && stored.couchette != null && stored.seat != null && stored.couchette <= stored.seat) {
    flags.push(FLAGS.storedLeSe);
  }
  if (!live || live.status === "unreadable") {
    if (live) flags.push(FLAGS.error);
    return { flags, deltaCouchette: null, deltaSleeper: null, ageDays, exact: null };
  }
  if (live.depNight && live.depNight !== night) flags.push(FLAGS.depNotNight);
  // The stored clock is what the calendar's Book link opens the shop with; a
  // train whose departure moved since would open on a connection that is gone.
  else if (stored?.dep && live.dep && stored.dep !== live.dep) flags.push(FLAGS.depMoved);
  if (live.le && live.se && live.le.price <= live.se.price) flags.push(FLAGS.leAtOrBelowSe);
  if (live.le && live.be && live.be.price < live.le.price) flags.push(FLAGS.beBelowLe);
  const stPriced = stored?.status === "priced";
  if (stPriced && live.status === "none") flags.push(FLAGS.pricedToNone);
  if (stored?.status === "none" && live.status === "priced") flags.push(FLAGS.noneToPriced);
  const deltaCouchette = stPriced ? delta(live.classes?.couchette ?? null, stored.couchette) : null;
  const deltaSleeper = stPriced ? delta(live.classes?.sleeperBed ?? null, stored.sleeperBed) : null;
  if (deltaCouchette) flags.push(FLAGS.deltaCouchette);
  if (deltaSleeper) flags.push(FLAGS.deltaSleeper);
  const products = [live.le?.product, live.be?.product].filter(Boolean);
  if (products.some((p) => !isSparschiene(p))) flags.push(FLAGS.notSparschiene);
  const berthPrices = [live.le?.price, live.be?.price].filter((p) => p != null);
  if (berthPrices.some((p) => !endsInNine(p))) {
    flags.push(partnerTrains.includes(key) ? `${FLAGS.non9}(partner)` : FLAGS.non9);
  }
  if (reader) {
    const mine = live.status === "priced" ? live.classes : null;
    const theirs = reader.error ? undefined : reader.classes && Object.keys(reader.classes).length ? reader.classes : null;
    const agree = theirs !== undefined
      && samePrice(mine?.couchette ?? null, theirs?.couchette ?? null)
      && samePrice(mine?.sleeperBed ?? null, theirs?.sleeperBed ?? null);
    if (!agree) flags.push(FLAGS.readerDiff);
  }
  let exact = null;
  if (stored && stored.status !== "missing") {
    exact = stored.status === live.status
      && (live.status !== "priced"
        || (samePrice(stored.couchette, live.classes.couchette ?? null) && samePrice(stored.sleeperBed, live.classes.sleeperBed ?? null)));
  }
  return { flags, deltaCouchette, deltaSleeper, ageDays, exact };
}

/** What differs between two readings of the same request: [] when nothing does. */
export function repeatDifferences(first, second) {
  if (!first || !second) return ["no answer to compare"];
  const fields = [
    ["status", (l) => l.status],
    ["dep", (l) => l.dep ?? l.firstDep ?? null],
    ["arr", (l) => l.arr ?? null],
    ["seat", (l) => l.se?.price ?? null],
    ["couchette", (l) => l.le?.price ?? null],
    ["sleeper", (l) => l.be?.price ?? null],
    ["seat product", (l) => l.se?.product ?? null],
    ["couchette product", (l) => l.le?.product ?? null],
    ["sleeper product", (l) => l.be?.product ?? null],
  ];
  return fields
    .filter(([, get]) => get(first) !== get(second))
    .map(([name, get]) => `${name} ${get(first) ?? "—"} → ${get(second) ?? "—"}`);
}

/**
 * Which class the owner's shop figure is for, read off the compartment they
 * noted ("Liegewagen 6er", "couchette 4-berth", "Schlafwagen Double"); null
 * when it does not say.
 */
export function shopClassOf(compartment) {
  const text = String(compartment ?? "");
  if (/couch|liege/i.test(text)) return "couchette";
  if (/sleep|schlaf|bett|\bbed\b|berth|single|double|triple|deluxe/i.test(text)) return "sleeperBed";
  return null;
}

/**
 * One disputed night in a sentence the owner can act on: whose figure their
 * shop price agrees with — the live answer, our stored one, or neither.
 * { cls, matchesLive, matchesStored, text }.
 */
export function disputedVerdict(shop, stored, live) {
  if (!shop || shop.price == null) return { cls: null, matchesLive: null, matchesStored: null, text: "no shop figure noted" };
  const cls = shopClassOf(shop.compartment);
  const classes = cls ? [cls] : ["couchette", "sleeperBed"];
  const liveOf = (c) => (live?.status === "priced" ? live.classes?.[c] ?? null : null);
  const storedOf = (c) => (stored?.status === "priced" ? stored[c] ?? null : null);
  // null, not false, where there is no figure to compare: "nightjet.com did
  // not answer" must not read as "nightjet.com disagrees".
  const matches = (of) => (classes.some((c) => of(c) != null)
    ? classes.some((c) => of(c) != null && samePrice(of(c), shop.price))
    : null);
  const matchesLive = matches(liveOf);
  const matchesStored = matches(storedOf);
  const figures = classes
    .map((c) => `${c === "couchette" ? "couchette" : "bed"} live ${fmtPrice(liveOf(c))} / stored ${fmtPrice(storedOf(c))}`)
    .join("; ");
  let who;
  if (matchesLive && matchesStored) who = "matches both nightjet.com now and our stored figure";
  else if (matchesLive) who = `matches nightjet.com now${matchesStored === false ? "; our stored figure is stale" : ""}`;
  else if (matchesStored) {
    who = matchesLive === false
      ? "matches our stored figure but not nightjet.com now: the price has moved since, or nightjet.com and the shop differ"
      : "matches our stored figure (no live figure to compare)";
  } else if (matchesLive == null && matchesStored == null) who = "has nothing to compare with: no stored or live figure for that class";
  else who = "matches neither nightjet.com now nor our stored figure: nightjet.com and the shop disagree, or it is another product or compartment";
  return { cls, matchesLive, matchesStored, text: `shop €${fmtPrice(shop.price)} ${who} — ${figures}` };
}

/** The listed evidence headers off a response, lower-cased names, present ones only. */
export function evidenceHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const get = typeof headers.get === "function"
    ? (n) => headers.get(n)
    : (n) => {
        const k = Object.keys(headers).find((h) => h.toLowerCase() === n);
        return k ? headers[k] : null;
      };
  for (const name of EVIDENCE_HEADERS) {
    const v = get(name);
    if (v != null && v !== "") out[name] = String(v);
  }
  return out;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return Math.round((v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2) * 100) / 100;
}

const share = (n, d) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "—");

/**
 * The run in numbers. `rows` are { request, stored, live, comparison,
 * headers, repeat? }; repeats (group D) count only towards the stability and
 * cache evidence, never twice towards the match shares.
 */
export function summarize(rows) {
  const firsts = rows.filter((r) => r.request.group !== "D");
  const compared = firsts.filter((r) => r.comparison?.exact != null);
  const exact = compared.filter((r) => r.comparison.exact);
  const byBucket = {};
  for (const label of [...LEAD_BUCKETS.map((b) => b.label), "43+"]) {
    const inBucket = compared.filter((r) => r.request.bucket === label);
    if (inBucket.length || label !== "43+") {
      byBucket[label] = { compared: inBucket.length, exact: inBucket.filter((r) => r.comparison.exact).length };
    }
  }
  const spread = compared.filter((r) => r.request.group === "C");
  const dc = firsts.map((r) => r.comparison?.deltaCouchette).filter((d) => d != null);
  const ds = firsts.map((r) => r.comparison?.deltaSleeper).filter((d) => d != null);
  const abs = (list) => list.map((d) => Math.abs(d));

  const products = { seat: {}, couchette: {}, sleeperBed: {} };
  for (const r of firsts) {
    const l = r.live;
    if (!l || l.status === "unreadable") continue;
    for (const [cls, key] of [["seat", "se"], ["couchette", "le"], ["sleeperBed", "be"]]) {
      if (!l[key]) continue;
      const name = l[key].product ?? "(no name)";
      products[cls][name] = (products[cls][name] ?? 0) + 1;
    }
  }

  const answered = firsts.filter((r) => r.live && r.live.status !== "unreadable");
  const leSe = answered.filter((r) => r.live.le && r.live.se);
  const beLe = answered.filter((r) => r.live.le && r.live.be);
  const storedSeat = firsts.filter((r) => r.stored?.status === "priced" && r.stored.couchette != null && r.stored.seat != null);
  const invariants = {
    liveCouchetteAboveSeat: { checked: leSe.length, violations: leSe.filter((r) => r.live.le.price <= r.live.se.price).length },
    liveBedNotBelowCouchette: { checked: beLe.length, violations: beLe.filter((r) => r.live.be.price < r.live.le.price).length },
    storedCouchetteAboveSeat: { checked: storedSeat.length, violations: storedSeat.filter((r) => r.stored.couchette <= r.stored.seat).length },
  };

  const flagCounts = {};
  for (const r of rows) for (const f of r.comparison?.flags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;

  const repeats = rows.filter((r) => r.request.group === "D" && r.live);
  const repeatSummary = {
    asked: rows.filter((r) => r.request.group === "D").length,
    answered: repeats.length,
    same: repeats.filter((r) => r.repeat && !r.repeat.differences.length).length,
    differ: repeats.filter((r) => r.repeat?.differences.length).length,
    details: repeats.map((r) => ({
      id: r.request.id, repeatOf: r.request.repeatOf, key: r.request.key, night: r.request.night,
      differences: r.repeat?.differences ?? [], gapSeconds: r.repeat?.gapSeconds ?? null,
      etagSame: r.repeat?.etagSame ?? null,
    })),
  };

  const cache = {};
  const responded = rows.filter((r) => r.headers);
  for (const name of EVIDENCE_HEADERS) {
    const values = responded.map((r) => r.headers[name]).filter((v) => v != null);
    if (!values.length) continue;
    const entry = { present: values.length, of: responded.length };
    if (!PER_RESPONSE_HEADERS.has(name)) {
      entry.values = {};
      for (const v of values) entry.values[v] = (entry.values[v] ?? 0) + 1;
    }
    cache[name] = entry;
  }

  return {
    asked: firsts.length,
    answered: answered.length,
    compared: compared.length,
    exact: exact.length,
    exactShare: share(exact.length, compared.length),
    spreadShare: share(spread.filter((r) => r.comparison.exact).length, spread.length),
    byBucket,
    medianAbsDelta: { couchette: median(abs(dc)), sleeperBed: median(abs(ds)), all: median(abs([...dc, ...ds])) },
    nonZeroDeltas: { couchette: dc.filter(Boolean).length, sleeperBed: ds.filter(Boolean).length },
    products,
    invariants,
    flagCounts,
    repeats: repeatSummary,
    cache,
  };
}

// ── robots.txt ───────────────────────────────────────────────────────────────

/** robots.txt as groups of { agents, rules: [{ allow, path }] } (RFC 9309, simply). */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    // Rules before any User-agent line belong to no group and are ignored.
    if ((field === "allow" || field === "disallow") && current && value) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  return groups;
}

function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether robots.txt lets `agent` fetch `path`: the group naming the agent if
 * there is one, else `*`; the longest matching rule wins and Allow wins a tie
 * (RFC 9309). { allowed, rule, group }.
 */
export function robotsVerdict(text, path, agent = "*") {
  const groups = parseRobots(text);
  const token = agent.toLowerCase();
  const own = token === "*" ? [] : groups.filter((g) => g.agents.includes(token));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const rule of chosen.flatMap((g) => g.rules)) {
    if (!ruleMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return { allowed: !best || best.allow, rule: best, group: own.length ? token : chosen.length ? "*" : null };
}

/**
 * The paths among `paths` that robots.txt keeps from `*` or from our own
 * agent. Both groups are read, so a rule written for everyone is honoured
 * even where we also have a group of our own: the conservative reading.
 */
export function robotsDisallowed(text, paths, agent = ROBOTS_AGENT) {
  const out = [];
  for (const path of paths) {
    for (const who of ["*", agent]) {
      const v = robotsVerdict(text, path, who);
      if (!v.allowed) {
        out.push({ path, agent: v.group, rule: `Disallow: ${v.rule.path}` });
        break;
      }
    }
  }
  return out;
}

// ── The ÖBB shop ─────────────────────────────────────────────────────────────

/** One adult, no cards: the traveller nightjet.com's price search prices. */
export const SHOP_PASSENGER = {
  type: "ADULT",
  id: 1,
  me: false,
  remembered: false,
  isSelected: true,
  cards: [],
  relations: [],
  challengedFlags: { hasHandicappedPass: false, hasAssistanceDog: false, hasWheelchair: false, hasAttendant: false },
};

const SHOP_DEBUG_FILTER = {
  noAggregationFilter: false, noEqclassFilter: false, noNrtpathFilter: false, noPaymentFilter: false,
  useTripartFilter: false, noVbxFilter: false, noCategoriesFilter: false,
};

/**
 * The shop's local date-time, "2026-10-20T21:30:00.000", from a Vienna wall
 * clock "2026-10-20T21:39" moved back `minutesBefore` — so the train itself is
 * among the connections from that moment on. null when unreadable.
 */
export function shopDateTime(localDateTime, minutesBefore = 0) {
  if (!LOCAL_DATE_TIME.test(String(localDateTime ?? ""))) return null;
  const ms = Date.parse(`${localDateTime}:00Z`) - minutesBefore * 60_000;
  return `${new Date(ms).toISOString().slice(0, 16)}:00.000`;
}

/** "NJ 466" → { name: "NJ", number: "466" }; null for anything else. */
export function trainCategory(key) {
  const m = String(key ?? "").trim().match(/^([A-Za-z]+)\s*(\d+)$/);
  return m ? { name: m[1].toUpperCase(), number: m[2] } : null;
}

/** POST /api/hafas/v4/timetable — direct trains only, one adult. */
export function timetableBody({ datetime, fromId, toId, from, to }) {
  return {
    datetimeDeparture: datetime,
    filter: {
      regionaltrains: false, direct: true, changeTime: false, wheelchair: false,
      bikes: false, trains: false, motorail: false, connections: [],
    },
    passengers: [SHOP_PASSENGER],
    count: 5,
    sortType: "DEPARTURE",
    from: { number: Number(fromId), name: from },
    to: { number: Number(toId), name: to },
  };
}

/** POST /api/offer/v6/offers for one connection. */
export function offersBody({ connectionId, datetime }) {
  return {
    selection: { connectionId, offerSections: [] },
    ignoreSelectionOnOfferChange: false,
    passengers: [SHOP_PASSENGER],
    debugFilter: SHOP_DEBUG_FILTER,
    datetime,
  };
}

/**
 * The connection in a timetable answer that is our train that night: no
 * change of train, one journey section of the train's category and number,
 * our two station ids, and the departure minute nightjet.com gave. Anything
 * less is not proof it is the same train, so it is reported, not used.
 * { connection, candidates, problem }.
 */
export function findShopConnection(body, { key, fromId, toId, dep }) {
  const cat = trainCategory(key);
  const list = Array.isArray(body?.connections) ? body.connections : null;
  if (!list) return { connection: null, candidates: [], problem: `no connections list (${describeShape(body)})` };
  const candidates = list.map((c) => {
    const journeys = (c?.sections ?? []).filter((s) => s?.type === "journey");
    const cats = journeys.map((s) => `${s?.category?.name ?? s?.category?.shortName ?? "?"} ${s?.category?.number ?? "?"}`);
    return {
      id: c?.id ?? null,
      trains: cats.join(" + "),
      from: c?.from?.esn ?? null,
      to: c?.to?.esn ?? null,
      departure: String(c?.from?.departure ?? ""),
      switches: c?.switches ?? Math.max(0, journeys.length - 1),
      journeys,
    };
  });
  const match = candidates.find((c) => {
    if (!c.id || c.switches !== 0 || c.journeys.length !== 1) return false;
    const category = c.journeys[0].category ?? {};
    const name = String(category.name ?? category.shortName ?? category.displayName ?? "").toUpperCase();
    return cat
      && name === cat.name
      && String(category.number ?? "") === cat.number
      && String(c.from) === String(fromId)
      && String(c.to) === String(toId)
      && (!dep || c.departure.startsWith(dep));
  });
  const shown = candidates.map(({ journeys, ...rest }) => rest);
  return match
    ? { connection: { id: match.id, departure: match.departure }, candidates: shown, problem: null }
    : { connection: null, candidates: shown, problem: `no direct ${key} ${fromId} → ${toId} departing ${dep ?? "?"}` };
}

/**
 * Per-category minima from a /api/offer/v6/offers answer. The shape is known
 * from one third-party client only (OenFare, Feb 2026):
 *   offerSections[].travelClasses[].offers[].reservation.compartments[]
 *     { id, price, variations: [{ genderDesignation: "FEMALE" }] }
 * joined on id to offerSections[].media.compartments[]
 *     { id, accommodationType: SEAT | COUCHETTE | BERTH, compartmentGroup, name: { en, de } }.
 * Seats are counted and discarded; couchettes and berths get an overall
 * minimum, one per compartment name, and a ladies-only minimum apart (a
 * nightjet.com "cheapest couchette" may be one). Whether a compartment's
 * price includes the base ticket is not known, so the figures are reported,
 * not trusted. Never throws: what does not fit is listed in `surprises`.
 */
export function extractShopOffers(body) {
  const surprises = [];
  const result = {
    ok: false,
    couchette: { min: null, byName: {}, ladies: null },
    berth: { min: null, byName: {}, ladies: null },
    seats: 0,
    compartments: 0,
    tiers: [],
    surprises,
  };
  const sections = Array.isArray(body?.offerSections) ? body.offerSections : null;
  if (!sections) {
    surprises.push(`no offerSections (${describeShape(body)})`);
    return result;
  }
  const media = new Map();
  for (const section of sections) {
    for (const m of section?.media?.compartments ?? []) if (m?.id != null) media.set(String(m.id), m);
  }
  if (!media.size) surprises.push("no media.compartments to name the compartments by");
  const tiers = new Set();
  const lower = (slot, price) => (slot == null || price < slot ? price : slot);
  for (const section of sections) {
    for (const travelClass of section?.travelClasses ?? []) {
      for (const offer of travelClass?.offers ?? []) {
        const tier = offer?.flexibility ?? offer?.name?.en ?? offer?.title?.en ?? offer?.name ?? offer?.id ?? null;
        if (tier != null && typeof tier !== "object") tiers.add(String(tier));
        for (const comp of offer?.reservation?.compartments ?? []) {
          result.compartments++;
          const m = media.get(String(comp?.id));
          const price = parseOfferPrice(comp?.price);
          if (!m) {
            surprises.push(`compartment ${comp?.id} not in media`);
            continue;
          }
          const type = String(m.accommodationType ?? "").toUpperCase();
          if (type === "SEAT") {
            result.seats++;
            continue;
          }
          const slot = type === "COUCHETTE" ? result.couchette : type === "BERTH" ? result.berth : null;
          if (!slot) {
            surprises.push(`compartment ${comp?.id}: accommodationType ${JSON.stringify(m.accommodationType)}`);
            continue;
          }
          if (price == null) {
            surprises.push(`compartment ${comp?.id}: price ${JSON.stringify(comp?.price)}`);
            continue;
          }
          const name = m.name?.en ?? m.name?.de ?? m.compartmentGroup ?? `#${comp.id}`;
          slot.min = lower(slot.min, price);
          slot.byName[name] = lower(slot.byName[name], price);
          const ladies = (comp?.variations ?? []).some((v) => String(v?.genderDesignation ?? "").toUpperCase() === "FEMALE");
          if (ladies) slot.ladies = lower(slot.ladies, price);
        }
      }
    }
  }
  result.tiers = [...tiers];
  result.ok = result.couchette.min != null || result.berth.min != null;
  if (!result.ok && !surprises.length) surprises.push(`${result.compartments} compartment(s), no couchette or berth priced`);
  return result;
}

// ── The dated shop link ──────────────────────────────────────────────────────

function formatDate(isoDate, dateFormat) {
  const [y, m, d] = isoDate.split("-");
  if (dateFormat === "yyyy-MM-dd") return `${y}-${m}-${d}`;
  if (dateFormat === "dd-MM-yyyy") return `${d}-${m}-${y}`;
  return `${d}.${m}.${y}`;
}

/**
 * ÖBB's shop link for one train on one night, filled exactly the way the fare
 * calendar fills operator-booking.json's journeyUrlTemplate
 * (buildDatedBookingLink + datedBookingHref): ids as they are, names
 * URL-encoded, the two clocks literal. null when an id, a name or a
 * well-formed clock is missing — a link to another train is worse than none.
 */
export function shopLink(template, ends, { dep, arr } = {}, { dateFormat = "yyyy-MM-dd" } = {}) {
  if (!template || !ends) return null;
  const { fromId, toId, from, to } = ends;
  if (!/^\d{7}$/.test(String(fromId ?? "")) || !/^\d{7}$/.test(String(toId ?? "")) || !from || !to) return null;
  if (!LOCAL_DATE_TIME.test(String(dep ?? "")) || !LOCAL_DATE_TIME.test(String(arr ?? "")) || arr <= dep) return null;
  return template
    .replaceAll("{originId}", fromId)
    .replaceAll("{destId}", toId)
    .replaceAll("{originName}", encodeURIComponent(from))
    .replaceAll("{destName}", encodeURIComponent(to))
    .replaceAll("{date}", formatDate(dep.slice(0, 10), dateFormat))
    .replaceAll("{departure}", dep)
    .replaceAll("{arrival}", arr);
}

// ── Report ───────────────────────────────────────────────────────────────────

const PRODUCT_SHORT = {
  sparschiene: "Spar",
  "sparschiene komfort": "SparKomf",
  komfortticket: "Komfort",
  "standard-ticket": "Standard",
};

export function shortProduct(product) {
  if (!product) return "";
  return PRODUCT_SHORT[product.toLowerCase()] ?? product.slice(0, 10);
}

export function fmtPrice(v) {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

const fmtDelta = (d) => (d == null ? "" : d === 0 ? "0" : `${d > 0 ? "+" : ""}${fmtPrice(d)}`);
const offerCell = (o) => (o ? `${fmtPrice(o.price)} ${shortProduct(o.product)}`.trim() : "—");

function storedCell(stored) {
  if (!stored || stored.status === "missing") return "missing";
  if (stored.status === "none") return `none${stored.reason ? `:${stored.reason}` : ""}`;
  return `${fmtPrice(stored.couchette)}/${fmtPrice(stored.sleeperBed)}`;
}

function liveDepCell(live) {
  const dep = live?.dep ?? live?.firstDep ?? null;
  return dep ? `${dep.slice(5, 10)} ${dep.slice(11, 16)}` : "";
}

function statusCell(row) {
  if (row.skipped) return `not asked (${row.skipped})`;
  if (row.error) return row.error;
  if (row.live?.status === "unreadable") return `unreadable: ${row.live.note}`;
  if (row.live?.status === "none") return `none:${row.live.reason}`;
  return "";
}

export const TABLE_COLUMNS = [
  ["#", 3], ["g", 1], ["train", 9], ["night", 10], ["lead", 4], ["stored chk", 10], ["stored c/s", 13],
  ["live se", 14], ["live le", 16], ["live be", 16], ["Δc", 7], ["Δs", 7], ["live dep", 11], ["flags", 0],
];

/** The fixed-width table, one line per request, header and rule first. */
export function formatTable(rows) {
  const pad = (s, w) => (w ? String(s).slice(0, w).padEnd(w) : String(s));
  const line = (cells) => cells.map((c, i) => pad(c, TABLE_COLUMNS[i][1])).join(" ").trimEnd();
  const out = [line(TABLE_COLUMNS.map(([h]) => h)), "-".repeat(160)];
  for (const r of rows) {
    const { request: q, stored, live, comparison: c } = r;
    const chk = stored?.checkedAt ? `${stored.checkedAt.slice(5)} ${c?.ageDays ?? "?"}d` : "";
    const status = statusCell(r);
    const flags = [...(c?.flags ?? []), ...(status ? [status] : [])].join(" ");
    out.push(line([
      q.id, q.group, q.key, q.night, `+${q.lead}`, chk, storedCell(stored),
      offerCell(live?.se), offerCell(live?.le), offerCell(live?.be),
      fmtDelta(c?.deltaCouchette), fmtDelta(c?.deltaSleeper), liveDepCell(live), flags,
    ]));
  }
  return out;
}

export const CSV_COLUMNS = [
  "id", "group", "reasons", "train", "night", "lead_days", "from", "to",
  "stored_status", "stored_couchette", "stored_sleeper", "stored_seat", "stored_checked_at",
  "live_status", "live_couchette", "live_couchette_product", "live_sleeper", "live_sleeper_product",
  "live_seat", "live_dep", "live_arr", "flags", "price_search_url", "shop_link",
  "shop_price", "shop_product", "shop_compartment", "checked_at",
];

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** CSV text from objects keyed by `columns`. */
export function toCsv(records, columns = CSV_COLUMNS) {
  return [columns.join(","), ...records.map((rec) => columns.map((c) => csvCell(rec[c])).join(","))].join("\n") + "\n";
}

/**
 * The owner's checklist: one row per sampled night (repeats folded into the
 * night they repeat), with the dated shop link built from the live answer's
 * own clocks and four empty columns to fill in beside the shop.
 */
export function checklistRecords(rows, { template, dateFormat } = {}) {
  return rows
    .filter((r) => r.request.group !== "D")
    .map((r) => {
      const { request: q, stored, live, ends } = r;
      const priced = stored?.status === "priced";
      const repeatFlags = rows
        .filter((x) => x.request.repeatOf === q.id)
        .flatMap((x) => x.comparison?.flags ?? [])
        .filter((f) => f === FLAGS.repeatDiff);
      const link = live?.status === "priced" || live?.reason === "noBerth"
        ? shopLink(template, ends, { dep: live.dep, arr: live.arr }, { dateFormat })
        : null;
      return {
        id: q.id,
        group: q.group,
        reasons: q.reasons.join("; "),
        train: q.key,
        night: q.night,
        lead_days: q.lead,
        from: ends?.from ?? "",
        to: ends?.to ?? "",
        stored_status: stored?.status === "none" && stored.reason ? `none:${stored.reason}` : stored?.status ?? "missing",
        stored_couchette: priced ? stored.couchette ?? "" : "",
        stored_sleeper: priced ? stored.sleeperBed ?? "" : "",
        stored_seat: stored?.seat ?? "",
        stored_checked_at: stored?.checkedAt ?? "",
        live_status: r.skipped ? `not asked (${r.skipped})` : r.error ? `error: ${r.error}`
          : live ? (live.status === "none" ? `none:${live.reason}` : live.status) : "",
        live_couchette: live?.le?.price ?? "",
        live_couchette_product: live?.le?.product ?? "",
        live_sleeper: live?.be?.price ?? "",
        live_sleeper_product: live?.be?.product ?? "",
        live_seat: live?.se?.price ?? "",
        live_dep: live?.dep ?? "",
        live_arr: live?.arr ?? "",
        flags: [...(r.comparison?.flags ?? []), ...repeatFlags].join(" "),
        price_search_url: r.url ?? "",
        shop_link: link ?? "",
        shop_price: "",
        shop_product: "",
        shop_compartment: "",
        checked_at: "",
      };
    });
}
