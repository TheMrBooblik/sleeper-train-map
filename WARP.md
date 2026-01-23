# WARP.md

This repository implements an interactive web map that visualizes sleeper train routes and stations across Europe.

- Framework and UI: Next.js with Tailwind CSS for styling.
- Map engine: Leaflet, integrated via react-leaflet (the map is rendered client-side using a dynamically imported component).

Data model and source
- Purpose: Provide users with up-to-date information about European sleeper trains and their connections.
- Source of truth: All data is currently fetched from the Back-on-Track night-train-data project:
  https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/${type}.json
- Access pattern: Requests go through a Next.js API route (see `src/pages/api/trains.js`), which proxies the upstream URL and returns JSON with cache headers. The `${type}` parameter corresponds to identifiers defined in `src/constants/backOnTrack.js` (e.g., `STOPS`, `ROUTES`, `TRIPS`, `VIEW_MAP`).

Notes on rendering
- The Leaflet map is embedded via `react-leaflet` with SSR disabled using `next/dynamic` (see `src/components/Map/Map.js` and `src/components/Map/DynamicMap.js`).
- Global styles live in `src/styles/globals.css` and include Tailwind utilities.
