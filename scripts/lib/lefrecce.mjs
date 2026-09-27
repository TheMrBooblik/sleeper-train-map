// scripts/lib/lefrecce.mjs
// Trenitalia fares from lefrecce.it — the JSON backend (BFF) behind the
// operator's own booking site. Read-only: one ticket search per train, no
// cart, no login. Used by the viaggiatreno adapter to price Intercity Notte.
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

// The berth classes, cheapest-kind first. A seat is priced too (every ICN
// sells them) but is the from-price only when a train sells no berth at all.
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

function offerIsSaleable(offer) {
  const status = String(offer?.status ?? offer?.saleability ?? "").toUpperCase();
  return !status || status === "SALEABLE" || status === "AVAILABLE";
}

/**
 * Parse a /ticket/solutions response into the fare for one train, or null.
 * Returns { fromPrice, currency: "EUR", seatClass, classes: {seat?, couchette?, sleeperCabin?} }.
 *
 * Reads the per-service grid when the response carries one (cheapest saleable
 * offer per class); a solution without a grid still has its own headline
 * price, which is kept as a class-less figure rather than guessed at.
 */
export function parseSolutionsFare(json, trainNumber) {
  const entries = Array.isArray(json?.solutions) ? json.solutions : [];
  const match = entries.find((e) => solutionHasTrain(e?.solution ?? e, trainNumber));
  if (!match) return null;
  const solution = match.solution ?? match;

  const classes = {};
  const grids = Array.isArray(match.grids) ? match.grids : Array.isArray(solution.grids) ? solution.grids : [];
  for (const grid of grids) {
    for (const service of grid?.services ?? []) {
      const cls = classifyService(service?.name ?? service?.description);
      if (!cls) continue;
      const offers = Array.isArray(service?.offers) ? service.offers : [];
      const prices = offers
        .filter(offerIsSaleable)
        .map((o) => parseAmount(o?.price?.amount ?? o?.price))
        .filter((v) => v != null);
      const min = prices.length ? Math.min(...prices) : parseAmount(service?.minPrice?.amount ?? service?.minPrice);
      if (min != null && (classes[cls] == null || min < classes[cls])) classes[cls] = min;
    }
  }

  const berths = BERTH_CLASSES.filter((c) => classes[c] != null);
  if (berths.length) {
    const seatClass = berths.reduce((a, b) => (classes[b] < classes[a] ? b : a));
    return { fromPrice: classes[seatClass], currency: "EUR", seatClass, classes };
  }
  if (classes.seat != null) {
    return { fromPrice: classes.seat, currency: "EUR", seatClass: "seat", classes };
  }
  const headline = parseAmount(solution?.price?.amount ?? solution?.price);
  return headline != null ? { fromPrice: headline, currency: "EUR", seatClass: null, classes: {} } : null;
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
export async function searchTrainFare(
  { fromCode, toCode, date, time, trainNumber },
  { fetchImpl = fetch } = {},
) {
  const fromId = lefrecceLocationId(fromCode);
  const toId = lefrecceLocationId(toCode);
  if (!fromId || !toId) throw new Error(`no lefrecce id for ${fromCode}/${toCode}`);
  const res = await fetchImpl(`${LEFRECCE_BASE}/ticket/solutions`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en-GB,en;q=0.9,it;q=0.8",
    },
    body: JSON.stringify(solutionsRequestBody({ fromId, toId, date, time })),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`solutions HTTP ${res.status}`);
  if (!text || text.trimStart().startsWith("<")) throw new Error("solutions non-JSON body");
  const json = JSON.parse(text);
  return {
    fare: parseSolutionsFare(json, trainNumber),
    solutions: Array.isArray(json?.solutions) ? json.solutions.length : 0,
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
