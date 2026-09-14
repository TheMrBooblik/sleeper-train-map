// tests/verify-official-row.mjs
// The detail panel was rendering Back-on-Track's copy of a timetable the
// operator had already replaced. Run: npm run verify-official-row
//
// Enrichment corrects the ROW and never the trips table (the upstream
// Back-on-Track export), so anything reading `trip.origin_departure_time`,
// `trip.via`, `trip.duration` or `trip.service_id` on a corroborated row shows
// the superseded value — while the map line, the bottom bar and the connection
// page, all of which read the row, show the corrected one.
//
// Two halves here: the pure function, and the measurement against the committed
// payload that says how much it was worth. The second is what makes a
// regression loud — reverting the panel's tier leaves these numbers standing.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  officialRowSchedule,
  durationMinutesBetween,
  formatDurationShort,
} from "../src/lib/officialRowSchedule.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(TESTS_DIR, "..");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const ROW = {
  route_id: 107,
  official_sources: ["sncf"],
  trip_short_name_0: "IC Nuit 5789",
  origin_departure_time_0: "20:57",
  destination_arrival_time_0: "08:24",
  via_0: "Crest - Die - Gap",
  service_id_0: "2026: Daily",
  origin_departure_time_1: "19:57",
  destination_arrival_time_1: "07:52",
  via_1: "Gap - Die - Crest",
  service_id_1: "2026: Mon, Fri",
};

check("an unstamped row answers null, so it keeps Back-on-Track's everything", () => {
  assert.equal(officialRowSchedule({ ...ROW, official_sources: [] }, 0), null);
  assert.equal(officialRowSchedule({ ...ROW, official_sources: undefined }, 0), null);
  assert.equal(officialRowSchedule(null, 0), null);
});

check("each direction reads its own suffix", () => {
  assert.equal(officialRowSchedule(ROW, 0).departure, "20:57");
  assert.equal(officialRowSchedule(ROW, 1).departure, "19:57");
  assert.equal(officialRowSchedule(ROW, 0).serviceDays, "2026: Daily");
  assert.equal(officialRowSchedule(ROW, 1).serviceDays, "2026: Mon, Fri");
});

check("anything but direction 1 reads as 0, matching resolveScheduleLink", () => {
  for (const d of [0, "0", null, undefined, 2, ""])
    assert.equal(officialRowSchedule(ROW, d).via, "Crest - Die - Gap");
  assert.equal(officialRowSchedule(ROW, "1").via, "Gap - Die - Crest");
});

check("duration is measured, and wraps past midnight", () => {
  // 20:57 → 08:24 is a night train, not a negative number.
  assert.equal(durationMinutesBetween("20:57", "08:24"), 687);
  assert.equal(formatDurationShort(687), "11h 27m");
  assert.equal(officialRowSchedule(ROW, 0).durationText, "11h 27m");
  // Same-day is not special-cased into a wrap.
  assert.equal(durationMinutesBetween("08:00", "17:30"), 570);
  assert.equal(formatDurationShort(570), "9h 30m");
  assert.equal(formatDurationShort(120), "2h");
  assert.equal(durationMinutesBetween("20:57", null), null);
  assert.equal(officialRowSchedule({ ...ROW, destination_arrival_time_0: "" }, 0).durationText, "");
});

check("a stamped row carrying nothing to say still answers null", () => {
  assert.equal(officialRowSchedule({ official_sources: ["sncf"] }, 0), null);
});

// ── the panel's precedence, asserted against its source ────────────────────
// The defect was ordering, so ordering is what there is to assert — the same
// reason verify-via-schedule reads the panel's feed chain rather than its output
// (the component imports extensionless specifiers and will not load in raw node).
{
  const panel = fs.readFileSync(
    path.join(ROOT, "src/components/TrainDetailPanel/TrainDetailPanel.js"),
    "utf8",
  );

  check("the panel consults the corrected row at all", () => {
    assert.match(panel, /officialRowSchedule\(\s*tripRoute,\s*trip\.direction_id,?\s*\)/);
  });

  // A per-operator feed knows this train first-hand and must keep winning; the
  // row's corrected value only has to beat Back-on-Track's trip.
  const before = (a, b, where) => {
    const i = panel.indexOf(a);
    const j = panel.indexOf(b, i < 0 ? 0 : i);
    assert.ok(i >= 0, `${where}: "${a}" not found`);
    assert.ok(j > i, `${where}: expected "${a}" before "${b}"`);
  };

  check("times: feeds, then the corrected row, then the trip", () => {
    // The departure tile.
    const tile = panel.slice(panel.indexOf("{pkpOriginDeparture ||"));
    for (const feed of ["naOriginDeparture", "esOriginDeparture"])
      assert.ok(
        tile.indexOf(feed) < tile.indexOf("officialRow?.departure"),
        `${feed} must be consulted before the row`,
      );
    assert.ok(
      tile.indexOf("officialRow?.departure") < tile.indexOf("trip.origin_departure_time"),
      "the corrected row must beat the Back-on-Track trip",
    );
  });

  check("duration: the feed, then the measured row, then the trip", () => {
    before("esDuration ||", "officialRow?.durationText", "duration");
    before("officialRow?.durationText", "formatTime(trip.duration)", "duration");
  });

  check("service days: the feed, then the row, then the trip", () => {
    const freq = panel.slice(panel.indexOf("// PKP is the source of truth"));
    assert.ok(
      freq.indexOf("esSchedule?.days") < freq.indexOf("officialRow?.serviceDays"),
      "the feed's dated days must beat the row's",
    );
    assert.ok(
      freq.indexOf("officialRow?.serviceDays") < freq.indexOf("trip.service_id"),
      "the row's days must beat Back-on-Track's",
    );
  });

  check("the via summary prefers the corrected stop list over the trip's", () => {
    assert.match(panel, /esVia \|\| officialRow\?\.via \|\| trip\.via/);
  });
}

// ── what it was worth, against the committed payload ───────────────────────
{
  const published = JSON.parse(
    fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"),
  ).data;

  const hhmm = (v) => {
    const m = String(v ?? "").match(/T(\d{2}):(\d{2})/) || String(v ?? "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? `${String(Number(m[1]) % 24).padStart(2, "0")}:${m[2]}` : null;
  };
  const gap = (a, b) => {
    if (!a || !b) return 0;
    const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const d = Math.abs(m(a) - m(b));
    return Math.min(d, 1440 - d);
  };

  const tripFor = new Map();
  for (const t of Object.values(published.trips)) {
    const k = `${t.route_id}|${Number(t.direction_id) === 1 ? 1 : 0}`;
    if (!tripFor.has(k)) tripFor.set(k, t);
  }

  let stamped = 0;
  let timeDrift = 0;
  let viaDrift = 0;
  let worst = 0;
  for (const row of Object.values(published.viewMap)) {
    if (!Array.isArray(row.official_sources) || !row.official_sources.length) continue;
    stamped += 1;
    for (const d of [0, 1]) {
      const official = officialRowSchedule(row, d);
      const trip = tripFor.get(`${row.route_id}|${d}`);
      if (!official || !trip) continue;
      const worstHere = Math.max(
        gap(hhmm(official.departure), hhmm(trip.origin_departure_time)),
        gap(hhmm(official.arrival), hhmm(trip.destination_arrival_time)),
      );
      if (worstHere > 0) timeDrift += 1;
      worst = Math.max(worst, worstHere);
      if (official.via && trip.via && official.via !== trip.via) viaDrift += 1;
    }
  }

  check("the committed payload still shows why this exists", () => {
    assert.ok(stamped >= 20, `expected corroborated rows, found ${stamped}`);
    assert.ok(
      timeDrift >= 10,
      `expected the trip cards to disagree with their rows, found ${timeDrift}`,
    );
    assert.ok(worst >= 120, `expected a large worst-case drift, found ${worst} min`);
    assert.ok(viaDrift >= 30, `expected via lists to differ, found ${viaDrift}`);
    console.log(
      `      ${stamped} corroborated rows; ${timeDrift} directions where the trip ` +
        `contradicts its row on a time (worst ${worst} min); ${viaDrift} on the stop list`,
    );
  });
}

console.log(`\n✓ verify-official-row: ${passed} checks passed`);
