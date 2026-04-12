import { test, expect } from '@playwright/test';

test.describe('Map Interactivity', () => {
  test('page loads without errors', async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];

    // Listen for console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Listen for page errors
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    await page.goto('/');

    // PKP polylines: static GTFS-derived bundle must exist (merged client-side in useInitialData)
    const pkpRes = await page.request.get('/data/gtfs/pkpTrainShapes.json');
    expect(pkpRes.ok(), 'pkpTrainShapes.json should be served').toBeTruthy();
    const pkpJson = await pkpRes.json();
    expect(pkpJson.byTrainKey?.['16170']?.positions?.length ?? 0).toBeGreaterThan(10);

    // Wait for the map to load
    await page.waitForSelector('.leaflet-container', { timeout: 10000 });
    
    // Give time for any async errors to appear
    await page.waitForTimeout(2000);
    
    // Check for errors
    expect(consoleErrors, `Console errors found: ${consoleErrors.join(', ')}`).toHaveLength(0);
    expect(pageErrors, `Page errors found: ${pageErrors.join(', ')}`).toHaveLength(0);
    
    // Verify the page rendered successfully
    const mapContainer = page.locator('.leaflet-container');
    await expect(mapContainer).toBeVisible();
  });
});
