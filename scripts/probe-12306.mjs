// scripts/probe-12306.mjs
// One-shot reconnaissance for the China Railway adapter: kyfw.12306.cn may
// block some egress (dev sandbox / Actions IPs). Run from CI ("Probe 12306
// source" workflow), download the artifact, then finalize/enable the chinese
// adapter against real responses.
//
// Read-only: session init + schedule JSON + station_name.js. No login/booking.
// Run: node scripts/probe-12306.mjs [outputDir]

import fs from "node:fs";
import path from "node:path";
import {
  createCookieJar,
  datePlusDays,
  fetchStationNamesJs,
  findTrainInLeftTicket,
  initSession,
  KYFW_BASE,
  parseQueryByTrainNoResponse,
  parseStationNamesJs,
  queryByTrainNo,
  queryLeftTicket,
  queryTicketPrice,
  USER_AGENT,
} from "./lib/12306.mjs";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const outDir = process.argv[2] ?? null;

// Beijing West (BXP) → Lhasa (LSO); Z21 is a known overnight sleeper.
const SAMPLE = {
  fromTelecode: "BXP",
  toTelecode: "LSO",
  trainCode: "Z21",
  dateOffsetDays: 3,
};

function save(name, body) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  fs.writeFileSync(path.join(outDir, name), text.slice(0, MAX_SNAPSHOT_BYTES));
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

const summary = {
  ok: false,
  steps: {},
  errors: [],
};

console.log(`[probe-12306] base=${KYFW_BASE} ua=${USER_AGENT}`);

const jar = createCookieJar();

// 1. Session cookie
try {
  const session = await initSession(fetch, jar);
  summary.steps.session = { ok: session.ok, status: session.status, cookies: !!jar.header() };
  console.log(`\n━━━ session init\n  status: ${session.status} | cookies: ${jar.header() ? "yes" : "no"}`);
  save("01-session.json", summary.steps.session);
} catch (err) {
  summary.errors.push(`session: ${err.message}`);
  console.log(`\n━━━ session init\n  FAILED: ${err.message}`);
}

// 2. station_name.js
try {
  const stations = await fetchStationNamesJs(fetch, jar);
  const sample = [...stations.byTelecode.entries()].slice(0, 5).map(([k, v]) => ({
    telecode: k,
    chineseName: v.chineseName,
    pinyin: v.pinyin,
  }));
  summary.steps.stationNames = {
    ok: true,
    count: stations.byTelecode.size,
    sample,
    hasBXP: stations.byTelecode.has("BXP"),
    hasLSO: stations.byTelecode.has("LSO"),
  };
  console.log(
    `\n━━━ station_name.js\n  stations: ${stations.byTelecode.size} | BXP: ${summary.steps.stationNames.hasBXP} | LSO: ${summary.steps.stationNames.hasLSO}`,
  );
  console.log(`  sample: ${sample.map((s) => `${s.telecode}=${s.chineseName}`).join(", ")}`);
  save("02-station_name-head.js", stations.text.slice(0, 8000));
  save("02-station_name-meta.json", summary.steps.stationNames);
} catch (err) {
  summary.errors.push(`station_name: ${err.message}`);
  console.log(`\n━━━ station_name.js\n  FAILED: ${err.message}`);
}

// 3. leftTicket queryO for BXP→LSO
const date = datePlusDays(todayUtc(), SAMPLE.dateOffsetDays);
try {
  const lt = await queryLeftTicket(
    { date, fromTelecode: SAMPLE.fromTelecode, toTelecode: SAMPLE.toTelecode },
    { fetchImpl: fetch, jar },
  );
  const match = findTrainInLeftTicket(lt.trains, SAMPLE.trainCode);
  summary.steps.leftTicket = {
    ok: true,
    date,
    endpoint: lt.endpoint,
    trainCount: lt.trains.length,
    zCodes: lt.trains.filter((t) => /^Z/i.test(t.trainCode)).map((t) => t.trainCode).slice(0, 20),
    match: match
      ? {
          trainCode: match.trainCode,
          trainNo: match.trainNo,
          departTime: match.departTime,
          arriveTime: match.arriveTime,
          softSleeper: match.softSleeper,
          hardSleeper: match.hardSleeper,
          fromStationNo: match.fromStationNo,
          toStationNo: match.toStationNo,
          seatTypes: match.seatTypes,
        }
      : null,
  };
  console.log(
    `\n━━━ leftTicket ${lt.endpoint}\n  date: ${date} | trains: ${lt.trains.length} | ${SAMPLE.trainCode}: ${match ? match.trainNo : "NOT FOUND"}`,
  );
  save("03-leftTicket.json", {
    endpoint: lt.endpoint,
    trainCount: lt.trains.length,
    trains: lt.trains.slice(0, 30),
    match,
  });

  // 4. queryByTrainNo for the matched Z21
  if (match?.trainNo) {
    try {
      const sched = await queryByTrainNo(
        {
          trainNo: match.trainNo,
          fromTelecode: match.fromTelecode || SAMPLE.fromTelecode,
          toTelecode: match.toTelecode || SAMPLE.toTelecode,
          date,
        },
        { fetchImpl: fetch, jar },
      );
      summary.steps.queryByTrainNo = {
        ok: true,
        stopCount: sched.stops.length,
        stops: sched.stops,
      };
      console.log(`\n━━━ queryByTrainNo\n  stops: ${sched.stops.length}`);
      for (const s of sched.stops.slice(0, 8)) {
        console.log(`    ${s.stationNo} ${s.nameZh} arr=${s.arrival ?? "-"} dep=${s.departure ?? "-"}`);
      }
      if (sched.stops.length > 8) console.log(`    … +${sched.stops.length - 8} more`);
      save("04-queryByTrainNo.json", { stops: sched.stops, rawKeys: Object.keys(sched.raw ?? {}) });
    } catch (err) {
      summary.errors.push(`queryByTrainNo: ${err.message}`);
      console.log(`\n━━━ queryByTrainNo\n  FAILED: ${err.message}`);
    }

    // 5. queryTicketPrice — the berth fare the nightly scrape stamps on the route.
    try {
      const price = await queryTicketPrice(
        {
          trainNo: match.trainNo,
          fromStationNo: match.fromStationNo,
          toStationNo: match.toStationNo,
          seatTypes: match.seatTypes,
          date,
        },
        { fetchImpl: fetch, jar },
      );
      summary.steps.ticketPrice = { ok: !!price.fare, url: price.url, fare: price.fare, rawData: price.raw?.data ?? null };
      console.log(`\n━━━ queryTicketPrice\n  url: ${price.url}`);
      console.log(`  raw: ${JSON.stringify(price.raw?.data ?? price.raw).slice(0, 400)}`);
      console.log(
        price.fare
          ? `  fare: from ¥${price.fare.fromPrice} (${price.fare.seatClass}) — ${JSON.stringify(price.fare.classes)}`
          : "  fare: NO BERTH CLASS PRICED — check SLEEPER_FARE_CLASSES against the raw keys above",
      );
      save("05-queryTicketPrice.json", price.raw);
    } catch (err) {
      summary.errors.push(`queryTicketPrice: ${err.message}`);
      console.log(`\n━━━ queryTicketPrice\n  FAILED: ${err.message}`);
    }
  } else {
    summary.errors.push("queryByTrainNo skipped — no leftTicket match for Z21");
  }
} catch (err) {
  summary.errors.push(`leftTicket: ${err.message}`);
  console.log(`\n━━━ leftTicket\n  FAILED: ${err.message}`);
}

summary.ok =
  summary.steps.session?.ok &&
  summary.steps.stationNames?.ok &&
  summary.steps.leftTicket?.ok &&
  summary.steps.queryByTrainNo?.ok &&
  summary.steps.ticketPrice?.ok;

save("00-summary.json", summary);
console.log(
  `\n[probe-12306] ${summary.ok ? "OK — parsers can be finalized/enabled" : "PARTIAL/FAILED — see errors"}`,
);
if (summary.errors.length) console.log(`  errors: ${summary.errors.join("; ")}`);
if (outDir) console.log(`  snapshots: ${outDir}/`);

// Exit non-zero on hard failure so the workflow is visible as failed, but still
// upload whatever we captured (workflow uses upload-artifact after this step
// with if: always() — see probe-12306.yml).
process.exitCode = summary.ok ? 0 : 1;
