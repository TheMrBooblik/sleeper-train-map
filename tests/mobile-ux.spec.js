import { test, expect } from "@playwright/test";

/**
 * Mobile viewport checks for the map homepage UX overhaul:
 * search overlay, PWA manifest, and core selection chrome.
 * Run under the `mobile-chrome` Playwright project (Pixel 5).
 */

test.describe("Mobile map UX", () => {
  test("PWA manifest is served with required fields", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(Array.isArray(manifest.icons)).toBeTruthy();
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test("PWA icons exist", async ({ request }) => {
    for (const path of [
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/apple-touch-icon.png",
    ]) {
      const res = await request.get(path);
      expect(res.ok(), path).toBeTruthy();
      expect(res.headers()["content-type"] || "").toMatch(/image\/png/);
    }
  });

  test("mobile search overlay opens and can select a station", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 20000 });

    // Dismiss welcome tour sheet if present so it doesn't block header taps.
    const closeTour = page.getByRole("button", { name: "Close tour" });
    if (await closeTour.isVisible().catch(() => false)) {
      await closeTour.click();
    }

    await page.getByRole("button", { name: "Search stations" }).click();
    await expect(
      page.getByRole("dialog", { name: "Search stations" }),
    ).toBeVisible();

    const search = page.getByRole("combobox", { name: "Search stations" });
    await search.fill("Berlin");

    // Wait for result list; pick the first city/station option.
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible({ timeout: 10000 });
    await option.click();

    // Overlay should close after select; filter chip or bottom bar may appear.
    await expect(
      page.getByRole("dialog", { name: "Search stations" }),
    ).toBeHidden({ timeout: 5000 });

    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);
  });

  test("mobile menu exposes Trains near me", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 20000 });

    const closeTour = page.getByRole("button", { name: "Close tour" });
    if (await closeTour.isVisible().catch(() => false)) {
      await closeTour.click();
    }

    await page.getByRole("button", { name: "Map controls" }).click();
    await expect(
      page.getByRole("button", { name: "Trains near me" }),
    ).toBeVisible();
  });
});
