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
