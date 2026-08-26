/**
 * Integration coverage model — the maths behind /data → Integrations.
 *
 * Answers one question: which of Pingwi's routes still come from Back-on-Track
 * (a third-party community dataset) rather than from the operator's own feed,
 * and which integration is worth building next.
 *
 * Pure and dependency-free — every input is passed in, nothing is read from
 * disk — so `tests/verify-integrations.mjs` can exercise it with raw node and
 * the API route stays a thin reader. Kept as .mjs for the same reason
 * operatorNames.mjs is.
 *
 * The one rule worth stating out loud, because the whole tool exists to keep
 * it honest: *finding* an official API is not the same as *fetching* from it.
 * Integration status is therefore derived from the registry and tonight's
 * payload; the curated catalogue only fills in what the data cannot know.
 */
import { OPERATORS, splitAgencyIds } from "../seo/operatorNames.mjs";

export const BACKONTRACK_SOURCE_ID = "backontrack";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Feed freshness reuses the thresholds /api/data-status has always used, so the
// two admin surfaces never disagree about what "fresh" means.
const FEED_FRESH_HOURS = 25;
const FEED_AGING_HOURS = 50;

// Content freshness: how long a route's own fingerprint (endpoints, days,
// train numbers, stop sequence) has stood still. A nightly fetch of a stale
// upstream is still green on the feed and dead on the content, which is
// exactly the blind spot this dashboard exists to close.
const CONTENT_AGING_DAYS = 90;
const CONTENT_STALE_DAYS = 180;

export const INTEGRATION_STATUSES = [
  "not-investigated",
  "source-discovered",
  "source-tested",
  "in-progress",
  "integrated",
  "needs-maintenance",
];
export const SOURCE_STATUSES = [
  "integrated",
  "working",
  "discovered",
  "broken",
];
export const DIFFICULTIES = ["easy", "medium", "hard", "unknown"];
export const AUTH_KINDS = ["none", "api-key", "oauth", "account", "unknown"];

// ─── Route → source ─────────────────────────────────────────────────────────

/**
 * Which registry source produced this row?
 *
 * Precedence matters. `official_sources` is written by the scrape post-step
 * only when an official feed actually corroborated the row, so it outranks
 * everything. Failing that, a synthetic row carries its source in its key —
 * longest prefix first, because "nj_standalone_" and a hypothetical "nj_"
 * would both match and only the longer one is right. Everything left is
 * Back-on-Track.
 *
 * @param {string} routeKey
 * @param {object} row       viewMap row
 * @param {Array}  registry  data/sources/registry.json
 * @returns {string[]} registry source ids (never empty)
 */
export function resolveRouteSources(routeKey, row, registry) {
  const known = new Set((registry ?? []).map((e) => e?.id).filter(Boolean));
  const stamped = Array.isArray(row?.official_sources)
    ? row.official_sources.filter((id) => known.has(id))
    : [];
  if (stamped.length) return [...stamped].sort();

  const prefixes = (registry ?? [])
    .filter((e) => e?.synthetic?.idPrefix)
    .map((e) => [e.synthetic.idPrefix, e.id])
    .sort((a, b) => b[0].length - a[0].length);
  const hit = prefixes.find(([prefix]) => String(routeKey).startsWith(prefix));
  return hit ? [hit[1]] : [BACKONTRACK_SOURCE_ID];
}

/** The concrete address a source reads, for printing instead of a category. */
export function describeSource(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    endpoint: entry.endpoint ?? null,
    docsUrl: entry.docsUrl ?? null,
    homepage: entry.homepage ?? null,
    kind: entry.kind ?? null,
    official: entry.official === true,
    trusted: entry.trusted === true,
    enabled: entry.enabled === true,
    output: entry.output ?? null,
  };
}

/** Every station a row touches, both directions, endpoints included. */
export function routeStations(row) {
  const out = new Set();
  for (const d of [0, 1]) {
    for (const field of [`origin_trip_${d}`, `destination_trip_${d}`]) {
      const name = (row?.[field] ?? "").trim();
      if (name) out.add(name);
    }
    for (const name of String(row?.[`via_${d}`] ?? "").split(" - ")) {
      const trimmed = name.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return out;
}

/** Operators credited with a row: whoever actually runs it. */
export function routeOperatorIds(row) {
  // bot_agency_id first: a synthetic row overwrites agency_id with the feed's
  // own operator ("ÖBB"), losing the joint operator Back-on-Track recorded
  // ("MÁV/ÖBB"). The map and the detail panel already resolve it this way.
  const ids = splitAgencyIds(row?.bot_agency_id || row?.agency_id);
  return ids.length ? ids : ["?"];
}

// ─── Freshness ──────────────────────────────────────────────────────────────

function hoursSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / MS_PER_HOUR));
}

function daysSince(dateish, now) {
  if (!dateish) return null;
  const t = Date.parse(dateish);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / MS_PER_DAY));
}

/**
 * 🟢 fresh / 🟡 aging / 🔴 stale / ⚫ never / ⚪ unknown — of the *fetch*.
 *
 * "never" and "unknown" are different claims and must not be collapsed:
 * `never` means nothing first-party feeds this at all, `unknown` means
 * something does but leaves no dated artifact we can read (an external-runner
 * step maintaining another source's bundle, say).
 */
export function feedFreshness(lastSuccessAt, now, { automated = true } = {}) {
  if (!automated) return "never";
  const hours = hoursSince(lastSuccessAt, now);
  if (hours === null) return "unknown";
  if (hours <= FEED_FRESH_HOURS) return "fresh";
  if (hours <= FEED_AGING_HOURS) return "aging";
  return "stale";
}

/** 🟢 / 🟡 / 🔴 — of the *content*, i.e. when the route last actually changed. */
export function contentFreshness(days) {
  if (days === null || days === undefined) return "unknown";
  if (days < CONTENT_AGING_DAYS) return "fresh";
  if (days < CONTENT_STALE_DAYS) return "aging";
  return "stale";
}

// ─── Rows ───────────────────────────────────────────────────────────────────

/**
 * One row per route on the map.
 *
 * @param {object}   args
 * @param {object}   args.viewMap       published viewMap (key → row)
 * @param {Array}    args.registry
 * @param {object}   [args.history]     route-history.json `routes` block
 * @param {object}   [args.sourceHealth] per-source health, see buildSourceStatus
 * @param {Date}     [args.now]
 */
export function buildRouteRows({
  viewMap,
  registry,
  history = {},
  sourceHealth = {},
  now = new Date(),
}) {
  const byId = Object.fromEntries((registry ?? []).map((e) => [e.id, e]));

  return Object.entries(viewMap ?? {})
    .map(([routeKey, row]) => {
      const sourceIds = resolveRouteSources(routeKey, row, registry);
      // The first official source is the one worth naming; otherwise whatever
      // produced the row (Back-on-Track, or a manual/curated source).
      const primarySourceId =
        sourceIds.find((id) => byId[id]?.official === true) ?? sourceIds[0];
      const primary = byId[primarySourceId] ?? null;
      const automated = sourceIds.some((id) => byId[id]?.official === true);

      const health = sourceHealth[primarySourceId] ?? null;
      const hist = history?.[routeKey] ?? null;
      const changedDays = daysSince(hist?.lastChanged ?? hist?.firstSeen, now);
      const stations = routeStations(row);

      return {
        routeKey,
        routeName:
          row?.route_long_name ||
          `${row?.origin_trip_0 ?? "?"} – ${row?.destination_trip_0 ?? "?"}`,
        trainNumbers: [row?.trip_short_name_0, row?.trip_short_name_1]
          .filter(Boolean)
          .map((n) => String(n).trim()),
        origin: row?.origin_trip_0 ?? null,
        destination: row?.destination_trip_0 ?? null,
        agencyId: row?.agency_id ?? null,
        botAgencyId: row?.bot_agency_id ?? null,
        operatorIds: routeOperatorIds(row),
        sourceIds,
        primarySourceId,
        sourceLabel: primary?.label ?? primarySourceId,
        sourceEndpoint: primary?.endpoint ?? null,
        sourceKind: primary?.kind ?? null,
        automated,
        official: automated,
        stationCount: stations.size,
        stations: [...stations],
        lastSuccessAt: health?.lastSuccessAt ?? null,
        lastFailureAt: health?.lastFailureAt ?? null,
        feedFreshness: feedFreshness(health?.lastSuccessAt, now, { automated }),
        firstSeen: hist?.firstSeen ?? null,
        lastSeen: hist?.lastSeen ?? null,
        lastChanged: hist?.lastChanged ?? null,
        daysSinceChange: changedDays,
        contentFreshness: contentFreshness(changedDays),
      };
    })
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey));
}

/**
 * Per-source freshness, merging what the scrape recorded with what the files
 * themselves say. The file timestamps are always there; source-health.json
 * only appears after the first nightly run that writes it, and adds the
 * failure side of the story.
 *
 * @param {object} args
 * @param {Array}  args.registry
 * @param {object} args.fileTimestamps  { [sourceId]: { uploadedAt, trainCount } }
 * @param {object} [args.health]        source-health.json `sources` block
 */
export function buildSourceStatus({
  registry,
  fileTimestamps = {},
  health = {},
  now = new Date(),
}) {
  const out = {};
  for (const entry of registry ?? []) {
    const file = fileTimestamps[entry.id] ?? null;
    const recorded = health?.[entry.id] ?? null;
    // Prefer the recorded success (it survives a night where nothing changed);
    // fall back to the artifact's own stamp so this works before the first run.
    const lastSuccessAt = recorded?.lastSuccessAt ?? file?.uploadedAt ?? null;
    out[entry.id] = {
      ...describeSource(entry),
      lastRunAt: recorded?.lastRunAt ?? null,
      lastSuccessAt,
      lastFailureAt: recorded?.lastFailureAt ?? null,
      lastError: recorded?.lastError ?? null,
      consecutiveFailures: recorded?.consecutiveFailures ?? 0,
      trainCount: recorded?.trainCount ?? file?.trainCount ?? null,
      hoursSinceSuccess: hoursSince(lastSuccessAt, now),
      freshness: feedFreshness(lastSuccessAt, now, { automated: true }),
    };
  }
  return out;
}

// ─── Priority ───────────────────────────────────────────────────────────────

const READINESS = { tested: 1.0, discovered: 0.6, none: 0.15 };
// Ease is allowed to exceed 1: a plain GTFS zip needs a registry entry and an
// allowlist, because scripts/adapters/gtfs-sleeper.mjs already reads that
// shape. Nine routes behind a ready adapter beat sixty behind a research task.
const EASE = { easy: 1.5, medium: 1.0, hard: 0.5, unknown: 0.9 };
const HIGH_BAND = 10;
const MEDIUM_BAND = 4;

const READINESS_LABEL = {
  tested: "source tested",
  discovered: "source found, untested",
  none: "no official source found",
};

function readinessOf(sources) {
  if (!sources?.length) return "none";
  if (sources.some((s) => s.status === "working" || s.status === "integrated"))
    return "tested";
  return "discovered";
}

function median(values) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

/**
 * How much better off would Pingwi be if this integration existed, and how
 * cheap is it? Deliberately a formula you can read in one line rather than a
 * model — every factor is surfaced in the UI so a surprising ranking can be
 * argued with.
 *
 * @param {object} operator  a row from buildOperatorRows (pre-priority fields)
 * @returns {{score:number, band:string, reason:string, factors:object}}
 */
export function scorePriority(operator) {
  const botRoutes = operator?.manualRouteCount ?? 0;
  const botStations = operator?.manualStationCount ?? 0;
  const readinessKey = readinessOf(operator?.officialSources);
  const difficulty = DIFFICULTIES.includes(operator?.difficulty)
    ? operator.difficulty
    : "unknown";
  const staleDays = operator?.medianDaysSinceChange;

  const impact = botRoutes + 0.1 * botStations;
  const readiness = READINESS[readinessKey];
  const ease = EASE[difficulty];
  const recency = 1 + 0.5 * Math.min((staleDays ?? 0) / 365, 1);

  const score = Math.round(impact * readiness * ease * recency * 10) / 10;
  const band =
    score >= HIGH_BAND ? "high" : score >= MEDIUM_BAND ? "medium" : "low";

  const parts = [
    `${botRoutes} route${botRoutes === 1 ? "" : "s"} on Back-on-Track`,
    `${botStations} station${botStations === 1 ? "" : "s"}`,
  ];
  if (staleDays !== null && staleDays !== undefined)
    parts.push(`unchanged ${staleDays}d`);
  parts.push(READINESS_LABEL[readinessKey]);
  parts.push(`${difficulty} to build`);

  // "Build next" means there is an integration to build. An operator already
  // running on its own feed with most routes covered has residue (a joint
  // service the feed omits, a postponed train), not a project — it still shows
  // in the table with its band, it just does not head the shortlist.
  const mostlyCovered =
    operator?.integrationStatus === "integrated" &&
    (operator?.routeCoveragePct ?? 0) >= 50;

  return {
    score,
    band,
    reason: parts.join(" · "),
    actionable: readinessKey !== "none" && botRoutes > 0 && !mostlyCovered,
    factors: {
      impact: Math.round(impact * 10) / 10,
      readiness,
      ease,
      recency: Math.round(recency * 100) / 100,
      readinessKey,
      difficulty,
    },
  };
}

// ─── Operators ──────────────────────────────────────────────────────────────

/**
 * One row per operator, joining what the payload proves against what the
 * catalogue claims.
 *
 * @param {object} args
 * @param {Array}  args.routeRows     from buildRouteRows
 * @param {Array}  args.registry
 * @param {object} args.catalog       data/sources/official-sources.json
 * @param {object} [args.agencies]    Back-on-Track agencies snapshot (.data)
 * @param {object} [args.sourceStatus] from buildSourceStatus
 */
export function buildOperatorRows({
  routeRows,
  registry,
  catalog,
  agencies = {},
  sourceStatus = {},
  now = new Date(),
}) {
  const byId = Object.fromEntries((registry ?? []).map((e) => [e.id, e]));
  const catalogOps = catalog?.operators ?? {};
  const buckets = new Map();

  for (const route of routeRows ?? []) {
    for (const opId of route.operatorIds) {
      if (!buckets.has(opId)) {
        buckets.set(opId, {
          routes: [],
          stations: new Set(),
          automatedStations: new Set(),
          sourceIds: new Map(),
        });
      }
      const bucket = buckets.get(opId);
      bucket.routes.push(route);
      for (const station of route.stations) {
        bucket.stations.add(station);
        if (route.automated) bucket.automatedStations.add(station);
      }
      for (const id of route.sourceIds) {
        bucket.sourceIds.set(id, (bucket.sourceIds.get(id) ?? 0) + 1);
      }
    }
  }

  const rows = [];
  for (const [id, bucket] of buckets) {
    const curated = catalogOps[id] ?? null;
    const agency = agencies?.[id] ?? null;
    const automatedRoutes = bucket.routes.filter((r) => r.automated);
    const manualRoutes = bucket.routes.filter((r) => !r.automated);

    // Concrete "current source" — what Pingwi reads today, with counts, so a
    // half-migrated operator reads as half-migrated instead of one label.
    const currentSources = [...bucket.sourceIds.entries()]
      .map(([sourceId, routeCount]) => ({
        ...(describeSource(byId[sourceId]) ?? {
          id: sourceId,
          label: sourceId,
          endpoint: null,
          official: false,
        }),
        routeCount,
        ...(sourceStatus[sourceId]
          ? {
              lastSuccessAt: sourceStatus[sourceId].lastSuccessAt,
              lastFailureAt: sourceStatus[sourceId].lastFailureAt,
              lastError: sourceStatus[sourceId].lastError,
              consecutiveFailures: sourceStatus[sourceId].consecutiveFailures,
              freshness: sourceStatus[sourceId].freshness,
            }
          : {}),
      }))
      .sort((a, b) => b.routeCount - a.routeCount);

    const officialCurrent = currentSources.filter((s) => s.official);
    const newestOf = (list) =>
      list
        .map((s) => s.lastSuccessAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    // Two different questions: "when did we last pull anything for this
    // operator" (the Last update column — a Back-on-Track-only operator still
    // has a real answer) and "when did an official feed last succeed", which is
    // what integration health actually turns on.
    const lastSuccessAt = newestOf(currentSources);
    const officialLastSuccessAt = newestOf(officialCurrent);
    const failing = officialCurrent.find(
      (s) => (s.consecutiveFailures ?? 0) > 0,
    );

    // Derived, never taken on trust from the catalogue: a found API is not a
    // running integration. Only the payload can prove data is flowing.
    let integrationStatus;
    let statusOrigin;
    if (automatedRoutes.length > 0) {
      const feed = feedFreshness(officialLastSuccessAt, now, {
        automated: true,
      });
      const disabled = officialCurrent.some((s) => s.enabled === false);
      integrationStatus =
        feed === "stale" || failing || disabled
          ? "needs-maintenance"
          : "integrated";
      statusOrigin = "derived";
    } else {
      integrationStatus = INTEGRATION_STATUSES.includes(
        curated?.integrationStatus,
      )
        ? curated.integrationStatus
        : "not-investigated";
      // The catalogue cannot award itself "integrated" — the payload just said
      // no route of this operator is on an official source.
      if (
        integrationStatus === "integrated" ||
        integrationStatus === "needs-maintenance"
      ) {
        integrationStatus = "in-progress";
      }
      statusOrigin = "curated";
    }

    const manualStations = new Set();
    for (const route of manualRoutes)
      for (const s of route.stations) manualStations.add(s);

    const base = {
      id,
      name:
        OPERATORS[id]?.name ||
        agency?.agency_name_romanized ||
        agency?.agency_name ||
        id,
      slug: OPERATORS[id]?.slug ?? null,
      website: curated?.website || agency?.agency_url || null,
      countries:
        curated?.countries ??
        (agency?.agency_state ? [agency.agency_state] : []),
      logoUrl: agency?.agency_logo_url || null,

      routeCount: bucket.routes.length,
      automatedRouteCount: automatedRoutes.length,
      manualRouteCount: manualRoutes.length,
      stationCount: bucket.stations.size,
      automatedStationCount: bucket.automatedStations.size,
      manualStationCount: manualStations.size,
      routeCoveragePct: bucket.routes.length
        ? Math.round((automatedRoutes.length / bucket.routes.length) * 100)
        : 0,
      stationCoveragePct: bucket.stations.size
        ? Math.round(
            (bucket.automatedStations.size / bucket.stations.size) * 100,
          )
        : 0,

      currentSources,
      officialSources: curated?.sources ?? [],
      integrationStatus,
      statusOrigin,
      difficulty: DIFFICULTIES.includes(curated?.difficulty)
        ? curated.difficulty
        : "unknown",
      notes: curated?.notes ?? null,
      inCatalog: Boolean(curated),

      lastSuccessAt,
      officialLastSuccessAt,
      lastFailureAt:
        officialCurrent
          .map((s) => s.lastFailureAt)
          .filter(Boolean)
          .sort()
          .pop() ?? null,
      lastError: failing?.lastError ?? null,
      feedFreshness: feedFreshness(officialLastSuccessAt, now, {
        automated: automatedRoutes.length > 0,
      }),
      medianDaysSinceChange: median(manualRoutes.map((r) => r.daysSinceChange)),

      manualRoutes: manualRoutes.map((r) => r.routeKey),
      routeKeys: bucket.routes.map((r) => r.routeKey),
    };

    rows.push({ ...base, priority: scorePriority(base) });
  }

  return rows.sort(
    (a, b) =>
      b.priority.score - a.priority.score ||
      b.manualRouteCount - a.manualRouteCount ||
      a.name.localeCompare(b.name),
  );
}

// ─── Headline numbers ───────────────────────────────────────────────────────

/**
 * The five numbers at the top of the dashboard, plus the one that matters:
 * the share of routes served by a first-party automated source.
 */
export function computeTotals(routeRows, operatorRows) {
  const totalRoutes = routeRows.length;
  const automatedRoutes = routeRows.filter((r) => r.automated).length;
  const backontrackRoutes = routeRows.filter(
    (r) => r.sourceIds.includes(BACKONTRACK_SOURCE_ID) && !r.automated,
  ).length;
  const otherManualRoutes = totalRoutes - automatedRoutes - backontrackRoutes;

  // "May be out of date": an automated feed that has gone quiet, or content
  // that has not moved in half a year.
  const staleRoutes = routeRows.filter(
    (r) => r.feedFreshness === "stale" || r.contentFreshness === "stale",
  ).length;

  // The approval index only started recording routes in June 2026, so early
  // on nothing can be "unchanged ≥180d" yet. Surfacing the oldest age next to
  // the count keeps a legitimate zero from reading as a broken tile.
  const oldestContentDays = routeRows.reduce(
    (max, r) =>
      Number.isFinite(r.daysSinceChange)
        ? Math.max(max, r.daysSinceChange)
        : max,
    0,
  );
  const highPriority = (operatorRows ?? []).filter(
    (o) => o.priority.band === "high",
  ).length;
  const operatorsOnBackontrack = (operatorRows ?? []).filter(
    (o) => o.manualRouteCount > 0,
  ).length;

  return {
    totalRoutes,
    automatedRoutes,
    backontrackRoutes,
    otherManualRoutes,
    automatedPct: totalRoutes
      ? Math.round((automatedRoutes / totalRoutes) * 100)
      : 0,
    staleRoutes,
    oldestContentDays,
    highPriority,
    operatorCount: (operatorRows ?? []).length,
    operatorsOnBackontrack,
  };
}

/** Top integrations to build next — only ones that actually have a source. */
export function nextIntegrations(operatorRows, limit = 5) {
  return (operatorRows ?? [])
    .filter((o) => o.priority.actionable)
    .slice(0, limit);
}

/**
 * Operators carrying Back-on-Track routes with no official source found at
 * all — real exposure, nothing to build against. Distinct from "not on the
 * shortlist": an operator already running on its own feed is left out of the
 * top five because the work is done, not because it is blocked.
 */
export function blockedOperators(operatorRows) {
  return (operatorRows ?? [])
    .filter(
      (o) =>
        o.manualRouteCount > 0 && o.priority.factors.readinessKey === "none",
    )
    .sort((a, b) => b.manualRouteCount - a.manualRouteCount);
}
