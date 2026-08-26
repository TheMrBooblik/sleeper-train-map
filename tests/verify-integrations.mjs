// tests/verify-integrations.mjs
// Covers the integration dashboard: route→source resolution, the priority
// formula, the headline totals against the real committed payload, the shape
// of the research catalogue, and the admin write path for it.
// Run: npm run verify-integrations

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKONTRACK_SOURCE_ID,
  DIFFICULTIES,
  INTEGRATION_STATUSES,
  SOURCE_STATUSES,
  buildOperatorRows,
  buildRouteRows,
  buildSourceStatus,
  blockedOperators,
  computeTotals,
  contentFreshness,
  feedFreshness,
  nextIntegrations,
  resolveRouteSources,
  routeOperatorIds,
  routeStations,
  scorePriority,
} from "../src/lib/integrations/model.mjs";
import { applyOverrideMutation, OVERRIDE_FILES } from "../src/pages/api/lib/overrides-mutate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const problems = [];
let checks = 0;
function check(label, condition) {
  checks++;
  if (condition) console.log(`  ✓ ${label}`);
  else problems.push(label);
}

// ─── resolveRouteSources ────────────────────────────────────────────────────

const REGISTRY_FIXTURE = [
  { id: "backontrack", kind: "backontrack", enabled: true, official: false },
  { id: "nightjet", enabled: true, official: true, synthetic: { idPrefix: "nj_standalone_" } },
  { id: "nj-short", enabled: true, official: true, synthetic: { idPrefix: "nj_" } },
  { id: "pkp-gtfs", enabled: true, official: true },
];

check(
  "a plain numeric key resolves to Back-on-Track",
  resolveRouteSources("37", {}, REGISTRY_FIXTURE).join() === BACKONTRACK_SOURCE_ID,
);
check(
  "the longest synthetic prefix wins (nj_standalone_ over nj_)",
  resolveRouteSources("nj_standalone_NJ_493", {}, REGISTRY_FIXTURE).join() === "nightjet",
);
check(
  "a shorter prefix still matches its own keys",
  resolveRouteSources("nj_401", {}, REGISTRY_FIXTURE).join() === "nj-short",
);
check(
  "official_sources outranks the key prefix",
  resolveRouteSources("nj_standalone_NJ_493", { official_sources: ["pkp-gtfs"] }, REGISTRY_FIXTURE).join() ===
    "pkp-gtfs",
);
check(
  "an official_sources id absent from the registry is ignored",
  resolveRouteSources("37", { official_sources: ["ghost"] }, REGISTRY_FIXTURE).join() ===
    BACKONTRACK_SOURCE_ID,
);
check(
  "resolveRouteSources never returns empty",
  resolveRouteSources("x", {}, []).length === 1,
);

// ─── Row helpers ────────────────────────────────────────────────────────────

check(
  "routeStations collects endpoints and via, both directions, deduped",
  [
    ...routeStations({
      origin_trip_0: "A",
      destination_trip_0: "C",
      via_0: "B",
      origin_trip_1: "C",
      destination_trip_1: "A",
      via_1: "B",
    }),
  ].sort().join() === "A,B,C",
);
check(
  "routeOperatorIds prefers bot_agency_id (who runs it) over the feed's agency_id",
  routeOperatorIds({ agency_id: "ÖBB", bot_agency_id: "MÁV/ÖBB" }).join() === "MÁV,ÖBB",
);
check(
  "routeOperatorIds falls back to agency_id",
  routeOperatorIds({ agency_id: "PKP/ČD" }).join() === "PKP,ČD",
);

// ─── Freshness ──────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-26T12:00:00Z");
check(
  "a fetch inside 25h is fresh",
  feedFreshness("2026-08-26T03:00:00Z", NOW) === "fresh",
);
check("a fetch at 30h is aging", feedFreshness("2026-08-25T06:00:00Z", NOW) === "aging");
check("a fetch at 60h is stale", feedFreshness("2026-08-24T00:00:00Z", NOW) === "stale");
check(
  "a route on no first-party source is 'never', not 'stale'",
  feedFreshness("2026-08-26T03:00:00Z", NOW, { automated: false }) === "never",
);
check(
  "an automated source with no timestamp is 'unknown', not 'never'",
  feedFreshness(null, NOW, { automated: true }) === "unknown",
);
check("content unchanged 200 days is stale", contentFreshness(200) === "stale");
check("content with no history is unknown", contentFreshness(null) === "unknown");

// ─── Priority ───────────────────────────────────────────────────────────────

const discovered = [{ status: "discovered" }];
const tested = [{ status: "working" }];

const base = { manualRouteCount: 10, manualStationCount: 40, medianDaysSinceChange: 0 };
const easyTested = scorePriority({ ...base, officialSources: tested, difficulty: "easy" });
const easyDiscovered = scorePriority({ ...base, officialSources: discovered, difficulty: "easy" });
const hardDiscovered = scorePriority({ ...base, officialSources: discovered, difficulty: "hard" });
const noSource = scorePriority({ ...base, officialSources: [], difficulty: "easy" });

check("a tested source outranks an untested one", easyTested.score > easyDiscovered.score);
check("an easy build outranks a hard one", easyDiscovered.score > hardDiscovered.score);
check("no known source ranks below a found one", noSource.score < hardDiscovered.score);
check(
  "more routes means a higher score",
  scorePriority({ ...base, manualRouteCount: 40, officialSources: discovered, difficulty: "easy" }).score >
    easyDiscovered.score,
);
check(
  "stale content lifts the score",
  scorePriority({ ...base, officialSources: discovered, difficulty: "easy", medianDaysSinceChange: 400 })
    .score > easyDiscovered.score,
);
check("high scores land in the high band", easyTested.band === "high");
check(
  "an operator with nothing on Back-on-Track scores zero",
  scorePriority({ manualRouteCount: 0, manualStationCount: 0, officialSources: tested, difficulty: "easy" })
    .score === 0,
);
check(
  "the reason names the routes, the readiness and the difficulty",
  /10 routes on Back-on-Track/.test(easyDiscovered.reason) &&
    /source found, untested/.test(easyDiscovered.reason) &&
    /easy to build/.test(easyDiscovered.reason),
);
check(
  "an operator with no source is never on the build-next shortlist",
  noSource.actionable === false,
);
check(
  "an operator already integrated and mostly covered drops off the shortlist",
  scorePriority({
    ...base,
    officialSources: tested,
    difficulty: "easy",
    integrationStatus: "integrated",
    routeCoveragePct: 90,
  }).actionable === false,
);
check(
  "an integrated operator still mostly on Back-on-Track stays on the shortlist",
  scorePriority({
    ...base,
    officialSources: tested,
    difficulty: "easy",
    integrationStatus: "integrated",
    routeCoveragePct: 30,
  }).actionable === true,
);

// ─── Against the real committed payload ─────────────────────────────────────

const registry = readJson("data/sources/registry.json");
const catalog = readJson("data/sources/official-sources.json");
const published = readJson("public/data/published/initial-data.json");
const agencies = readJson("public/data/scraped/backontrack-agencies.json").data;
let history = {};
try {
  history = readJson("public/data/published/route-history.json").routes;
} catch {
  problems.push("public/data/published/route-history.json missing — run `npm run canonicalize`");
}

const fileTimestamps = {};
for (const entry of registry) {
  const file = entry.output ?? entry.outputs?.[0] ?? null;
  if (!file) continue;
  try {
    const raw = readJson(`public/data/scraped/${file}`);
    fileTimestamps[entry.id] = {
      uploadedAt: raw.uploadedAt,
      trainCount: Object.keys(raw?.data?.trains ?? {}).length || null,
    };
  } catch {
    /* a source that has never run yet is fine */
  }
}

const sourceStatus = buildSourceStatus({ registry, fileTimestamps });
const routeRows = buildRouteRows({
  viewMap: published.data.viewMap,
  registry,
  history,
  sourceHealth: sourceStatus,
});
const operatorRows = buildOperatorRows({ routeRows, registry, catalog, agencies, sourceStatus });
const totals = computeTotals(routeRows, operatorRows);

check(
  "every published route is accounted for",
  routeRows.length === Object.keys(published.data.viewMap).length,
);
check(
  "automated + Back-on-Track + other manual sums to the total",
  totals.automatedRoutes + totals.backontrackRoutes + totals.otherManualRoutes === totals.totalRoutes,
);
check(
  "the automated percentage matches its own numerator",
  totals.automatedPct === Math.round((totals.automatedRoutes / totals.totalRoutes) * 100),
);
check("at least a third of routes are first-party automated", totals.automatedPct >= 33);
check("some routes still depend on Back-on-Track (or this tool is done)", totals.backontrackRoutes >= 0);
check("every operator has at least one route", operatorRows.every((o) => o.routeCount > 0));
check(
  "coverage never exceeds the route count",
  operatorRows.every((o) => o.automatedRouteCount <= o.routeCount && o.routeCoveragePct <= 100),
);
check(
  "operators are sorted by priority, highest first",
  operatorRows.every((o, i) => i === 0 || operatorRows[i - 1].priority.score >= o.priority.score),
);
check("the build-next shortlist holds at most five", nextIntegrations(operatorRows).length <= 5);
check(
  "every shortlisted operator has a concrete official URL to open",
  nextIntegrations(operatorRows).every((o) => /^https?:\/\//.test(o.officialSources[0]?.url ?? "")),
);
check(
  "blocked operators genuinely have no source",
  blockedOperators(operatorRows).every((o) => (o.officialSources ?? []).length === 0),
);
check(
  "an operator is never reported as integrated while none of its routes is automated",
  operatorRows.every((o) => o.integrationStatus !== "integrated" || o.automatedRouteCount > 0),
);
check(
  "derived status wins wherever official data is actually flowing",
  operatorRows.every((o) => o.automatedRouteCount === 0 || o.statusOrigin === "derived"),
);

// ─── The catalogue itself ───────────────────────────────────────────────────

const liveOperatorIds = new Set(operatorRows.map((o) => o.id));
const PLACEHOLDER = /(example\.(com|org)|operator\.com|your-|TODO|CHANGEME)/i;

for (const [id, entry] of Object.entries(catalog.operators ?? {})) {
  const tag = `catalogue[${id}]`;
  if (!liveOperatorIds.has(id)) {
    problems.push(`${tag} is not a live operator on the map`);
  }
  if (!INTEGRATION_STATUSES.includes(entry.integrationStatus)) {
    problems.push(`${tag} unknown integrationStatus "${entry.integrationStatus}"`);
  }
  if (!DIFFICULTIES.includes(entry.difficulty)) {
    problems.push(`${tag} unknown difficulty "${entry.difficulty}"`);
  }
  if (!Array.isArray(entry.sources)) {
    problems.push(`${tag} sources must be an array`);
    continue;
  }
  if (!entry.sources.length && !entry.notes) {
    problems.push(`${tag} has no sources and no note explaining what was checked`);
  }
  for (const [i, source] of entry.sources.entries()) {
    const stag = `${tag}.sources[${i}]`;
    if (!source.name) problems.push(`${stag} needs a name`);
    if (!SOURCE_STATUSES.includes(source.status)) {
      problems.push(`${stag} unknown status "${source.status}"`);
    }
    // The whole point of the catalogue: a concrete address you can open, not
    // a category like "official GTFS".
    if (!/^https?:\/\/\S+$/.test(source.url ?? "")) {
      problems.push(`${stag} needs an absolute URL, got "${source.url}"`);
    } else if (PLACEHOLDER.test(source.url)) {
      problems.push(`${stag} looks like a placeholder URL: ${source.url}`);
    }
    if (source.docsUrl && !/^https?:\/\/\S+$/.test(source.docsUrl)) {
      problems.push(`${stag} docsUrl must be absolute, got "${source.docsUrl}"`);
    }
    if (source.probeWorkflow && !fs.existsSync(path.join(ROOT, ".github/workflows", source.probeWorkflow))) {
      problems.push(`${stag} probeWorkflow not found: ${source.probeWorkflow}`);
    }
  }
}
check(
  "every operator still on Back-on-Track has a catalogue entry",
  operatorRows.filter((o) => o.manualRouteCount > 0).every((o) => Boolean(catalog.operators?.[o.id])),
);
check(
  "every live operator has a website recorded",
  operatorRows.every((o) => Boolean(o.website)),
);

// ─── The admin write path ───────────────────────────────────────────────────

check(
  "official-sources is an admin-writable resource",
  OVERRIDE_FILES["official-sources"] === "data/sources/official-sources.json",
);

const seed = { v: 1, operators: {} };
const added = applyOverrideMutation(
  "official-sources",
  "setSource",
  {
    agencyId: "TEST",
    source: { name: "Feed", url: "https://example.test/gtfs.zip", format: "GTFS", status: "discovered" },
  },
  seed,
);
check("setSource appends a source", added.operators.TEST.sources.length === 1);
check("setSource is not a mutation of the input", (seed.operators.TEST ?? null) === null);

const edited = applyOverrideMutation(
  "official-sources",
  "setOperator",
  { agencyId: "TEST", operator: { integrationStatus: "source-tested", difficulty: "easy", notes: "hi" } },
  added,
);
check(
  "setOperator keeps the sources under it",
  edited.operators.TEST.sources.length === 1 && edited.operators.TEST.integrationStatus === "source-tested",
);

const removed = applyOverrideMutation("official-sources", "removeSource", { agencyId: "TEST", index: 0 }, edited);
check("removeSource drops it", removed.operators.TEST.sources.length === 0);

function rejects(label, action, payload, current) {
  checks++;
  try {
    applyOverrideMutation("official-sources", action, payload, current);
    problems.push(`accepted invalid input: ${label}`);
  } catch (err) {
    if (err.code === "INVALID_OVERRIDE") console.log(`  ✓ rejects ${label}`);
    else problems.push(`wrong error for ${label}: ${err.message}`);
  }
}
rejects("a source with no url", "setSource", { agencyId: "TEST", source: { name: "x" } }, added);
rejects(
  "an unknown source status",
  "setSource",
  { agencyId: "TEST", source: { name: "x", url: "https://a.test", status: "maybe" } },
  added,
);
rejects(
  "an unknown integrationStatus",
  "setOperator",
  { agencyId: "TEST", operator: { integrationStatus: "shipped" } },
  added,
);
rejects("an out-of-range source index", "removeSource", { agencyId: "TEST", index: 9 }, added);
rejects("an unknown action", "explode", { agencyId: "TEST" }, added);

// ─── Result ─────────────────────────────────────────────────────────────────

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\nverify-integrations: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(
  `\n[verify-integrations] ${checks} checks passed — ` +
    `${totals.totalRoutes} routes, ${totals.automatedRoutes} first-party (${totals.automatedPct}%), ` +
    `${totals.backontrackRoutes} on Back-on-Track across ${totals.operatorsOnBackontrack} operators`,
);
