// CDN-request guard.
//
// Vercel Hobby includes 1M CDN requests a month and the site ran out in
// October 2026. The largest multiplier was Next's viewport prefetch: every
// <Link> that scrolled into view fetched its target's page data and route
// chunk, so one visit to the homepage made 118 requests (57 of them prefetches)
// and one to /connections 114 (72). src/components/Link.js turns that off by
// default; this pins that every link goes through it.
//
// Shape, not a count: the failure mode is one new direct import of next/link,
// and nothing at build or request time complains about it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const WRAPPER = path.join(SRC, "components", "Link.js");

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error("  ✗ " + msg);
};
const pass = (msg) => console.log("  ✓ " + msg);

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(m?jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

console.log("links go through the no-prefetch wrapper");
{
  const direct = sourceFiles(SRC).filter(
    (f) => f !== WRAPPER && /from\s+["']next\/link["']|require\(\s*["']next\/link["']\s*\)/.test(fs.readFileSync(f, "utf8")),
  );
  if (direct.length) {
    fail(
      `imports next/link directly (use src/components/Link.js): ` +
        direct.map((f) => path.relative(ROOT, f)).join(", "),
    );
  } else {
    pass("no file outside src/components/Link.js imports next/link");
  }

  const wrapper = fs.readFileSync(WRAPPER, "utf8");
  if (!/prefetch\s*=\s*false/.test(wrapper)) {
    fail("src/components/Link.js no longer defaults prefetch to false");
  } else {
    pass("the wrapper defaults prefetch to false");
  }
}

console.log("no eager router prefetching");
{
  const eager = sourceFiles(SRC).filter((f) => /router\.prefetch\(/.test(fs.readFileSync(f, "utf8")));
  if (eager.length) {
    fail(`router.prefetch() fetches a page nobody asked for: ${eager.map((f) => path.relative(ROOT, f)).join(", ")}`);
  } else {
    pass("no router.prefetch() calls");
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll CDN-request checks passed");
process.exit(failures ? 1 : 0);
