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
    for (const station of ['Wien Hbf', 'Paris Est', 'Roma Termini']) {
      expect(names.has(station), `expected station "${station}"`).toBeTruthy();
    }
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
