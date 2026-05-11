/**
 * Derive GTFS train-number lookup keys from a Back-on-Track trip label
 * (trip_short_name / trip_short_name_0 / _1). Order matters: prefer IC, then TLK,
 * slash-suffixed numbers, EN/EC, then any 4–6 digit run (for compound labels).
 *
 * Used by the PKP GTFS parse script and by the API when attaching polylines to viewMap.
 */

/**
 * @param {string} label
 * @returns {string[]}
 */
export function extractKeysFromTripLabel(label) {
  const s = String(label || "");
  const keys = [];
  /** @param {string} k */
  const push = (k) => {
    if (k && !keys.includes(k)) keys.push(k);
  };

  const ic = s.match(/\bIC\s+(\d{3,6})\b/i);
  if (ic) push(ic[1]);

  const tlk = s.match(/\bTLK\s+(\d{3,6})\b/i);
  if (tlk) push(tlk[1]);

  const slash = s.match(/\/(\d{3,6})(?:\D|$)/);
  if (slash) push(slash[1]);

  const en = s.match(/\bEN\s+(\d{3,6})\b/i);
  if (en) push(en[1]);

  const ec = s.match(/\bEC\s+(\d{3,6})\b/i);
  if (ec) push(ec[1]);

  const longRuns = s.match(/\d{4,6}/g) || [];
  longRuns.forEach((n) => push(n));

  return keys;
}

/**
 * @param {string} label
 * @param {Record<string, { positions?: number[][] }>} byTrainKey
 * @returns {number[][] | null}
 */
export function positionsForBoTTripLabel(label, byTrainKey) {
  if (!byTrainKey) return null;
  for (const k of extractKeysFromTripLabel(label)) {
    const entry = byTrainKey[k];
    if (entry?.positions?.length >= 2) return entry.positions;
  }
  return null;
}

/**
 * @param {string} label
 * @param {Record<string, { stops?: string[] }>} byTrainKey
 * @returns {string[] | null}
 */
export function stopsForBoTTripLabel(label, byTrainKey) {
  if (!byTrainKey) return null;
  for (const k of extractKeysFromTripLabel(label)) {
    const entry = byTrainKey[k];
    if (entry?.stops?.length >= 2) return entry.stops;
  }
  return null;
}

/**
 * @param {string} label
 * @param {Record<string, { rail_segments?: {positions: number[][]}[] }>} byTrainKey
 * @returns {{positions: number[][]}[] | null}
 */
export function railSegmentsForBoTTripLabel(label, byTrainKey) {
  if (!byTrainKey) return null;
  for (const k of extractKeysFromTripLabel(label)) {
    const entry = byTrainKey[k];
    if (entry?.rail_segments?.length >= 1) return entry.rail_segments;
  }
  return null;
}

/**
 * @param {string} label
 * @param {Record<string, { bus_segments?: {positions: number[][]}[] }>} byTrainKey
 * @returns {{positions: number[][]}[] | null}
 */
export function busSegmentsForBoTTripLabel(label, byTrainKey) {
  if (!byTrainKey) return null;
  for (const k of extractKeysFromTripLabel(label)) {
    const entry = byTrainKey[k];
    if (entry?.bus_segments?.length >= 1) return entry.bus_segments;
  }
  return null;
}
