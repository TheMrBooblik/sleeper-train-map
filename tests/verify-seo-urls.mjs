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
import { lastmodFor, CONTENT_VERSION_DATE } from "../src/lib/seo/lastmod.mjs";

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

// ── sitemap lastmod ────────────────────────────────────────────────────────
// Every URL used to carry the payload's generation timestamp, so each nightly
// scrape claimed the whole site had changed. lastmod is now per-URL, and the two
// ways to get it wrong are: a date in the future (crawlers discard the file),
// and going back to one value for everything.
{
  const FALLBACK = "2026-09-10T16:15:16.757Z";
  const floor = "2026-06-01";

  check(
    lastmodFor("2026-09-08", FALLBACK, floor) === "2026-09-08",
    "a route's own change date wins when it is newer than the floor",
  );
  check(
    lastmodFor("2026-01-15", FALLBACK, floor) === floor,
    "a route older than the template floor is lifted to it, not left in January",
  );
  check(
    lastmodFor("", FALLBACK, floor) === FALLBACK,
    "a URL with no history at all keeps the payload date — better than no lastmod",
  );
  for (const junk of [null, undefined, "yesterday", "2026-9-8", 20260908, "2026-09-08T00:00:00Z"]) {
    check(
      lastmodFor(junk, FALLBACK, floor) === FALLBACK,
      `malformed lastChanged (${JSON.stringify(junk)}) must fall back, not reach the sitemap`,
    );
  }

  check(
    /^\d{4}-\d{2}-\d{2}$/.test(CONTENT_VERSION_DATE),
    `CONTENT_VERSION_DATE must be a W3C date, got ${CONTENT_VERSION_DATE}`,
  );
  check(
    CONTENT_VERSION_DATE <= new Date().toISOString().slice(0, 10),
    `CONTENT_VERSION_DATE ${CONTENT_VERSION_DATE} is in the future — crawlers discard a sitemap that claims that`,
  );

  // The point of the change: the committed history really does spread the
  // routes out, so per-URL lastmod is a signal and not 297 copies of one date.
  const history = JSON.parse(
    fs.readFileSync(
      new URL("../public/data/published/route-history.json", import.meta.url),
      "utf8",
    ),
  ).routes;
  const dates = new Set(
    Object.values(history)
      .map((h) => h.lastChanged)
      .filter(Boolean),
  );
  check(
    dates.size > 1,
    `route-history.json has ${dates.size} distinct lastChanged value(s) — per-URL lastmod would be pointless`,
  );
  const today = new Date().toISOString().slice(0, 10);
  const future = [...dates].filter((d) => d > today);
  check(future.length === 0, `route-history.json has future lastChanged dates: ${future.join(", ")}`);
}

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
  //
  // Connection pages are settled here: validPairSlugs IS the emitted set. Hub
  // pages are not — getStationMap() nests a city under its endpoint's country
  // and gates on MIN_ROUTES_PER_STATION, and neither the country table nor the
  // stop→country index loads in raw node (extensionless imports, and the
  // published stops carry no country). So a hub destination is checked for the
  // part this file can settle: the city segment must be spelled the way the
  // build spells it. That it also clears the route threshold is asserted
  // end-to-end against a live server in tests/seo-redirects.spec.js, which
  // fetches every non-connection destination.
  const emitted = new Set(["/connections", "/", "/about", "/privacy"]);
  for (const s of validPairSlugs) emitted.add(`/connections/${s}`);

  const citySlugs = new Set();
  for (const r of routes) {
    for (const f of ["origin_trip_0", "destination_trip_0", "origin_trip_1", "destination_trip_1"]) {
      const city = cityForStation(r[f] || "");
      if (city) citySlugs.add(slugify(city));
    }
  }
  const HUB = /^\/night-trains\/[a-z0-9-]+(?:\/from\/([a-z0-9-]+))?$/;

  const dangling = Object.entries(redirects).filter(([, d]) => {
    if (emitted.has(d)) return false;
    const hub = HUB.exec(d);
    // A country hub (no /from/) is emitted for every country with routes; a city
    // hub must name a city some endpoint resolves to.
    if (hub) return hub[1] ? !citySlugs.has(hub[1]) : false;
    return true;
  });
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

// ── one route, one connection page ─────────────────────────────────────────
// getPairMap() indexes a route under EVERY direction's city pair, so a row whose
// two directions resolve to different cities emits two pages with identical
// content — and buildSummary's pairSlug (the canonical) names only one of them,
// leaving the other an orphan duplicate. European Sleeper's Berlin–Paris row was
// exactly that: ES 474 arrives at Paris Gare du Nord and ES 475 departs from
// Mitry-Claye while Gare du Nord is under works, so the corridor had a
// /connections/berlin-to-mitry-claye twin nobody would ever search for.
{
  for (const r of routes) {
    const slugs = new Set();
    for (const d of [0, 1]) {
      const o = r[`origin_trip_${d}`];
      const x = r[`destination_trip_${d}`];
      if (!o || !x) continue;
      const a = cityForStation(o);
      const b = cityForStation(x);
      if (!a || !b || a === b) continue;
      slugs.add(buildPairSlug(a, b));
    }
    check(
      slugs.size <= 1,
      `route ${r.route_id} emits ${slugs.size} connection pages ([...slugs] = ${[...slugs].join(", ")}); ` +
        `its two directions resolve to different cities — add the odd endpoint to station-cities.json`,
    );
  }
}

// ── the missing-city reporter must see an unrecognised qualifier ────────────
// Its original rule only reported a name the fallback had CHANGED, which made it
// blind to the shape that actually costs pages: a qualifier the fallback does not
// know, so the name is left alone and quietly becomes its own city. "Hamburg
// Altona" and "Milano Certosa" sat in the payload unreported for months with
// "Hamburg Harburg" and "Milano Centrale" already one line away in the table.
{
  const reported = new Set(
    stationsMissingCityOverride([
      "Hamburg Dammtor", // not in the table; "Hamburg *" siblings are
      "Sofia", // genuinely its own city, single token, no sibling
      "Bologna Centrale", // fallback handles it, still worth a human look
    ]),
  );
  check(
    reported.has("Hamburg Dammtor"),
    'stationsMissingCityOverride missed "Hamburg Dammtor" — a sibling in the table names its city',
  );
  check(
    !reported.has("Sofia"),
    'stationsMissingCityOverride reported "Sofia", which is already its own city',
  );
  check(
    reported.has("Bologna Centrale"),
    'stationsMissingCityOverride stopped reporting a name the fallback rewrites',
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
