import { test, expect } from '@playwright/test';

test.describe('Pre-commit Smoke Tests', () => {
  test('homepage loads without errors', async ({ page }) => {
    const pageErrors = [];

    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    await page.goto('/');
    await page.waitForSelector('.leaflet-container', { timeout: 15000 });

    expect(pageErrors, `Page errors detected: ${pageErrors.join(', ')}`).toHaveLength(0);
  });

  test('planner page renders without client errors', async ({ page }) => {
    const pageErrors = [];

    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    const response = await page.goto('/plan');
    expect(response?.ok()).toBeTruthy();

    await expect(page.getByRole('heading', { name: 'Where could you go tonight?' })).toBeVisible();
    await expect(page.getByLabel('From')).toBeVisible();
    await expect(page.getByLabel('When')).toBeVisible();

    expect(pageErrors, `Page errors detected: ${pageErrors.join(', ')}`).toHaveLength(0);
  });

  test('planner stations API responds correctly', async ({ request }) => {
    const response = await request.get('/api/plan-stations');

    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('application/json');

    const data = await response.json();
    expect(Array.isArray(data.stations)).toBeTruthy();
    expect(data.stations.length).toBeGreaterThan(0);
  });

  test('planner destination API validates required query parameters', async ({ request }) => {
    const response = await request.get('/api/plan-destinations');
    expect(response.status()).toBe(400);
  });

  test('existing API endpoint responds correctly', async ({ request }) => {
    const response = await request.get('/api/trains?type=stops');

    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('application/json');

    const data = await response.json();
    expect(data).toBeDefined();
  });
});
