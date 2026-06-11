// tests/verify-proposals-apply.mjs
// Unit tests for the proposal envelope helpers (filename codec, validation)
// and the pure apply dispatch. Run: npm run verify-proposals
import assert from "node:assert";
import {
  buildProposal,
  encodeProposalFilename,
  parseProposalFilename,
  validateProposal,
  generateProposalId,
} from "../src/pages/api/lib/proposals.mjs";
import { planProposalApply } from "../src/pages/api/lib/proposals-apply.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
function throws(name, fn, code = "INVALID_PROPOSAL") {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = e?.code === code;
  }
  assert.ok(threw, `${name}: expected ${code}`);
  passed++;
  console.log(`  ✓ ${name} (rejected)`);
}

// ── filename codec ──────────────────────────────────────────────────────────
check("filename round-trips", () => {
  const meta = {
    createdAt: "2026-06-10T12:03:01.000Z",
    source: "public",
    kind: "price.update",
    id: "p_20260610_ab12cd",
  };
  const name = encodeProposalFilename(meta);
  assert.strictEqual(
    name,
    "20260610T120301Z__public__price.update__p_20260610_ab12cd.json",
  );
  assert.deepStrictEqual(parseProposalFilename(name), meta);
});
check("parse rejects junk", () => {
  assert.strictEqual(parseProposalFilename("notes.txt"), null);
  assert.strictEqual(parseProposalFilename("a__b__c.json"), null);
});
throws("encode rejects separator injection", () =>
  encodeProposalFilename({
    createdAt: "2026-06-10T12:03:01.000Z",
    source: "pub__lic",
    kind: "note",
    id: "x",
  }),
);

// ── envelope build/validate ────────────────────────────────────────────────
check("buildProposal applies defaults and validates", () => {
  const p = buildProposal({
    source: "public",
    kind: "note",
    title: "Test",
    summary: "hello",
  });
  assert.strictEqual(p.v, 1);
  assert.strictEqual(p.status, "pending");
  assert.ok(p.id.startsWith("p_"));
  assert.deepStrictEqual(validateProposal(p), []);
});
check("evidence excerpt is capped", () => {
  const p = buildProposal({
    source: "ai",
    kind: "note",
    title: "Test",
    evidence: { urls: ["https://x"], excerpt: "y".repeat(5000) },
  });
  assert.strictEqual(p.evidence.excerpt.length, 2048);
});
throws("buildProposal rejects unknown kind", () =>
  buildProposal({ source: "public", kind: "nope", title: "x" }),
);
throws("buildProposal rejects unknown source", () =>
  buildProposal({ source: "alien", kind: "note", title: "x" }),
);
check("oversized proposal flagged", () => {
  const p = buildProposal({ source: "admin", kind: "note", title: "x" });
  p.after = { blob: "z".repeat(20000) };
  assert.ok(validateProposal(p).some((m) => m.includes("bytes")));
});
check("ids are filename-safe", () => {
  for (let i = 0; i < 20; i++) {
    assert.match(generateProposalId(), /^p_\d{8}_[a-z0-9]+$/);
  }
});

// ── apply dispatch ──────────────────────────────────────────────────────────
check("note apply is a no-op", () => {
  assert.deepStrictEqual(planProposalApply({ type: "note", payload: {} }), []);
  assert.deepStrictEqual(planProposalApply(null), []);
});

check("override.set delegates to applyOverrideMutation", () => {
  const steps = planProposalApply({
    type: "override.set",
    payload: {
      resource: "station-aliases",
      action: "set",
      payload: { alias: "Wien HBF", canonical: "Wien Hbf" },
    },
  });
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].path, "data/overrides/station-aliases.json");
  const next = steps[0].mutate({ existing: "Keep" });
  assert.strictEqual(next["wien hbf"], "Wien Hbf");
  assert.strictEqual(next.existing, "Keep");
});
throws("override.set rejects unknown resource", () =>
  planProposalApply({
    type: "override.set",
    payload: { resource: "nope", action: "set", payload: {} },
  }),
);
throws(
  "override.set propagates mutation validation",
  () =>
    planProposalApply({
      type: "override.set",
      payload: { resource: "station-aliases", action: "set", payload: { alias: "" } },
    })[0].mutate({}),
  "INVALID_OVERRIDE",
);

check("seen.approve sets route approved", () => {
  const steps = planProposalApply({
    type: "seen.approve",
    payload: { routeKey: "nj_standalone_NJ_295" },
  });
  assert.strictEqual(steps[0].path, "data/canonical/state/seen.json");
  const next = steps[0].mutate({
    v: 1,
    routes: { other: { approved: true } },
    injectedStations: {},
  });
  assert.strictEqual(next.routes.nj_standalone_NJ_295.approved, true);
  assert.strictEqual(next.routes.other.approved, true);
});
check("seen.approve works on missing file and stations", () => {
  const steps = planProposalApply({
    type: "seen.approve",
    payload: { stationName: "Marabda" },
  });
  const next = steps[0].mutate(null);
  assert.strictEqual(next.injectedStations.Marabda.approved, true);
});
throws("seen.approve needs a target", () =>
  planProposalApply({ type: "seen.approve", payload: {} }),
);

check("route.remove flips approved off", () => {
  const steps = planProposalApply({
    type: "route.remove",
    payload: { routeKey: "cr_Z21" },
  });
  const next = steps[0].mutate({ v: 1, routes: { cr_Z21: { approved: true } } });
  assert.strictEqual(next.routes.cr_Z21.approved, false);
});

const sampleRoute = {
  v: 1,
  routeKey: "curated_TLJ_1920",
  status: "active",
  agencyId: "TCDD",
  operatorName: "TCDD",
  name: "Ankara - Kars",
  directions: [
    {
      trainName: "TLJ 1920",
      calendar: { daysOfWeek: ["mon"], validFrom: null, validUntil: null, exceptions: [], note: null },
      stations: [
        { name: "Ankara Gar", lat: 39.9359, lon: 32.8474, arrival: null, departure: "18:00" },
        { name: "Kars", lat: 40.6135, lon: 43.0824, arrival: "18:21", departure: null },
      ],
      polyline: null,
    },
  ],
};

check("route.add writes a new canonical route file", () => {
  const steps = planProposalApply({ type: "route.add", payload: { route: sampleRoute } });
  assert.strictEqual(steps[0].path, "data/canonical/routes/curated_TLJ_1920.json");
  const next = steps[0].mutate(null);
  assert.strictEqual(next.routeKey, "curated_TLJ_1920");
  assert.ok(next.updatedAt);
});
throws("route.add refuses to overwrite", () =>
  planProposalApply({ type: "route.add", payload: { route: sampleRoute } })[0].mutate({
    routeKey: "curated_TLJ_1920",
  }),
);
throws("route.update requires existing file", () =>
  planProposalApply({ type: "route.update", payload: { route: sampleRoute } })[0].mutate(null),
);
throws("route.add validates directions", () =>
  planProposalApply({
    type: "route.add",
    payload: { route: { ...sampleRoute, directions: [] } },
  }),
);
throws("route key must be filename-safe", () =>
  planProposalApply({
    type: "route.add",
    payload: { route: { ...sampleRoute, routeKey: "../escape" } },
  }),
);

check("price.update sets and removes entries", () => {
  const steps = planProposalApply({
    type: "price.update",
    payload: {
      routeKey: "nj_standalone_NJ_295",
      price: { fromPrice: 49.9, currency: "EUR", source: "probe:nightjet-offers" },
    },
  });
  assert.strictEqual(steps[0].path, "data/canonical/prices.json");
  const next = steps[0].mutate({ old_route: { fromPrice: 1, currency: "EUR" } });
  assert.strictEqual(next.nj_standalone_NJ_295.fromPrice, 49.9);
  assert.strictEqual(next.old_route.fromPrice, 1);

  const removal = planProposalApply({
    type: "price.update",
    payload: { routeKey: "old_route", price: null },
  });
  const afterRemoval = removal[0].mutate(next);
  assert.ok(!("old_route" in afterRemoval));
});
throws("price.update validates fromPrice", () =>
  planProposalApply({
    type: "price.update",
    payload: { routeKey: "x", price: { fromPrice: -5, currency: "EUR" } },
  }),
);

throws("unknown apply type rejected", () =>
  planProposalApply({ type: "wat", payload: {} }),
);

console.log(`\n[verify-proposals] ${passed} checks passed`);
