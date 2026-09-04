import { test, expect } from '@playwright/test';

// API data-shape and content checks (documented in CLAUDE.md).

test.describe('Data integrity', () => {
  test('initial-data has expected shape and volume', async ({ request }) => {
    const response = await request.get('/api/initial-data');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data.stops)).toBeTruthy();
    expect(data.stops.length).toBeGreaterThan(1000);
    expect(Object.keys(data.viewMap).length).toBeGreaterThan(50);
    expect(Object.keys(data.trips).length).toBeGreaterThan(50);
  });

  test('known stations are present', async ({ request }) => {
    const data = await (await request.get('/api/initial-data')).json();
    const names = new Set(data.stops.map((s) => s.stop_name));
    // Stations a sleeper route actually calls at. The endpoint no longer ships
    // the whole Back-on-Track stops table — see the projection test below — so
    // this list has to be route-served: Paris Est used to sit here but no night
    // train in the dataset stops there (they use Austerlitz / Gare du Nord), so
    // it never had a marker either.
    for (const station of ['Wien Hbf', 'Paris Austerlitz', 'Roma Termini']) {
      expect(names.has(station), `expected station "${station}"`).toBeTruthy();
    }
  });

  test('stops are projected down to the ones routes reach', async ({ request }) => {
    const data = await (await request.get('/api/initial-data')).json();

    // Every station named by a route row must have its record, or it silently
    // loses its marker; nothing much beyond them should ride along. The full
    // table is ~29 800 stops, of which ~1 900 are on a route.
    const named = new Set();
    for (const route of Object.values(data.viewMap)) {
      for (const field of ['origin_trip_0', 'destination_trip_0', 'origin_trip_1', 'destination_trip_1']) {
        if (route[field]) named.add(route[field]);
      }
    }
    const ids = new Set(data.stops.map((s) => s.stop_id));
    const namesSet = new Set(data.stops.map((s) => s.stop_name));
    const missing = [...named].filter((n) => !ids.has(n) && !namesSet.has(n));
    expect(missing, `endpoint stations without a stop record: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0);

    expect(data.stops.length).toBeLessThan(5000);
  });

  test('first-paint payload carries no route geometry', async ({ request }) => {
    const data = await (await request.get('/api/initial-data')).json();
    const withGeometry = Object.values(data.viewMap).filter(
      (r) => r.nj_polyline_0 || r.nj_polyline_1 || r.nj_polyline,
    );
    expect(withGeometry).toHaveLength(0);

    // ...and the endpoint it moved to serves it for the same routes.
    const geometry = await (await request.get('/api/route-geometry')).json();
    const ids = new Set(Object.keys(data.viewMap));
    const orphans = Object.keys(geometry).filter((k) => !ids.has(k));
    expect(orphans, `geometry for routes not in the payload: ${orphans.join(', ')}`).toHaveLength(0);
    expect(Object.keys(geometry).length).toBeGreaterThan(50);
  });

  test('no Train4you (UEX) leaks into the payload', async ({ request }) => {
    const data = await (await request.get('/api/initial-data')).json();
    const uexRoutes = Object.values(data.viewMap).filter(
      (r) => (r.agency_id || '').trim() === 'UEX',
    );
    expect(uexRoutes).toHaveLength(0);
  });

  test('generic operator-trains endpoint matches legacy per-operator endpoint', async ({ request }) => {
    const [generic, legacy] = await Promise.all([
      request.get('/api/operator-trains?source=nightjet'),
      request.get('/api/nightjet-trains'),
    ]);
    expect(generic.ok()).toBeTruthy();
    expect(legacy.ok()).toBeTruthy();
    expect(await generic.json()).toEqual(await legacy.json());
  });

  test('operator-trains rejects unknown sources', async ({ request }) => {
    const response = await request.get('/api/operator-trains?source=nope');
    expect(response.status()).toBe(404);
  });

  test('osm-relation endpoint validates input and serves geometry', async ({ request }) => {
    const missing = await request.get('/api/osm-relation');
    expect(missing.status()).toBe(400);

    const bad = await request.get('/api/osm-relation?relationId=abc');
    expect(bad.status()).toBe(400);

    // Served from the committed cache when fresh; falls back to Overpass when
    // stale. When the upstream is unreachable (sandboxed CI) the endpoint must
    // still degrade to a structured JSON error, not crash.
    const response = await request.get('/api/osm-relation?relationId=18616102');
    const data = await response.json();
    if (response.ok()) {
      expect(data.coordinates.length).toBeGreaterThan(0);
    } else {
      expect(response.status()).toBeGreaterThanOrEqual(403);
      expect(data.error).toBeTruthy();
    }
  });
});
