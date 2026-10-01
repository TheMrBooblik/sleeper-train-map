// tests/verify-fx.mjs
// The approximate euro figure printed beside a fare in another currency
// (src/lib/fx.mjs) and the nightly source of its rates
// (scripts/adapters/ecb-fx.mjs). Run: npm run verify-fx

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseEcbDaily, run } from "../scripts/adapters/ecb-fx.mjs";
import { EUR_RATES, eurHintFor, eurRateNote, formatEurApprox, toEur } from "../src/lib/fx.mjs";
import { validateRegistry } from "../scripts/lib/registry.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sources/registry.json"), "utf8"));
const entry = registry.find((e) => e.id === "ecb-fx");

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks++;
  console.log(`  ✓ ${name}`);
};

// The ECB's daily file, in the shape it has had for two decades (single quotes).
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-09-25'>
      <Cube currency='USD' rate='1.1712'/>
      <Cube currency='JPY' rate='180.84'/>
      <Cube currency='CNY' rate='8.3031'/>
      <Cube currency='SEK' rate='10.912'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const TABLE = { date: "2026-09-25", rates: { JPY: 180, CNY: 8, SEK: 10 } };

await check("the ECB file parses to a dated table of units per euro", () => {
  const { date, rates } = parseEcbDaily(ECB_XML);
  assert.equal(date, "2026-09-25");
  assert.deepEqual(rates, { USD: 1.1712, JPY: 180.84, CNY: 8.3031, SEK: 10.912 });
  assert.throws(() => parseEcbDaily("<html>maintenance</html>"), /no dated rates/);
});

await check("an amount converts at the table's rate", () => {
  assert.equal(toEur(18000, "JPY", TABLE), 100);
  assert.equal(toEur(100, "EUR", TABLE), null, "a euro fare needs no euro figure");
  assert.equal(toEur(100, "GEL", TABLE), null, "no rate, no figure");
  assert.equal(toEur(null, "JPY", TABLE), null);
});

await check("the figure reads '≈ €87': whole euros, grouped, one decimal below €10", () => {
  assert.equal(formatEurApprox(16040, "JPY", TABLE), "≈ €89");
  assert.equal(formatEurApprox(720, "CNY", TABLE), "≈ €90");
  assert.equal(formatEurApprox(15, "SEK", TABLE), "≈ €1.5");
  assert.equal(formatEurApprox(900000, "JPY", TABLE), "≈ €5,000");
  assert.equal(formatEurApprox(39, "EUR", TABLE), "");
  assert.equal(eurHintFor({ fromPrice: 16040, currency: "JPY" }, TABLE), "≈ €89");
  assert.equal(eurHintFor(null, TABLE), "");
  assert.match(eurRateNote(TABLE), /25 Sep 2026/);
});

await check("the committed rates cover every currency a published fare is quoted in", () => {
  const published = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/published/initial-data.json"), "utf8"));
  const payload = published.data ?? published;
  const currencies = new Set();
  for (const row of Object.values(payload.viewMap)) {
    for (const key of ["pricing", "fare_0", "fare_1"]) {
      if (row[key]?.currency && row[key].fromPrice != null) currencies.add(row[key].currency);
    }
  }
  currencies.delete("EUR");
  for (const c of currencies) assert.ok(EUR_RATES?.rates?.[c] > 0, `a rate for ${c}`);
  assert.match(EUR_RATES.date, /^\d{4}-\d{2}-\d{2}$/);
});

await check("the registry runs it nightly, and a bad night keeps the last rates", async () => {
  assert.ok(entry, "registry has an ecb-fx entry");
  assert.deepEqual(validateRegistry(registry), []);
  assert.equal(entry.endpoint, entry.params.feedUrl);
  assert.equal(entry.synthetic ?? null, null, "it feeds no route");

  const written = {};
  const ctx = (body, status = 200) => ({
    today: "2026-09-28",
    fetch: async () => ({ ok: status === 200, status, text: async () => body }),
    write: (file, data) => {
      written[file] = data;
    },
  });
  const quiet = console.log;
  console.log = () => {};
  try {
    await run(entry, ctx(ECB_XML));
    assert.equal(written[entry.output].date, "2026-09-25");
    assert.equal(written[entry.output].rates.JPY, 180.84);

    delete written[entry.output];
    await assert.rejects(() => run(entry, ctx("", 503)), /HTTP 503/);
    await assert.rejects(
      () => run(entry, ctx(ECB_XML.replace(/<Cube currency='CNY'[^>]*\/>/, ""))),
      /lack CNY/,
    );
    assert.equal(written[entry.output], undefined, "nothing is written over the last good rates");
  } finally {
    console.log = quiet;
  }
});

console.log(`\n[verify-fx] ${checks} checks passed`);
