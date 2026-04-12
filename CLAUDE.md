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

- **Map is always client-side only** — never attempt SSR for anything in `src/components/Map/`.
- **Operator filtering:** Train4you is filtered at the API level (`initial-data.js`, `trains.js`). NightJet/EuroNight routes come from both Back-on-Track (route metadata) and the official NightJet API (accurate polylines). Use `isTrain4you()` from `src/lib/trainOperatorsFilter.js`.
- **Data sources:** Back-on-Track EU GitHub repo (route metadata, station lists) + NightJet official API (accurate polylines for NJ/EN routes). Both scraped daily into Vercel Blob. RegioJet GTFS is parsed separately via `npm run parse-gtfs`.
- **Station coordinates** are stored in `src/data/stationCoordinates.js` as a lookup table and merged via `src/helpers/enrichStationsWithCoordinates.js`.
- **Route polylines** use `@mapbox/polyline` encoding. Route styling per operator is in `src/components/Map/utils/`.

### Data Storage (Vercel Blob)

Data is scraped once daily and stored in Vercel Blob. API routes read from Blob first (if uploaded within 25h) and fall back to GitHub / official APIs.

**Blob keys:**
- `backontrack/stops.json`, `backontrack/view_ontd_map.json`, `backontrack/trips.json` — Back-on-Track datasets
- `nightjet/trains.json` — Official NJ/EN train data with decoded polylines `{ uploadedAt, trains: { "NJ 403": {positions, stations}, ... } }`
- `osm-relation/{id}.json` — OSM relation geometries (e.g. European Sleeper 453)

- **`src/pages/api/lib/blob-store.js`** — Vercel Blob wrapper: `getBlobData` / `putBlobData` (Back-on-Track), `getNJTrains` / `putNJTrains` (NightJet), `getOsmRelation` / `putOsmRelation` (OSM), `isFresh(uploadedAt)`. Module-level listing cache (per prefix) avoids repeated `list()` calls per cold start.
- **`src/pages/api/lib/train-fetcher.js`** — `fetchSingleTrain(number, date)`, `fetchPartnerTrainNumbers(date)`, `normalize(data, date, operator)`.
- **`src/pages/api/scrape-backontrack.js`** — Daily cron (3AM UTC): fetches Back-on-Track datasets from GitHub, NJ/EN trains from NightJet API (polylines decoded and stored), OSM relation geometries. Protected by `Authorization: Bearer <CRON_SECRET>`.
- **`src/pages/api/osm-relation.js`** — Reads relation geometry from Blob first; falls back to Overpass API and stores the result in Blob for future requests.

Required env vars: `BLOB_READ_WRITE_TOKEN` (auto-set when linking a Vercel Blob store to the project), `CRON_SECRET`.

### API Routes (`src/pages/api/`)

| Route                   | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `initial-data.js`       | Combined stops + routes + trips (with NJ/EN polylines merged) — Blob first  |
| `trains.js`             | Generic Back-on-Track data fetcher — reads Blob first, falls back to GitHub |
| `scrape-backontrack.js` | Daily cron: scrapes Back-on-Track + NightJet API, stores to Vercel Blob     |
| `osm-relation.js`       | OSM relation geometry — reads Blob first, falls back to Overpass API        |

### Testing

Playwright E2E tests live in `tests/`. The config (`playwright.config.js`) auto-starts `npm run dev` on port 3000.

- **`tests/map.spec.js`** — basic map load and no console errors
- **`tests/smoke.spec.js`** — pre-commit smoke (homepage + API response)
- **`tests/data-integrity.spec.js`** — API data shape, known stations present, no Train4you, OSM relation endpoint
- **`tests/map-data.spec.js`** — compares API stop/route counts against what renders on the map; verifies known stations appear as markers; verifies clicking a marker opens the detail panel

Run a single test file: `npx playwright test tests/data-integrity.spec.js`

