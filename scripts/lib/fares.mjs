// scripts/lib/fares.mjs
// Shared by every adapter that prices its own trains (12306, lefrecce).

// A fare that failed to refresh tonight keeps the last figure the source gave
// — but not forever: past this age it is dropped rather than shown with a
// date nobody reads. The carried fare keeps its own sampledAt, so the UI's
// "Checked <month>" stays honest.
export const FARE_CARRY_MAX_DAYS = 30;

/**
 * Give a train whose price call failed tonight the fare it had last run, when
 * that fare is recent enough to stand behind. Returns how many were carried.
 * Pure — exported for tests.
 */
export function carryPreviousFares(trains, previousTrains, { today, maxAgeDays = FARE_CARRY_MAX_DAYS } = {}) {
  if (!previousTrains || typeof previousTrains !== "object") return 0;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  let carried = 0;
  for (const [key, train] of Object.entries(trains ?? {})) {
    if (train.fare) continue;
    const prev = previousTrains[key]?.fare;
    if (!Number.isFinite(prev?.fromPrice)) continue;
    const sampledMs = Date.parse(`${prev.sampledAt}T00:00:00Z`);
    if (!Number.isFinite(sampledMs) || !Number.isFinite(todayMs)) continue;
    if ((todayMs - sampledMs) / 86_400_000 > maxAgeDays) continue;
    train.fare = prev;
    carried++;
  }
  return carried;
}

