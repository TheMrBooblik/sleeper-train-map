// scripts/lib/probe-health.mjs
// Pure helpers behind public/data/scraped/probe-health.json.
//
// A price probe fails silently by construction: it reaches an undocumented API,
// extracts nothing, files no proposal — which is byte-for-byte what a probe with
// nothing new to report does — and its workflow step is continue-on-error. The
// NightJet probe ran every Monday for months on exactly that path and produced
// no price at all, with nothing anywhere recording the fact. These functions
// turn "found nothing again" into a number someone can look at.
//
// No fs, no clock: the caller passes `nowIso` and the previous file's contents.

/**
 * Accept either shape an adapter may return: the rich
 * `{ prices, attempted, errors }`, or a bare array of price findings (what the
 * contract was before health reporting, kept working so an adapter that has not
 * been updated still reports its prices).
 *
 * @returns {{prices: object[], attempted: number, errors: string[]}}
 */
export function normalizeProbeResult(result) {
  if (Array.isArray(result)) {
    return { prices: result, attempted: result.length, errors: [] };
  }
  const prices = Array.isArray(result?.prices) ? result.prices : [];
  const errors = Array.isArray(result?.errors) ? result.errors.filter(Boolean) : [];
  const attempted = Number.isFinite(result?.attempted) ? result.attempted : prices.length;
  return { prices, attempted, errors };
}

/**
 * Fold this run's outcomes into the previous health record.
 *
 * A probe with no outcome this run (not scheduled, disabled) carries its record
 * forward untouched rather than being recorded as a success or a failure — the
 * same rule the scrape runner's source-health merge follows.
 *
 * @param {Record<string, object>} previous  the previous file's `probes` block
 * @param {Array<object>} entries            registry entries carrying probe.pricing
 * @param {Record<string, object>} outcomes  entry id → normalizeProbeResult() output
 * @param {string} nowIso
 * @returns {Record<string, object>}
 */
export function mergeProbeHealth(previous, entries, outcomes, nowIso) {
  const probes = { ...(previous ?? {}) };
  for (const entry of entries ?? []) {
    const prior = previous?.[entry.id] ?? {};
    const adapter = entry.probe?.pricing?.adapter ?? null;
    const outcome = outcomes?.[entry.id];
    if (!outcome) {
      probes[entry.id] = { ...prior, adapter };
      continue;
    }
    const found = outcome.prices.length;
    // Errors alongside a price is a partial run, not a failure: some routes
    // answered. Only a run that got nothing AND hit errors is a failure — a run
    // that found nothing with no errors had nothing to sample.
    const failed = found === 0 && outcome.errors.length > 0;
    probes[entry.id] = {
      adapter,
      lastRunAt: nowIso,
      lastSuccessAt: found > 0 ? nowIso : (prior.lastSuccessAt ?? null),
      lastFailureAt: failed ? nowIso : (prior.lastFailureAt ?? null),
      lastError: failed ? outcome.errors[0] : (prior.lastError ?? null),
      attempted: outcome.attempted,
      found,
      // The number that makes a dead probe legible at a glance.
      consecutiveEmptyRuns: found > 0 ? 0 : (prior.consecutiveEmptyRuns ?? 0) + 1,
    };
  }
  return probes;
}
