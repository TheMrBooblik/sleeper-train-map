/**
 * How the map names a train once a station is selected: from where the
 * traveller is, to where the train takes them.
 *
 * A route row states its endpoints in one fixed direction (Bruxelles Midi →
 * Milano), so a click on Milan used to list "Bruxelles Midi – Milano" — the
 * train you would board in Brussels, not in Milan. Every surface that names a
 * train for a selected station now starts at the selected city's own station:
 * the bottom bar's chips (TrainBottomBar), the line's hover tooltip and the
 * route chip at the top of the map (DynamicMap), and which of the two trains
 * the detail panel lists first (TrainDetailPanel). One function answers all
 * four, so a chip cannot say "Milano – Bruxelles" above a panel that opens on
 * the Brussels train. When the station is an intermediate stop, the other end
 * is the farther endpoint, the direction with the longer ride: from Brussels,
 * ES 453 Berlin–Paris reads "Bruxelles Midi – Berlin", not "– Paris", since
 * that is the night on the train.
 *
 * Dependency-free: the city test, the via splitter and the coordinate lookup
 * are injected, so the rule is testable in raw node.
 */

const EARTH_KM = 6371;

function distanceKm(a, b) {
  if (!a || !b) return null;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * "Is this station in the city the user picked?" — the display-normalised
 * name equals the selected one, or the raw name contains it ("Milano Porta
 * Garibaldi" for "Milano"). The test the bottom bar has always used, shared so
 * every surface agrees about "here". No selection matches nothing.
 * @param {string} selectedName display-normalised name of the selected station
 * @param {(name: string) => string} normalizeForDisplay
 */
export function selectedCityMatcher(selectedName, normalizeForDisplay) {
  if (!selectedName) return () => false;
  const lower = String(selectedName).toLowerCase();
  return (station) => {
    if (!station) return false;
    const name = String(station).trim();
    return (
      normalizeForDisplay(name) === selectedName ||
      name.toLowerCase().includes(lower)
    );
  };
}

/**
 * The two names for a route: { from, to, direction, fromIsSelected }.
 * `direction` is the row direction (0/1) whose train that is, for its number.
 *
 * - The selected city is an endpoint → from that endpoint to the other one
 *   (for direction 1, its own stated endpoints when it starts there).
 * - It is an intermediate stop → from that stop to the endpoint farther away
 *   along the ground; with no coordinates for either end, the end with more
 *   stops left before it.
 * - The row runs one way only → never against it (see below).
 * - It is neither (the route reached the bar through a city-group match the
 *   stop names do not show) → the row's own direction-0 endpoints, flagged
 *   with fromIsSelected: false so the caller can keep its old via hint.
 *
 * @param {object} route viewMap row
 * @param {object} deps
 * @param {(name: string) => boolean} deps.inSelectedCity
 * @param {(via: string) => string[]} [deps.splitVia]
 * @param {(name: string) => [number, number] | null} [deps.coordsOf]
 */
export function stationFirstEndpoints(
  route,
  { inSelectedCity, splitVia = defaultSplit, coordsOf = () => null },
) {
  const a = route?.origin_trip_0 || route?.origin_trip_1 || "";
  const b = route?.destination_trip_0 || route?.destination_trip_1 || "";
  const a1 = route?.origin_trip_1 || "";
  const b1 = route?.destination_trip_1 || "";

  // A one-way row (45 of 298: ICN 1962 Messina→Milano and ICN 1963
  // Milano→Siracusa are separate rows) has one train, running a → b. From
  // anywhere on it the chip can only point toward b, and at b itself the
  // train only arrives — so it keeps its real direction rather than invent a
  // departure that does not exist.
  const twoWay = Boolean(a1 || route?.trip_short_name_1 || route?.via_1);
  if (!twoWay) {
    if (a && inSelectedCity(a))
      return { from: a, to: b, direction: 0, fromIsSelected: true };
    const vias = route?.via_0 ? splitVia(route.via_0) || [] : [];
    const stop = vias.find((s) => inSelectedCity(s));
    if (stop) return { from: stop, to: b, direction: 0, fromIsSelected: true };
    return { from: a, to: b, direction: 0, fromIsSelected: false };
  }

  if (a && inSelectedCity(a))
    return { from: a, to: b, direction: 0, fromIsSelected: true };
  if (a1 && inSelectedCity(a1))
    return { from: a1, to: b1 || a, direction: 1, fromIsSelected: true };
  if (b && inSelectedCity(b))
    return { from: b, to: a, direction: 1, fromIsSelected: true };

  // An intermediate stop, in either direction's own stop list: the two can
  // differ (ICN 796 runs Salerno–Torino along the coast, its return ICN 797
  // inland through Milano), so a city only one direction serves must still be
  // found — and then the train is that direction's.
  const lists = [
    { via: route?.via_0, start: a, end: b, dir: 0 },
    { via: route?.via_1, start: a1 || b, end: b1 || a, dir: 1 },
  ];
  for (const { via, start, end, dir } of lists) {
    const vias = via ? splitVia(via) || [] : [];
    const idx = vias.findIndex((s) => inSelectedCity(s));
    if (idx < 0) continue;
    const stop = vias[idx];
    // Only this direction calls here (ICN 798 at Parma; 797 runs non-stop
    // from Milano to Roma), so its train is the only one to board: never the
    // farther end if that is the other direction's. A row that states no stop
    // list for the other direction says nothing either way.
    const otherVias = splitVia(lists[1 - dir].via || "") || [];
    if (otherVias.length && !otherVias.some((s) => inSelectedCity(s))) {
      return { from: stop, to: end, direction: dir, fromIsSelected: true };
    }
    const here = coordsOf(stop);
    const toStart = distanceKm(here, coordsOf(start));
    const toEnd = distanceKm(here, coordsOf(end));
    const towardEnd =
      toStart != null && toEnd != null
        ? toEnd >= toStart
        : vias.length - 1 - idx >= idx; // stops still to come vs already passed
    return towardEnd
      ? { from: stop, to: end, direction: dir, fromIsSelected: true }
      : { from: stop, to: start, direction: 1 - dir, fromIsSelected: true };
  }
  return { from: a, to: b, direction: 0, fromIsSelected: false };
}

/**
 * The bar's text per route, with the train number added only where two
 * routes would otherwise read the same — two different trains from Bologna
 * to Lecce (ICN 754 and ICN 758) must not look like one listed twice.
 * @param {{ from: string, to: string, trainNumber?: string }[]} labels
 * @returns {string[]} the suffix for each, "" when the label is unique
 */
export function disambiguateLabels(labels) {
  const count = new Map();
  for (const l of labels) {
    const k = `${l.from}\u0000${l.to}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  return labels.map((l) =>
    count.get(`${l.from}\u0000${l.to}`) > 1 && l.trainNumber
      ? l.trainNumber
      : "",
  );
}

function defaultSplit(via) {
  return String(via ?? "")
    .split(" - ")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Which direction of `row` a trip card describes: its own direction_id — the
 * key the panel already pairs a trip card with its row by (officialRowSchedule,
 * the per-direction timetable link) — else the train number when exactly one
 * direction carries it, else null. A number both directions share settles
 * nothing: Back-on-Track labels some routes with one number for both trains.
 */
export function tripDirection(row, trip) {
  if (!trip) return null;
  const id = Number(trip.direction_id);
  if (
    trip.direction_id != null &&
    trip.direction_id !== "" &&
    (id === 0 || id === 1)
  )
    return id;
  const name = String(trip.trip_short_name ?? "").trim();
  if (!row || !name) return null;
  const hits = [0, 1].filter(
    (dir) => String(row[`trip_short_name_${dir}`] ?? "").trim() === name,
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Trip cards with the train the traveller boards first: for each route whose
 * station-first direction is known (`firstDirection[routeId]`), its trip
 * running the other way moves behind the rest. Stable, and nothing else
 * moves — a trip whose route or direction is unknown keeps its place.
 * @param {object[]} trips
 * @param {Record<string, 0|1>} firstDirection route_id → direction
 * @param {(trip: object) => 0|1|null} directionOf
 * @returns {object[] | null} null when no trip's route has a preference
 */
export function orderTripsStationFirst(trips, firstDirection, directionOf) {
  const list = trips ?? [];
  const rank = (trip) => {
    const want = firstDirection?.[String(trip?.route_id)];
    if (want !== 0 && want !== 1) return null;
    const dir = directionOf(trip);
    if (dir !== 0 && dir !== 1) return null;
    return dir === want ? 0 : 1;
  };
  const ranked = list.map((trip, i) => ({ trip, i, r: rank(trip) }));
  if (!ranked.some((x) => x.r != null)) return null;
  return ranked
    .sort((a, b) => (a.r ?? 0) - (b.r ?? 0) || a.i - b.i)
    .map((x) => x.trip);
}

/**
 * The stop list of one direction of a row, in travel order. Direction 1 is
 * its own list when the row states one, else direction 0 reversed — the
 * same reading as stationFirstEndpoints above. [] for a direction the row
 * does not run (a one-way row's direction 1).
 */
function directionStops(route, dir, splitVia) {
  const a = route?.origin_trip_0 || route?.origin_trip_1 || "";
  const b = route?.destination_trip_0 || route?.destination_trip_1 || "";
  const via0 = route?.via_0 ? splitVia(route.via_0) || [] : [];
  const d0 = [a, ...via0, b].filter(Boolean);
  if (dir === 0) return d0;
  const a1 = route?.origin_trip_1 || "";
  const twoWay = Boolean(a1 || route?.trip_short_name_1 || route?.via_1);
  if (!twoWay) return [];
  if (!route?.via_1) return [...d0].reverse();
  const via1 = splitVia(route.via_1) || [];
  return [a1 || b, ...via1, route?.destination_trip_1 || a].filter(Boolean);
}

/**
 * Which direction of a row takes a traveller from one place to another:
 * 0 or 1 when that direction calls at `from` before `to` (direction 0 when
 * both do, as on a loop), -1 when the row names both and no direction runs
 * that way (a one-way row met from its far end), null when its stop lists do
 * not name both — the route reached the selection through a city-group match,
 * which proves nothing about order.
 * @param {object} route viewMap row
 * @param {object} deps
 * @param {(name: string) => boolean} deps.inFrom
 * @param {(name: string) => boolean} deps.inTo
 * @param {(via: string) => string[]} [deps.splitVia]
 */
export function directionBetween(
  route,
  { inFrom, inTo, splitVia = defaultSplit },
) {
  let namesBoth = false;
  for (const dir of [0, 1]) {
    const stops = directionStops(route, dir, splitVia);
    const iFrom = stops.findIndex((s) => inFrom(s));
    let iTo = -1;
    stops.forEach((s, i) => {
      if (inTo(s)) iTo = i;
    });
    if (iFrom < 0 || iTo < 0) continue;
    namesBoth = true;
    if (iFrom < iTo) return dir;
  }
  return namesBoth ? -1 : null;
}

/**
 * The routes a traveller at the selected station could ride to a second
 * clicked station — what a click on that station means once one is selected
 * (DynamicMap): the routes the two share, less any proven to run only the
 * other way. Those whose order is known come first, in the order given
 * (the caller passes them already ranked, as the bottom bar ranks them).
 * @param {object[]} routes viewMap rows calling at both stations
 * @returns {{ route: object, direction: 0|1|null }[]}
 */
export function routesBetweenStations(routes, deps) {
  const out = [];
  for (const route of routes ?? []) {
    const direction = directionBetween(route, deps);
    if (direction === -1) continue;
    out.push({ route, direction });
  }
  return [
    ...out.filter((r) => r.direction != null),
    ...out.filter((r) => r.direction == null),
  ];
}

/**
 * A route named for a known direction, from the selected station: the first
 * stop of that direction in the selected city, to that direction's last stop.
 * What a route opened by clicking a second station is called, so the chip and
 * the panel name the train that actually runs toward it. null when that
 * direction does not name the selected city.
 */
export function endpointsInDirection(
  route,
  direction,
  { inFrom, splitVia = defaultSplit },
) {
  const stops = directionStops(route, direction, splitVia);
  const from = stops.find((s) => inFrom(s));
  if (!from) return null;
  return {
    from,
    to: stops[stops.length - 1],
    direction,
    fromIsSelected: true,
  };
}
