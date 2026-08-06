# AGENTS.md

This repo is the **Sleeper Train Map** — a Next.js 15 app that visualizes night sleeper
train routes on a Leaflet map. For the full architecture, data flow, and the complete
command list, see `CLAUDE.md` (it is the source of truth for commands and design).

## Cursor Cloud specific instructions

These notes cover non-obvious startup/run caveats for this environment. Standard commands
(dev/build/test, the many `verify-*` suites, scrape/canonicalize) are already documented in
`CLAUDE.md` and `package.json` scripts — refer to those rather than duplicating.

### Node version

- Use the pre-installed Node (v22). It works with Next 15.1.11.
- Ignore `.nvmrc` (pins `v18.17.0`): that is **below** Next 15's minimum (Node ≥ 18.18) and
  would fail. Do not `nvm use` it.

### Running services

- Single service: the Next.js app. `npm run dev` serves on port **3000**.
- The app reads its data from committed JSON (`public/data/published/initial-data.json`), so
  the map is fully functional offline — you do **not** need to run any scrape to develop/test.
- E2E tests (`npm test`) auto-start their own dev server via Playwright's `webServer` config,
  so you don't need to start `npm run dev` first for them. The smoke config uses port **3100**
  (`npm run test:smoke`).

### Data freshness caveat (why one E2E test fails in a fresh env)

- The nightly scrape (GitHub Actions) is the only thing that populates
  `public/data/scraped/*-trains.json` (nightjet, amtrak, viarail, etc.). Those source feeds
  are unreachable from a dev/CI egress policy, so in a fresh environment several of those
  files are empty (e.g. `nightjet-trains.json` has 0 trains).
- As a result, `tests/polish-routes.spec.js` → "API returns PKP routes with expected endpoint
  stations" fails on its final `nj_polyline` assertion for the EN 40406/40407
  (München↔Warszawa) route, because that polyline comes from Nightjet enrichment. This is a
  **data-freshness artifact, not a code bug** — the committed published data itself lacks that
  polyline. All other E2E, smoke, and pure-logic `verify-*` suites pass.
