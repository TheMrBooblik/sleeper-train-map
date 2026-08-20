// tests/verify-es-timetable.mjs
// Unit tests for the European Sleeper timetable-page parser
// (scripts/lib/es-timetable.mjs), which is the operator's own source of truth
// for stops and times. The fixture in tests/fixtures/es-timetable is the real
// markup from https://www.europeansleeper.eu/timetable, so these run offline —
// the scrape sandbox has no egress to that host.
// Raw node, no network. Run: npm run verify-es-timetable
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTimetableHtml,
  serviceDaysFromHtml,
} from "../scripts/lib/es-timetable.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "es-timetable",
  "timetable.html",
);
const html = fs.readFileSync(FIXTURE, "utf8");
const journeys = parseTimetableHtml(html);
const byTrain = Object.fromEntries(journeys.map((j) => [j.train, j]));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("every rendered train block becomes a journey", () => {
  assert.deepStrictEqual(
    journeys.map((j) => j.train),
    ["ES 474", "ES 452"],
  );
  assert.strictEqual(byTrain["ES 474"].stops.length, 7);
  assert.strictEqual(byTrain["ES 452"].stops.length, 14);
});

check("the bold time is the departure, the trailing note is the arrival", () => {
  // Getting this backwards is the whole risk of the format: Aulnoye-Aymeries
  // arrives 08:47 and leaves 09:02, a 15-minute stand that would read as a
  // 15-minute-early departure if the two were swapped.
  const stop = byTrain["ES 474"].stops.find((s) => s.name === "Aulnoye-Aymeries");
  assert.strictEqual(stop.arrival, "08:47");
  assert.strictEqual(stop.departure, "09:02");
});

check("the first stop has only a departure", () => {
  const first = byTrain["ES 474"].stops[0];
  assert.strictEqual(first.name, "Berlin Gesundbrunnen");
  assert.strictEqual(first.departure, "17:25");
  assert.strictEqual(first.arrival, null);
});

check("the last stop has only an arrival", () => {
  // It carries no "Arrival" note, so its bold time is the arrival — not a
  // departure from a station the train terminates at.
  const last = byTrain["ES 474"].stops[byTrain["ES 474"].stops.length - 1];
  assert.strictEqual(last.name, "Paris Nord");
  assert.strictEqual(last.arrival, "11:23");
  assert.strictEqual(last.departure, null);
});

check("an overnight run keeps its stops in page order, not clock order", () => {
  // ES 452 leaves Prague at 18:00 and reaches Deventer at 05:09 the next
  // morning; sorting by time would scramble the night.
  const names = byTrain["ES 452"].stops.map((s) => s.name);
  assert.strictEqual(names[0], "Prague hl.n. (main station)");
  assert.strictEqual(names[5], "Berlin Gesundbrunnen");
  assert.strictEqual(names[6], "Deventer");
  assert.strictEqual(names[names.length - 1], "Bruxelles-Midi");
  assert.strictEqual(byTrain["ES 452"].stops[5].departure, "23:01");
  assert.strictEqual(byTrain["ES 452"].stops[6].arrival, "05:09");
});

check("endpoints come off the header table and agree with the stop list", () => {
  for (const j of journeys) {
    assert.strictEqual(j.origin, j.stops[0].name, `${j.train} origin`);
    assert.strictEqual(
      j.destination,
      j.stops[j.stops.length - 1].name,
      `${j.train} destination`,
    );
  }
});

check("station names keep the operator's spelling for the alias layer", () => {
  // Canonicalization happens downstream; the parser must not quietly rewrite
  // names or the alias table can never be checked against what the page says.
  const names = byTrain["ES 452"].stops.map((s) => s.name);
  assert.ok(names.includes("Prague hl.n. (main station)"));
  assert.ok(names.includes("Usti nad Labem hl.n."));
  assert.ok(names.includes("Den Haag HS"));
  assert.ok(byTrain["ES 474"].stops.some((s) => s.name === "Liège-Guillemins"));
});

check("service days are read from the prose, per named train", () => {
  const days = serviceDaysFromHtml(html);
  assert.deepStrictEqual(days["452"], ["tue", "thu", "sun"]);
  assert.deepStrictEqual(days["453"], ["mon", "wed", "fri"]);
  assert.deepStrictEqual(days["474"], ["mon", "wed", "fri"]);
  assert.deepStrictEqual(days["475"], ["tue", "thu", "sun"]);
  assert.strictEqual(byTrain["ES 474"].daysOfWeek.join(","), "mon,wed,fri");
});

check("the Milan paragraph names no train, so no days are guessed for it", () => {
  // "(Brussels > Milan) departs on Monday, Thursday and Saturday." has no train
  // number, and 400/401 must not inherit another train's days by accident.
  const days = serviceDaysFromHtml(html);
  assert.strictEqual(days["400"], undefined);
  assert.strictEqual(days["401"], undefined);
});

check("days come back in week order regardless of how the sentence reads", () => {
  const days = serviceDaysFromHtml(
    "<p>Train ES 999 (A &gt; B) departs on Sunday, Wednesday and Monday.</p>",
  );
  assert.deepStrictEqual(days["999"], ["mon", "wed", "sun"]);
});

check("degenerate input yields nothing rather than throwing", () => {
  assert.deepStrictEqual(parseTimetableHtml(""), []);
  assert.deepStrictEqual(parseTimetableHtml(null), []);
  assert.deepStrictEqual(parseTimetableHtml("<html><body>no trains</body></html>"), []);
  assert.deepStrictEqual(serviceDaysFromHtml(""), {});
});

check("a block with fewer than two stops is dropped", () => {
  const one = `<h3>Train ES 900</h3><div class="stops">
    <div class="flex"><b>10:00</b><span class="flex-col stop">Somewhere</span></div>
  </div>`;
  assert.deepStrictEqual(parseTimetableHtml(one), []);
});

console.log(`\n[verify-es-timetable] ${passed} checks passed`);
