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

  test('the planner fits the narrowest phone', async ({ page }) => {
    // The date field spilled past the card on a real phone: a native
    // input[type=date] has a wide intrinsic width, and a grid item defaults to
    // min-width:auto, so it refuses to shrink. 320px is an iPhone SE.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/plan/amsterdam/2026-09-18');
    await page.waitForSelector('#plan-date');

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const input = document.getElementById('plan-date');
      const card = input.closest('section');
      return {
        page: doc.scrollWidth - doc.clientWidth,
        spill: Math.round(
          input.getBoundingClientRect().right - card.getBoundingClientRect().right,
        ),
      };
    });
    expect(overflow.page, 'page scrolls sideways').toBe(0);
    expect(overflow.spill, 'date field spills past its card').toBeLessThanOrEqual(0);
  });

  test('the start chips are a real top, per region', async ({ page }) => {
    // Two faults in one: the list was ranked by a score that was not the number
    // on the chips (so it read as alphabetical), and all three products —
    // European sleepers, China Railway, Amtrak/VIA — were ranked against each
    // other, which put Beijing above Vienna.
    await page.goto('/plan');
    const counts = async () =>
      page.$$eval('#start-city-chips li a span:last-child', (els) =>
        els.map((e) => Number(e.textContent)),
      );

    for (const region of ['Europe', 'Asia', 'North America']) {
      await page.getByRole('tab', { name: region }).click();
      await expect(page.getByRole('tab', { name: region })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const nums = await counts();
      expect(nums.length, `${region} rendered no chips`).toBeGreaterThan(0);
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i], `${region} chip ${i} is out of order`).toBeLessThanOrEqual(
          nums[i - 1],
        );
      }
    }

    // Europe is the default, and it is what the server pre-rendered — a
    // different order here would reshuffle the chips a second after paint.
    await page.getByRole('tab', { name: 'Europe' }).click();
    const first = await page.locator('#start-city-chips li a').first().textContent();
    expect(first).toContain('Vienna');
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
