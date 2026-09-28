// scripts/adapters/jr-sunrise.mjs
// Sunrise Izumo / Sunrise Seto (Japan) — the nightly refresh.
//
// The trains, their stop patterns, positions and fare tariff are the committed
// baseline in data/sources/jr-sunrise.json. Each night this reads JR West's own
// pages and replaces what it can confirm:
//
//   1. JR West's Sunrise pages (params.guidePages): the berth charge per room
//      type, and the links to each train's timetable page — so a timetable id
//      JR renumbers at a timetable change is found again rather than going stale.
//   2. Each train timetable page (params.timetableUrlTemplate, for the seed ids
//      plus every id the guide links), dated params.dateOffsetDays ahead.
//      A page stands for a train only when it lists every one of that train's
//      stops in order with plausible times (scripts/lib/jr-sunrise.mjs); a train
//      no page validates keeps the baseline for all of its stops.
//
// Never fatal for the map: the trains file is always written, from the baseline
// where the pages said nothing usable. When NOTHING could be confirmed the run
// throws after writing, so source-health.json records the failure and the
// integration dashboard shows the source needs attention — a silent fallback is
// the one outcome that would look identical to a healthy night.
//
// Dev sandboxes cannot reach JR's hosts; the "Probe JR Sunrise source" workflow
// (label a PR `run-probes`) and a `refresh-data` run show what the parsers make
// of the live pages.

import fs from "node:fs";
import path from "node:path";
import {
  acceptRoomCharges,
  buildSunriseTrains,
  datePlusDays,
  discoverTimetableIds,
  expandUrlTemplate,
  makeStationMatcher,
  parseRoomCharges,
  timetableFromPage,
  validateConfig,
} from "../lib/jr-sunrise.mjs";

const FETCH_TIMEOUT_MS = 20_000;
const REQUEST_SPACING_MS = 800;
const MAX_TIMETABLE_PAGES = 12;

// Identify the client, and ask for Japanese first: JR West serves the
// timetable in Japanese, which is the spelling the station aliases carry.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; PingwiSleeperMap/1.0; +https://pingwi.com)",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Decode a response body with the charset the server or the page declares.
 * Japanese sites still serve Shift_JIS and EUC-JP; decoding those as UTF-8
 * would turn every station name into mojibake and match nothing.
 */
export function decodeBody(buffer, contentType = "") {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  const label = declared.toLowerCase().replace(/^(x-)?sjis$/, "shift_jis");
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchPage(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { url, status: res.status, html: null };
    const html = decodeBody(await res.arrayBuffer(), res.headers?.get?.("content-type") ?? "");
    return { url, status: res.status, html };
  } catch (err) {
    return { url, status: 0, html: null, error: err.message };
  }
}

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const configPath = path.join(ctx.rootDir, params.configPath ?? "data/sources/jr-sunrise.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const configProblems = validateConfig(config);
  if (configProblems.length) {
    throw new Error(`jr-sunrise config is unusable: ${configProblems.join("; ")}`);
  }

  const fetchImpl = ctx.fetch ?? fetch;
  const spacing = params.requestSpacingMs ?? REQUEST_SPACING_MS;
  const travelDate = datePlusDays(ctx.today, params.dateOffsetDays ?? 3);
  const log = (msg) => console.log(`[scrape] jr-sunrise: ${msg}`);

  // 1. The guide pages: berth charges + links to the timetable pages.
  const guides = [];
  for (const url of params.guidePages ?? []) {
    const page = await fetchPage(url, fetchImpl);
    guides.push(page);
    log(`${url} → ${page.html ? `HTTP ${page.status}, ${page.html.length} chars` : `no page (${page.error ?? `HTTP ${page.status}`})`}`);
    await sleep(spacing);
  }

  // 2. Timetable pages: the seeded ids plus every id a guide page links to.
  const ids = [
    ...new Set([...(params.seedTimetableIds ?? []), ...guides.flatMap((g) => discoverTimetableIds(g.html))]),
  ].slice(0, MAX_TIMETABLE_PAGES);
  const matchStation = makeStationMatcher(config.stations);
  const timetables = {};
  const attempts = Object.fromEntries(config.trains.map((t) => [t.lineName, []]));
  for (const id of ids) {
    if (config.trains.every((t) => timetables[t.lineName])) break;
    const url = expandUrlTemplate(params.timetableUrlTemplate, { id, date: travelDate });
    const page = await fetchPage(url, fetchImpl);
    await sleep(spacing);
    if (!page.html) {
      log(`${url} → no page (${page.error ?? `HTTP ${page.status}`})`);
      continue;
    }
    for (const train of config.trains) {
      if (timetables[train.lineName]) continue;
      const result = timetableFromPage(page.html, train, matchStation);
      if (result.stops) {
        timetables[train.lineName] = { stops: result.stops, url };
      } else {
        attempts[train.lineName].push(`${id}: ${result.problems.slice(0, 3).join(", ")}`);
      }
    }
  }
  for (const train of config.trains) {
    if (timetables[train.lineName]) {
      log(`${train.lineName}: timetable from ${timetables[train.lineName].url}`);
    } else {
      console.warn(
        `[scrape] jr-sunrise: ${train.lineName}: no page validated — keeping the baseline` +
          (attempts[train.lineName].length ? ` (${attempts[train.lineName].join(" | ")})` : ` (${ids.length} page(s) tried)`),
      );
    }
  }

  // 3. Berth charges, from whichever guide page prices the rooms.
  const parsed = Object.assign({}, ...guides.map((g) => parseRoomCharges(g.html)));
  const rooms = acceptRoomCharges(parsed, config.fares.roomCharges);
  if (rooms.rejected.length) console.warn(`[scrape] jr-sunrise: berth charges not taken: ${rooms.rejected.join("; ")}`);
  log(
    rooms.live.length
      ? `berth charges confirmed for ${rooms.live.join(", ")}`
      : "no berth charge could be read — pricing with the baseline",
  );

  const trains = buildSunriseTrains(config, {
    timetables,
    roomCharges: rooms.charges,
    faresCheckedAt: rooms.live.length ? ctx.today : config.fares.checkedAt,
    today: ctx.today,
  });
  const confirmed = Object.keys(timetables).length;
  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    travelDate,
    checks: {
      timetables: Object.fromEntries(
        config.trains.map((t) => [t.lineName, timetables[t.lineName]?.url ?? "baseline"]),
      ),
      berthCharges: rooms.live.length ? rooms.live : "baseline",
    },
    trains,
  });
  log(`stored ${Object.keys(trains).length} trains (${confirmed} timetable(s) confirmed for ${travelDate})`);

  if (!confirmed && !rooms.live.length) {
    throw new Error(
      "wrote the baseline — no JR page confirmed a timetable or a berth charge tonight " +
        "(run the 'Probe JR Sunrise source' workflow to see what the pages returned)",
    );
  }
}
