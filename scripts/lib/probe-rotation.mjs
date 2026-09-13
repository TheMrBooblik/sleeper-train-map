// scripts/lib/probe-rotation.mjs
// Which routes a weekly price probe samples this run.
//
// The probe exists to widen price coverage over time, and the naive selection —
// take the first N candidates — cannot do that: the candidate list is derived
// from the scraped trains file in a stable order, so every Monday sampled the
// same four of seventy NightJet routes and the other sixty-six could never get a
// price no matter how long the job ran.
//
// Two rules fix that. A route with no price at all outranks one that already has
// one, because a missing price is a question the page cannot answer while a stale
// price is merely old. And the unpriced half advances by a FULL page each run
// (rotation * sampleSize, not rotation), so successive runs cover fresh ground
// instead of sliding one entry along and re-reading what they just read.
//
// Pure and total: no clock, no network, no fs. The caller supplies `rotation`
// (a monotone run counter — weeksSinceEpoch() below) so the choice is
// reproducible and testable.

/**
 * A monotone weekly counter, for use as `rotation`. Weeks since the Unix epoch,
 * so it keeps increasing across years (an ISO week number would reset every
 * January and re-probe the same page it sampled twelve months earlier).
 *
 * @param {number} [nowMs]
 * @returns {number}
 */
export function weeksSinceEpoch(nowMs = Date.now()) {
  return Math.floor(nowMs / (7 * 24 * 60 * 60 * 1000));
}

/** Rotate `list` left by `offset` positions. Total: empty list rotates to itself. */
function rotate(list, offset) {
  if (list.length === 0) return [];
  const start = ((offset % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * Order by staleness, oldest first. A record with no `sampledAt` sorts oldest:
 * we cannot show it is fresh, and treating unknown as fresh would park it at the
 * back of the queue permanently.
 */
function byStalenessAsc(a, b) {
  const at = Date.parse(a.price?.sampledAt ?? "") || 0;
  const bt = Date.parse(b.price?.sampledAt ?? "") || 0;
  if (at !== bt) return at - bt;
  return a.candidate.routeKey.localeCompare(b.candidate.routeKey);
}

/**
 * Choose this run's probe targets.
 *
 * @param {Array<{routeKey: string}>} candidates  probe-able routes, any order
 * @param {Record<string, {sampledAt?: string}>} [prices]  data/canonical/prices.json
 * @param {object} [opts]
 * @param {number} [opts.sampleSize=4]  request budget for this run
 * @param {number} [opts.rotation=0]    monotone run counter (weeksSinceEpoch())
 * @returns {Array<object>} a subset of `candidates`, in the order to probe them
 */
export function selectProbeTargets(candidates, prices = {}, opts = {}) {
  const sampleSize = Number.isFinite(opts.sampleSize) ? Math.max(0, opts.sampleSize) : 4;
  const rotation = Number.isFinite(opts.rotation) ? opts.rotation : 0;
  if (sampleSize === 0) return [];

  // Sort by routeKey first: the incoming order comes from whatever the scrape
  // happened to write, and a rotation over an unstable order is not a rotation.
  const sorted = [...(candidates ?? [])]
    .filter((c) => c && typeof c.routeKey === "string" && c.routeKey)
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey));

  const unpriced = [];
  const priced = [];
  for (const candidate of sorted) {
    const price = prices?.[candidate.routeKey];
    if (price && Number.isFinite(price.fromPrice)) priced.push({ candidate, price });
    else unpriced.push(candidate);
  }

  // Advance a whole page per run so week N+1 starts where week N stopped.
  const picked = rotate(unpriced, rotation * sampleSize).slice(0, sampleSize);
  if (picked.length >= sampleSize) return picked;

  // Coverage is complete (or nearly) — spend what's left re-checking the prices
  // most likely to have gone stale, so the figures on the pages keep meaning
  // something once every route has one.
  const refresh = [...priced].sort(byStalenessAsc).map((p) => p.candidate);
  return [...picked, ...refresh.slice(0, sampleSize - picked.length)];
}
