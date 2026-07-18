// scripts/lib/12306.mjs
// Read-only helpers for China Railway's public kyfw.12306.cn JSON surface
// (same endpoints the official web UI uses — no login, no booking).
// Used by the chinese adapter and the probe-12306 reconnaissance script.

import { FETCH_TIMEOUT_MS, OVERPASS_ENDPOINTS } from "./scrape-helpers.mjs";

export const KYFW_BASE = "https://kyfw.12306.cn";
export const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

const DEFAULT_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: `${KYFW_BASE}/otn/leftTicket/init`,
  "X-Requested-With": "XMLHttpRequest",
};

// leftTicket query endpoint names flip during schedule-version rollovers.
export const LEFT_TICKET_ENDPOINTS = ["queryO", "queryG", "queryA", "queryE"];

/**
 * Cookie jar for a 12306 session. Call initSession() once, then pass the
 * jar into subsequent requests so otn endpoints accept the call.
 */
export function createCookieJar() {
  const jar = new Map();
  return {
    store(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      // Node <18 fallback: single set-cookie header
      if (!raw.length) {
        const single = res.headers.get("set-cookie");
        if (single) raw.push(single);
      }
      for (const line of raw) {
        const pair = line.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      if (!jar.size) return "";
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

export async function initSession(fetchImpl = fetch, jar = createCookieJar()) {
  const res = await fetchImpl(`${KYFW_BASE}/otn/leftTicket/init`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
  });
  jar.store(res);
  // Drain body so the connection can close cleanly.
  await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, jar };
}

function withCookies(jar, extra = {}) {
  const cookie = jar?.header?.() ?? "";
  return {
    ...DEFAULT_HEADERS,
    ...extra,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse station_name.js (var station_names='@…|…|…') into telecode lookups.
 * Each station record is pipe-separated; field layout (historical, stable):
 *   [0] short code  [1] Chinese name  [2] telecode  [3] pinyin  …
 */
export function parseStationNamesJs(jsText) {
  const m = String(jsText ?? "").match(/['"](@[^'"]+)['"]/);
  if (!m) return { byTelecode: new Map(), byChineseName: new Map(), byPinyin: new Map() };
  const byTelecode = new Map();
  const byChineseName = new Map();
  const byPinyin = new Map();
  for (const chunk of m[1].split("@").filter(Boolean)) {
    const parts = chunk.split("|");
    if (parts.length < 4) continue;
    const chineseName = parts[1]?.trim();
    const telecode = parts[2]?.trim();
    const pinyin = parts[3]?.trim()?.toLowerCase();
    if (!telecode || !chineseName) continue;
    const rec = { telecode, chineseName, pinyin, shortCode: parts[0]?.trim() ?? null };
    byTelecode.set(telecode, rec);
    byChineseName.set(chineseName, rec);
    if (pinyin) byPinyin.set(pinyin, rec);
  }
  return { byTelecode, byChineseName, byPinyin };
}

export async function fetchStationNamesJs(fetchImpl = fetch, jar = null) {
  // Version query param is ignored by the CDN for caching; any value works.
  const url = `${KYFW_BASE}/otn/resources/js/framework/station_name.js?station_version=1.9300`;
  const res = await fetchImpl(url, {
    headers: withCookies(jar, { Accept: "application/javascript,*/*" }),
  });
  if (jar) jar.store(res);
  if (!res.ok) throw new Error(`station_name.js HTTP ${res.status}`);
  const text = await res.text();
  return { text, ...parseStationNamesJs(text) };
}

/**
 * Parse one pipe-delimited leftTicket result row into a structured object.
 * Field indices follow the official web UI (stable for years; probe if they drift).
 */
export function parseLeftTicketRow(raw, stationMap = {}) {
  const parts = String(raw ?? "").split("|");
  if (parts.length < 30) return null;
  const trainCode = parts[3]?.trim();
  if (!trainCode) return null;
  const fromCode = parts[6]?.trim();
  const toCode = parts[7]?.trim();
  return {
    secretStr: parts[0] || null,
    trainNo: parts[2]?.trim() || null, // internal train_no for queryByTrainNo
    trainCode, // commercial number e.g. "Z21"
    fromTelecode: fromCode || null,
    toTelecode: parts[7]?.trim() || null,
    startTelecode: parts[4]?.trim() || null,
    endTelecode: parts[5]?.trim() || null,
    fromStation: stationMap[fromCode] || fromCode || null,
    toStation: stationMap[toCode] || toCode || null,
    departTime: parts[8]?.trim() || null,
    arriveTime: parts[9]?.trim() || null,
    duration: parts[10]?.trim() || null,
    // Soft sleeper / hard sleeper availability codes ("有", "无", digits, or "")
    softSleeper: parts[23]?.trim() || "",
    hardSleeper: parts[28]?.trim() || "",
  };
}

export function parseLeftTicketResponse(json) {
  const data = json?.data;
  if (!data) return { trains: [], stationMap: {} };
  const stationMap = data.map && typeof data.map === "object" ? data.map : {};
  const rows = Array.isArray(data.result) ? data.result : [];
  const trains = rows.map((r) => parseLeftTicketRow(r, stationMap)).filter(Boolean);
  return { trains, stationMap };
}

/**
 * Normalize a commercial train label ("Z 21", "Z21", "z21") → "Z21".
 */
export function normalizeTrainCode(label) {
  const m = String(label ?? "")
    .trim()
    .toUpperCase()
    .match(/^([GDCZTKLY]|DJ)?\s*(\d+[A-Z]?)$/i);
  if (!m) {
    // Fallback: strip spaces
    return String(label ?? "").replace(/\s+/g, "").toUpperCase() || null;
  }
  return `${(m[1] || "").toUpperCase()}${m[2]}`;
}

/** Display form used as trains-file keys historically: "Z 21". */
export function displayTrainCode(code) {
  const n = normalizeTrainCode(code);
  if (!n) return null;
  const m = n.match(/^([A-Z]+)(\d.*)$/);
  return m ? `${m[1]} ${m[2]}` : n;
}

export async function queryLeftTicket(
  { date, fromTelecode, toTelecode },
  { fetchImpl = fetch, jar = createCookieJar(), endpoints = LEFT_TICKET_ENDPOINTS } = {},
) {
  let lastErr = null;
  for (const ep of endpoints) {
    const url =
      `${KYFW_BASE}/otn/leftTicket/${ep}` +
      `?leftTicketDTO.train_date=${encodeURIComponent(date)}` +
      `&leftTicketDTO.from_station=${encodeURIComponent(fromTelecode)}` +
      `&leftTicketDTO.to_station=${encodeURIComponent(toTelecode)}` +
      `&purpose_codes=ADULT`;
    try {
      const res = await fetchImpl(url, { headers: withCookies(jar) });
      jar.store(res);
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`${ep} HTTP ${res.status}`);
        continue;
      }
      // 12306 sometimes returns HTML error pages or empty bodies when blocked.
      if (!text || text.trimStart().startsWith("<")) {
        lastErr = new Error(`${ep} non-JSON body`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        lastErr = new Error(`${ep} JSON parse failed`);
        continue;
      }
      if (json?.status === false && !json?.data) {
        lastErr = new Error(`${ep} status:false`);
        continue;
      }
      return { endpoint: ep, ...parseLeftTicketResponse(json), raw: json };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("leftTicket query failed");
}

/**
 * Parse queryByTrainNo JSON into ordered stops with HH:MM times.
 * Official fields: station_name, arrive_time, start_time, station_no, stopover_time.
 * First stop arrive_time is often "----"; last start_time may be "----".
 */
export function parseQueryByTrainNoResponse(json) {
  const rows = json?.data?.data;
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows
    .map((row) => {
      const name = (row?.station_name ?? "").toString().trim();
      if (!name) return null;
      const arrive = normalizeClock(row?.arrive_time);
      const depart = normalizeClock(row?.start_time);
      return {
        nameZh: name,
        stationNo: row?.station_no ?? null,
        arrival: arrive,
        departure: depart,
        stopover: row?.stopover_time ?? null,
      };
    })
    .filter(Boolean);
}

function normalizeClock(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "----" || s === "--" || s === "24:00") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export async function queryByTrainNo(
  { trainNo, fromTelecode, toTelecode, date },
  { fetchImpl = fetch, jar = createCookieJar() } = {},
) {
  const url =
    `${KYFW_BASE}/otn/czxx/queryByTrainNo` +
    `?train_no=${encodeURIComponent(trainNo)}` +
    `&from_station_telecode=${encodeURIComponent(fromTelecode)}` +
    `&to_station_telecode=${encodeURIComponent(toTelecode)}` +
    `&depart_date=${encodeURIComponent(date)}`;
  const res = await fetchImpl(url, { headers: withCookies(jar) });
  jar.store(res);
  const text = await res.text();
  if (!res.ok) throw new Error(`queryByTrainNo HTTP ${res.status}`);
  if (!text || text.trimStart().startsWith("<")) {
    throw new Error("queryByTrainNo non-JSON body");
  }
  const json = JSON.parse(text);
  return { stops: parseQueryByTrainNoResponse(json), raw: json };
}

/**
 * Find a leftTicket row whose commercial trainCode matches the allowlist label.
 */
export function findTrainInLeftTicket(trains, lineName) {
  const want = normalizeTrainCode(lineName);
  if (!want) return null;
  return (trains ?? []).find((t) => normalizeTrainCode(t.trainCode) === want) ?? null;
}

/** YYYY-MM-DD for "today + offsetDays" in local time (CI = UTC). */
export function datePlusDays(baseIsoDate, offsetDays) {
  const [y, m, d] = baseIsoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * Title-case a 12306 pinyin slug for display: "shenzhendong" → "Shenzhendong".
 * Matches the common CR labelling style (one word, first letter capital).
 */
export function titleCasePinyin(pinyin) {
  const s = String(pinyin ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Display label: prefer curated English, fall back to pinyin; always append
 * Chinese in parentheses when known — e.g. "Shenzhendong(深圳东)".
 */
export function formatChineseDisplayName(english, nameZh) {
  const en = (english ?? "").toString().trim();
  const zh = (nameZh ?? "").toString().trim();
  if (en && zh) {
    if (en.includes(`(${zh})`) || en.endsWith(zh)) return en;
    return `${en}(${zh})`;
  }
  return en || zh || null;
}

/**
 * Build a station resolver from allowlist stations + 12306 station_name.js
 * pinyin + optional coord caches/overrides.
 * Matches Chinese names (nameZh) and English names (case-insensitive).
 *
 * @param {object} [args.stationNames]  parseStationNamesJs() result — fills
 *   English from pinyin when the allowlist has no curated name
 * @param {Record<string,{lat:number,lon:number}>} [args.coordsByZh]
 *   Chinese-name → coords cache (geocode / prior scrape)
 */
export function makeChineseStationResolver({
  allowlistStations = [],
  overrides = {},
  stationNames = null,
  coordsByZh = {},
} = {}) {
  const byZh = new Map();
  const byEn = new Map();

  const upsertZh = (nameZh, patch) => {
    const key = (nameZh ?? "").toString().trim();
    if (!key) return;
    const prev = byZh.get(key) ?? {
      name: null,
      nameZh: key,
      telecode: null,
      coords: null,
    };
    byZh.set(key, {
      name: patch.name ?? prev.name,
      nameZh: key,
      telecode: patch.telecode ?? prev.telecode,
      coords: patch.coords ?? prev.coords,
    });
  };

  // 1. Pinyin from the official 12306 station list (covers ~all stops).
  if (stationNames?.byChineseName) {
    for (const [zh, rec] of stationNames.byChineseName) {
      upsertZh(zh, {
        name: titleCasePinyin(rec.pinyin),
        telecode: rec.telecode ?? null,
      });
    }
  }

  // 2. Geocode / scrape coord cache keyed by Chinese name (lowest-priority coords).
  for (const [zh, v] of Object.entries(coordsByZh ?? {})) {
    if (!Number.isFinite(v?.lat) || !Number.isFinite(v?.lon)) continue;
    upsertZh(zh, { coords: { lat: v.lat, lon: v.lon } });
  }

  // 3. Curated allowlist wins for English spelling + coords.
  for (const s of allowlistStations) {
    if (!s) continue;
    const coords =
      Number.isFinite(s.lat) && Number.isFinite(s.lon) ? { lat: s.lat, lon: s.lon } : null;
    if (s.nameZh) {
      upsertZh(s.nameZh, {
        name: s.name ?? null,
        telecode: s.telecode ?? null,
        coords,
      });
    }
    if (s.name) {
      byEn.set(s.name.toLowerCase().trim(), {
        name: s.name,
        nameZh: s.nameZh ?? null,
        telecode: s.telecode ?? null,
        coords,
      });
    }
  }

  // 4. Manual overrides (English or Chinese keys) — highest priority.
  for (const [name, v] of Object.entries(overrides ?? {})) {
    if (!Number.isFinite(v?.lat) || !Number.isFinite(v?.lon)) continue;
    const key = name.toLowerCase().trim();
    if (/[\u4e00-\u9fff]/.test(name)) {
      upsertZh(name, { coords: { lat: v.lat, lon: v.lon } });
      continue;
    }
    const existing = byEn.get(key);
    if (existing) {
      existing.coords = { lat: v.lat, lon: v.lon };
    } else {
      byEn.set(key, { name, nameZh: null, telecode: null, coords: { lat: v.lat, lon: v.lon } });
    }
  }

  return (nameZhOrEn) => {
    const raw = (nameZhOrEn ?? "").toString().trim();
    if (!raw) return null;
    return byZh.get(raw) ?? byEn.get(raw.toLowerCase()) ?? null;
  };
}

/**
 * Turn queryByTrainNo stops + resolver into the standard trains-file stations[].
 * Names are always English(中文) when both are known.
 */
export function normalizeChineseStations(stops, { resolveStation, today }) {
  return (stops ?? []).map((s) => {
    const zh = s.nameZh ?? null;
    const resolved = resolveStation(zh) ?? resolveStation(s.name);
    const english = resolved?.name ?? null;
    const displayName = formatChineseDisplayName(english, zh) ?? s.name ?? null;
    return {
      id: null,
      name: displayName,
      nameZh: zh,
      location: resolved?.coords
        ? { latitude: resolved.coords.lat, longitude: resolved.coords.lon }
        : null,
      arrival: s.arrival ? `${today}T${s.arrival}:00` : null,
      departure: s.departure ? `${today}T${s.departure}:00` : null,
      pickup: true,
      dropoff: true,
    };
  });
}

async function fetchJsonWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok || !text || text.trimStart().startsWith("<") || text.startsWith("You are making too many requests")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

async function geocodeChineseStationViaWikidata(nameZh, fetchImpl = fetch) {
  const name = String(nameZh ?? "").trim();
  if (!name) return null;
  const search = await fetchJsonWithTimeout(
    fetchImpl,
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name + "站")}&language=zh&format=json&limit=3`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
  );
  const rows = search?.search ?? [];
  // Prefer Chinese/China railway hits; Korean/Japanese stations can share
  // characters and were slipping through (e.g. Gamgok for 甘谷).
  const hit =
    rows.find((row) => /railway station in .*china|china.*railway station|车站|火车站/i.test(`${row?.label ?? ""} ${row?.description ?? ""}`)) ||
    rows.find((row) => /railway station/i.test(`${row?.label ?? ""} ${row?.description ?? ""}`) && !/korea|japan|north korea/i.test(`${row?.description ?? ""}`)) ||
    null;
  if (!hit?.id) return null;
  const entity = await fetchJsonWithTimeout(
    fetchImpl,
    `https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
  );
  const value = entity?.entities?.[hit.id]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
  const lat = Number(value?.latitude);
  const lon = Number(value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, source: "wikidata" };
}

async function geocodeChineseStationViaOverpass(nameZh, fetchImpl = fetch) {
  const name = String(nameZh ?? "").trim();
  if (!name) return null;
  const query = `[out:json][timeout:20];\n(\n  node["railway"~"station|halt",i]["name"="${name}"](18,73,55,136);\n  way["railway"~"station|halt",i]["name"="${name}"](18,73,55,136);\n  relation["railway"~"station|halt",i]["name"="${name}"](18,73,55,136);\n);\nout center tags;`;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const data = await fetchJsonWithTimeout(fetchImpl, endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: query,
    });
    const hits = (data?.elements ?? [])
      .map((el) => ({
        lat: el.lat ?? el.center?.lat,
        lon: el.lon ?? el.center?.lon,
        name: el.tags?.name ?? null,
      }))
      .filter((el) => el.name === name && Number.isFinite(el.lat) && Number.isFinite(el.lon));
    if (hits.length) return { lat: hits[0].lat, lon: hits[0].lon, source: "overpass-railway" };
  }
  return null;
}

/**
 * Geocode a Chinese railway station. First try exact OSM railway-station match
 * (much safer for names shared by cities/counties), then fall back to
 * Nominatim search. Returns {lat,lon} or null.
 */
export async function geocodeChineseStation(nameZh, { fetchImpl = fetch } = {}) {
  const fromWikidata = await geocodeChineseStationViaWikidata(nameZh, fetchImpl);
  if (fromWikidata) return fromWikidata;

  const exact = await geocodeChineseStationViaOverpass(nameZh, fetchImpl);
  if (exact) return exact;

  const q = `${String(nameZh ?? "").trim()}火车站`;
  if (!q || q === "火车站") return null;
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(q)}` +
    "&format=jsonv2&limit=1&countrycodes=cn,mn,vn";
  const rows = await fetchJsonWithTimeout(fetchImpl, url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  // Only accept explicit railway hits — generic city/admin matches caused the
  // bad China station locations we just audited.
  const hit = (Array.isArray(rows) ? rows : []).find((row) => {
    const cls = String(row?.class ?? "").toLowerCase();
    const type = String(row?.type ?? "").toLowerCase();
    return cls === "railway" || ["station", "halt", "stop", "tram_stop"].includes(type);
  });
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, source: "nominatim-railway" };
}
