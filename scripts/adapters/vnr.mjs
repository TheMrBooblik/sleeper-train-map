// scripts/adapters/vnr.mjs
// Vietnam Railways night trains — the nightly refresh.
//
// Everything comes from VNR's own times-and-fares site, giotaugiave.dsvn.vn,
// read the way its pages are used (scripts/lib/vnr.mjs explains the forms):
//
//   1. For each line page in `params.lines` and each direction, the list of
//      trains; then each train's timetable for `params.dateOffsetDays` ahead —
//      every stop with its kilometre post and the date of each departure, so
//      a 33-hour Reunification Express keeps its length.
//   2. A train is kept when it runs through a night and takes at least
//      `minMinutes` (data/sources/vnr-sleepers.json): a new night train is
//      picked up without an edit.
//   3. For each kept train, its fares on the same date between its two ends,
//      from the matching giave/ page — every kind of berth, priced per berth,
//      insurance and VAT included.
//   4. OpenStreetMap's railway network and stations around Vietnam (cached
//      weekly, osm-vnr-track.json): station positions and the line each
//      train is drawn along.
//
// Never fatal for the map: when the site cannot be read the trains are
// carried from last night's file (up to 30 days) and the run returns a
// warning so source-health.json records that tonight confirmed nothing. A
// block (detectBlock) stops the pass for the night — this map never works
// around one. "Probe VNR source" (label a PR `run-probes`) prints what the
// live site answers.

import fs from "node:fs";
import path from "node:path";
import { HONEST_USER_AGENT, detectBlock } from "../lib/http-block.mjs";
import { loadOsmTrack } from "../lib/osm-track.mjs";
import {
  berthFares,
  buildVnrTrains,
  dropDuplicateTimetables,
  fareRecord,
  formFields,
  isNightTrain,
  makeStationNamer,
  parseAspForm,
  parseFares,
  parseTimetable,
  selectNamed,
  selectedOption,
  stationKey,
  stationPositions,
} from "../lib/vnr.mjs";

const REQUEST_SPACING_MS = 1_000;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_PAUSE_MS = 20_000;
const DEFAULT_DATE_OFFSET_DAYS = 7;
// The whole site pass, however slow the host is tonight: what was read by
// then is kept, every other train comes from last night's file.
const PASS_BUDGET_MS = 15 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTimeout = (err) => /TIMEOUT|ECONNRESET|ETIMEDOUT|ECONNREFUSED|aborted/i.test(String(err?.cause?.code ?? err?.name ?? err?.message ?? err));

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** One cookie-carrying session on one page of the site (WebForms state is per session). */
export function makeSession({ fetchImpl = fetch, spacingMs = REQUEST_SPACING_MS, log = () => {}, counter = { requests: 0, blocked: null } } = {}) {
  const cookies = new Map();
  async function once(url, form) {
    const headers = {
      "User-Agent": HONEST_USER_AGENT,
      Accept: "text/html,*/*;q=0.8",
      "Accept-Language": "vi,en;q=0.8",
      Referer: url,
    };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    counter.requests += 1;
    const res = await fetchImpl(url, { method: form ? "POST" : "GET", headers, body, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const lines = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson: false });
    if (block) {
      counter.blocked = block;
      throw new Error(`blocked: ${block.reason}`);
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return text;
  }
  return async function call(url, form = null) {
    if (counter.blocked) throw new Error(`blocked: ${counter.blocked.reason}`);
    await sleep(spacingMs);
    try {
      return await once(url, form);
    } catch (err) {
      if (counter.blocked || !isTimeout(err)) throw err;
      log(`${url}: ${err.cause?.code ?? err.message} — retrying once in ${RETRY_PAUSE_MS / 1000} s`);
      await sleep(RETRY_PAUSE_MS);
      return once(url, form);
    }
  };
}

const ddmmyyyy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const DIRECTIONS = ["1", "0"];

/**
 * The page answering for one direction: GET, then (for the return direction,
 * and to set the date) one search, whose answer lists that direction's trains.
 */
async function openDirection(call, url, chieu, date) {
  let form = parseAspForm(await call(url));
  const answer = await call(url, formFields(form, { txtNgayDi: date, ddlChieu: chieu, search: true }));
  form = parseAspForm(answer);
  const chosen = selectedOption(selectNamed(form, "ddlChieu"))?.value;
  if (chosen !== chieu) throw new Error(`asked for direction ${chieu}, the page answered ${chosen ?? "none"}`);
  return { form, answer };
}

/** Pick a train, then its whole run (first station of the list to the farthest one). */
async function readTimetable(call, url, form, { chieu, date, option }) {
  let answer = await call(url, formFields(form, { txtNgayDi: date, ddlChieu: chieu, ddlMacTau: option.value, search: true }));
  let page = parseAspForm(answer);
  if (selectedOption(selectNamed(page, "ddlMacTau"))?.value !== option.value) throw new Error("the page did not take the train");
  const from = selectNamed(page, "ddlGaDi")?.options[0];
  const to = [...(selectNamed(page, "ddlGaDen")?.options ?? [])].sort((a, b) => Number(b.value) - Number(a.value))[0];
  if (!from || !to) throw new Error("no stations listed for it");
  const spans = (tt) => tt && stationKey(tt.stops[0].name) === stationKey(from.text) && stationKey(tt.stops.at(-1).name) === stationKey(to.text);
  let tt = parseTimetable(answer);
  if (!spans(tt)) {
    answer = await call(url, formFields(page, { txtNgayDi: date, ddlChieu: chieu, ddlMacTau: option.value, ddlGaDi: from.value, ddlGaDen: to.value, search: true }));
    page = parseAspForm(answer);
    tt = parseTimetable(answer);
  }
  if (!spans(tt)) throw new Error(`no timetable from ${from.text} to ${to.text}`);
  return { tt, form: page };
}

/**
 * Every train on every listed line, both directions: `trains` is name → { tt,
 * line, chieu, id }, `failed` the names listed tonight whose timetable could
 * not be read (they are carried from last night rather than dropped).
 */
export async function readTimetables({ base, lines, date, call, log, deadline }) {
  const out = new Map();
  const failed = new Set();
  for (const line of lines) {
    const url = new URL(`giotau/${line}`, base).href;
    for (const chieu of DIRECTIONS) {
      if (Date.now() > deadline) {
        log(`time budget spent — ${line} (${chieu}) and the lines after it are left for tomorrow`);
        return { trains: out, failed, complete: false };
      }
      let form;
      try {
        ({ form } = await openDirection(call, url, chieu, date));
      } catch (err) {
        if (/blocked/.test(err.message)) throw err;
        log(`giotau/${line} direction ${chieu}: ${err.message}`);
        failed.add(`page:${line}|${chieu}`);
        continue;
      }
      const options = selectNamed(form, "ddlMacTau")?.options ?? [];
      const read = [];
      for (const option of options) {
        const name = option.text.replace(/Ð/g, "Đ").trim();
        if (out.has(name)) continue;
        try {
          const got = await readTimetable(call, url, form, { chieu, date, option });
          form = got.form;
          out.set(name, { tt: got.tt, line, chieu, id: option.value });
          failed.delete(name);
          read.push(name);
        } catch (err) {
          if (/blocked/.test(err.message)) throw err;
          failed.add(name);
          log(`${name}: ${err.message}`);
        }
      }
      log(`giotau/${line} direction ${chieu}: ${options.length} train(s), read ${read.join(" ") || "none new"}`);
    }
  }
  return { trains: out, failed, complete: true };
}

/** A kept train's fares between its two ends, from the giave/ twin of its line page. */
export async function readFares({ base, trains, date, call, log, deadline, namer }) {
  const out = new Map();
  const byPage = new Map();
  for (const [name, t] of trains) {
    const key = `${t.line}|${t.chieu}`;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push([name, t]);
  }
  for (const [key, list] of byPage) {
    if (Date.now() > deadline) {
      log("time budget spent — the remaining fares are carried from last night");
      break;
    }
    const [line, chieu] = key.split("|");
    const url = new URL(`giave/${line}`, base).href;
    let form;
    try {
      ({ form } = await openDirection(call, url, chieu, date));
    } catch (err) {
      if (/blocked/.test(err.message)) throw err;
      log(`giave/${line} direction ${chieu}: ${err.message}`);
      continue;
    }
    for (const [name, t] of list) {
      const option = (selectNamed(form, "ddlMacTau")?.options ?? []).find((o) => o.text.replace(/Ð/g, "Đ").trim() === name);
      if (!option) {
        log(`${name}: not on the fare page giave/${line}`);
        continue;
      }
      try {
        let answer = await call(url, formFields(form, { txtNgayDi: date, ddlChieu: chieu, ddlMacTau: option.value, search: true }));
        let page = parseAspForm(answer);
        const pick = (tail, stationName) =>
          (selectNamed(page, tail)?.options ?? []).find((o) => stationKey(namer(o.text)) === stationKey(namer(stationName)));
        const from = pick("ddlGaDi", t.tt.stops[0].name);
        const to = pick("ddlGaDen", t.tt.stops.at(-1).name);
        if (!from || !to) throw new Error(`fare page lists no ${from ? t.tt.stops.at(-1).name : t.tt.stops[0].name}`);
        answer = await call(url, formFields(page, { txtNgayDi: date, ddlChieu: chieu, ddlMacTau: option.value, ddlGaDi: from.value, ddlGaDen: to.value, search: true }));
        page = parseAspForm(answer);
        form = page;
        const rows = parseFares(answer);
        if (!rows) throw new Error("no fare table in the answer");
        out.set(name, { rows, classes: berthFares(rows) });
      } catch (err) {
        if (/blocked/.test(err.message)) throw err;
        log(`${name}: fares — ${err.message}`);
      }
    }
  }
  return out;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function run(entry, ctx) {
  const params = entry.params ?? {};
  const log = (msg) => console.log(`[scrape] ${entry.id}: ${msg}`);
  const config = JSON.parse(fs.readFileSync(path.join(ctx.rootDir, params.configPath), "utf8"));
  const namer = makeStationNamer(config.stationNames);
  const previousFile = readJsonSafe(path.join(ctx.rootDir, "public/data/scraped", entry.output));
  const previous = previousFile?.data?.trains ?? previousFile?.trains ?? {};
  const offset = params.dateOffsetDays ?? DEFAULT_DATE_OFFSET_DAYS;
  const travelDate = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const date = ddmmyyyy(travelDate);
  const counter = { requests: 0, blocked: null };
  const call = makeSession({ fetchImpl: ctx.fetch ?? fetch, log, counter });
  const deadline = Date.now() + (params.budgetMs ?? PASS_BUDGET_MS);

  let found = null;
  let carry = new Set();
  let warning = null;
  try {
    const { trains: all, failed, complete } = await readTimetables({ base: params.baseUrl, lines: params.lines ?? [], date, call, log, deadline });
    // A train the site listed but did not answer for tonight, or any train
    // when a whole page or the time budget failed, keeps last night's entry.
    carry = complete && ![...failed].some((f) => f.startsWith("page:")) ? failed : new Set(Object.keys(previous));
    const night = new Map([...all].filter(([name, t]) => isNightTrain(t.tt, config, name)));
    log(`${all.size} train(s) read, ${night.size} run through a night: ${[...night.keys()].join(" ")}`);
    const fares = await readFares({ base: params.baseUrl, trains: night, date, call, log, deadline, namer });
    found = new Map();
    for (const [name, t] of night) {
      const fare = fares.get(name);
      if (fare && !Object.keys(fare.classes ?? {}).length) {
        log(`${name}: sells no berth on ${travelDate} — left out (${fare.rows.map((r) => r.code).join(" ")})`);
        continue;
      }
      found.set(name, { timetable: t.tt, fare: fare ? fareRecord(fare.classes, { sampledAt: ctx.today, travelDate }) : null });
    }
    found = dropDuplicateTimetables(found, log);
    const unpriced = [...found].filter(([, f]) => !f.fare).map(([n]) => n);
    if (unpriced.length) log(`no fare on ${travelDate} for ${unpriced.join(" ")} — kept with their timetable, last night's fare if any`);
    if (!found.size) throw new Error("no night train read");
  } catch (err) {
    warning = `giotaugiave.dsvn.vn: ${err.message} — trains carried from last night's file`;
    log(warning);
    found = null;
  }
  log(`${counter.requests} request(s) for travel on ${travelDate}`);

  const osmTrack = await loadOsmTrack({
    rootDir: ctx.rootDir,
    today: ctx.today,
    params: { file: "osm-vnr-track.json", bbox: [8.4, 102.1, 23.4, 109.5], stations: true, ...(params.osmTrack ?? {}) },
    fetchImpl: ctx.fetch ?? fetch,
    log,
  });
  const stopLists = found
    ? [...found.values()].map((f) => f.timetable.stops.map((s) => ({ name: namer(s.name), km: s.km })))
    : Object.values(previous).map((t) => (t.stations ?? []).map((s) => ({ name: s.name, km: s.km ?? null })));
  const positions = stationPositions(stopLists, config.anchors, osmTrack?.stations ?? null, log);

  const trains = buildVnrTrains({ config, found, carry, positions, previous, today: ctx.today, travelDate, osmTrack, log });
  if (!Object.keys(trains).length) {
    throw new Error(`no trains built (${warning ?? "the site answered but nothing was kept"})`);
  }
  for (const t of Object.values(trains)) {
    const a = t.stations[0];
    const b = t.stations.at(-1);
    log(
      `${t.lineName}: ${a.name} ${a.departure} → ${b.name} ${b.arrival} (+${b.arrivalDay}), ${Math.floor(t.durationMinutes / 60)}h${String(t.durationMinutes % 60).padStart(2, "0")}, ${t.stations.length} stops, from ${t.fare ? `${t.fare.fromPrice.toLocaleString("en")} ₫` : "—"}, positions ${JSON.stringify(t.positions)}, line ${JSON.stringify(t.geometry)}`,
    );
  }
  ctx.write(entry.output, { uploadedAt: ctx.today, travelDate, trains });
  log(`stored ${Object.keys(trains).length} train(s)`);
  return warning ? { warning } : undefined;
}
