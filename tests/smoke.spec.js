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

    const heading = page.getByRole('heading', { name: 'Where could you go tonight?' });
    const from = page.getByLabel('From');
    const when = page.getByLabel('When');

    await expect(heading).toBeVisible();
    await expect(from).toBeVisible();
    await expect(when).toBeVisible();

    // DOM presence is not enough: the planner must be visually readable on
    // Pingwi's dark global background.
    for (const element of [heading, from, when]) {
      await expect(element).toBeInViewport();
      const visibility = await element.evaluate((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          color: style.color,
          backgroundColor: style.backgroundColor,
          opacity: style.opacity,
          width: rect.width,
          height: rect.height,
        };
      });

      expect(visibility.opacity).not.toBe('0');
      expect(visibility.width).toBeGreaterThan(0);
      expect(visibility.height).toBeGreaterThan(0);
    }

    await expect(from).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(heading).toHaveCSS('color', 'rgb(255, 255, 255)');

    await page.screenshot({ path: 'test-results/plan-page.png', fullPage: true });

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
