# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run export       # Export as static HTML
npm run start        # Start production server
npm run parse-gtfs   # Parse RegioJet GTFS data (scripts/parse-regiojet-gtfs.js)

npm test             # Run Playwright E2E tests
npm run test:ui      # Run Playwright tests with interactive UI
npm run test:headed  # Run tests in headed browser mode
npm run test:smoke   # Run smoke tests (separate config)
```

## Architecture Overview

**Sleeper Train Map** — interactive visualization of European night sleeper train routes on a Leaflet map. Built with Next.js 15, React 18, React-Leaflet, and Tailwind CSS 4.

### Data Flow

1. **App Entry:** `pages/index.js` → `<Layout>` component manages global UI state (`isGrouped`, `showRoutes`, `hideIntermediateStations`, `layerType`), persisted to localStorage.

2. **Data Fetching:** `useInitialData()` consolidates all data into a single `/api/initial-data` request. The hook uses **module-level caching** (1h TTL) shared across all component instances. The API endpoint sets CDN cache headers (`s-maxage=3600`).

3. **Map Rendering:** `DynamicMap.js` is loaded with `next/dynamic` + `ssr: false` (Leaflet requires browser APIs). It consumes `useMapMarkers()` and `useRoutePaths()` hooks that memoize expensive computations. Route path rendering uses `startTransition()` to keep the filter checkbox responsive.

4. **Station Selection:** Clicking a marker sets selected station state → filters related routes → `TrainBottomBar` and `TrainDetailPanel` display journey details.

### Key Architectural Decisions

- **No Vercel paid features. No freemium features with usage limits we could hit.** Stick to OSS Next.js features and the Vercel Hobby tier surface area. That rules out Vercel Blob, KV, Postgres, Edge Config, Vercel Cron (use GitHub Actions instead), and any `maxDuration > 10s` config in `vercel.json` (Hobby caps Serverless Functions at 10s). When adding a feature that would normally lean on a managed Vercel service, commit the data to the repo and serve it from `public/` or bundle it via an ESM import.
- **Bundled data files vs. `public/` static assets:** JSON in `data/overrides/` is *bundled into the lambda* via ESM JSON imports (e.g. `src/data/stationAliases.js` and `src/pages/api/lib/primitives.mjs`'s `import ... with { type: "json" }`). Never `fs.readFileSync` something from `data/` in an API route — Next.js doesn't trace dynamic file reads and the file won't be in the Vercel bundle. Larger nightly artifacts (`public/data/scraped/*.json`, `public/data/published/initial-data.json`) live under `public/` so the daily-scrape commit ships them as static assets and the lambda can read them from disk.
- **Map is always client-side only** — never attempt SSR for anything in `src/components/Map/`.
- **Operator filtering:** Train4you is filtered at the API level (`initial-data.js`, `trains.js`). NightJet/EuroNight routes come from both Back-on-Track (route metadata) and the official NightJet API (accurate polylines). Use `isTrain4you()` from `src/lib/trainOperatorsFilter.js`.
- **Data sources:** Back-on-Track EU GitHub repo (route metadata, station lists) + NightJet official API (accurate polylines for NJ/EN routes). Scraped daily by a GitHub Action (`.github/workflows/scrape-data.yml`) which commits to `public/data/scraped/*.json` and runs `npm run canonicalize` to write the pre-merged `public/data/published/initial-data.json`. RegioJet GTFS is parsed separately via `npm run parse-gtfs`.
- **Station coordinates** are stored in `src/data/stationCoordinates.js` as a lookup table and merged via `src/helpers/enrichStationsWithCoordinates.js`.
- **Route polylines** use `@mapbox/polyline` encoding. Route styling per operator is in `src/components/Map/utils/`.

### Data Storage (committed JSON, no managed services)

All scraped data is committed to the repo. There is no Vercel Blob, KV, or Postgres in the data path.

**Layout:**
- `public/data/scraped/backontrack-{stops,view_ontd_map,trips}.json` — raw Back-on-Track datasets, refreshed nightly.
- `public/data/scraped/{nightjet,chinese,italian,caucasus,cd}-trains.json` — per-operator timetables with decoded polylines, e.g. `{ uploadedAt, trains: { "NJ 403": {positions, stations}, ... } }`.
- `public/data/scraped/osm-{relationId}.json` — cached OSM relation geometries.
- `public/data/published/initial-data.json` — the pre-merged `{ stops, viewMap, trips }` payload served directly by `/api/initial-data` when fresh. Built by `npm run canonicalize`.
- `data/overrides/*.json` — manually editable lookups (station aliases/coords, operator pricing/booking, etc.) bundled into the lambda via ESM JSON imports.

- **`src/pages/api/lib/file-store.js`** — thin wrapper around `fs.readFileSync` over `public/data/scraped/` and `public/data/published/`. Exposes `getBlobData`, `getNJTrains`, `getChineseTrains`, …, `getPublishedInitialData`, `isFresh(uploadedAt)`. (Name still says "Blob" for back-compat with the old import path — it's just disk now.)
- **`src/pages/api/lib/build-initial-data.mjs`** — pure merge of all sources into the legacy `{ stops, viewMap, trips }` payload. Shared by `/api/initial-data` and `scripts/canonicalize.mjs` so the live route and the build script can't diverge.
- **`src/pages/api/lib/primitives.mjs`** — small dependency-free helpers (operator filter, station aliases via `with { type: "json" }`, view-map activity). Runnable by raw Node and webpack-bundled into the lambda.
- **`src/pages/api/lib/train-fetcher.js`** — `fetchSingleTrain(number, date)`, `fetchPartnerTrainNumbers(date)`, `normalize(data, date, operator)`. Used by the scrape script, not by request handlers.
- **`scripts/scrape-data.mjs` + `scripts/canonicalize.mjs`** — daily GitHub Actions job (`.github/workflows/scrape-data.yml`, 3 AM UTC) runs scrape → canonicalize and commits the result. Replaces the old Vercel-Cron-backed `scrape-backontrack` route.
- **`src/pages/api/osm-relation.js`** — reads cached relation geometry from `public/data/scraped/osm-{id}.json` first, falls back to Overpass API.

No special env vars are required for the data path. (Admin write endpoints under `/api/admin/*` still need their own auth secrets — see `src/pages/api/auth/`.)

### API Routes (`src/pages/api/`)

| Route                   | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `initial-data.js`       | Combined stops + routes + trips (NJ/EN/CR/IT/Caucasus polylines merged) — published-file fast path, falls back to scraped files, then GitHub |
| `trains.js`             | Generic Back-on-Track data fetcher — reads scraped file store, falls back to GitHub    |
| `osm-relation.js`       | OSM relation geometry — reads scraped cache, falls back to Overpass API                |
| `nightjet-trains.js`    | Serves the cached NJ/EN trains file used by the train detail panel                     |
| `scrape-backontrack.js` | Vestigial. The daily scrape now runs in GitHub Actions; do not wire this to Vercel Cron. |

### Testing

Playwright E2E tests live in `tests/`. The config (`playwright.config.js`) auto-starts `npm run dev` on port 3000.

- **`tests/map.spec.js`** — basic map load and no console errors
- **`tests/smoke.spec.js`** — pre-commit smoke (homepage + API response)
- **`tests/data-integrity.spec.js`** — API data shape, known stations present, no Train4you, OSM relation endpoint
- **`tests/map-data.spec.js`** — compares API stop/route counts against what renders on the map; verifies known stations appear as markers; verifies clicking a marker opens the detail panel

Run a single test file: `npx playwright test tests/data-integrity.spec.js`

