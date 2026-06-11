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
npm run parse-gtfs   # Parse RegioJet GTFS data (scripts/parse-regiojet-gtfs.js)
npm run parse-pkp-gtfs # Parse Polish GTFS shapes (weekly in CI)
npm run ai-tasks     # AI assist batch (GitHub Models; needs GITHUB_TOKEN with models:read)
npm run probe-prices # Sample operator booking APIs → price.update proposals
npm run bootstrap-seen # One-off: grandfather all current routes/stations as approved

npm test             # Run Playwright E2E tests
npm run test:smoke   # Run smoke tests (separate config)
# Pure-logic unit suites (raw node, no browser):
npm run verify-registry && npm run verify-build-parity && npm run verify-overrides && \
npm run verify-proposals && npm run verify-classify && npm run verify-calendar && \
npm run verify-canonical-routes && npm run verify-ai
```

## Architecture Overview

**Sleeper Train Map** — interactive visualization of European night sleeper train routes on a Leaflet map. Built with Next.js 15, React 18, React-Leaflet, and Tailwind CSS 4.

### Data Flow

1. **App Entry:** `pages/index.js` → `<Layout>` component manages global UI state (`isGrouped`, `showRoutes`, `hideIntermediateStations`, `layerType`), persisted to localStorage.

2. **Data Fetching:** `useInitialData()` consolidates all data into a single `/api/initial-data` request. The hook uses **module-level caching** (1h TTL) shared across all component instances. The API endpoint sets CDN cache headers (`s-maxage=3600`).

3. **Map Rendering:** `DynamicMap.js` is loaded with `next/dynamic` + `ssr: false` (Leaflet requires browser APIs). It consumes `useMapMarkers()` and `useRoutePaths()` hooks that memoize expensive computations.

4. **Station Selection:** Clicking a marker sets selected station state → filters related routes → `TrainBottomBar` and `TrainDetailPanel` display journey details.

### The source registry (no hardcoded operators)

`data/sources/registry.json` declares every data source: which adapter scrapes it (`scripts/adapters/{adapter}.mjs`), what file it writes (`public/data/scraped/{output}`), and how its trains merge into the map payload (the `synthetic` config consumed by `build-initial-data.mjs`: id prefix, agency, station aliasing, BoT dedup strategy). **Adding an operator = adding a registry entry** (+ an adapter module only if no existing kind fits: `backontrack`, `json-api`, `html`, `gtfs`, `static-config`, `osm`, `canonical-routes`). The scrape runner, the merge, `/api/operator-trains`, `/api/data-status`, and the admin dashboard all iterate the registry. Schema + validation: `scripts/lib/registry.mjs`; editable in the admin "Registry" tab (server re-validates before committing).

### Review queue ("all new data verified first")

Everything non-mechanical flows through a proposal queue the admin reviews in `/data` → Review tab:

- **Proposals** are single JSON files on the **`proposals` git branch** (`data/proposals/{pending,resolved}/`), metadata encoded in filenames so listing the queue is one GitHub Contents call. Envelope schema/codec: `src/pages/api/lib/proposals.mjs`. The branch never deploys (`vercel.json` → `git.deploymentEnabled.proposals: false`).
- **Producers:** nightly classifier (`scripts/classify-changes.mjs` + pure `scripts/lib/classify.mjs`), AI tasks (`scripts/ai-tasks.mjs`), price probes (`scripts/probe-prices.mjs`), and the public `/api/suggest` endpoint (honeypot + rate-limited; "Suggest an edit" in the detail panel).
- **The gate:** `data/canonical/state/seen.json` is the approval index. `buildInitialData({ seenIndex })` withholds viewMap rows / injected station markers not yet approved (default-allow when the index is absent so the map can never blank; canonicalize hard-fails if >10% of routes would be withheld). New route keys and stations are gated; updates to approved routes auto-apply, with FYI notes for material changes (days/endpoints/operator); vanished trains are retained 7 days (sticky merge in the scrape runner) then noticed once.
- **Applying:** approval in the Review tab runs `planProposalApply()` (`src/pages/api/lib/proposals-apply.mjs`) — pure mutations committed to main via the GitHub Contents API (`src/pages/api/lib/github-content.mjs`). Apply kinds: `override.set` (reuses `applyOverrideMutation`), `seen.approve`, `route.add/update/remove`, `price.update`, `note` (no-op). Admin's own edits in the other tabs commit directly (the admin IS the reviewer).

### Curated routes & prices (data-only route coverage)

- `data/canonical/routes/{routeKey}.json` — admin-approved route files (created by `route.add` approvals). The `curated` registry source compiles them into the standard trains shape, so they flow through the same pipeline as scraped operators. Keys must be `curated_{trainName with _}`. New/changed curated routes appear after the next nightly scrape (or a manual `workflow_dispatch`).
- `data/canonical/prices.json` — per-route from-prices (from probes/AI/public, all reviewed). Stamped onto viewMap rows + trips at compile time; consumed by the existing `getOperatorPricing()` route-first seam, surfacing as "from €X" badges with no component changes.
- `src/pages/api/lib/calendar.mjs` — canonical service calendar; parses BoT service strings and GTFS calendars, renders back to display strings, unparseable inputs round-trip verbatim.

### Key Architectural Decisions

- **No Vercel paid features. No freemium features with usage limits we could hit.** Stick to OSS Next.js features and the Vercel Hobby tier surface area. That rules out Vercel Blob, KV, Postgres, Edge Config, Vercel Cron (use GitHub Actions instead), and any `maxDuration > 10s` config in `vercel.json` (Hobby caps Serverless Functions at 10s). When adding a feature that would normally lean on a managed Vercel service, commit the data to the repo and serve it from `public/` or bundle it via an ESM import.
- **Bundled data files vs. `public/` static assets:** JSON in `data/` that API routes need is *bundled into the lambda* via ESM JSON imports (`import ... with { type: "json" }` — see `primitives.mjs`, `build-initial-data.mjs`, `initial-data.js`). Never `fs.readFileSync` something from `data/` in an API route — Next.js doesn't trace dynamic file reads and the file won't be in the Vercel bundle. Larger nightly artifacts live under `public/` so the daily-scrape commit ships them as static assets and the lambda reads them from disk. (Scripts under `scripts/` run in raw Node and may fs-read anything.)
- **AI is free-tier and never load-bearing.** `scripts/lib/ai.mjs` calls GitHub Models with the Actions `GITHUB_TOKEN` (`models: read`), hard request budget + spacing, returns null on any failure; all AI steps are `continue-on-error` and only ever produce proposals.
- **Map is always client-side only** — never attempt SSR for anything in `src/components/Map/`.
- **Operator filtering:** Train4you is filtered at the API level. Use `isTrain4you()` from `src/lib/trainOperatorsFilter.js`.
- **Station coordinates** are stored in `src/data/stationCoordinates.js` as a lookup table and merged via `src/helpers/enrichStationsWithCoordinates.js`.
- **Route polylines** use `@mapbox/polyline` encoding. Route styling per operator is in `src/components/Map/utils/`.

### Data Storage (committed JSON, no managed services)

All data is committed to the repo. Git is the database and the audit log.

**Layout:**
- `public/data/scraped/backontrack-{stops,view_ontd_map,trips}.json` — raw Back-on-Track datasets, refreshed nightly.
- `public/data/scraped/{nightjet,cd,chinese,italian,caucasus,curated}-trains.json` — per-source trains (`{ uploadedAt, trains: { "NJ 403": {polyline, stations, lastSeenAt}, ... } }`); filenames come from registry `output`.
- `public/data/scraped/osm-{relationId}.json` — cached OSM relation geometries.
- `public/data/published/initial-data.json` — the pre-merged, review-gated `{ stops, viewMap, trips }` payload served directly by `/api/initial-data` when fresh. Built by `npm run canonicalize`.
- `data/sources/registry.json` — the source registry (see above).
- `data/canonical/{routes/*.json, prices.json, state/seen.json}` — curated routes, per-route prices, approval index.
- `data/overrides/*.json` — manually editable lookups (station aliases/coords, operator pricing/booking, etc.), bundled via ESM JSON imports, edited in the admin panel.
- `data/proposals/` — exists only on the `proposals` branch (the review queue).

**Key modules:**
- **`src/pages/api/lib/file-store.js`** — disk reads over `public/data/scraped|published/`; generic `getTrainsBySource(file)`, `isFresh(uploadedAt)` (25h TTL).
- **`src/pages/api/lib/build-initial-data.mjs`** — pure registry-driven merge into the legacy `{ stops, viewMap, trips }` payload (+ seen gate + price stamping). Shared by `/api/initial-data` and `scripts/canonicalize.mjs`; `tests/verify-build-parity.mjs` is the golden test.
- **`src/pages/api/lib/github-content.mjs`** — GitHub Contents helpers (read/put/delete/list/branch, sha-conflict retry) used by all admin writes, the suggest endpoint, and the Actions scripts. Env: `ADMIN_GITHUB_TOKEN`/`GITHUB_TOKEN`, `ADMIN_REPO`/`GITHUB_REPOSITORY`, `ADMIN_COMMIT_BRANCH` (default main), `PROPOSALS_BRANCH` (default proposals).
- **`scripts/scrape-data.mjs`** — registry-driven runner (+ NJ⇄BoT view-map post-step, sticky-trains merge). Daily GitHub Actions job (`.github/workflows/scrape-data.yml`, 3 AM UTC): scrape → canonicalize → classify → AI assist → (Mondays) PKP GTFS + price probes → auto-commit.

### API Routes (`src/pages/api/`)

| Route                     | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `initial-data.js`         | Combined stops + routes + trips, review-gated — published-file fast path, falls back to scraped files, then GitHub |
| `operator-trains.js`      | Generic per-source trains: `?source={registry id}` (legacy `{nightjet,cd,chinese,italian,caucasus}-trains.js` are thin aliases) |
| `trains.js`               | Generic Back-on-Track data fetcher — reads scraped file store, falls back to GitHub    |
| `osm-relation.js`         | OSM relation geometry — reads scraped cache, falls back to Overpass API                |
| `data-status.js`          | Freshness dashboard, derived from the registry                                          |
| `suggest.js`              | Public suggestions → proposal queue (honeypot, rate limits, `SUGGEST_DRY_RUN=1` for CI) |
| `admin/override.js`       | Admin direct edits to `data/overrides/*` + the registry (auth: `admin_session` cookie)  |
| `admin/proposals/*`       | Review queue: list, fetch, approve/edit-approve/reject                                  |

### Testing

Playwright E2E tests live in `tests/`. The config (`playwright.config.js`) auto-starts `npm run dev` on port 3000.

- **`tests/map.spec.js`** — basic map load and no console errors
- **`tests/smoke.spec.js`** — pre-commit smoke (homepage + API response)
- **`tests/data-integrity.spec.js`** — API data shape, known stations, no Train4you, operator-trains parity, OSM endpoint
- **`tests/suggest-api.spec.js`** — public suggestion endpoint validation/honeypot
- **`tests/map-data.spec.js`** — compares API stop/route counts against what renders on the map
- **`tests/verify-*.mjs`** — pure-logic suites runnable with raw node (see Commands); `verify-build-parity` asserts the merge is identical to the committed published artifact — run it after any change to `build-initial-data.mjs` or the registry.

Run a single test file: `npx playwright test tests/data-integrity.spec.js`
