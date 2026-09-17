import { test, expect } from '@playwright/test';

test.describe('Pre-commit Smoke Tests', () => {
  test('homepage loads without errors', async ({ page }) => {
    const errors = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    page.on('pageerror', error => {
      errors.push(error.message);
    });

    await page.goto('/');
    
    // Wait for map container to ensure React rendered
    await page.waitForSelector('.leaflet-container', { timeout: 15000 });
    
    expect(errors, `Errors detected: ${errors.join(', ')}`).toHaveLength(0);
  });

  test('API endpoint responds correctly', async ({ request }) => {
    const response = await request.get('/api/trains?type=stops');
    
    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('application/json');
    
    const data = await response.json();
    expect(data).toBeDefined();
  });
});

test.describe('Planner Smoke Tests', () => {
  test('planner renders a styled shell server-side', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/plan');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The page must be styled by the stylesheet, not by a runtime
    // document.head injection — a server-rendered request has no JS.
    const bg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');

    expect(errors, `Errors detected: ${errors.join(', ')}`).toHaveLength(0);
  });

  test('a shared plan URL resolves on a cold load', async ({ page }) => {
    await page.goto('/plan/amsterdam-to-vienna/2026-09-18');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      /Amsterdam/i,
    );
    // Parameterised plans must never be indexable — the URL space is infinite.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex/,
    );
  });
});
