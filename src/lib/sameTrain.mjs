// src/lib/sameTrain.mjs
// Is a scraped train the train a Back-on-Track row describes, or only a train
// that shares its number?
//
// A bare train number is only unique within an operator, and nightjet.com
// proves it is not unique across one shop either: from October 2026 it lists
// an "EN 442" running Budapest → Stuttgart, while Back-on-Track's EN 442 is
// ČD's Humenné → Praha. Matched by number alone, the build deleted the
// Humenné–Praha row as "covered by official data" and the scrape painted the
// Budapest line onto it.
//
// The test is the cheapest one that separates the two on the real data: the
// same train ends in at least one of the same cities. Across every
// Back-on-Track row a nightjet.com train shares its number with (50 matches,
// 2026-10-15), every genuine match shares at least one end city — 47 of them
// both, the EN 40462 portion that stops at Sargans one — and the collision
// (row 6, both directions) shares none. Cities, not station names, because
// the two sources spell stations differently ("Warschau Wschodnia" /
// "Warszawa Wschodnia") and a portion may end at another station of the same
// city.
//
// It rejects only what it can prove different: a row or train without
// endpoint names is treated as the same train, which is what the number
// match alone said before.

import { cityForStation } from "./seo/cities.mjs";
import { resolveCanonicalStationName } from "../pages/api/lib/primitives.mjs";

function cityKey(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const canonical = resolveCanonicalStationName(raw) || raw;
  const city = cityForStation(canonical) || canonical;
  return String(city).normalize("NFC").toLowerCase();
}

/** The cities a row's endpoints are in, both directions. */
export function rowEndCities(row) {
  const names = [row?.origin_trip_0, row?.destination_trip_0, row?.origin_trip_1, row?.destination_trip_1];
  return new Set(names.map(cityKey).filter(Boolean));
}

/** The cities a train's first and last station are in. */
export function trainEndCities(train) {
  const stations = Array.isArray(train?.stations) ? train.stations : [];
  if (stations.length < 2) return [];
  return [stations[0]?.name, stations[stations.length - 1]?.name].map(cityKey).filter(Boolean);
}

/**
 * Whether `train` (a trains-file entry with `stations`) can be the train
 * `row` (a view-map row) describes: true unless both have endpoints and no
 * end city is shared.
 * @param {object} row
 * @param {object} train
 */
export function sameTrainAsRow(row, train) {
  const rowCities = rowEndCities(row);
  const ends = trainEndCities(train);
  if (!rowCities.size || !ends.length) return true;
  return ends.some((c) => rowCities.has(c));
}
