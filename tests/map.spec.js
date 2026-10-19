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

  // A quick drag that starts on a station runs the cursor over its neighbours
  // (the pane trails the cursor by a frame). Leaflet queues those hovers and
  // opens their tooltips on release, after their mouseout has already fired,
  // and the map gliding on under a still cursor drops more mouseouts — so
  // station names stayed on the map with the cursor long gone. Without
  // MarkerTooltipGuard this left a name stuck on nearly every drag.
  test('station tooltips close once the cursor has left them, after a drag', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.waitForSelector('.station-dot', { timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(800);

    const stuckTooltips = () => page.evaluate(() => {
      const hovered = [...document.querySelectorAll('.leaflet-marker-icon')]
        .some((el) => el.matches(':hover'));
      return hovered
        ? []
        : [...document.querySelectorAll('.leaflet-tooltip')].map((t) => t.textContent.trim());
    });

    for (let i = 0; i < 8; i++) {
      const markers = await page.evaluate(() =>
        [...document.querySelectorAll('.leaflet-marker-icon')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })
          .filter((p) => p.x > 200 && p.x < 1080 && p.y > 120 && p.y < 680),
      );
      expect(markers.length).toBeGreaterThan(0);
      const m = markers[(i * 7) % markers.length];
      const dir = i % 2 ? 1 : -1;
      await page.mouse.move(m.x, m.y);
      await page.waitForTimeout(150);
      await page.mouse.down();
      for (let s = 1; s <= 10; s++) {
        await page.mouse.move(m.x + dir * s * 35, m.y + Math.sin(s) * 25);
      }
      await page.mouse.up();
      await page.waitForTimeout(500);
      expect(await stuckTooltips(), `after drag ${i + 1}`).toEqual([]);
      await page.mouse.move(m.x + dir * 350, m.y + 230);
      // Let the inertia glide finish before asking again.
      await page.waitForTimeout(1500);
      expect(await stuckTooltips(), `after drag ${i + 1}, map settled`).toEqual([]);
    }
  });
});
