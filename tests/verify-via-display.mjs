// tests/verify-via-display.mjs
// Unit tests for Train Details via summarisation (src/lib/viaDisplay.mjs).
// Run: npm run verify-via-display

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMajorViaContext,
  isMajorViaStation,
  majorViaScore,
  selectMajorViaStations,
} from "../src/lib/viaDisplay.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED = path.join(__dirname, "..", "public/data/published/initial-data.json");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const emptyCtx = buildMajorViaContext({});

check("empty / null via returns null", () => {
  assert.strictEqual(selectMajorViaStations(null, emptyCtx), null);
  assert.strictEqual(selectMajorViaStations("", emptyCtx), null);
  assert.strictEqual(selectMajorViaStations("   ", emptyCtx), null);
});

check("via with no major stops returns null", () => {
  const via = "Videle - Roșiori Nord - Caracal - Lugoj";
  assert.strictEqual(selectMajorViaStations(via, emptyCtx), null);
});

check("up to three major stops are kept in route order", () => {
  const via = "Berlin Hbf - Leipzig Hbf - Dresden Hbf";
  const ctx = buildMajorViaContext({});
  assert.strictEqual(selectMajorViaStations(via, ctx), via);
});

check("more than three majors: highest-scored stops, route order on ties", () => {
  const via =
    "Berlin Hbf - Leipzig Hbf - Dresden Hbf - München Hbf - Nürnberg Hbf";
  const ctx = buildMajorViaContext({});
  // Berlin/Leipzig/München are on the always-show list (score 4); Dresden/Nürnberg
  // only match the Hbf suffix (score 2).
  assert.strictEqual(
    selectMajorViaStations(via, ctx),
    "Berlin Hbf - Leipzig Hbf - München Hbf",
  );
});

check("endpoint on another route counts as major", () => {
  const viewMap = {
    hub: {
      origin_trip_0: "Winnipeg",
      destination_trip_0: "Churchill",
    },
  };
  const ctx = buildMajorViaContext(viewMap);
  const via =
    "Gladstone - Plumas - Glenella - Winnipeg - Dauphin - The Pas";
  assert.ok(isMajorViaStation("Winnipeg", ctx));
  assert.strictEqual(selectMajorViaStations(via, ctx), "Winnipeg");
});

check("Polish Główny stations qualify as major", () => {
  const via =
    "Knin - Wrocław Główny - Poznań Główny - Toruń Główny - Gdańsk Główny";
  const ctx = buildMajorViaContext({});
  assert.strictEqual(
    selectMajorViaStations(via, ctx),
    "Wrocław Główny - Poznań Główny - Toruń Główny",
  );
});

check("city token does not false-match Boston Bar", () => {
  const ctx = buildMajorViaContext({});
  assert.strictEqual(majorViaScore("Boston Bar", ctx), 0);
});

check("Amtrak-style city names match major tokens", () => {
  const ctx = buildMajorViaContext({});
  assert.ok(majorViaScore("Milwaukee", ctx) > 0);
  assert.ok(majorViaScore("St. Paul-Minneapolis", ctx) > 0);
  assert.ok(majorViaScore("Spokane", ctx) > 0);
});

// Long-route fixtures from published data when available (offline, no network).
if (fs.existsSync(PUBLISHED)) {
  const { data } = JSON.parse(fs.readFileSync(PUBLISHED, "utf8"));
  const viewMap = data.viewMap;
  const ctx = buildMajorViaContext(viewMap);

  check("VIA Canadian: at most 3 hub cities in route order", () => {
    const row = Object.values(viewMap).find(
      (r) => r.route_id === "via_Vancouver_-_Toronto",
    );
    assert.ok(row?.via_0, "fixture route missing");
    const summary = selectMajorViaStations(row.via_0, ctx);
    assert.ok(summary, "expected a via summary");
    assert.ok(summary.split(" - ").length <= 3);
    assert.strictEqual(summary, "Winnipeg - Saskatoon - Edmonton");
  });

  check("Empire Builder: at most 3 major stops", () => {
    const row = Object.values(viewMap).find(
      (r) => r.route_id === "amtrak_Empire_Builder",
    );
    assert.ok(row?.via_0, "fixture route missing");
    const summary = selectMajorViaStations(row.via_0, ctx);
    assert.strictEqual(
      summary,
      "Spokane - Whitefish Amtrak Station - Fargo Amtrak Station",
    );
  });

  check("EC 460: allowlisted / main stations beat plain intermediates", () => {
    const row = Object.values(viewMap).find((r) =>
      String(r.trip_short_name_0 || "").includes("EC 460"),
    );
    assert.ok(row?.via_0, "fixture route missing");
    const summary = selectMajorViaStations(row.via_0, ctx);
    assert.strictEqual(
      summary,
      "Praha hlavní nádraží - Wrocław Główny - Poznań Główny",
    );
  });
}

console.log(`\n${passed} passed`);
