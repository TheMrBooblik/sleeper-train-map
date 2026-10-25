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

  test('the results fit the narrowest phone too', async ({ page }) => {
    // The check above passed while the ride cards visibly spilled off a real
    // phone, because it asked the wrong two questions. It measured
    // documentElement.scrollWidth — but the app scrolls an inner
    // `h-dvh overflow-y-auto` div and body is overflow-x:hidden, so the
    // document reports 0 however far the content runs — and it measured before
    // any result had rendered, so the only thing on screen was the form.
    //
    // What actually broke: `<div className="grid gap-3">` with no column
    // template sizes its implicit column `auto`, which floors the track at the
    // item's min-content, and a grid item defaults to min-width:auto. The ride
    // cards came out 440px wide inside a 288px container — the date field's
    // fault one level up. So the question to ask is the blunt one: after the
    // results are on screen, does ANY element reach past the viewport.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/plan/vienna/2026-09-18');
    await page.waitForSelector('article', { timeout: 20000 });

    const worst = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      let over = 0;
      let who = '';
      for (const el of document.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const past = Math.round(rect.right - limit);
        if (past > over) {
          over = past;
          who = `${el.tagName.toLowerCase()}.${String(el.className || '')
            .split(' ')
            .slice(0, 3)
            .join('.')}`;
        }
      }
      return { over, who, cards: document.querySelectorAll('article').length };
    });

    // A blank page overflows by nothing, so the count is what stops this
    // passing vacuously.
    expect(worst.cards, 'no ride cards rendered').toBeGreaterThan(10);
    expect(worst.over, `${worst.who} reaches past the viewport`).toBe(0);
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

  test('picking a destination shows the trip, not the same form again', async ({ page }) => {
    // On a phone the form and the heading are the whole first screen. Picking
    // "To" used to clear the field it was typed in (it only ever appended) and
    // render the trip below the fold, so the tap looked like a reset. Now the
    // form folds into a one-line summary and the trip is on screen.
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto('/plan/amsterdam/2026-10-23');
    const to = page.getByRole('combobox', { name: 'To (optional)' });
    await expect(to).toBeEnabled({ timeout: 20000 });
    await to.click();
    await to.fill('Vienna');
    await page.getByRole('option', { name: /Vienna/ }).first().click();

    await expect(page).toHaveURL(/\/plan\/amsterdam-to-vienna\//);
    const results = page.locator('#plan-results');
    await expect(results).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Add another city after Vienna/ })).toBeVisible();

    // Reopened, the form shows the destination that was picked.
    await page.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('Vienna');
  });

  test('a trip with no night lists its cheapest nights, and a month is a grid', async ({ page }) => {
    // "Any time" is the default: the planner tries every night of the next
    // three months and shows the cheapest. A month narrows it to a grid.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/plan/brussels-to-prague');
    const results = page.locator('#plan-results');
    const nights = results.locator('ol > li a');
    await expect(nights.first()).toBeVisible({ timeout: 30000 });
    await expect(results.getByRole('heading', { level: 2 })).toHaveText(/Cheapest nights|When it runs/);
    await expect(page.getByText('Departing Any time')).toBeVisible();
    // Each night opens that night's plan.
    expect(await nights.first().getAttribute('href')).toMatch(/\/plan\/brussels-to-[a-z-]+\/\d{4}-\d{2}-\d{2}/);

    // Nothing reaches past a 320px screen. The page scrolls an inner div, so
    // ask every element rather than the document (see the test above).
    const overflow = await page.evaluate(() => {
      let worst = 0;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > window.innerWidth + 0.5) worst = Math.max(worst, r.right - window.innerWidth);
      }
      return worst;
    });
    expect(overflow).toBe(0);

    const months = results.getByRole('button', { name: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/ });
    if (await months.count()) {
      await months.first().click();
      await expect(page).toHaveURL(/\/plan\/brussels-to-prague\/\d{4}-\d{2}$/);
      await expect(results.locator('.grid-cols-7').first()).toBeVisible();
    }
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
