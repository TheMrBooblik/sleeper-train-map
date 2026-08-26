import { test, expect } from "@playwright/test";
import redirects from "../data/seo/redirects.json";

// A handful of representative sources rather than all 325 — enough to catch a
// broken rule, cheap enough to run on every commit.
const SAMPLE = Object.keys(redirects)
  .filter((s) => s.startsWith("/trains/"))
  .slice(0, 5)
  .concat(Object.keys(redirects).filter((s) => s.startsWith("/connections/")).slice(0, 3));

test.describe("retired URLs redirect in one hop", () => {
  for (const source of SAMPLE) {
    test(`${source} → ${redirects[source]}`, async ({ request }) => {
      const res = await request.get(source, { maxRedirects: 0 });
      expect(res.status(), `${source} should redirect`).toBe(301);
      // Dev/preview keeps destinations relative; production makes them absolute.
      const location = res.headers()["location"] || "";
      expect(location.replace(/^https:\/\/pingwi\.com/, "")).toBe(redirects[source]);
    });
  }

  test("a /trains/ URL missing from the map still never 404s", async ({ request }) => {
    const res = await request.get("/trains/this-slug-never-existed", { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect((res.headers()["location"] || "").replace(/^https:\/\/pingwi\.com/, "")).toBe(
      "/connections",
    );
  });

  test("redirects resolve to a real page, not a 404", async ({ request }) => {
    const res = await request.get(SAMPLE[0]);
    expect(res.status()).toBe(200);
  });
});

test.describe("sitemap", () => {
  test("contains no retired or redirecting URL", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const xml = await res.text();

    expect(xml, "sitemap still lists retired /trains/ pages").not.toContain("/trains/");

    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
      m[1].replace(/^https?:\/\/[^/]+/, ""),
    );
    expect(locs.length).toBeGreaterThan(50);

    const redirecting = locs.filter((l) => redirects[l] !== undefined);
    expect(redirecting, "sitemap lists URLs that redirect").toEqual([]);

    // Every entry must be on the canonical host.
    for (const loc of [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])) {
      expect(loc.startsWith("https://pingwi.com")).toBe(true);
    }
  });
});

// These assert tags in the prerendered HTML, so they read the response directly
// rather than booting a browser.
test.describe("canonicals", () => {
  test("a connection page self-canonicalizes on the new host", async ({ request }) => {
    const pair = Object.values(redirects).find((d) => d.startsWith("/connections/"));
    const html = await (await request.get(pair)).text();
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
    expect(canonical).toBe(`https://pingwi.com${pair}`);
    expect(html).not.toContain("sleeper-train-map.pingwi.com");
  });

  test("the admin panel is noindexed", async ({ request }) => {
    const html = await (await request.get("/data")).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/);
  });

  test("the retired login page is gone", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.status()).toBe(404);
  });
});
