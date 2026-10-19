// scripts/lib/es-fares.mjs
// European Sleeper fares from the operator's own booking API — the JSON
// backend behind booking.europeansleeper.eu (no key, no login, no cart).
// Used by the europeansleeper adapter to keep a night-by-night fare calendar
// per train, the same shape the Intercity Notte calendar uses
// (scripts/lib/fare-calendar.mjs).
//
// Two calls price a night:
//   POST /search/trains        { from, to, departureDate } → the trains on
//                              three consecutive days, each with its routeId
//                              and whether it is bookable. One call answers
//                              "does our train run" for three nights at once.
//   POST /search/availability  { trainRouteId, trainNumber, travelDate, … } →
//                              every place type on sale that night with its
//                              fare levels (Easy / Good / Flex Night) and
//                              free places.
// So a train costs ~1⅓ requests a night, and every train's six weeks fit in
// one nightly run — the calendar is refreshed whole every night rather than a
// slice at a time as lefrecce's has to be.
//
// The dev sandbox cannot reach the API host, so this was written from the
// operator's published OpenAPI description; `npm run probe-es-fares` (label a
// PR `run-probes`) prints what the live API answers.

export const ES_API_BASE = "https://europeansleeperprod-api.azurewebsites.net/api";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

/** Passenger type 72 = Adult. 44 (Interrail) and 73 (Child) are never asked for. */
export const ADULT = 72;

/**
 * What a place type sells, as one of our fare class keys, or null to leave it
 * out. The calendar prices what a standard adult can buy, so:
 *   - seats are recognised only to be left out (the map shows beds);
 *   - women-only compartments are left out — not everyone can book them,
 *     the same rule that keeps Young/Senior offers out of the ICN calendar;
 *   - a private couchette compartment is priced for the whole compartment
 *     (one booking, up to 5–6 people), and keeps its own class so it is
 *     never read as a per-person bed price.
 */
export function classifyPlaceType(key) {
  const k = String(key ?? "").toLowerCase().trim();
  if (!k || /women/.test(k)) return null;
  if (/^seat/.test(k)) return null;
  if (/^couchette-\d+-private$/.test(k)) return "privateCouchette";
  if (/^couchette-\d+$/.test(k)) return "couchette";
  const cabin = k.match(/^(berth|comfort)-(single|double|triple)$/);
  if (cabin) {
    const size = { single: "Single", double: "Double", triple: "Triple" }[cabin[2]];
    return `${cabin[1] === "comfort" ? "comfort" : "sleeper"}${size}`;
  }
  return null;
}

const FARE_TYPES = ["easy-night", "good-night", "flex-night"];

function eur(prices) {
  const n = Number(prices?.eur ?? prices?.EUR);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * The cheapest fare a price class sells tonight, as { amount, fareType }, or
 * null when nothing in it can be booked. Reads the per-fare-level list when
 * the class carries one (a sold-out Easy Night must not price the class), and
 * the class's own "cheapest price" only when it carries none.
 */
export function cheapestFare(priceClass) {
  if (!priceClass || priceClass.bookable === false) return null;
  if (Number.isFinite(priceClass.freeSeatsCount) && priceClass.freeSeatsCount <= 0) return null;
  const levels = Array.isArray(priceClass.fareTypes) ? priceClass.fareTypes.filter(Boolean) : [];
  if (levels.length) {
    let best = null;
    for (const level of levels) {
      if (level.bookable === false) continue;
      if (Number.isFinite(level.availableSeats) && level.availableSeats <= 0) continue;
      const amount = eur(level.prices);
      if (amount == null) continue;
      if (!best || amount < best.amount) {
        best = { amount, fareType: FARE_TYPES.includes(level.id) ? level.id : null };
      }
    }
    return best;
  }
  const amount = eur(priceClass.prices);
  return amount == null ? null : { amount, fareType: null };
}

/**
 * An availability answer read into a night's calendar entry fields:
 * { classes: { couchette: 49.99, sleeperTriple: 119.99, … }, fareTypes:
 * { couchette: "easy-night", … } } — cheapest bookable fare per class, berths
 * only. Several place types can land on one class (couchette-4/-5/-6), and
 * the class keeps the cheapest of them.
 */
export function classesFromAvailability(body) {
  const availability = body?.availabilityResult?.availability ?? body?.availability ?? body;
  const priceClasses = Array.isArray(availability?.priceClasses) ? availability.priceClasses : [];
  const classes = {};
  const fareTypes = {};
  const seen = [];
  for (const pc of priceClasses) {
    seen.push(String(pc?.placeTypeKey ?? "?"));
    const cls = classifyPlaceType(pc?.placeTypeKey);
    if (!cls) continue;
    const fare = cheapestFare(pc);
    if (!fare) continue;
    if (classes[cls] == null || fare.amount < classes[cls]) {
      classes[cls] = fare.amount;
      if (fare.fareType) fareTypes[cls] = fare.fareType;
      else delete fareTypes[cls];
    }
  }
  return { classes, fareTypes, seen };
}

/** "2026-10-12T19:22:00" / "2026-10-12" → "2026-10-12"; anything else → null. */
export function isoDateOf(value) {
  const m = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const bare = (n) => String(n ?? "").replace(/\D/g, "").replace(/^0+/, "");

/**
 * The /search/trains answer as { date → result | null } for ONE train: each
 * night the answer covers, with our train's result on it, or null when that
 * night's slot holds no train or another one. Nights the answer does not
 * mention are absent — they say nothing either way.
 */
export function nightsFromTrainSearch(body, trainNumber) {
  const want = bare(trainNumber);
  const out = {};
  for (const group of Array.isArray(body?.routeSearchResults) ? body.routeSearchResults : []) {
    for (const r of Array.isArray(group?.searchResultOutward) ? group.searchResultOutward : []) {
      const date = isoDateOf(r?.trip?.travelDate) ?? isoDateOf(r?.departureDateTime);
      if (!date) continue;
      const ours = r?.trip && bare(r.trip.trainNumber) === want;
      if (ours) out[date] = { routeId: r.routeId ?? null, trip: r.trip };
      else if (!(date in out)) out[date] = null;
    }
  }
  return out;
}

// ─── station ids ──────────────────────────────────────────────────────────

/** Lowercase, diacritics off, punctuation to spaces — "Bruxelles-Midi" ≈ "Bruxelles Midi". */
export function foldName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every station in a /constants answer as [{ id, name }]. */
export function constantsStations(constants) {
  const out = [];
  for (const country of Array.isArray(constants?.stations) ? constants.stations : []) {
    for (const s of Array.isArray(country?.stations) ? country.stations : []) {
      const id = String(s?.id ?? s?.uicCode ?? "").trim();
      if (id && s?.name) out.push({ id, name: String(s.name) });
    }
  }
  return out;
}

/**
 * The operator's EVA number for one of our station names, or null.
 *
 * The curated map in operator-booking.json comes first: it is what the
 * booking deep links already use, so a fare and its Book button address the
 * same station. A curated id the operator's station list does not know is
 * not trusted. After that the operator's own list, by folded name: exact,
 * then the one station whose words all appear in ours or ours in its, with
 * the city (first word) required to agree — "Paris Nord" for "Paris Gare du
 * Nord", never "Berlin Ostbahnhof" for "Berlin Gesundbrunnen". Ambiguous
 * means null: a fare for the wrong station is worse than none.
 */
export function resolveStationId(name, { curated = {}, stations = [] } = {}) {
  const known = new Set(stations.map((s) => s.id));
  const curatedId = curated[name] ?? curated[String(name ?? "").trim()];
  if (curatedId && (!known.size || known.has(String(curatedId)))) return String(curatedId);

  // Bilingual names ("Brussel-Zuid / Bruxelles-Midi") are read as either half,
  // on both sides.
  const halvesOf = (n) => String(n ?? "").split(/\s*\/\s*/).map(foldName).filter(Boolean);
  const wanted = halvesOf(name);
  const candidates = stations.map((s) => ({ id: s.id, names: [foldName(s.name), ...halvesOf(s.name)] }));
  const unique = (hits) => {
    const ids = [...new Set(hits.map((c) => c.id))];
    return ids.length === 1 ? ids[0] : null;
  };
  for (const want of wanted) {
    const id = unique(candidates.filter((c) => c.names.includes(want)));
    if (id) return id;
  }
  for (const want of wanted) {
    const wantTokens = want.split(" ");
    const id = unique(
      candidates.filter((c) =>
        c.names.some((n) => {
          const tokens = n.split(" ");
          if (tokens[0] !== wantTokens[0]) return false;
          return tokens.every((t) => wantTokens.includes(t)) || wantTokens.every((t) => tokens.includes(t));
        }),
      ),
    );
    if (id) return id;
  }
  return null;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

async function call(path, { method = "GET", body, fetchImpl = fetch, base = ES_API_BASE, timeoutMs = 20_000 } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${path}`);
      err.status = res.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      // An HTML answer is a block or maintenance page, not data.
      const err = new Error(`non-JSON answer from ${path} (${text.slice(0, 60).replace(/\s+/g, " ")}…)`);
      err.status = res.status;
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function fetchConstants(opts = {}) {
  return call("/constants", opts);
}

export function trainSearchBody({ fromId, toId, date }) {
  return {
    fromLocationId: String(fromId),
    toLocationId: String(toId),
    departureDate: date,
    returnDate: null,
    passengerTypes: [ADULT],
    bicycleCount: 0,
    petsCount: 0,
  };
}

export function availabilityBody({ routeId, fromId, toId, trainNumber, date }) {
  return {
    trainRouteId: routeId,
    fromLocationId: String(fromId),
    toLocationId: String(toId),
    passengerTypes: [ADULT],
    trainNumber: bare(trainNumber),
    travelDate: `${date}T00:00:00`,
    bicycleCount: 0,
  };
}

export function searchTrains(args, opts = {}) {
  return call("/search/trains", { ...opts, method: "POST", body: trainSearchBody(args) });
}

export function searchAvailability(args, opts = {}) {
  return call("/search/availability?lang=en-GB", { ...opts, method: "POST", body: availabilityBody(args) });
}
