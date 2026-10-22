// scripts/lib/ktmb-kits.mjs
// KITS (online.ktmb.com.my), KTM Berhad's own ticket shop, asked the way its
// search page asks — before anyone logs in. Login is required to reserve a
// seat (/Trip/Reserve), never to search or to see a coach's seats and fares,
// and nothing here reserves.
//
// The page's own flow, read off its scripts (js/Home/Index_v3.js,
// js/Trip/Index.js, js/Trip/Layout.js) by `npm run probe-ktmb`:
//   1. GET /                    the search form: an antiforgery token (and its
//                               cookie) and `jsStations`, one opaque
//                               StationData blob per station id.
//   2. POST /Trip               the form (FromStationId/Data, ToStationId/Data,
//                               OnwardDate "D MMM YYYY", PassengerCount, token)
//                               → the results page, carrying SearchData and
//                               FormValidationCode for this search.
//   3. POST /Trip/Trip          JSON { SearchData, FormValidationCode,
//                               DepartDate "YYYY-MM-DD", IsReturn,
//                               BookingTripSequenceNo } → { status, data: html }
//                               listing the trains, each with a `data-TripData`.
//   4. POST /Trip/LayoutV2      JSON { SearchData, TripData, Pax } →
//                               { Status, Data: { Coaches: [{ CoachLabel,
//                               Seats: [{ SeatNo, Price, SeatTypeName, … }] }] } }.
//
// Strict and honest: an honest User-Agent, a pause between requests, and a
// block (detectBlock) ends the run for the night — this map never works
// around one.

import { HONEST_USER_AGENT, detectBlock } from "./http-block.mjs";

export const KITS_BASE = "https://online.ktmb.com.my/";
const FETCH_TIMEOUT_MS = 30_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "2026-10-29" → "29 Oct 2026", the search form's date. */
export function kitsFormDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const decodeAttr = (v) =>
  String(v ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** The value of `<input … name|id="name" … value="…">` in a page. */
export function inputValue(html, name) {
  for (const m of String(html ?? "").matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = m[1];
    const key = new RegExp(`\\b(?:name|id)\\s*=\\s*["']${name}["']`, "i");
    if (!key.test(attrs)) continue;
    const v = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\bvalue\s*=\s*'([^']*)'/i.exec(attrs);
    if (v) return decodeAttr(v[1]);
  }
  return null;
}

/** The search page's `jsStations`: [{ Id, StationData }]. */
export function parseStations(html) {
  const m = /var\s+jsStations\s*=\s*(\[[\s\S]*?\]);/.exec(String(html ?? ""));
  if (!m) return [];
  try {
    const list = JSON.parse(m[1]);
    return Array.isArray(list) ? list.filter((s) => s && s.Id && s.StationData) : [];
  } catch {
    return [];
  }
}

/** A cookie-carrying client for KITS, polite and strict. */
export function makeKitsClient({ base = KITS_BASE, fetchImpl = fetch, spacingMs = 1_200, log = () => {} } = {}) {
  const cookies = new Map();
  let blocked = null;
  let requests = 0;
  let token = null;
  const remember = (res) => {
    const lines = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  async function call(relative, { form = null, json = null, expectJson = false } = {}, hops = 0) {
    if (blocked) throw new Error(`blocked: ${blocked.reason}`);
    await sleep(spacingMs);
    const headers = {
      "User-Agent": HONEST_USER_AGENT,
      Accept: expectJson ? "application/json, text/javascript, */*; q=0.01" : "text/html,*/*;q=0.8",
      "Accept-Language": "en,ms;q=0.8",
      Referer: base,
    };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      body = new URLSearchParams(form).toString();
    } else if (json) {
      headers["Content-Type"] = "application/json";
      headers["X-Requested-With"] = "XMLHttpRequest";
      if (token) headers.RequestVerificationToken = token;
      body = JSON.stringify(json);
    }
    requests += 1;
    const url = new URL(relative, base).href;
    const res = await fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    remember(res);
    const text = await res.text();
    const location = res.headers?.get?.("location");
    if (location && res.status >= 300 && res.status < 400 && hops < 3) {
      return call(new URL(location, url).href, { expectJson }, hops + 1);
    }
    const block = detectBlock({ status: res.status, headers: res.headers, body: text }, { expectJson });
    if (block) {
      blocked = block;
      throw new Error(`blocked: ${block.reason}`);
    }
    if (res.status >= 400) throw new Error(`${relative}: HTTP ${res.status}`);
    if (expectJson) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${relative}: HTTP ${res.status}, not JSON`);
      }
    }
    return text;
  }

  let stations = null;
  /** The search form: its token and every station's StationData. */
  async function open() {
    const home = await call("");
    stations = new Map(parseStations(home).map((s) => [String(s.Id), s.StationData]));
    token = inputValue(home, "__RequestVerificationToken");
    if (!token || !stations.size) throw new Error(`search form unreadable (token ${token ? "yes" : "no"}, ${stations.size} stations)`);
    log(`KITS: ${stations.size} stations in the search form`);
    return stations;
  }

  /**
   * One search: the trains between two station ids on a date, as the results
   * page's own /Trip/Trip answer (html) plus the SearchData its layout calls need.
   */
  async function search({ from, to, date }) {
    if (!stations) await open();
    const a = stations.get(String(from));
    const b = stations.get(String(to));
    if (!a || !b) throw new Error(`station ${!a ? from : to} is not in KITS's search form`);
    const page = await call("Trip", {
      form: {
        FromStationData: a,
        ToStationData: b,
        FromStationId: String(from),
        ToStationId: String(to),
        OnwardDate: kitsFormDate(date),
        ReturnDate: "",
        PassengerCount: "1",
        __RequestVerificationToken: token,
      },
    });
    const searchData = inputValue(page, "SearchData");
    const formValidationCode = inputValue(page, "FormValidationCode");
    token = inputValue(page, "__RequestVerificationToken") ?? token;
    if (!searchData || !formValidationCode) throw new Error("results page carried no SearchData");
    const answer = await call("Trip/Trip", {
      json: { SearchData: searchData, FormValidationCode: formValidationCode, DepartDate: date, IsReturn: false, BookingTripSequenceNo: 1 },
      expectJson: true,
    });
    if (answer?.status !== true || typeof answer.data !== "string") {
      throw new Error(`Trip/Trip answered ${JSON.stringify(answer?.messages ?? answer).slice(0, 200)}`);
    }
    return { searchData, html: answer.data };
  }

  /** A train's coaches and the fare of every place in them. */
  async function layout({ searchData, tripData }) {
    const answer = await call("Trip/LayoutV2", { json: { SearchData: searchData, TripData: tripData, Pax: 1 }, expectJson: true });
    const ok = answer?.Status ?? answer?.status;
    const data = answer?.Data ?? answer?.data;
    if (ok !== true || !data) throw new Error(`Trip/LayoutV2 answered ${JSON.stringify(answer?.Messages ?? answer?.messages ?? answer).slice(0, 200)}`);
    return data;
  }

  return {
    open,
    search,
    layout,
    get blocked() {
      return blocked;
    },
    get requests() {
      return requests;
    },
  };
}
