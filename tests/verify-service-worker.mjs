#!/usr/bin/env node
/**
 * Validates the routing predicates in public/sw.js. Run:
 *   node tests/verify-service-worker.mjs
 *
 * The service worker is a browser global script, so it is evaluated here in a
 * vm context with `self` stubbed — the file that ships is the file under test.
 *
 * It exists because the bug it now pins was invisible: `isNeverCache` matched
 * `startsWith("/data")` to keep the loopback-only /data admin page out of the
 * cache, and thereby also excluded /data/gtfs/pkpTrainShapes.json — the single
 * largest asset the map downloads was the one thing never cached, and nothing
 * about that was observable short of watching the network panel on a reload.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let failures = 0;
function fail(msg) {
  console.error("FAIL:", msg);
  failures += 1;
}
function ok(msg) {
  console.log("  ✓", msg);
}
function expect(actual, wanted, what) {
  if (actual === wanted) return true;
  fail(`${what}: got ${actual}, want ${wanted}`);
  return false;
}

// ─── Load sw.js with just enough of a worker global to evaluate ─────────────

const source = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
const listeners = {};
const sandbox = {
  self: {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    location: { origin: "https://pingwi.com" },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  },
  caches: { open: async () => ({}), keys: async () => [], match: async () => undefined },
  fetch: async () => ({ ok: true }),
  console,
  Date,
  URL,
  Promise,
  Number,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

// Function declarations land on the sandbox object; `const` bindings do not,
// so those are read back by evaluating the identifier in the same context.
const { isNeverCache, isDataPayload, isStaticAsset, isFresh } = sandbox;
const CACHE_VERSION = vm.runInContext("CACHE_VERSION", sandbox);
const MAX_STALE_MS = vm.runInContext("MAX_STALE_MS", sandbox);

for (const [name, fn] of Object.entries({ isNeverCache, isDataPayload, isStaticAsset, isFresh })) {
  if (typeof fn !== "function") fail(`sw.js no longer defines ${name}()`);
}
if (failures > 0) process.exit(1);

const url = (p) => new URL(p, "https://pingwi.com");

// ─── 1. The admin page, and only the admin page ─────────────────────────────
console.log("1) never-cache paths");

for (const p of ["/data", "/api/admin/override", "/api/suggest", "/api/admin/proposals/1"]) {
  expect(isNeverCache(url(p)), true, `${p} must never be cached`);
}
if (!isNeverCache(url("/api/admin/proposals"))) fail("proposals paths must never be cached");
ok("admin, suggest and proposals paths excluded");

// The regression: everything *under* /data is data, not the admin page.
for (const p of [
  "/data/gtfs/pkpTrainShapes.json",
  "/data/gtfs/rjChopTimetable.json",
  "/data/rjChopPolyline.json",
  "/data/enHumennePolyline.json",
]) {
  expect(isNeverCache(url(p)), false, `${p} must be cacheable`);
}
ok("the GTFS bundles and static polylines are cacheable");

// ─── 2. Data payloads get the stale-while-revalidate path ───────────────────
console.log("2) data payloads");

for (const p of [
  "/api/initial-data",
  "/api/route-geometry",
  "/api/osm-relation?relationId=18616102&v=2",
  "/api/trains?type=agencies",
  "/data/gtfs/pkpTrainShapes.json",
  "/data/zemplinPolyline.json",
]) {
  expect(isDataPayload(url(p)), true, `${p} should be a data payload`);
}
ok("every request the map makes for its own data is covered");

for (const p of ["/", "/connections/berlin-to-paris", "/_next/static/chunks/main.js", "/data"]) {
  expect(isDataPayload(url(p)), false, `${p} should not be a data payload`);
}
ok("pages and static chunks are left to their own strategies");

// ─── 3. Static assets stay cache-first ──────────────────────────────────────
console.log("3) static assets");

for (const p of ["/_next/static/chunks/main.js", "/icons/icon-192.png", "/leaflet/images/marker.png", "/favicon.ico"]) {
  expect(isStaticAsset(url(p)), true, `${p} should be a static asset`);
}
// A data payload must not also match the cache-first branch, or it would be
// pinned to the first copy ever fetched and never refresh.
for (const p of ["/api/initial-data", "/data/gtfs/pkpTrainShapes.json"]) {
  expect(isStaticAsset(url(p)), false, `${p} must not be treated as immutable`);
}
ok("content-hashed assets cache-first, data payloads never");

// ─── 4. Staleness ceiling ───────────────────────────────────────────────────
console.log("4) freshness");

const withDate = (d) => ({ headers: { get: (k) => (k === "date" ? d : null) } });
expect(isFresh(withDate(new Date().toUTCString())), true, "a response from now is fresh");
expect(
  isFresh(withDate(new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString())),
  true,
  "a two-hour-old response is fresh",
);
expect(
  isFresh(withDate(new Date(Date.now() - 25 * 60 * 60 * 1000).toUTCString())),
  false,
  "a response older than the nightly scrape is stale",
);
expect(isFresh(withDate("not a date")), false, "an unparseable date is not fresh");
expect(isFresh(withDate(null)), false, "a missing date header is not fresh");
expect(isFresh(undefined), false, "no response at all is not fresh");
ok("bounded by the nightly scrape cycle, and safe on a missing header");

// ─── 5. The cache version moved with the strategy ───────────────────────────
console.log("5) constants");

if (typeof CACHE_VERSION !== "string" || !CACHE_VERSION) {
  fail("CACHE_VERSION is not a string — the read-back below is what makes this check real");
} else if (CACHE_VERSION === "train-map-v1") {
  fail("CACHE_VERSION must change when the caching strategy does, or returning visitors keep v1 entries");
} else {
  ok(`cache version is ${CACHE_VERSION}`);
}

// The ceiling is what stops a returning visitor being pinned to an old *shape*
// of a file after a deploy that changes one; an unbounded value would.
if (!(Number.isFinite(MAX_STALE_MS) && MAX_STALE_MS > 0 && MAX_STALE_MS <= 24 * 60 * 60 * 1000)) {
  fail(`MAX_STALE_MS should be a positive value no longer than a day, got ${MAX_STALE_MS}`);
} else {
  ok(`stale ceiling is ${MAX_STALE_MS / 3600000}h`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll service worker checks passed.");
