import { test, expect } from '@playwright/test';

// Public suggestion endpoint: validation layer must be deterministic without
// GitHub credentials. With no token the endpoint returns 503 for storable
// suggestions; with SUGGEST_DRY_RUN=1 it returns 201 — both prove validation
// passed. Honeypot and 400 paths never touch GitHub.

const valid = {
  type: 'correction',
  context: { routeKey: 'icn_ICN_770', trainName: 'ICN 770' },
  message: 'The departure time shown for Roma Termini is off by an hour.',
  website: '',
};

test.describe('Suggest API', () => {
  test('rejects non-POST', async ({ request }) => {
    const res = await request.get('/api/suggest');
    expect(res.status()).toBe(405);
  });

  test('rejects missing message', async ({ request }) => {
    const res = await request.post('/api/suggest', {
      data: { ...valid, message: 'short' },
    });
    expect(res.status()).toBe(400);
  });

  test('rejects unknown type', async ({ request }) => {
    const res = await request.post('/api/suggest', {
      data: { ...valid, type: 'spam' },
    });
    expect(res.status()).toBe(400);
  });

  test('rejects bad price fields', async ({ request }) => {
    const res = await request.post('/api/suggest', {
      data: {
        ...valid,
        type: 'price',
        fields: { fromPrice: -10, currency: 'EUR' },
      },
    });
    expect(res.status()).toBe(400);
  });

  test('rejects oversized payloads', async ({ request }) => {
    const res = await request.post('/api/suggest', {
      data: { ...valid, message: 'x'.repeat(9000) },
    });
    expect(res.status()).toBe(400);
  });

  test('honeypot is silently accepted without storing', async ({ request }) => {
    const res = await request.post('/api/suggest', {
      data: { ...valid, website: 'http://bot.example' },
    });
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json.ok).toBeTruthy();
  });

  test('valid suggestion passes validation', async ({ request }) => {
    const res = await request.post('/api/suggest', { data: valid });
    // 201 = stored (or SUGGEST_DRY_RUN); 503 = GitHub not configured in this
    // environment. Anything else means validation or handler is broken.
    expect([201, 503]).toContain(res.status());
  });
});
