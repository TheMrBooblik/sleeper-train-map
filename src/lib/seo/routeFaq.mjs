/**
 * Data-driven FAQ builders for the per-train (/trains/[slug]) and city-pair
 * (/connections/[pair]) pages — the counterpart to buildCountryFaq() in faq.js.
 *
 * These are PURE functions over already-resolved primitive inputs (strings and
 * numbers the pages compute in getStaticProps). They import nothing, so they add
 * no coupling and are unit-testable in raw node (tests/verify-seo-faq.mjs).
 *
 * Same contract as the country FAQ: every answer is derived strictly from the
 * route's own data — questions with no supporting data are simply omitted, so
 * the output stays genuinely useful and safe to emit as FAQPage structured data.
 * Returns [{ q, a }] with plain-string questions/answers.
 */

/** Join a list of names as "A, B and C" (drops falsy entries). */
function humanJoin(names) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The best answer we can give about cost, or "" when we know nothing.
 *
 * Tiered, because the three cases are genuinely different answers rather than
 * degradations of one — and the second and third are opposites:
 *
 *   1. a sampled "from" figure  → the number, plus how to read it
 *   2. yield-managed fares      → book early; the price moves
 *   3. a fixed tariff           → booking early does NOT make it cheaper
 *
 * Nothing is invented: `pricingType` is the operator's own record in
 * data/overrides/operator-pricing.json, and an operator with no record produces
 * no answer rather than a guess.
 *
 * The records' `note` is deliberately NOT used. It is an internal annotation,
 * not prose: on most operators it restates the type ("NightJet / EuroNight
 * yield-managed pricing" after a sentence already saying fares are
 * yield-managed) and on one it is just the operator's name.
 *
 * @param {object} input
 * @param {string} [input.fromPrice]     already formatted, e.g. "from €39"
 * @param {string} [input.pricingType]   "dynamic" | "fixed"
 * @param {string} [input.operatorNames] humanJoin()ed operator names
 * @returns {string}
 */
export function costAnswer({ fromPrice = "", pricingType = "", operatorNames = "" } = {}) {
  if (fromPrice) {
    return (
      `Fares vary by date and comfort class, but tickets start ${fromPrice}.` +
      (pricingType === "dynamic"
        ? " Prices rise closer to departure, so the earliest bookings are the cheapest."
        : "")
    );
  }
  // The operator is the subject when we know it and the route is when we do
  // not, so the sentence is never left without one.
  const sells = operatorNames ? `${operatorNames} sells this route` : "This route is sold";
  if (pricingType === "dynamic") {
    return (
      `${sells} at yield-managed fares: the price depends on the date, the comfort ` +
      `class and how far ahead you book, and it rises as the train fills. Booking as ` +
      `early as possible is what makes it cheap.`
    );
  }
  if (pricingType === "fixed") {
    return (
      `${sells} on a fixed tariff: the fare is set by distance and comfort class, so ` +
      `it does not rise as the departure approaches and booking early does not make ` +
      `it cheaper — though sleeper berths do sell out.`
    );
  }
  return "";
}

/**
 * FAQ for a single train route.
 *
 * @param {object} input
 * @param {string} input.origin        display city, e.g. "Amsterdam"
 * @param {string} input.destination   display city, e.g. "Zürich"
 * @param {string[]} [input.operators] operator names
 * @param {string} [input.durationText] e.g. "10h 45m"
 * @param {string} [input.departureTime] e.g. "19:32"
 * @param {string} [input.arrivalTime]   e.g. "08:20"
 * @param {string} [input.fromPrice]     already formatted, e.g. "from €39"
 * @param {string} [input.classes]       e.g. "Seats, couchettes, sleepers"
 * @param {string[]} [input.trainNumbers] e.g. ["NJ 40295"]
 * @returns {{q:string,a:string}[]}
 */
export function buildRouteFaq(input = {}) {
  const {
    origin,
    destination,
    operators = [],
    durationText = "",
    departureTime = "",
    arrivalTime = "",
    fromPrice = "",
    classes = "",
    trainNumbers = [],
  } = input;

  if (!origin || !destination) return [];

  const pair = `${origin} to ${destination}`;
  const operatorNames = humanJoin(operators);
  const faq = [];

  // How long is the journey.
  if (durationText) {
    faq.push({
      q: `How long is the night train from ${origin} to ${destination}?`,
      a: `The ${origin}–${destination} night train takes about ${durationText}.`,
    });
  }

  // Departure (and arrival, when known) — no "next day" claim, times only.
  if (departureTime) {
    faq.push({
      q: `What time does the ${pair} night train leave?`,
      a:
        `It departs ${origin} at ${departureTime}` +
        (arrivalTime ? ` and arrives in ${destination} at ${arrivalTime}.` : "."),
    });
  }

  // Price — fromPrice already carries its "from €X" prefix.
  if (fromPrice) {
    faq.push({
      q: `How much does the ${pair} night train cost?`,
      a: `Fares vary by date and comfort class, but tickets start ${fromPrice}.`,
    });
  }

  // Onboard classes — only when the value is descriptive (guards against raw
  // numeric class codes producing an odd sentence).
  if (classes && /[a-zA-Z]/.test(classes)) {
    faq.push({
      q: `What classes are available on the ${pair} night train?`,
      a: `Onboard you can choose ${classes}.`,
    });
  }

  // Who runs it.
  if (operatorNames) {
    const trains = (trainNumbers || []).filter(Boolean);
    faq.push({
      q: `Which operator runs the ${pair} night train?`,
      a:
        `The route is operated by ${operatorNames}` +
        (trains.length ? ` (train ${trains.join(" / ")}).` : "."),
    });
    // How to book — points to the concrete next step on the page.
    faq.push({
      q: `How do I book the ${pair} night train?`,
      a: `Book directly with ${operatorNames}. Open the timetable above for the departure and booking link.`,
    });
  }

  return faq;
}

/**
 * FAQ for a city-pair connection (≥2 trains).
 *
 * @param {object} input
 * @param {string} input.originCity
 * @param {string} input.destCity
 * @param {number} input.trainCount              number of trains on the pair
 * @param {string[]} [input.operators]           operator names
 * @param {string} [input.fastestDurationText]   e.g. "9h 10m"
 * @param {string} [input.fromPrice]             already formatted, e.g. "from €29"
 * @param {string} [input.pricingType]           "dynamic" | "fixed", from the operator record
 * @returns {{q:string,a:string}[]}
 */
export function buildConnectionFaq(input = {}) {
  const {
    originCity,
    destCity,
    trainCount = 0,
    operators = [],
    fastestDurationText = "",
    fromPrice = "",
    pricingType = "",
  } = input;

  if (!originCity || !destCity) return [];

  const pair = `${originCity} to ${destCity}`;
  const operatorNames = humanJoin(operators);
  const faq = [];

  // How many + who.
  if (trainCount > 0) {
    faq.push({
      q: `How many night trains run between ${originCity} and ${destCity}?`,
      a:
        `${trainCount} night ${trainCount === 1 ? "train connects" : "trains connect"} ${originCity} and ${destCity}` +
        (operatorNames ? `, run by ${operatorNames}.` : "."),
    });
  }

  // Fastest journey.
  if (fastestDurationText) {
    faq.push({
      q: `How long does the ${pair} night train take?`,
      a: `The fastest overnight journey is about ${fastestDurationText}.`,
    });
  }

  // What it costs. A concrete "from" figure is the best answer, but until the
  // price probes fill one in there is a second-best one that is still true and
  // still the thing a traveller is deciding on: WHETHER BOOKING EARLY HELPS.
  // That differs by operator and the answer is already in the data, so leaving
  // the question out entirely — as this did — said nothing on every page.
  const priceAnswer = costAnswer({ fromPrice, pricingType, operatorNames });
  if (priceAnswer) {
    faq.push({
      q: `How much is a night train from ${originCity} to ${destCity}?`,
      a: priceAnswer,
    });
  }

  // How to book.
  if (operatorNames) {
    faq.push({
      q: `How do I book a night train from ${originCity} to ${destCity}?`,
      a: `Compare the trains above and book directly with ${operatorNames}.`,
    });
  }

  return faq;
}
