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
//
// These assert PROPERTIES, not a literal summary, because the input is nightly
// data and not a fixture. The Empire Builder check used to pin
// "Spokane - Whitefish - Fargo" and went red on its own: Amtrak's feed now
// publishes the eastbound trip as the representative one, so via_0 reads
// Chicago→Seattle and the summary is "Milwaukee - St. Paul-Minneapolis -
// Fargo". Both answers are correct — the function did exactly its job on the
// via list it was given — and pinning the string tested which direction Amtrak
// felt like publishing. That is a landmine now that the branch-refresh workflow
// regenerates this payload on a label, so the invariants the function actually
// promises are what these assert: at most three, every one of them major, and
// in the order they appear in the route.
if (fs.existsSync(PUBLISHED)) {
  const { data } = JSON.parse(fs.readFileSync(PUBLISHED, "utf8"));
  const viewMap = data.viewMap;
  const ctx = buildMajorViaContext(viewMap);

  const checkSummary = (label, via) => {
    const summary = selectMajorViaStations(via, ctx);
    assert.ok(summary, `${label}: expected a via summary`);
    const picked = summary.split(" - ");
    assert.ok(picked.length <= 3, `${label}: at most three stops, got ${picked.length}`);
    const all = via.split(" - ").map((n) => n.trim());
    for (const name of picked) {
      assert.ok(isMajorViaStation(name, ctx), `${label}: ${name} is not a major station`);
      assert.ok(all.includes(name), `${label}: ${name} is not on the route`);
    }
    const positions = picked.map((n) => all.indexOf(n));
    assert.deepStrictEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `${label}: stops must stay in route order`,
    );
    // The ranking itself: an allowlisted hub or a main station must never lose
    // its place to a plain intermediate. Asserted as "nothing left out scores
    // higher than anything kept", which is the property the literals above were
    // standing in for — and unlike them it holds whichever direction the feed
    // publishes.
    const chosen = new Set(picked);
    const scoreOf = (n) => majorViaScore(n, ctx);
    const lowestKept = Math.min(...picked.map(scoreOf));
    for (const name of all) {
      if (chosen.has(name)) continue;
      assert.ok(
        scoreOf(name) <= lowestKept,
        `${label}: ${name} (${scoreOf(name)}) outranks a kept stop (${lowestKept})`,
      );
    }
    return summary;
  };

  check("VIA Canadian: at most 3 hub cities in route order", () => {
    const row = Object.values(viewMap).find(
      (r) => r.route_id === "via_Vancouver_-_Toronto",
    );
    assert.ok(row?.via_0, "fixture route missing");
    checkSummary("VIA Canadian", row.via_0);
  });

  check("Empire Builder: at most 3 major stops", () => {
    const row = Object.values(viewMap).find(
      (r) => r.route_id === "amtrak_Empire_Builder",
    );
    assert.ok(row?.via_0, "fixture route missing");
    checkSummary("Empire Builder", row.via_0);
  });

  check("EC 460: allowlisted / main stations beat plain intermediates", () => {
    const row = Object.values(viewMap).find((r) =>
      String(r.trip_short_name_0 || "").includes("EC 460"),
    );
    assert.ok(row?.via_0, "fixture route missing");
    // Its literal drifted too, for the same reason and unnoticed behind the
    // Empire Builder's: the PKP enrichment rewrote this row's stop list, so the
    // answer is now "Wrocław Główny - Poznań Główny - Toruń Główny". The
    // ranking assertion in checkSummary is what this check was really for.
    checkSummary("EC 460", row.via_0);
  });
}

console.log(`\n${passed} passed`);
