// tests/verify-seo-urls.mjs
// Guards the URL layer that the pingwi.com migration rests on. Run: npm run verify-seo-urls
//
// This layer had essentially no coverage before: nothing asserted a slug, a
// canonical, or that the redirect map pointed anywhere real. The expensive
// failure mode is silent — a redirect to a URL the build doesn't emit is a 301
// into a 404, which burns crawl budget and loses the page.

import fs from "node:fs";

import { slugify, buildPairSlug, orderCityPair } from "../src/lib/seo/slugify.mjs";
import { buildRouteSlugMaps } from "../src/lib/seo/routeSlugs.mjs";
import { cityForStation, stationsMissingCityOverride } from "../src/lib/seo/cities.mjs";
import { pairSlugForRoute, flattenRedirects } from "../scripts/build-seo-redirects.mjs";

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const published = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/published/initial-data.json", import.meta.url),
    "utf8",
  ),
);
const viewMap = published.data.viewMap;
const routes = Object.values(viewMap);
const redirects = JSON.parse(
  fs.readFileSync(new URL("../data/seo/redirects.json", import.meta.url), "utf8"),
);

// ── slugify: characters with no NFD decomposition ──────────────────────────
{
  check(slugify("Bodø") === "bodo", `slugify("Bodø") = ${slugify("Bodø")}, want "bodo"`);
  check(slugify("Xi'an") === "xian", `slugify("Xi'an") = ${slugify("Xi'an")}, want "xian"`);
  check(slugify("Straße") === "strasse", `slugify("Straße") = ${slugify("Straße")}`);
  check(slugify("Ærø") === "aero", `slugify("Ærø") = ${slugify("Ærø")}`);
  check(slugify("Kraków") === "krakow", `slugify("Kraków") = ${slugify("Kraków")}`);
  check(slugify("Przemyśl") === "przemysl", `slugify("Przemyśl") = ${slugify("Przemyśl")}`);
  // No slug may contain anything that needs URL-escaping.
  check(/^[a-z0-9-]*$/.test(slugify("Ústí nad Labem hl.n.")), "slugify leaked a non-URL char");
}

// ── city pairs are undirected: both orders produce one canonical slug ───────
{
  check(
    buildPairSlug("Vienna", "Paris") === buildPairSlug("Paris", "Vienna"),
    "buildPairSlug is direction-dependent — the two directions would be separate pages",
  );
  check(buildPairSlug("Vienna", "Paris") === "paris-to-vienna", "unexpected canonical order");
  const [a, b] = orderCityPair("Vienna", "Paris");
  check(a === "Paris" && b === "Vienna", "orderCityPair disagrees with buildPairSlug");
}

// ── the migration plan's own before/after examples ──────────────────────────
{
  const cases = [
    [["Praha hl.n.", "Bruxelles Midi / Brussel Zuid"], "brussels-to-prague"],
    [["Przemyśl Gł.", "Frankfurt (Main) Flughafen Fernbahnhof"], "frankfurt-to-przemysl"],
    [["Przemyśl Gł.", "Frankfurt (Main) Süd"], "frankfurt-to-przemysl"],
    [["Messina Centrale", "Palermo Centrale"], "messina-to-palermo"],
    [["Salerno", "Torino Porta Nuova"], "salerno-to-turin"],
  ];
  for (const [[from, to], want] of cases) {
    const got = buildPairSlug(cityForStation(from), cityForStation(to));
    check(got === want, `"${from}" + "${to}" → ${got}, want ${want}`);
  }
}

// ── every route has a connection page ──────────────────────────────────────
const validPairSlugs = new Set();
{
  let orphans = 0;
  for (const route of routes) {
    const slug = pairSlugForRoute(route);
    if (!slug) {
      orphans += 1;
      continue;
    }
    validPairSlugs.add(slug);
  }
  check(
    orphans === 0,
    `${orphans} route(s) resolve to no /connections/ page — retiring /trains/ would strand them`,
  );
  check(validPairSlugs.size > 0, "no connection slugs resolved at all");
}

// ── legacy per-train slugs are unique and stable ───────────────────────────
{
  const { byRouteId, bySlug } = buildRouteSlugMaps(viewMap);
  check(
    byRouteId.size === bySlug.size,
    `train slug collision: ${byRouteId.size} routes → ${bySlug.size} slugs`,
  );
  // Rebuilding must be deterministic, or nightly runs would churn the redirect map.
  const again = buildRouteSlugMaps(viewMap);
  check(
    [...byRouteId.entries()].every(([id, s]) => again.byRouteId.get(id) === s),
    "buildRouteSlugMaps is not deterministic across runs",
  );
}

// ── the redirect map ───────────────────────────────────────────────────────
{
  const sources = new Set(Object.keys(redirects));

  // No chains. Old URL → final destination in ONE hop; a chain wastes the crawl
  // budget this whole migration exists to conserve.
  const chained = Object.entries(redirects).filter(([, d]) => sources.has(d));
  check(
    chained.length === 0,
    `${chained.length} redirect chain(s), e.g. ${chained
      .slice(0, 3)
      .map(([s, d]) => `${s} → ${d} → ${redirects[d]}`)
      .join("; ")}`,
  );

  // flattenRedirects must be a no-op on an already-flat map, and must report no cycles.
  const { flattened, cycles } = flattenRedirects(redirects);
  check(cycles.length === 0, `redirect cycle(s): ${cycles.join(", ")}`);
  check(
    Object.entries(flattened).every(([s, d]) => redirects[s] === d),
    "committed redirects.json is not flattened — re-run npm run build-redirects",
  );

  // Every destination must be a page the build actually emits.
  const emitted = new Set(["/connections", "/", "/about", "/privacy"]);
  for (const s of validPairSlugs) emitted.add(`/connections/${s}`);
  const dangling = Object.entries(redirects).filter(([, d]) => !emitted.has(d));
  check(
    dangling.length === 0,
    `${dangling.length} redirect(s) point at a URL the build does not emit, e.g. ${dangling
      .slice(0, 5)
      .map(([s, d]) => `${s} → ${d}`)
      .join("; ")}`,
  );

  // A source must never also be a live page.
  const selfRedirect = Object.keys(redirects).filter((s) => emitted.has(s));
  check(
    selfRedirect.length === 0,
    `${selfRedirect.length} URL(s) are both a live page and a redirect source: ${selfRedirect
      .slice(0, 5)
      .join(", ")}`,
  );

  // Every retired per-train URL must be covered.
  const { bySlug } = buildRouteSlugMaps(viewMap);
  const missing = [...bySlug.keys()].filter((s) => !sources.has(`/trains/${s}`));
  check(
    missing.length === 0,
    `${missing.length} /trains/ URL(s) missing from the redirect map — run npm run build-redirects`,
  );
}

// ── report-only: endpoints with no explicit city override ──────────────────
// A nightly scrape can add a route between reviews. The fallback handles it, but
// the name is worth a human look — so this reports and never fails CI.
{
  const endpoints = new Set();
  for (const r of routes) {
    for (const d of [0, 1]) {
      if (r[`origin_trip_${d}`]) endpoints.add(r[`origin_trip_${d}`]);
      if (r[`destination_trip_${d}`]) endpoints.add(r[`destination_trip_${d}`]);
    }
  }
  const missing = stationsMissingCityOverride([...endpoints]);
  if (missing.length) {
    console.log(
      `\nℹ ${missing.length} endpoint(s) fall back to the generic city rule — ` +
        `add them to data/overrides/station-cities.json if the guess is wrong:`,
    );
    for (const m of missing) console.log(`    ${m.padEnd(40)} → ${cityForStation(m)}`);
  }
}

if (problems.length) {
  console.error(`\n✗ verify-seo-urls: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `\n✓ verify-seo-urls: ${routes.length} routes → ${validPairSlugs.size} connection pages, ` +
    `${Object.keys(redirects).length} redirects, no chains`,
);
