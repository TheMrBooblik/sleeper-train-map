// tests/verify-overrides-mutate.mjs
// Unit tests for the pure override mutation logic. Run: npm run verify-overrides
import assert from "node:assert";
import {
  applyOverrideMutation,
  OVERRIDE_FILES,
} from "../src/pages/api/lib/overrides-mutate.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
function throws(name, fn) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = e?.code === "INVALID_OVERRIDE";
  }
  assert.ok(threw, `${name}: expected INVALID_OVERRIDE`);
  passed++;
  console.log(`  ✓ ${name} (rejected)`);
}

// station-coordinates
check("coords set", () => {
  const out = applyOverrideMutation(
    "station-coordinates",
    "set",
    { name: "Foo", lat: 1.5, lon: 2.5 },
    { Bar: { lat: 0, lon: 0 } },
  );
  assert.deepStrictEqual(out.Foo, { lat: 1.5, lon: 2.5 });
  assert.deepStrictEqual(out.Bar, { lat: 0, lon: 0 });
});
check("coords set coerces numeric strings", () => {
  const out = applyOverrideMutation(
    "station-coordinates",
    "set",
    { name: "Foo", lat: "1.5", lon: "2.5" },
    {},
  );
  assert.deepStrictEqual(out.Foo, { lat: 1.5, lon: 2.5 });
});
check("coords remove", () => {
  const out = applyOverrideMutation(
    "station-coordinates",
    "remove",
    { name: "Bar" },
    { Bar: { lat: 0, lon: 0 }, Baz: { lat: 1, lon: 1 } },
  );
  assert.ok(!("Bar" in out));
  assert.ok("Baz" in out);
});
throws("coords set rejects bad lat", () =>
  applyOverrideMutation("station-coordinates", "set", { name: "X", lat: "nope", lon: 1 }, {}),
);

// stations-to-skip (array)
check("skip add", () => {
  const out = applyOverrideMutation("stations-to-skip", "add", { name: "New" }, ["A"]);
  assert.deepStrictEqual(out, ["A", "New"]);
});
check("skip add is idempotent", () => {
  const out = applyOverrideMutation("stations-to-skip", "add", { name: "A" }, ["A"]);
  assert.deepStrictEqual(out, ["A"]);
});
check("skip remove", () => {
  const out = applyOverrideMutation("stations-to-skip", "remove", { name: "A" }, ["A", "B"]);
  assert.deepStrictEqual(out, ["B"]);
});

// always-show-stations (array)
check("alwaysShow add", () => {
  const out = applyOverrideMutation("always-show-stations", "add", { name: "Wien Hbf" }, []);
  assert.deepStrictEqual(out, ["Wien Hbf"]);
});

// operator-pricing
check("pricing set", () => {
  const out = applyOverrideMutation(
    "operator-pricing",
    "set",
    { agencyId: "VR", type: "dynamic", currency: "EUR" },
    {},
  );
  assert.deepStrictEqual(out.VR, {
    type: "dynamic",
    currency: "EUR",
    fromPrice: null,
    source: "manual",
  });
});
check("pricing set with fromPrice + note", () => {
  const out = applyOverrideMutation(
    "operator-pricing",
    "set",
    { agencyId: "ÖBB", type: "dynamic", currency: "EUR", fromPrice: 29.9, note: "n", source: "verified" },
    {},
  );
  assert.deepStrictEqual(out["ÖBB"], {
    type: "dynamic",
    currency: "EUR",
    fromPrice: 29.9,
    source: "verified",
    note: "n",
  });
});
throws("pricing set rejects bad type", () =>
  applyOverrideMutation("operator-pricing", "set", { agencyId: "X", type: "weird" }, {}),
);
check("pricing remove", () => {
  const out = applyOverrideMutation(
    "operator-pricing",
    "remove",
    { agencyId: "VR" },
    { VR: { type: "fixed" }, SJ: { type: "dynamic" } },
  );
  assert.ok(!("VR" in out));
  assert.ok("SJ" in out);
});

// station-name-replacements
check("name setStop", () => {
  const out = applyOverrideMutation(
    "station-name-replacements",
    "setStop",
    { oldName: "Baqël", newName: "Oborishte" },
    { routeReplacements: {}, stopReplacements: {} },
  );
  assert.strictEqual(out.stopReplacements["Baqël"], "Oborishte");
});
check("name setRoute with routeIds", () => {
  const out = applyOverrideMutation(
    "station-name-replacements",
    "setRoute",
    { oldName: "Baqël", newName: "Oborishte", routeIds: [142] },
    { routeReplacements: {}, stopReplacements: {} },
  );
  assert.deepStrictEqual(out.routeReplacements["Baqël"], {
    newName: "Oborishte",
    routeIds: [142],
  });
});
check("name setRoute without routeIds stores string", () => {
  const out = applyOverrideMutation(
    "station-name-replacements",
    "setRoute",
    { oldName: "A", newName: "B" },
    { routeReplacements: {}, stopReplacements: {} },
  );
  assert.strictEqual(out.routeReplacements.A, "B");
});

// immutability: input must not be mutated
check("input is not mutated", () => {
  const input = { Bar: { lat: 0, lon: 0 } };
  applyOverrideMutation("station-coordinates", "set", { name: "Foo", lat: 1, lon: 1 }, input);
  assert.deepStrictEqual(input, { Bar: { lat: 0, lon: 0 } });
});

// validation
throws("unknown resource rejected", () =>
  applyOverrideMutation("nope", "set", {}, {}),
);
throws("unknown action rejected", () =>
  applyOverrideMutation("station-coordinates", "frobnicate", { name: "X" }, {}),
);

// every declared file path looks sane
check("OVERRIDE_FILES paths are under data/overrides/", () => {
  for (const p of Object.values(OVERRIDE_FILES)) {
    assert.ok(p.startsWith("data/overrides/") && p.endsWith(".json"), p);
  }
});

console.log(`\n[verify-overrides] ${passed} checks passed`);
