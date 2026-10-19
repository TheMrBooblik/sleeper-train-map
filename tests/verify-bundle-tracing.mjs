// Deployment-storage guard for the serverless bundles.
//
// Vercel bills one function bundle per route per retained deployment, and the
// nightly scrape mints a deployment a night. file-store.mjs reads its datasets
// through a computed path, so @vercel/nft traces the whole of public/data/ into
// every route that can reach it — 24 MB apiece, ~370 MB a deployment, which is
// what filled the 10 GB free tier. next.config.js answers that with a per-route
// outputFileTracingExcludes table.
//
// The table is only as good as its coverage: a route added without a row
// inherits the full 24 MB again, and nothing at build or request time complains.
// So this pins the shape rather than the byte count — the failure mode is a
// missing row, not a big number.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const config = require(path.join(ROOT, "next.config.js"));

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error("  ✗ " + msg);
};
const pass = (msg) => console.log("  ✓ " + msg);

const API_DIR = path.join(ROOT, "src", "pages", "api");

/** Every .js under pages/api is a route; .mjs is not. Returns route paths. */
function apiRoutes(dir = API_DIR, prefix = "/api") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...apiRoutes(full, `${prefix}/${e.name}`));
    } else if (e.name.endsWith(".js")) {
      const base = e.name.replace(/\.js$/, "");
      out.push(base === "index" ? prefix : `${prefix}/${base}`);
    }
  }
  return out;
}

// --- 1. helpers under pages/api must not be routes ----------------------------
console.log("pages/api/lib holds helpers, not routes");
{
  const strays = fs
    .readdirSync(path.join(API_DIR, "lib"))
    .filter((f) => f.endsWith(".js"));
  if (strays.length) {
    fail(
      `src/pages/api/lib/{${strays.join(", ")}} are .js, so Next compiles them as ` +
        `API routes and deploys a full lambda for each. Rename to .mjs.`,
    );
  } else {
    pass("every file in pages/api/lib is .mjs");
  }
}

// --- 2. the exclude table covers every route ----------------------------------
console.log("outputFileTracingExcludes covers every API route");
{
  const excludes = config.outputFileTracingExcludes || {};
  const keys = Object.keys(excludes);
  // Mirror next/dist/build/collect-build-traces.js: picomatch(key, {contains:true}).
  const covered = (route) => keys.some((k) => route.includes(k));

  const uncovered = apiRoutes().filter((r) => !covered(r));
  if (uncovered.length) {
    fail(
      `no tracing row for ${uncovered.join(", ")} — each inherits the whole of ` +
        `public/data/ (~24 MB) into its bundle. Add a row in next.config.js.`,
    );
  } else {
    pass(`all ${apiRoutes().length} API routes have a row`);
  }

  // --- 3. no wildcard key: excludes run AFTER includes, so '*' wipes them ------
  if (keys.includes("*")) {
    fail(
      "'*' key in outputFileTracingExcludes — excludes are applied after " +
        "includes (collect-build-traces.js), so a wildcard deletes the " +
        "per-route outputFileTracingIncludes as well. Keep excludes per route.",
    );
  } else {
    pass("no wildcard key (it would delete the per-route includes)");
  }

  // --- 4. no bracketed keys: picomatch reads [id] as a character class ---------
  const bracketed = keys.filter((k) => /\[.*\]/.test(k));
  if (bracketed.length) {
    fail(
      `bracketed key(s) ${bracketed.join(", ")} — picomatch reads [id] as a ` +
        `character class, so the key never matches its own route. Use the ` +
        `parent path instead, which matches by containment.`,
    );
  } else {
    pass("no bracketed keys");
  }

  // --- 5. the routes that answer 404 on Vercel carry no data at all ------------
  // /data and /api/admin/* are loopback-only (src/lib/localAdmin.mjs refuses
  // outright when VERCEL is set), so shipping them a dataset is pure storage.
  for (const route of ["/api/admin", "/api/data-status"]) {
    const row = keys.find((k) => route.includes(k));
    const globs = row ? excludes[row] : [];
    const covers = ["published", "gtfs", "backontrack", "osm-", "-trains"].every(
      (needle) => globs.some((g) => g.includes(needle)),
    );
    if (!covers) {
      fail(`${route} is loopback-only but its row does not exclude all of public/data/`);
    } else {
      pass(`${route} (404s on Vercel) excludes every dataset`);
    }
  }
}

// --- 6. the includes the sitemap depends on survive the excludes ---------------
console.log("sitemap keeps the files it is explicitly given");
{
  const includes = (config.outputFileTracingIncludes || {})["/sitemap.xml"] || [];
  const excluded = (config.outputFileTracingExcludes || {})["/sitemap.xml"] || [];
  // './public/data/gtfs/**' covers everything under './public/data/gtfs';
  // './public/data/scraped/osm-*.json' is a filename star within one directory.
  const globMatches = (glob, file) => {
    if (glob.endsWith("/**")) return file.startsWith(glob.slice(0, -2));
    const rx = new RegExp(
      "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$",
    );
    return rx.test(file);
  };
  const clashes = includes.filter((inc) =>
    excluded.some((ex) => globMatches(ex, inc)),
  );
  if (clashes.length) {
    fail(
      `/sitemap.xml includes ${clashes.join(", ")} but its exclude row removes ` +
        `them again — excludes run last, so the include is a no-op.`,
    );
  } else {
    pass("no include is cancelled by its own exclude row");
  }
}

// --- 7. legacy alias URLs are rewrites, not routes of their own ---------------
// Each page file under pages/api is one more function bundle in every retained
// deployment. The per-operator trains URLs are kept as rewrites onto the one
// generic route; a rewrite whose page file still exists would never fire
// (afterFiles rewrites lose to a real page), and one whose target is gone 404s.
console.log("legacy operator-trains URLs resolve through rewrites");
{
  const rewrites = await config.rewrites();
  const list = Array.isArray(rewrites) ? rewrites : rewrites.afterFiles || [];
  const legacy = list.filter((r) => /^\/api\/[a-z]+-trains$/.test(r.source));
  const routes = new Set(apiRoutes());
  if (legacy.length < 5) {
    fail(`expected the five legacy /api/*-trains rewrites, found ${legacy.length}`);
  }
  for (const r of legacy) {
    const target = r.destination.split("?")[0];
    if (routes.has(r.source)) {
      fail(`${r.source} is both a page file and a rewrite — the rewrite never fires`);
    } else if (!routes.has(target)) {
      fail(`${r.source} rewrites to ${target}, which is not a route`);
    }
  }
  if (legacy.length >= 5) pass(`${legacy.length} legacy URLs rewrite onto one route`);
}

console.log(
  failures ? `\n${failures} check(s) failed` : "\nAll bundle-tracing checks passed",
);
process.exit(failures ? 1 : 0);
