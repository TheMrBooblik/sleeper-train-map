// tests/verify-describe-error.mjs
// The scrape runner's error line. Raw node, no browser.
//
// The case that motivated it is the first one: undici throws a bare "fetch
// failed" whose cause is an AggregateError of one system error per address
// tried. Six nights of the CFR source failing recorded "fetch failed" and
// nothing a fix could start from.
import assert from "node:assert/strict";
import { describeError } from "../scripts/lib/describe-error.mjs";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

check(
  "undici fetch failure names the addresses and codes it actually tried",
  () => {
    const v6 = Object.assign(new Error("connect ETIMEDOUT 2a02:1:2::5:443"), {
      code: "ETIMEDOUT",
      syscall: "connect",
      address: "2a02:1:2::5",
      port: 443,
    });
    const v4 = Object.assign(new Error("connect ECONNREFUSED 193.0.0.1:443"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "193.0.0.1",
      port: 443,
    });
    const agg = Object.assign(new AggregateError([v6, v4], ""), {
      code: "ECONNREFUSED",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause: agg });

    const line = describeError(err);
    assert.ok(line.startsWith("fetch failed"), line);
    assert.match(line, /ETIMEDOUT/);
    assert.match(line, /ECONNREFUSED/);
    assert.match(line, /2a02:1:2::5/);
    assert.match(line, /193\.0\.0\.1/);
    // The bare message is what six nights of source-health.json recorded.
    assert.notEqual(line, "fetch failed");
  },
);

check("DNS failure surfaces the hostname", () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND data.gov.ro"), {
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "data.gov.ro",
  });
  const line = describeError(
    Object.assign(new TypeError("fetch failed"), { cause: dns }),
  );
  assert.match(line, /ENOTFOUND/);
  assert.match(line, /hostname=data\.gov\.ro/);
});

check("a plain error is unchanged", () => {
  assert.equal(describeError(new Error("HTTP 503")), "HTTP 503");
});

check("nested causes are chained, deepest last", () => {
  const root = new Error("socket hang up");
  const mid = Object.assign(new Error("request failed"), { cause: root });
  const top = Object.assign(new Error("cfr: download failed"), { cause: mid });
  assert.equal(
    describeError(top),
    "cfr: download failed ← request failed ← socket hang up",
  );
});

check("a self-referencing cause chain terminates", () => {
  const err = new Error("loop");
  err.cause = err;
  assert.equal(describeError(err), "loop");
});

check("output is capped so source-health.json cannot bloat", () => {
  let err = new Error("x".repeat(500));
  const line = describeError(err);
  assert.ok(line.length <= 400, `${line.length} chars`);
  assert.ok(line.endsWith("…"));
});

check("non-Error throws do not crash the describer", () => {
  assert.equal(describeError("boom"), "boom");
  assert.equal(describeError(undefined), "undefined");
  assert.equal(describeError(null), "null");
  assert.equal(describeError({ nope: 1 }), "[object Object]");
});

check("duplicate aggregate messages collapse", () => {
  const one = () =>
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: new AggregateError([one(), one(), one()], ""),
  });
  const line = describeError(err);
  assert.equal(
    line.match(/ECONNREFUSED \(code=ECONNREFUSED\)/g).length,
    1,
    line,
  );
});

console.log(`\n[verify-describe-error] ${passed} checks passed`);
