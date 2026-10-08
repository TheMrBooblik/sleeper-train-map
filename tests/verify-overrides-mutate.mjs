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

// disabled-routes (array, keyed on routeKey)
check("disabled-routes add", () => {
  const out = applyOverrideMutation("disabled-routes", "add", { routeKey: "142" }, ["7"]);
  assert.deepStrictEqual(out, ["7", "142"]);
});
check("disabled-routes add is idempotent", () => {
  const out = applyOverrideMutation("disabled-routes", "add", { routeKey: "7" }, ["7"]);
  assert.deepStrictEqual(out, ["7"]);
});
check("disabled-routes remove", () => {
  const out = applyOverrideMutation("disabled-routes", "remove", { routeKey: "7" }, ["7", "8"]);
  assert.deepStrictEqual(out, ["8"]);
});
throws("disabled-routes add rejects empty routeKey", () =>
  applyOverrideMutation("disabled-routes", "add", { routeKey: "" }, []),
);

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

// operator-booking
check("booking set creates record with empty stationNames", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "ÖBB", urlTemplate: "https://x?o={origin}&d={dest}" },
    {},
  );
  assert.deepStrictEqual(out["ÖBB"], {
    urlTemplate: "https://x?o={origin}&d={dest}",
    dealsUrl: null,
    dealsLabel: null,
    bookingPageUrl: null,
    stationNames: {},
  });
});
check("booking set preserves bookingPageUrl/requireStationMapping/routePages", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "AMTK", urlTemplate: "https://new" },
    {
      AMTK: {
        urlTemplate: "old",
        bookingPageUrl: "https://www.amtrak.com/tickets-reservations",
        requireStationMapping: true,
        routePages: { amtrak_Cardinal: "https://www.amtrak.com/routes/cardinal-train.html" },
        stationNames: { A: "a" },
      },
    },
  );
  assert.strictEqual(out.AMTK.urlTemplate, "https://new");
  assert.strictEqual(
    out.AMTK.bookingPageUrl,
    "https://www.amtrak.com/tickets-reservations",
  );
  assert.strictEqual(out.AMTK.requireStationMapping, true);
  assert.deepStrictEqual(out.AMTK.routePages, {
    amtrak_Cardinal: "https://www.amtrak.com/routes/cardinal-train.html",
  });
});
check("booking set carries the journey link and its date format through a URL edit", () => {
  const journeyUrlTemplate =
    "https://shop.oebbtickets.at/en/ticket?connectionDatetimeDeparture={date}T{departureTime}";
  const out = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "ÖBB", urlTemplate: "https://new" },
    { "ÖBB": { urlTemplate: "old", journeyUrlTemplate, dateFormat: "yyyy-MM-dd", stationNames: {} } },
  );
  assert.strictEqual(out["ÖBB"].urlTemplate, "https://new");
  assert.strictEqual(out["ÖBB"].journeyUrlTemplate, journeyUrlTemplate);
  assert.strictEqual(out["ÖBB"].dateFormat, "yyyy-MM-dd");
});
check("booking set can update and clear bookingPageUrl explicitly", () => {
  const updated = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "PKP", bookingPageUrl: "https://ebilet.intercity.pl/" },
    { PKP: { bookingPageUrl: "https://old" } },
  );
  assert.strictEqual(updated.PKP.bookingPageUrl, "https://ebilet.intercity.pl/");
  const cleared = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "PKP", bookingPageUrl: "" },
    { PKP: { bookingPageUrl: "https://old" } },
  );
  assert.strictEqual(cleared.PKP.bookingPageUrl, null);
});
check("booking set preserves existing stationNames", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "ÖBB", urlTemplate: "https://new" },
    { "ÖBB": { urlTemplate: "old", stationNames: { A: "a" } } },
  );
  assert.strictEqual(out["ÖBB"].urlTemplate, "https://new");
  assert.deepStrictEqual(out["ÖBB"].stationNames, { A: "a" });
});
check("booking set with deals link", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "set",
    { agencyId: "ES", dealsUrl: "https://deals", dealsLabel: "Deals" },
    {},
  );
  assert.strictEqual(out.ES.dealsUrl, "https://deals");
  assert.strictEqual(out.ES.dealsLabel, "Deals");
  assert.strictEqual(out.ES.urlTemplate, null);
});
check("booking setStationName adds a mapping", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "setStationName",
    { agencyId: "ÖBB", stationName: "Amsterdam Centraal", bookingName: "Amsterdam" },
    { "ÖBB": { urlTemplate: "u", stationNames: {} } },
  );
  assert.strictEqual(out["ÖBB"].stationNames["Amsterdam Centraal"], "Amsterdam");
  // existing config preserved
  assert.strictEqual(out["ÖBB"].urlTemplate, "u");
});
check("booking removeStationName drops a mapping", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "removeStationName",
    { agencyId: "ÖBB", stationName: "Amsterdam Centraal" },
    { "ÖBB": { stationNames: { "Amsterdam Centraal": "Amsterdam", "Basel SBB": "Basel" } } },
  );
  assert.ok(!("Amsterdam Centraal" in out["ÖBB"].stationNames));
  assert.strictEqual(out["ÖBB"].stationNames["Basel SBB"], "Basel");
});
check("booking remove deletes the operator", () => {
  const out = applyOverrideMutation(
    "operator-booking",
    "remove",
    { agencyId: "ÖBB" },
    { "ÖBB": { urlTemplate: "u" }, ES: { dealsUrl: "d" } },
  );
  assert.ok(!("ÖBB" in out));
  assert.ok("ES" in out);
});
throws("booking setStationName rejects empty bookingName", () =>
  applyOverrideMutation(
    "operator-booking",
    "setStationName",
    { agencyId: "ÖBB", stationName: "X", bookingName: "" },
    {},
  ),
);
throws("booking set rejects empty agencyId", () =>
  applyOverrideMutation("operator-booking", "set", { agencyId: "" }, {}),
);

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

// station-aliases
check("alias set", () => {
  const out = applyOverrideMutation(
    "station-aliases",
    "set",
    { alias: "Venedig Santa Lucia", canonical: "Venezia Santa Lucia" },
    { "rom termini": "Roma Termini" },
  );
  // key should be lowercased
  assert.strictEqual(out["venedig santa lucia"], "Venezia Santa Lucia");
  // existing entries preserved
  assert.strictEqual(out["rom termini"], "Roma Termini");
});
check("alias set lowercases the key", () => {
  const out = applyOverrideMutation(
    "station-aliases",
    "set",
    { alias: "BRÜSSEL MIDI", canonical: "Bruxelles Midi" },
    {},
  );
  assert.strictEqual(out["brüssel midi"], "Bruxelles Midi");
  assert.ok(!("BRÜSSEL MIDI" in out));
});
check("alias remove", () => {
  const out = applyOverrideMutation(
    "station-aliases",
    "remove",
    { alias: "rom termini" },
    { "rom termini": "Roma Termini", "venedig": "Venezia" },
  );
  assert.ok(!("rom termini" in out));
  assert.strictEqual(out["venedig"], "Venezia");
});
check("alias set on null current", () => {
  const out = applyOverrideMutation(
    "station-aliases",
    "set",
    { alias: "prag hbf", canonical: "Praha hl.n." },
    null,
  );
  assert.strictEqual(out["prag hbf"], "Praha hl.n.");
});
throws("alias set rejects empty alias", () =>
  applyOverrideMutation("station-aliases", "set", { alias: "", canonical: "Foo" }, {}),
);
throws("alias set rejects empty canonical", () =>
  applyOverrideMutation("station-aliases", "set", { alias: "foo", canonical: "" }, {}),
);

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

// source-registry (array of entries keyed by id)
const REGISTRY_FIXTURE = [
  { id: "nightjet", enabled: true, params: { countryCodes: [80] } },
  { id: "cd", enabled: true, params: {} },
];
check("registry setEnabled toggles one entry", () => {
  const out = applyOverrideMutation(
    "source-registry",
    "setEnabled",
    { id: "cd", enabled: false },
    REGISTRY_FIXTURE,
  );
  assert.strictEqual(out.find((e) => e.id === "cd").enabled, false);
  assert.strictEqual(out.find((e) => e.id === "nightjet").enabled, true);
});
check("registry setParams replaces params", () => {
  const out = applyOverrideMutation(
    "source-registry",
    "setParams",
    { id: "nightjet", params: { countryCodes: [80, 81] } },
    REGISTRY_FIXTURE,
  );
  assert.deepStrictEqual(out.find((e) => e.id === "nightjet").params, {
    countryCodes: [80, 81],
  });
});
check("registry set upserts an entry", () => {
  const entry = { id: "new-src", enabled: false, params: {} };
  const out = applyOverrideMutation(
    "source-registry",
    "set",
    { id: "new-src", entry },
    REGISTRY_FIXTURE,
  );
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out[2], entry);
});
check("registry remove deletes an entry", () => {
  const out = applyOverrideMutation(
    "source-registry",
    "remove",
    { id: "cd" },
    REGISTRY_FIXTURE,
  );
  assert.deepStrictEqual(out.map((e) => e.id), ["nightjet"]);
});
throws("registry setEnabled rejects unknown id", () =>
  applyOverrideMutation("source-registry", "setEnabled", { id: "nope", enabled: true }, REGISTRY_FIXTURE),
);
throws("registry setEnabled rejects non-boolean", () =>
  applyOverrideMutation("source-registry", "setEnabled", { id: "cd", enabled: "yes" }, REGISTRY_FIXTURE),
);
throws("registry setParams rejects non-object params", () =>
  applyOverrideMutation("source-registry", "setParams", { id: "cd", params: [1] }, REGISTRY_FIXTURE),
);
throws("registry set rejects id mismatch", () =>
  applyOverrideMutation("source-registry", "set", { id: "cd", entry: { id: "other" } }, REGISTRY_FIXTURE),
);

// every declared file path looks sane
check("OVERRIDE_FILES paths live under data/ and are JSON", () => {
  for (const p of Object.values(OVERRIDE_FILES)) {
    assert.ok(p.startsWith("data/") && p.endsWith(".json"), p);
  }
});

console.log(`\n[verify-overrides] ${passed} checks passed`);
