# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server

npm run scrape       # Registry-driven scrape of all sources (scripts/scrape-data.mjs)
npm run canonicalize # Merge scraped sources → public/data/published/initial-data.json (review-gated)
npm run classify     # Diff tonight's data vs seen index → proposals on the proposals branch
npm run build-mobile-payload # Render-ready payload for the mobile app (public/data/published/mobile-v1.json)
npm run build-basemap # Offline Natural Earth basemap → mobile/assets/basemap.json.gz (manual, committed)
npm run sync-mobile-seed # Copy the current payload into the app's bundled seed (manual, before a release)
npm run parse-gtfs   # Parse RegioJet GTFS data (scripts/parse-regiojet-gtfs.js)
npm run parse-pkp-gtfs # Parse Polish GTFS (runs nightly inside `npm run scrape` via the registry)
npm run ai-tasks     # AI assist batch (GitHub Models; needs GITHUB_TOKEN with models:read)
npm run probe-prices # Sample operator booking APIs → price.update proposals
npm run bootstrap-seen # One-off: grandfather all current routes/stations as approved

npm test             # Run Playwright E2E tests
npm run test:smoke   # Run smoke tests (separate config)
# Pure-logic unit suites (raw node, no browser):
npm run verify-registry && npm run verify-build-parity && npm run verify-overrides && \
npm run verify-local-admin && npm run verify-proposals && npm run verify-classify && npm run verify-calendar && \
npm run verify-canonical-routes && npm run verify-ai && npm run verify-enrich && \
 npm run verify-integrations && \
npm run verify-route-geometry && npm run verify-es && npm run verify-chinese-12306 && npm run verify-na-gtfs && \
npm run verify-synthetic-scope && npm run verify-return-branches && npm run verify-es-timetable && \
npm run verify-european-sleeper && npm run verify-station-times && npm run verify-marker-grouping && \
npm run verify-seo-booking && npm run verify-seo-faq && npm run verify-seo-urls && \
npm run verify-mobile-payload && npm run verify-basemap

# The Flutter app (mobile/) has its own toolchain:
cd mobile && flutter analyze && flutter test
```

## Architecture Overview

**Sleeper Train Map** — interactive visualization of European night sleeper train routes on a Leaflet map. Built with Next.js 15, React 18, React-Leaflet, and Tailwind CSS 4.

### Data Flow

1. **App Entry:** `pages/index.js` → `<Layout>` component manages global UI state (`isGrouped`, `showRoutes`, `hideIntermediateStations`, `layerType`), persisted to localStorage.

2. **Data Fetching:** `useInitialData()` consolidates all data into a single `/api/initial-data` request. The hook uses **module-level caching** (1h TTL) shared across all component instances. The API endpoint sets CDN cache headers (`s-maxage=3600`).

3. **Map Rendering:** `DynamicMap.js` is loaded with `next/dynamic` + `ssr: false` (Leaflet requires browser APIs). It consumes `useMapMarkers()` and `useRoutePaths()` hooks that memoize expensive computations.

4. **Station Selection:** Clicking a marker sets selected station state → filters related routes → `TrainBottomBar` and `TrainDetailPanel` display journey details.

### The source registry (no hardcoded operators)

`data/sources/registry.json` declares every data source: which adapter scrapes it (`scripts/adapters/{adapter}.mjs`), what file it writes (`public/data/scraped/{output}`), and how its trains merge into the map payload (the `synthetic` config consumed by `build-initial-data.mjs`: id prefix, agency, station aliasing, BoT dedup strategy). One subtlety worth knowing when `synthetic.excludeBotMatched` is on: a **bare** train number is only unique within an operator (BoT carries a CFM/CFR 401 and an SJN 475 next to European Sleeper's ES 401/475), so such sources declare `synthetic.botMatchAgencies: ["ES"]` to say whose rows may legitimately match — absent means "any row", which stays right for operator-prefixed keys like `"NJ 403"`. Rows carrying the source's own `idPrefix` never count as coverage either, so the scrape runner's leftover rows can't shadow the richer row the merge builds. Both rules are covered by `npm run verify-synthetic-scope`. **Adding an operator = adding a registry entry** (+ an adapter module only if no existing kind fits: `backontrack`, `json-api`, `html`, `gtfs`, `static-config`, `osm`, `canonical-routes`). Every enabled entry also declares `endpoint` — the concrete address it reads, so the integration dashboard can print `https://content.amtrak.com/content/gtfs/GTFS.zip` rather than "official GTFS"; nothing in the pipeline consumes it, and where `params.feedUrl`/`params.baseUrl` exists the validator forces the two to agree so the documentation cannot drift from what the adapter fetches (`verify-registry`). The scrape runner, the merge, `/api/operator-trains`, `/api/data-status`, and the admin dashboard all iterate the registry. Schema + validation: `scripts/lib/registry.mjs`; editable in the admin "Registry" tab (server re-validates before committing).

Additional per-entry capabilities (all optional, all registry-driven):

- **`trusted: true`** (requires `official: true`) — the source's data bypasses the review queue: new routes/stations it corroborates are auto-approved by the nightly classifier (see below). `trustConfig(registry)` in `scripts/lib/registry.mjs` derives the trusted prefixes/source ids.
- **`enrich`** — post-scrape view-map enrichment (`scripts/lib/enrich-view-map.mjs`, called from the runner's `finalizeViewMap`): updates matched BoT rows in place from official data. Strategies: `trainsByNumber` (match by `trip_short_name_0/1` against the source's trains file; options `setPolyline` + `polylineMode: legacy|perDirection`, `updateVia`, `setTimes`, `stamp`, `agencyIds`) and `gtfsBundle` (match via `pkpEntryForRoute` endpoint validation against `params.statusFile` — reused train numbers carry corridor `variants` picked by endpoint match, and compound labels stitch through-car legs at their junction, mid-corridor switches included; options `updateVia`, `stamp`, plus `geometryFallback` = OSM-backed polylines from `route-geometry.mjs` for rows the bundle can't corroborate — geometry only, never a stamp). `stamp` writes `official_sources: [sourceId]` onto the row — the classifier's corroboration signal. `updateEndpoints` replaces the row's `origin_trip_*`/`destination_trip_*` with the feed's first/last stop and `updateServiceDays` its `service_id_*` — both opt-in, for sources whose feed *is* the operator's timetable. They matter more than they look: Back-on-Track still called European Sleeper's ES 474/475 "Berlin Hbf" while the operator ran them out of Berlin-Spandau and into Berlin Gesundbrunnen, so the row's own polyline reached a different place than its endpoint marker — and `getStationTimesForTrain` (`src/lib/seo/stationTimes.js`) validates endpoints before accepting a feed's stop list, so the Berlin–Paris connection page silently lost its whole timetable. Slugs are city-based (`cityForStation`), so `/connections/berlin-to-paris` is unchanged; the legacy `/trains/` slug does change, which is what `npm run build-redirects` appends (old URL keeps resolving). Durations live on the *trip*, which enrichment never touches, so `routeDurationMinutes()` (`src/lib/seo/format.js`) measures them from the row's endpoint times whenever the row carries `official_sources` — across the published payload that corrects exactly the two rows whose stated duration contradicted their own times (ES 452 15h23→16h27, ES 474 18h32→17h05). Sources with `trainsByNumber` + `synthetic` also get raw-file synthetic leftover rows (the old NJ-only behavior, generalized).
- **`runner: "external"` + `command` + `schedule`** — registry-scheduled script steps that run inside `npm run scrape` (e.g. `pkp-gtfs` runs `npm run parse-pkp-gtfs` daily so the bundle is fresh before enrichment). `schedule: weekly` = Mondays or any `workflow_dispatch`/`FORCE_ALL_SOURCES=1` run.
- **`pkp-plk` supplements PKP station info** (`kind: json-api`, enabled): the official PLK "Otwarte Dane Kolejowe" API (`pdp-api.plk-sa.pl`, `scripts/adapters/pkp-plk.mjs`, auth via the `PLK_API_KEY` scrape secret) is the infrastructure manager's authoritative planned schedule, and its stop lists reach across the border (Berlin/Praha/Wien), adding the international station names GTFS's Polish feed lacks. It has no coordinates or track geometry, so instead of a synthetic/enrich source it **folds** its per-train stop lists (station names + times; coords reconciled from GTFS by city, foreign stops stay coordless — fine for the station-list text) into the existing `pkpTrainShapes.json` `byTrainKey` bundle, keeping the GTFS/OSM polylines. It fetches all IC trains in one bulk `/schedules?carriersInclude=IC` pull and matches bundle rows by train number **or** endpoint cities (international trains carry a national number ≠ the commercial EC/EN number). It also enriches Back-on-Track PKP rows the Polish GTFS doesn't carry (through-car routes like Warszawa–Rijeka): matched by oriented endpoints, it sets the detail-panel station list (`pkp_schedule_*`) plus `via_*` on the row — `via_` makes `deriveCities` link those stations to the route (map dots) and `buildAllRoutesPaths` chain them into the line, all from Back-on-Track coordinates (PLK has no geometry of its own). PLK emits station names ASCII-folded or in alternate forms (`Bohumin`, `Graz Hauptbahnhof`), so both the bundle fold and the GTFS-less row enrichment canonicalize every emitted name to its BoT spelling via `data/overrides/station-aliases.json` (`canonicalizeStationName`) — otherwise the international stops wouldn't match BoT's coordinate-bearing stations and would drop from the map dots and route line. Runs after `pkp-gtfs` (which regenerates the bundle nightly) and re-applies every run, but is gated on the `/api/v1/data-version` `schedulesVersion` GUID so a typical night is a single request (respects the hourly rate limit; caps via `params.maxRequestsPerRun`). Field reads are centralized in the adapter's `FIELDS` map (schema confirmed from live responses; the no-auth `/fields/schedules` endpoint documents it).
- **`europeansleeper` takes stops and times from the operator's own timetable, geometry from GTFS.** https://www.europeansleeper.eu/timetable is what European Sleeper stands behind, and it disagrees with the feed: the feed runs ES 474 out of Berlin-Spandau at 17:52, the operator out of Berlin Gesundbrunnen at 17:25, and Spandau appears nowhere on the page. `scripts/lib/es-timetable.mjs` parses it (plain server-rendered HTML, no framework payload) — the format's trap is that the **bold time is the departure at every stop except the last**, where it is the arrival, with intermediate arrivals in a trailing `<i>`. Service days come from prose, but only from sentences naming their train ("Train ES 452 … departs on Tuesday, Thursday and Sunday"); the Brussels–Milan paragraph names no number, so 400/401 keep the feed's days. `mergePageOverFeed()` in the adapter lays page over feed per train: **page** supplies stops/times/days, **GTFS always** supplies the polyline, the validity window and the December `future` period. The page's date picker is JS-driven and cannot be selected over GET (`?departure-date-sql=…` is ignored; the route `<select>` uses opaque ids like `value="8"` for ES 400), so a nightly fetch sees only trains running *now* — 400/401 stay on GTFS until the Milan service starts and upgrade by themselves. The fetch is never fatal: any failure logs and falls back to GTFS, so a page outage costs the operator's times, not its trains. Parser covered by `npm run verify-es-timetable` against committed real markup (`tests/fixtures/es-timetable/`), the merge by `npm run verify-es`. The sandbox has no egress to that host, so page-sourced data only appears after a scrape runs where egress is open.
- **`europeansleeper` runs off the Mobility Database GTFS feed mdb-3107** (`kind: gtfs`, enabled): `scripts/adapters/europeansleeper.mjs` downloads `mdb-3107/latest.zip` — MDB's self-updating alias, the same object its "Download latest" button serves, so a nightly job tracks the feed instead of pinning a snapshot (`params.fallbackUrls` carries the second MDB hostname; the dated `.../mdb-3107-YYYYMMDDHHMM/...zip` URLs are immutable and must not be used). Routes are taken per `data/sources/europeansleeper-sleepers.json`, matched on `route_short_name` ("ES 452"), and keyed by **bare number** ("452") because BoT view-map `trip_short_name_*` is bare. The feed ships `shapes.txt`, so ES no longer touches `scripts/lib/route-geometry.mjs`. It reuses `downloadGtfs`/`loadGtfsDir` from `scripts/lib/gtfs.mjs` but **not** `buildSleeperTrains`, because this feed is date-expanded — one trip and one `service_id` per operating date, `calendar_dates.txt` only, past dates retained, and each date free to carry its own diversion and shape. So the adapter: filters to trips still running on/after today; **splits them at the European timetable change** (the second Sunday in December) into the period running now and the one that replaces it; within each period picks the **modal** stop sequence (the generic "most stations" rule selects diversions that run once a year) and unions weekdays across every run in that period. Splitting matters — read as one window, ES 400 advertised four weekdays for a 3×/week train and showed December's routing four months early. The upcoming period rides along as `future` and `appendSyntheticRoutes` gives it its own row (`es_400_from_20261214`, `draw_as_active`, `"… (from 14 Dec)"`), which is what retired the hand-authored `future-route-previews.json` entry; it is emitted only when the new period changes the days or the endpoint **cities**, so a mid-route stop swap doesn't draw a near-duplicate line. The adapter also wraps `>24h` times and emits them `T`-prefixed (`enrich-view-map`'s `toHHMM` matches `/T(\d{2}:\d{2})/`), and canonicalizes station names at emit time via `station-aliases.json` so `updateVia`'s raw names still link stations to the route. Numbering follows the operator: the feed's ES 400/401 (Brussels–Milano) supersedes Back-on-Track's stale 456/457, whose row `240` is retired in `data/overrides/disabled-routes.json`. In `TrainDetailPanel`, the feed supersedes BoT for **every** European Sleeper train it carries, not just the synthetic rows: the panel keys ES off the trip's agency as well as the `es_` route prefix (the enriched BoT rows 237/238 have real trips and so never reach the synthetic fallback path), and prefers the feed's stop list, endpoint names, times, duration and service days over BoT's copy — BoT still routes ES 452 via Dresden Neustadt/Berlin Hbf, and its 15:23 duration contradicts the feed times the row already carries. Trains the feed does not carry (ES 454/455, postponed) keep BoT's values. The row itself is corrected the same way by the enrichment's `updateEndpoints` + `updateServiceDays` (below), so the map, the bottom bar and the connection pages agree with the card.
- **A bare train number is only unique within an operator — on the render side too.** The registry guards the scrape with `synthetic.botMatchAgencies`; the same rule has to hold wherever a feed keyed by bare number is read back. `src/lib/europeanSleeper.mjs` (`esScheduleForTrip`) is that guard for the detail panel: without it Back-on-Track's CFM/CFR **401** (Chişinău–București) and SJN **475** (Trondheim–Bodø) rendered European Sleeper's stops, endpoints, duration and service days, because the ES feed is keyed `400 401 452 453 474 475`. `src/lib/seo/stationTimes.mjs` solves the same problem the other way: it keeps **every** feed that claims a number and lets endpoint validation choose, instead of the first file `readdirSync` returned — first-wins was silently costing 14 Nightjet/EuroNight timetables on the connection pages (Zürich–Praha among them), since the shadowing feed then failed validation and the timetable was dropped rather than replaced. Its endpoint check runs both sides through `resolveCanonicalStationName`, so a feed's exonym ("Prag Hbf") validates against the route's canonical name, and emitted stop names are canonicalized so one page cannot spell a station two ways. Covered by `npm run verify-european-sleeper` and `npm run verify-station-times`.
- **`chinese` (China Railway)** scrapes `kyfw.12306.cn` nightly (`scripts/adapters/chinese.mjs` + `scripts/lib/12306.mjs`): curated sleeper allowlist in `data/sources/chinese-sleepers.json` → leftTicket + queryByTrainNo for live stops/times → English names/coords from the allowlist station catalog → `route-geometry` polylines. Dispatch "Probe 12306 source" if the scrape starts failing from Actions. Sticky merge keeps yesterday's trains on total outage; per-train `seedStations` cover internationals 12306 omits (e.g. K23 Ulaanbaatar).

### Integration dashboard (`/data` → Integrations)

The migration tracker: **which routes still come from Back-on-Track, what official source could replace it, and what to build next.** Today 147 of 288 routes (51%) run on a first-party automated source; 141 are still Back-on-Track across 28 operators.

- **The maths is one pure module**, `src/lib/integrations/model.mjs` (`.mjs`, dependency-free, raw-node testable — same reason as `operatorNames.mjs`). `/api/admin/integrations` is a thin reader over it; `IntegrationsTab` / `RouteSourcesTab` do one fetch and no arithmetic.
- **Route → source** (`resolveRouteSources`): `official_sources` first (the enrichment actually corroborated the row), then the longest matching `synthetic.idPrefix` (`nj_standalone_` must beat a shorter `nj_`), else `backontrack`. **Route → operator** is `splitAgencyIds(bot_agency_id || agency_id)` — `bot_agency_id` first because a synthetic row overwrites `agency_id` with the feed's own operator, losing the joint operator BoT recorded (`MÁV/ÖBB` → `ÖBB`), and the map and detail panel already resolve it that way.
- **Integration status is derived, never taken on trust from the catalogue.** "Found an official API" and "Pingwi fetches from it" are different claims, and the whole tool exists to keep them apart: an operator reads `integrated` only when a registry source with `official: true` is currently feeding ≥1 of its routes, `needs-maintenance` when that feed has gone stale/failing/disabled, and the curated status applies only when nothing official is flowing (where it cannot award itself `integrated`).
- **`data/sources/official-sources.json`** is the research catalogue: per operator a `website`, `countries`, `integrationStatus`, `difficulty`, `notes` and a list of concrete sources (`name`, `url`, `docsUrl`, `format`, `provides`, `auth`, `status`, `lastChecked`, `probeWorkflow`, `notes`). Planning data only — the scrape pipeline never reads it, and a source becomes real by getting a registry entry. Editable in the Integrations tab through the ordinary admin commit path (`official-sources` in `OVERRIDE_FILES`, actions `setOperator` / `setSource` / `removeSource`). `verify-integrations` rejects a source without an absolute, non-placeholder URL — the point is a link you can open, not a category.
- **Priority** ranks what to build next: `(botRoutes + 0.1 × botStations) × readiness (tested 1.0 / found 0.6 / none 0.15) × ease (easy 1.5 / medium 1.0 / hard 0.5 / unknown 0.9) × staleness`. `ease` exceeds 1 deliberately: a plain GTFS zip is a registry entry plus an allowlist because `gtfs-sleeper` already reads that shape, so SNCF's 9 routes outrank operators with more routes and no adapter. The "what to integrate next" shortlist skips operators with no source found (listed separately as "not actionable yet") and ones already integrated with ≥50% coverage — the table still bands everyone.
- **A fresh fetch is not fresh data.** Back-on-Track is scraped nightly so its timestamp is always green, which says nothing about whether upstream still maintains the route. Two artifacts close that gap, both committed by the existing daily workflow: `scripts/lib/classify.mjs` dates `lastChanged` on each seen entry (any fingerprint difference, stop-sequence drift included) and `canonicalize` projects it into **`public/data/published/route-history.json`** (~25 KB, so the 240 KB `seen.json` stays out of the lambda); the scrape runner persists the per-source errors it used to discard into **`public/data/scraped/source-health.json`** (`lastRunAt` / `lastSuccessAt` / `lastFailureAt` / `lastError` / `consecutiveFailures`, merged with the previous file). Both are optional inputs — freshness falls back to each artifact's own `uploadedAt`, and an entry with no `output` of its own (`pkp-gtfs` maintains the GTFS bundle) is dated from its `params.statusFile`, or it would read "never fetched" while visibly feeding 16 routes.
- **Tabs.** `/data` now opens on **Integrations**; **Route sources** is the flat 288-row table with the filters (the "Back-on-Track only" chip is the main one); **Routes** remains the map hide/show editor; **Review** keeps the proposal queue and its badge at the far end.

### Review queue ("all new data verified first")

Everything non-mechanical flows through a proposal queue the admin reviews in `/data` → Review tab. `/data`, `/api/admin/*`, and `/api/data-status` are loopback-only (`src/lib/localAdmin.mjs`): they 404 on Vercel and on any non-localhost host. There is no login.

- **Proposals** are single JSON files on the **`proposals` git branch** (`data/proposals/{pending,resolved}/`), metadata encoded in filenames so listing the queue is one GitHub Contents call. Envelope schema/codec: `src/pages/api/lib/proposals.mjs`. The branch never deploys (`vercel.json` → `git.deploymentEnabled.proposals: false`).
- **Producers:** nightly classifier (`scripts/classify-changes.mjs` + pure `scripts/lib/classify.mjs`), AI tasks (`scripts/ai-tasks.mjs`), price probes (`scripts/probe-prices.mjs`), and the public `/api/suggest` endpoint (honeypot + rate-limited; "Suggest an edit" in the detail panel).
- **The gate:** `data/canonical/state/seen.json` is the approval index. `buildInitialData({ seenIndex })` withholds viewMap rows / injected station markers not yet approved (default-allow when the index is absent so the map can never blank; canonicalize hard-fails if >10% of routes would be withheld). New route keys and stations are gated; updates to approved routes auto-apply, with FYI notes for material changes (days/endpoints/operator); vanished trains are retained 7 days (sticky merge in the scrape runner) then noticed once.
- **Trusted sources skip the gate:** routes whose key carries a trusted source's synthetic `idPrefix`, or whose row was stamped `official_sources` by the enrichment post-step, are auto-approved by `classify()` (`approved: true, autoApproved: <date>` in seen.json) — including previously-gated keys once corroborated. Stations injected by trusted sources auto-approve the same way (`stats.stationSources` from the build). Everything auto-added lands in ONE aggregate FYI `note` per night (dated `target.routeKey` so dedup can't block future nights). Disappearance notes are suppressed when a vanished key's trains all still run under another key (route-key migration). The workflow runs classify BEFORE canonicalize so auto-approvals go live the same night; a classify failure just gates new keys one extra night.
- **verify-build-parity** gates its build with the committed seen.json exactly like canonicalize. Any PR that changes merge inputs (registry, overrides, build code) must re-run `npm run canonicalize` to regenerate the published artifact, or the parity test fails.
- **Applying:** approval in the Review tab runs `planProposalApply()` (`src/pages/api/lib/proposals-apply.mjs`) — pure mutations committed to main via the GitHub Contents API (`src/pages/api/lib/github-content.mjs`). Apply kinds: `override.set` (reuses `applyOverrideMutation`), `seen.approve`, `route.add/update/remove`, `price.update`, `note` (no-op). Admin's own edits in the other tabs commit directly (the admin IS the reviewer).

### Curated routes & prices (data-only route coverage)

- `data/canonical/routes/{routeKey}.json` — admin-approved route files (created by `route.add` approvals). The `curated` registry source compiles them into the standard trains shape, so they flow through the same pipeline as scraped operators. Keys must be `curated_{trainName with _}`. New/changed curated routes appear after the next nightly scrape (or a manual `workflow_dispatch`).
- `data/canonical/prices.json` — per-route from-prices (from probes/AI/public, all reviewed). Stamped onto viewMap rows + trips at compile time; consumed by the existing `getOperatorPricing()` route-first seam, surfacing as "from €X" badges with no component changes.
- `src/pages/api/lib/calendar.mjs` — canonical service calendar; parses BoT service strings and GTFS calendars, renders back to display strings, unparseable inputs round-trip verbatim.

### The mobile app (`mobile/`) and its payload

The Flutter app does **not** carry a port of the map's logic. Route styling,
colour assignment, return-direction corridor de-duplication, OSM/static geometry
substitution and city clustering are ~2000 lines of pure JS here, and a Dart copy
would drift the first time the pipeline changed. So `scripts/build-mobile-payload.mjs`
runs *those same modules* in the nightly Action and writes
`public/data/published/mobile-v1.json` — the app decodes and paints it, nothing more.

- **What is baked:** encoded geometry per route (simplified, see below), one colour /
  weight / numeric dash per route, per-direction endpoints, times, service string, via
  list, amenities and a resolved booking URL (`operator-booking.json`'s `{origin}`/`{dest}`
  template filled in here), the route-relevant stations (1,880 of 29,749 — the rest are
  2.7 MB the app would parse and never draw) and both city-grouping states.
- **What is deliberately NOT baked: anything that reads the clock.**
  `isRouteOutsideServiceIdSeason` and `getFutureRouteStartDate` both call `new Date()`,
  so freezing their verdicts would tell a phone in November what was true in August —
  and the app ships a seed copy that can be months old. The payload carries their
  *inputs* (`seasonRanges`, `seasonBounded`, `futureStarts`, `hasUnknownStart`,
  `drawAsActive`) and the app re-evaluates. `verify-mobile-payload` fails the build if a
  verdict-shaped key (`isFuture`, `hidden`, …) ever appears on a route.
- **Geometry is simplified before encoding** (Douglas–Peucker, ~55 m, `scripts/lib/mobile-geometry.mjs`):
  334k points → 67k, an 80% cut invisible at the zoom range a sleeper map is read at.
  Dash patterns are normalised from Leaflet's `"10,5"`/`"8 6"` strings to numeric segments,
  because Flutter's `StrokePattern.dashed` wants numbers and the app should parse nothing.
- **One behaviour change from the web, on purpose:** `buildRouteColorMap` shades by an
  operator's *visible* route count, so the web gives a route a different shade when only
  one station's routes are on screen. The payload bakes one colour per route, computed
  over the full set, so a route keeps its colour across views.
- **A route hidden by today's season filter never reaches `buildAllRoutesPaths`**, so its
  geometry would be missing and the app could not un-hide it later. Nothing is seasonal
  today; the builder throws if that changes, rather than shipping a silent gap.
- **Delivery:** `public/` is static on the Vercel CDN and `src/middleware.js` only guards
  `/data` exactly, so `https://pingwi.com/data/published/mobile-v1.json` is a plain CDN
  asset — no lambda, no bandwidth cost beyond the CDN. The app ships a seed copy, caches
  the last good download, and refreshes with `If-None-Match`. Schema is frozen per
  version: a breaking change goes to `mobile-v2.json` so published apps keep working.
- `mobile/` is excluded from the Vercel build (`.vercelignore`) and from Prettier; the root
  `package.json` is deliberately **not** an npm workspace root, so the web build is untouched.

**The app itself** (`mobile/`, Flutter + flutter_map, package `com.pingwi.night_trains`):

- **No tile server.** `tile.openstreetmap.org` is what the web draws over, and the OSMF
  policy prohibits apps and offline prefetch outright. The hosted alternatives are metered
  and mostly non-commercial-only, which sits badly with the affiliate booking links the
  payload carries. So `scripts/build-basemap.mjs` bakes a Natural Earth basemap
  (public domain, 484 KB → 326 KB shipped, two levels of detail, 789 ranked city labels)
  and the app draws it as `PolygonLayer`s. It is complete offline, forever, for nothing.
- **One decoder for everything.** Routes are polyline precision 5, the basemap precision 4,
  both read by `lib/data/polyline_codec.dart` (~30 lines). That is why the basemap is
  re-encoded rather than shipped as a bespoke binary format.
- **Three data sources, in order:** the bundled seed asset (so a first launch in a tunnel
  draws the whole network) → the last good download in the app support directory → the
  network, one conditional GET against the CDN object. `npm run sync-mobile-seed` refreshes
  the seed and is deliberately **manual**: wiring it into the nightly job would put ~400 KB
  of asset churn in every data commit and trigger a mobile CI build for data the running
  app fetches over HTTP anyway.
- **What Dart re-derives, and why.** Only what the payload cannot answer: viewport marker
  thinning (`lib/logic/thinning.dart`, a port of `thinStationsByViewport`, kept free of any
  Flutter import so it is unit-testable), the season/future-start verdicts against the
  device clock (`lib/logic/season.dart`), haversine ranking for "stations near me"
  (`lib/logic/geo.dart`), and the utc/wall time conversion (`lib/logic/time_format.dart`).
  Everything else is laid out as given. The always-show allowlist is **not** ported — the
  web matches it through 50 lines of station-name normalisation, so the build resolves it
  and the payload carries a boolean per marker.
- **`opacity` is the base, never the ghost.** `buildAllRoutesPaths` folds `fadeAsFuture`
  into its `pathOptions`, which is a statement about the build date: ES 239 is "postponed to
  2027", so the baked value was the ghost and an app running in 2027 would have gone on
  fading a route that had opened. The payload carries `opacity` and `ghostOpacity`
  separately and `evaluateRoute` picks between them.
- **Toggles use the web's localStorage keys** (`train-map:isGrouped`, `:showRoutes`,
  `:hideIntermediateStations`) with the same defaults. The fourth web toggle, the
  OpenRailwayMap overlay, has no counterpart — it is a tile layer.
- **Size, measured:** the Play download is **8.7–9.4 MB** (`bundletool get-size total`,
  MIN/MAX across device configurations) against the 30 MB budget. The `.aab` artifact is
  52 MB, which is not the user-facing number — Play splits it per ABI and screen density
  and ships one slice. Flutter's icon-font tree-shaking accounts for a further 1.6 MB → 2.9 KB.
- **CI** is `.github/workflows/mobile-build.yml`, path-filtered to `mobile/**` so the
  nightly data commit never triggers it, and `push` limited to main so a PR branch does not
  run it twice: analyze, test, build an App Bundle, then `bundletool get-size total` with a
  hard 30 MB failure. That check parses `bundletool`'s CRLF CSV with `tr -d '\r'` and fails
  loudly when no number can be read — the first version let the `\r` through, which made the
  comparison error out, and a failing `[` returns 2, i.e. "false", so the gate silently
  passed at any size. ubuntu only — the repository is private, where macOS runners bill at
  ×10; iOS builds go through Xcode Cloud (25 h/month included with the Apple Developer
  Program).

The client-side half of the data pipeline — coordinate enrichment, terminus rewrites, the
PKP/RJ GTFS merges, `deriveCities` — used to live inside `useInitialData`, duplicated
verbatim between its load and refresh paths. It is now `src/lib/enrich-payload.mjs`
(`enrichInitialData`), which the hook and the payload builder both call, so the web is its
own regression test for what the app renders.

### Public URL structure (pingwi.com)

The site is served from **`https://pingwi.com`** (moved from `sleeper-train-map.pingwi.com`, Aug 2026). The origin is written in exactly one place, `src/lib/seo/site.js`; everything else builds URLs through `absoluteUrl()`.

| Path | Page |
| --- | --- |
| `/` | Interactive map + SSR'd indexable tour (top ~50 connections, country + operator hubs) |
| `/connections` | Directory of every city pair — the hub-of-hubs |
| `/connections/{cityA}-to-{cityB}` | **The canonical route page type.** One page per *undirected* city pair, carrying every train on the corridor in both directions: facts, corridor map, per-train timetables, booking CTAs, FAQ |
| `/night-trains/{country}` | Country hub → all its connections |
| `/night-trains/{country}/from/{city}` | City hub (≥2 routes) |
| `/operators/{operator}` | Operator hub → all its connections |

- **Slugs are city names, not station names.** `cityForStation()` (`src/lib/seo/cities.mjs`) resolves a raw station to its city: `data/overrides/station-cities.json` first (English exonyms + qualifier strips — "Praha hl.n." → Prague, "Zemun" → Belgrade), then a generic fallback that strips parentheticals, bilingual `A / B` halves and station-type suffixes. Add an entry when a new endpoint's fallback guess is wrong; `verify-seo-urls` reports uncovered endpoints without failing.
- **Pairs are undirected.** `buildPairSlug()` sorts the two city slugs, so both directions land on one page instead of two near-duplicates. Ordering helpers live in `src/lib/seo/slugify.mjs` (`.mjs` so raw-node scripts and the Next build compute identical slugs — divergence would emit redirects to URLs the build never renders).
- **The SEO layer sees what the map sees.** `/api/initial-data` withholds admin-disabled routes via `stripDisabledRoutes`; `src/lib/seo/data.js` reads the published artifact directly and so used to keep serving them — which left Back-on-Track's retired European Sleeper *456/457* (Brussels–Milan **via Zürich**, route 240) with a live connection page after the operator's own feed replaced it with ES 400/401 via Aarau. `getPublished()` now applies the same strip, and `scripts/build-seo-redirects.mjs` applies it too before computing targets.
- **`/trains/{slug}` is retired.** Those pages 301 into their `/connections/` parent. `data/seo/redirects.json` holds the map, regenerated by `npm run build-redirects` (nightly, after `canonicalize`) and **append-only on the source side** — a route can vanish from the dataset but its indexed URL must still resolve. A *destination* is not a promise, though: the route behind a page can vanish or be disabled, and a 301 into a 404 is worse than no redirect, so every destination is checked against the pages the payload actually emits and a dead one is repointed (same pair under the other slug order when that exists, else `/connections`). `next.config.js` turns it into 301s, listed *before* the legacy-host catch-all and with absolute destinations in production so a request to the old host resolves host **and** path in one hop.
- **The old host stays attached to the same Vercel project.** Do NOT configure a Vercel domain-level redirect for it — that preserves the path and forces a second hop through the retired URL.
- **Sitemap indexation is staged.** `SITEMAP_BATCH` in `src/pages/sitemap.xml.js`: `1` ships ~145 URLs (core + hubs + top 80 connections), `2` ships everything. Flip once GSC shows batch 1 indexing. The sitemap must only ever contain canonical, indexable, 200-returning URLs — `tests/seo-redirects.spec.js` asserts it lists nothing that redirects.

### Key Architectural Decisions

- **No Vercel paid features. No freemium features with usage limits we could hit.** Stick to OSS Next.js features and the Vercel Hobby tier surface area. That rules out Vercel Blob, KV, Postgres, Edge Config, Vercel Cron (use GitHub Actions instead), and any `maxDuration > 10s` config in `vercel.json` (Hobby caps Serverless Functions at 10s). When adding a feature that would normally lean on a managed Vercel service, commit the data to the repo and serve it from `public/` or bundle it via an ESM import.
- **Bundled data files vs. `public/` static assets:** JSON in `data/` that API routes need is *bundled into the lambda* via ESM JSON imports (`import ... with { type: "json" }` — see `primitives.mjs`, `build-initial-data.mjs`, `initial-data.js`). Never `fs.readFileSync` something from `data/` in an API route — Next.js doesn't trace dynamic file reads and the file won't be in the Vercel bundle. Larger nightly artifacts live under `public/` so the daily-scrape commit ships them as static assets and the lambda reads them from disk. (Scripts under `scripts/` run in raw Node and may fs-read anything.)
- **AI is free-tier and never load-bearing.** `scripts/lib/ai.mjs` calls GitHub Models with the Actions `GITHUB_TOKEN` (`models: read`), hard request budget + spacing, returns null on any failure; all AI steps are `continue-on-error` and only ever produce proposals.
- **Map is always client-side only** — never attempt SSR for anything in `src/components/Map/`.
- **Operator filtering:** Train4you is filtered at the API level. Use `isTrain4you()` from `src/lib/trainOperatorsFilter.js`.
- **Station coordinates** are stored in `src/data/stationCoordinates.js` as a lookup table and merged via `src/helpers/enrichStationsWithCoordinates.js`.
- **Route polylines** use `@mapbox/polyline` encoding. Route styling per operator is in `src/components/Map/utils/`.
- **Line style carries two separate facts** (`routeStyleUtils.js`, `MAP_LEGEND_LINE_BASE_STYLES`): the **dash** is cadence (solid = daily, `10,5` = sub-daily, `8,5` = ~weekly), and the **weight** is whether the route is real yet — every running route draws at `4.5`, and only a route that has never opened with no announced date (`hasUnknownStart`, e.g. ES Amsterdam–Milano "Postponed to 2027") drops to `2.75`. "Suspended" is not an unknown start. Cadence ranks from an explicit weekday list by **count**, so "Mon, Wed, Fri" and "Tue, Thu, Sun" draw alike. Synthetic rows have no `trips`, so `getRouteStyleFromFrequency` takes an optional row argument and ranks them from `service_id_0/1` — without it all 118 of them fall through to the daily default.
- **A city name is not a location.** `normalizeStationNameForDisplay` buckets markers by substring, and `groupCityMarkers` puts the grouped marker at the **average** of its members — so "Florence Amtrak Station" (South Carolina) joined Firenze Castello and Firenze Campo Marte and dragged the Florence dot to [40.6, −19.1], the middle of the Atlantic, leaving neither city a marker where it belongs. Each name bucket is now split into 60 km single-link proximity clusters first (`clusterByProximity`, reusing `distanceKm` from `returnGeometryBranches.js`), one marker per cluster. The radius is deliberately generous — Berlin-Spandau to Berlin Ostbahnhof is ~20 km — it exists to catch continents, not to second-guess city limits. Covered by `npm run verify-marker-grouping`.
- **A route is drawn as one line, never two.** Both directions carry geometry (`nj_polyline_0/1`, or a station chain per direction), and drawing both laid a second dashed stroke over the first: the dashes filled each other's gaps, so the line read solid and the cadence signal above was lost (it also read heavier, which is half the "too thick" story). The renderers (`buildAllRoutesPaths.js` + its twin in `useRoutePaths.js`) now draw direction 0, then only the stretches where direction 1 genuinely leaves it — `returnGeometryBranches()` (`src/components/Map/utils/returnGeometryBranches.js`), a 2 km-tolerance corridor test over a grid index, memoised per route. It **densifies** the outbound path first, because the tolerance is meant against the outbound *line*: a station chain's vertices can be 100+ km apart, and a return leg calling at extra intermediate stops sits far from every vertex while riding identical track. Over the published payload this leaves 311 strokes for 281 routes; the exact-reverse fast path (`arePositionsReverseEqual`) still short-circuits the common station-chain case. Covered by `npm run verify-return-branches`.

### Data Storage (committed JSON, no managed services)

All data is committed to the repo. Git is the database and the audit log.

**Layout:**
- `public/data/scraped/backontrack-{stops,view_ontd_map,trips}.json` — raw Back-on-Track datasets, refreshed nightly.
- `public/data/scraped/{nightjet,cd,chinese,italian,caucasus,curated,amtrak,viarail,europeansleeper}-trains.json` — per-source trains (`{ uploadedAt, trains: { "NJ 403": {polyline, stations, lastSeenAt}, ... } }`); filenames come from registry `output`. The `chinese` file is produced by `scripts/adapters/chinese.mjs` from the 12306 allowlist (`data/sources/chinese-sleepers.json`). The `amtrak`/`viarail` files are produced by the generic `gtfs-sleeper` adapter (`scripts/adapters/gtfs-sleeper.mjs` + `scripts/lib/gtfs.mjs`): it downloads an operator's official GTFS feed and keeps only the routes in a curated sleeper allowlist (`data/sources/{amtrak,viarail}-sleepers.json`), turning each into a synthetic route — feed shapes/stops/calendars mean no manual coordinates. The `europeansleeper` file comes from the same GTFS library through a dedicated adapter (see the registry section). Amtrak and VIA Rail stay empty until the first nightly scrape, since their feed hosts may be unreachable from a dev session's egress policy.
- `public/data/scraped/osm-{relationId}.json` — cached OSM relation geometries.
- `public/data/scraped/pkp-plk-trains.json` — PLK Open Data provenance/cache: `{ dataVersion, candidates }` — the fetched PLK stop-list candidates (per train, name/number + normalized stops) plus the schedule `/data-version` GUID that gates re-fetch. The actual enrichment is folded into `pkpTrainShapes.json` (see `pkp-plk` in the registry section).
- `public/data/published/initial-data.json` — the pre-merged, review-gated `{ stops, viewMap, trips }` payload served directly by `/api/initial-data` when fresh. Built by `npm run canonicalize`.
- `public/data/published/route-history.json` — per published route `{ firstSeen, lastSeen, lastChanged }`, projected from `seen.json` by `canonicalize`; the content-staleness signal behind the integration dashboard.
- `public/data/scraped/source-health.json` — per source `{ lastRunAt, lastSuccessAt, lastFailureAt, lastError, trainCount, consecutiveFailures }`, written by the scrape runner and merged across runs.
- `data/sources/registry.json` — the source registry (see above).
- `data/canonical/{routes/*.json, prices.json, state/seen.json}` — curated routes, per-route prices, approval index.
- `data/sources/official-sources.json` — the official-source research catalogue (see the integration dashboard above).
- `data/overrides/*.json` — manually editable lookups (station aliases/coords, operator pricing/booking, etc.), bundled via ESM JSON imports, edited in the admin panel.
- `data/proposals/` — exists only on the `proposals` branch (the review queue).

**Key modules:**
- **`src/pages/api/lib/file-store.js`** — disk reads over `public/data/scraped|published/`; generic `getTrainsBySource(file)`, `isFresh(uploadedAt)` (25h TTL).
- **`src/pages/api/lib/build-initial-data.mjs`** — pure registry-driven merge into the legacy `{ stops, viewMap, trips }` payload (+ seen gate + price stamping). Shared by `/api/initial-data` and `scripts/canonicalize.mjs`; `tests/verify-build-parity.mjs` is the golden test.
- **`src/pages/api/lib/github-content.mjs`** — GitHub Contents helpers (read/put/delete/list/branch, sha-conflict retry) used by all admin writes, the suggest endpoint, and the Actions scripts. Env: `ADMIN_GITHUB_TOKEN`/`GITHUB_TOKEN`, `ADMIN_REPO`/`GITHUB_REPOSITORY`, `ADMIN_COMMIT_BRANCH` (default main), `PROPOSALS_BRANCH` (default proposals).
- **`scripts/scrape-data.mjs`** — registry-driven runner (sticky-trains merge, registry-scheduled external steps, then the enrichment post-step from `scripts/lib/enrich-view-map.mjs` + synthetic leftovers). Daily GitHub Actions job (`.github/workflows/scrape-data.yml`, 3 AM UTC): scrape (incl. PKP GTFS) → classify → canonicalize → AI assist → (Mondays) price probes → auto-commit.

### API Routes (`src/pages/api/`)

| Route                     | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `initial-data.js`         | Combined stops + routes + trips, review-gated — published-file fast path, falls back to scraped files, then GitHub |
| `operator-trains.js`      | Generic per-source trains: `?source={registry id}` (legacy `{nightjet,cd,chinese,italian,caucasus}-trains.js` are thin aliases) |
| `trains.js`               | Generic Back-on-Track data fetcher — reads scraped file store, falls back to GitHub    |
| `osm-relation.js`         | OSM relation geometry — reads scraped cache, falls back to Overpass API                |
| `data-status.js`          | Freshness dashboard for /data (loopback-only)                                           |
| `suggest.js`              | Public suggestions → proposal queue (honeypot, rate limits, `SUGGEST_DRY_RUN=1` for CI) |
| `admin/integrations.js`   | Integration coverage: per-operator/route source, freshness, priority (loopback-only)     |
| `admin/override.js`       | Admin direct edits to `data/overrides/*` + the registry (loopback-only)                 |
| `admin/proposals/*`       | Review queue: list, fetch, approve/edit-approve/reject (loopback-only)                  |

### Testing

Playwright E2E tests live in `tests/`. The config (`playwright.config.js`) auto-starts `npm run dev` on port 3000.

- **`tests/map.spec.js`** — basic map load and no console errors
- **`tests/smoke.spec.js`** — pre-commit smoke (homepage + API response)
- **`tests/data-integrity.spec.js`** — API data shape, known stations, no Train4you, operator-trains parity, OSM endpoint
- **`tests/suggest-api.spec.js`** — public suggestion endpoint validation/honeypot
- **`tests/map-data.spec.js`** — compares API stop/route counts against what renders on the map
- **`tests/verify-*.mjs`** — pure-logic suites runnable with raw node (see Commands); `verify-build-parity` asserts the merge is identical to the committed published artifact — run it after any change to `build-initial-data.mjs` or the registry.
- **`tests/verify-integrations.mjs`** — the integration dashboard: source resolution precedence, the priority formula, the headline totals against the committed payload, the catalogue's shape (every source needs a real URL), and the `official-sources` admin mutations.

Run a single test file: `npx playwright test tests/data-integrity.spec.js`
