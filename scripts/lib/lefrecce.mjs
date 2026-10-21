// scripts/lib/lefrecce.mjs
// Trenitalia fares from lefrecce.it — the JSON backend (BFF) behind the
// operator's own booking site. Read-only: one ticket search per train, no
// cart, no login. Used by scripts/lib/icn-fares.mjs to price Intercity Notte.
//
// Two facts make this cheap to wire in:
//   - Viaggiatreno already gives every station its id ("S01700" = Milano
//     Centrale), and lefrecce addresses the same station as 830 + the six
//     digits (830001700). No station search, no name matching.
//   - A search answers with every solution leaving after a time, each with
//     its trains and the fares per service (seat, couchette, sleeper), so one
//     request per train is enough.
//
// Fares are yield-managed, so a figure is a sample for one date: the adapter
// searches a few weeks out and the UI says when it was checked.

export const LEFRECCE_BASE = "https://www.lefrecce.it/Channels.Website.BFF.WEB/website";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

/** "S01700" → 830001700 (lefrecce's location id); null when not a Viaggiatreno code. */
export function lefrecceLocationId(viaggiatrenoCode) {
  const m = String(viaggiatrenoCode ?? "").trim().match(/^S(\d{1,6})$/i);
  if (!m) return null;
  return Number(`830${m[1].padStart(6, "0")}`);
}

/** 39.9 / "39,90" / "€ 39.90" → 39.9; anything else → null. */
export function parseAmount(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  const m = String(raw ?? "").replace(/\s/g, "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The fare class a service name sells. Italian and English both occur on the
 * site, and the names carry the berth count ("Cuccetta Comfort 4 posti",
 * "Vagone Letto Singolo"), so this reads the kind, not the exact label.
 */
export function classifyService(name) {
  const s = String(name ?? "").toLowerCase();
  if (/letto|sleep|wagon|excelsior|singol|doppi|tripl/.test(s)) return "sleeperCabin";
  if (/cuccett|couchette/.test(s)) return "couchette";
  if (/posto|seat|sedere|classe|class|standard|base/.test(s)) return "seat";
  return null;
}

// The berth classes, cheapest-kind first. Seats are recognised only to be
// left out: the map shows sleeping places and nothing else.
const BERTH_CLASSES = ["couchette", "sleeperCabin"];

/** Does this solution run this train? Matches the train number on any of its trains. */
function solutionHasTrain(solution, trainNumber) {
  const want = String(trainNumber).replace(/\D/g, "");
  return (solution?.trains ?? []).some((t) =>
    [t?.name, t?.description, t?.number, t?.trainNumber]
      .filter((v) => v != null)
      .some((v) => String(v).replace(/\D/g, "") === want),
  );
}

/**
 * The price we quote is what a standard adult pays: a fare anyone can buy with
 * no age, loyalty card, group or return trip behind it. Trenitalia lists those
 * offers in the same grid as Base / Economy / Super Economy, and a Young or
 * Senior berth is often the cheapest one there — so, read by price alone, the
 * calendar quoted a fare most travellers cannot buy. Passenger types are a
 * later feature; until then they are left out rather than guessed at.
 * Matched on the offer's name, Italian or English. An unnamed offer is kept:
 * nothing says it is restricted.
 */
const RESTRICTED_OFFER =
  /young|giovan|junior|ragazz|bimb|bambin|child|kid|minor|senior|anzian|over\s*\d|under\s*\d|argento|carta\s*verde|cartafreccia|x-?go|militar|forze|disab|famig|family|group|grupp|insieme|2\s*x\s*1|a\s*\/\s*r|andata\s*e\s*ritorno|round\s*trip|return|weekend|studen|corporate|aziend|pmr/i;

export function offerName(offer) {
  return String(offer?.name ?? offer?.offerName ?? offer?.description ?? "").trim();
}

export function isStandardAdultOffer(offer) {
  return !RESTRICTED_OFFER.test(offerName(offer));
}

function offerIsSaleable(offer) {
  const status = String(offer?.status ?? offer?.saleability ?? "").toUpperCase();
  return !status || status === "SALEABLE" || status === "AVAILABLE";
}

/** "HH:MM" of a lefrecce timestamp as written ("2026-10-18T19:50:00.000+02:00" → "19:50"). */
function wallClock(ts) {
  const m = String(ts ?? "").match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function clockMinutes(clock) {
  const m = String(clock ?? "").match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// A night train is sold as "ICN"/"Intercity Notte"; a portion can be sold as
// plain Intercity. A regional or a Frecciarossa leaving the same minute is not ours.
const NIGHT_CATEGORY = /\bICN\b|notte|night|\bIC\b|intercity/i;

function isNightCategory(train) {
  return [train?.acronym, train?.denomination, train?.trainCategory, train?.description]
    .filter((v) => v != null)
    .some((v) => NIGHT_CATEGORY.test(String(v)));
}

/**
 * Which solution is our train. By number first. Failing that, by the minute
 * it leaves and its category: Trenitalia sells the Palermo–Messina portions of
 * the Sicilian sleepers under the main train's number, so the portion's own
 * number is not on the ticket, but the departure it describes is.
 */
function findTrainSolution(entries, trainNumber, departureClock, otherTrains = []) {
  const byNumber = entries.find((e) => solutionHasTrain(e?.solution ?? e, trainNumber));
  if (byNumber) return { entry: byNumber, matchedBy: "number" };
  const want = clockMinutes(departureClock);
  if (want == null) return null;
  const byTime = entries.filter((e) => {
    const sol = e?.solution ?? e;
    const got = clockMinutes(wallClock(sol?.departureTime));
    if (got == null || Math.abs(got - want) > 2 || !(sol?.trains ?? []).some(isNightCategory)) return false;
    // A train we track under its own number is that train, never a portion
    // of ours: ICN 771 is 770's seasonal twin and leaves the same minute, so
    // on a night 771 does not run the search answers with 770 — which is
    // 770's fare, not 771's.
    return !otherTrains.some((n) => solutionHasTrain(sol, n));
  });
  // Two night trains leaving the same minute cannot be told apart: price neither.
  return byTime.length === 1 ? { entry: byTime[0], matchedBy: "departure" } : null;
}

/**
 * Every offer name in an answer, split by whether the standard-adult rule kept
 * it — so the log says what "Young"/"Senior"-like names the grid really uses,
 * and a new restricted offer shows up as kept before it can go unnoticed.
 */
export function describeOffers(json) {
  const kept = new Set();
  const dropped = new Set();
  for (const e of Array.isArray(json?.solutions) ? json.solutions : []) {
    const sol = e?.solution ?? e;
    const grids = Array.isArray(e?.grids) ? e.grids : Array.isArray(sol?.grids) ? sol.grids : [];
    for (const grid of grids) {
      for (const service of grid?.services ?? []) {
        for (const o of Array.isArray(service?.offers) ? service.offers : []) {
          const name = offerName(o);
          if (name) (isStandardAdultOffer(o) ? kept : dropped).add(name);
        }
      }
    }
  }
  return { kept: [...kept], dropped: [...dropped] };
}

/** "ICN 1956 19:50" per solution — what the search did return, for the log. */
export function describeSolutions(json) {
  return (Array.isArray(json?.solutions) ? json.solutions : []).map((e) => {
    const sol = e?.solution ?? e;
    const trains = (sol?.trains ?? [])
      .map((t) => [t?.acronym, t?.name ?? t?.description].filter(Boolean).join(" "))
      .join("+");
    return `${trains || "?"} ${wallClock(sol?.departureTime) ?? "?"}`;
  });
}

/**
 * Parse a /ticket/solutions response into the fare for one train, or null.
 * Returns { fromPrice, currency: "EUR", seatClass, classes: {couchette?, sleeperCabin?}, matchedBy }.
 *
 * Reads the per-service grid (cheapest saleable offer per berth class). No
 * berth priced → null, never a seat or the headline price.
 */
export function parseSolutionsFare(json, trainNumber, { departureClock = null, otherTrains = [] } = {}) {
  const entries = Array.isArray(json?.solutions) ? json.solutions : [];
  const found = findTrainSolution(entries, trainNumber, departureClock, otherTrains);
  if (!found) return null;
  const match = found.entry;
  const solution = match.solution ?? match;
  const matchedBy = found.matchedBy;

  const classes = {};
  const grids = Array.isArray(match.grids) ? match.grids : Array.isArray(solution.grids) ? solution.grids : [];
  for (const grid of grids) {
    for (const service of grid?.services ?? []) {
      const cls = classifyService(service?.name ?? service?.description);
      if (!cls) continue;
      const offers = Array.isArray(service?.offers) ? service.offers : [];
      const prices = offers
        .filter((o) => offerIsSaleable(o) && isStandardAdultOffer(o))
        .map((o) => parseAmount(o?.price?.amount ?? o?.price))
        .filter((v) => v != null);
      // The service's own minPrice is only a fallback when it lists no offers
      // at all: it is the minimum over every offer, Young and Senior included.
      const min = prices.length
        ? Math.min(...prices)
        : offers.length
          ? null
          : parseAmount(service?.minPrice?.amount ?? service?.minPrice);
      if (min != null && (classes[cls] == null || min < classes[cls])) classes[cls] = min;
    }
  }

  // Berths only. A seat is classified so it can be skipped: this map prices
  // sleepers, and a seat fare — or the solution's headline price, which is
  // the cheapest seat — would put the wrong number on a sleeper card. A train
  // that sells no berth that night gets no fare at all.
  const berths = BERTH_CLASSES.filter((c) => classes[c] != null);
  if (!berths.length) return null;
  const berthClasses = Object.fromEntries(berths.map((c) => [c, classes[c]]));
  const seatClass = berths.reduce((a, b) => (classes[b] < classes[a] ? b : a));
  return { fromPrice: classes[seatClass], currency: "EUR", seatClass, classes: berthClasses, matchedBy };
}

/** "2026-10-18", "19:50" → the body lefrecce's search expects. */
export function solutionsRequestBody({ fromId, toId, date, time }) {
  return {
    departureLocationId: fromId,
    arrivalLocationId: toId,
    departureTime: `${date}T${time}:00.000`,
    adults: 1,
    children: 0,
    criteria: {
      frecceOnly: false,
      regionalOnly: false,
      intercityOnly: false,
      tourismOnly: false,
      noChanges: true,
      order: "DEPARTURE_DATE",
      offset: 0,
      limit: 10,
    },
    advancedSearchRequest: { bestFare: false, bikeFilter: false },
  };
}

/**
 * Search one train on one date. Resolves { fare, solutions, status } — fare
 * null when the train is not among the answers (not running that day) or no
 * price could be read; throws on transport errors and non-JSON answers.
 */
const HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json",
  "Accept-Language": "en-GB,en;q=0.9,it;q=0.8",
};

function normName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * lefrecce's id for a station, looked up by name — for the station whose
 * 830-prefixed Viaggiatreno code the search refuses (Siracusa answers 400).
 * Exact name first, then a name starting with it; never a "(Tutte le
 * stazioni)" group, which is a city and not a platform.
 */
export async function resolveLocationIdByName(name, { fetchImpl = fetch } = {}) {
  const want = normName(name);
  if (!want) return null;
  const res = await fetchImpl(
    `${LEFRECCE_BASE}/locations/search?name=${encodeURIComponent(name)}&limit=10`,
    { headers: HEADERS },
  );
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || text.trimStart().startsWith("<")) return null;
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = (Array.isArray(list) ? list : []).filter((r) => Number.isFinite(Number(r?.id)) && !r?.multistation);
  const pick =
    rows.find((r) => normName(r?.name) === want || normName(r?.displayName) === want) ??
    rows.find((r) => normName(r?.name).startsWith(want));
  return pick ? Number(pick.id) : null;
}

async function postSolutions({ fromId, toId, date, time }, fetchImpl) {
  const res = await fetchImpl(`${LEFRECCE_BASE}/ticket/solutions`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(solutionsRequestBody({ fromId, toId, date, time })),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

/**
 * Search one train on one date. Resolves { fare, solutions, seen, json } —
 * fare null when the train is not among the answers (not running that day)
 * or no price could be read; `seen` lists what the search did return. Throws
 * on transport errors and non-JSON answers.
 *
 * `ids` is an optional per-run cache of station ids resolved by name, keyed by
 * Viaggiatreno code, so a refused code costs one lookup per night, not one
 * per train.
 */
export async function searchTrainFare(
  { fromCode, toCode, fromName, toName, date, time, trainNumber, departureClock, otherTrains = [] },
  { fetchImpl = fetch, ids = new Map() } = {},
) {
  const idFor = (code) => ids.get(code) ?? lefrecceLocationId(code);
  let fromId = idFor(fromCode);
  let toId = idFor(toCode);
  if (!fromId || !toId) throw new Error(`no lefrecce id for ${fromCode}/${toCode}`);
  let r = await postSolutions({ fromId, toId, date, time }, fetchImpl);
  if (r.status === 400 && !ids.has(fromCode) && !ids.has(toCode)) {
    // A refused station id: look both ends up by name once and retry.
    const [f, t] = await Promise.all([
      resolveLocationIdByName(fromName, { fetchImpl }),
      resolveLocationIdByName(toName, { fetchImpl }),
    ]);
    if (f) ids.set(fromCode, f);
    if (t) ids.set(toCode, t);
    if ((f && f !== fromId) || (t && t !== toId)) {
      fromId = f ?? fromId;
      toId = t ?? toId;
      r = await postSolutions({ fromId, toId, date, time }, fetchImpl);
    }
  }
  if (!r.ok) {
    const err = new Error(`solutions HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  if (!r.text || r.text.trimStart().startsWith("<")) throw new Error("solutions non-JSON body");
  const json = JSON.parse(r.text);
  return {
    fare: parseSolutionsFare(json, trainNumber, { departureClock, otherTrains }),
    solutions: Array.isArray(json?.solutions) ? json.solutions.length : 0,
    seen: describeSolutions(json),
    offers: describeOffers(json),
    json,
  };
}

/** Wall-clock "HH:MM" of an instant in Italy — what the search's departureTime means. */
export function romeClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("hour")}:${get("minute")}`;
}

/** "HH:MM" minus a few minutes (clamped at midnight), so the train itself is inside the window. */
export function searchTimeBefore(clock, minutes = 5) {
  const m = String(clock ?? "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return "00:00";
  const total = Math.max(0, Number(m[1]) * 60 + Number(m[2]) - minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
