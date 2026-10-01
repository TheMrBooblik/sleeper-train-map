// scripts/lib/es-last-minute.mjs
// European Sleeper's last-minute deals: couchette places on trains leaving in
// the next one to three weeks, sold from per-direction landing pages on
// www.europeansleeper.eu (/last-minutes-berlin-prague, …) at a flat promo
// price — €40 / €60 a bed, €160 / €240 a whole private compartment as of 2026.
//
// They are often the cheapest way onto the train, and the operator's own fare
// finder (/fare-finder) does not show them: a deal is booked through the
// promotional site, which creates an ordinary booking at the deal price. So a
// calendar built from the booking API alone misses the best fare on exactly
// the nights it exists. This module finds them.
//
// What is known about the pages (from the operator's own booking flow, see
// the OpenAPI notes in CLAUDE.md): each deal has a numeric id (903–999 in
// mid-2026), the page's form posts it as `price`, and
// GET /receipt/price/{count}/{id} answers its price as "&euro;40" — or an
// empty body once the deal has expired. Which DATE an id belongs to is only
// on the landing page.
//
// The dev sandbox cannot reach the site, so the markup has never been seen
// from here. The parser is therefore layout-agnostic and strict, the
// jr-sunrise approach: it finds every deal id the page carries in any of the
// shapes a form or script would use, and dates one only from text inside its
// own option/label or the nearest date heading before it. A deal with no date
// it can stand behind is reported and dropped — never guessed onto a night.
// `npm run probe-es-fares` (label a PR `run-probes`) prints what the live
// pages yield.

const SITE = "https://www.europeansleeper.eu";
const USER_AGENT =
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://github.com/TheMrBooblik/sleeper-train-map)";

const DAY_MS = 86_400_000;
const isoMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (y, m, d) => {
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};

// English, Dutch, German and French — the site's four languages.
const MONTHS = [
  ["january", "januari", "januar", "janvier", "jan", "janv"],
  ["february", "februari", "februar", "fevrier", "feb", "febr", "fev", "fevr"],
  ["march", "maart", "marz", "maerz", "mars", "mar", "mrt", "maa"],
  ["april", "avril", "apr", "avr"],
  ["may", "mei", "mai"],
  ["june", "juni", "juin", "jun"],
  ["july", "juli", "juillet", "jul", "juil"],
  ["august", "augustus", "aout", "aug"],
  ["september", "septembre", "sep", "sept"],
  ["october", "oktober", "octobre", "oct", "okt"],
  ["november", "novembre", "nov"],
  ["december", "dezember", "decembre", "dec", "dez"],
];
const MONTH_INDEX = new Map(MONTHS.flatMap((names, i) => names.map((n) => [n, i + 1])));
const MONTH_RE = [...MONTH_INDEX.keys()].sort((a, b) => b.length - a.length).join("|");

/** Entities and accents off, so "ao&ucirc;t" and "août" both read "aout". */
export function decodeText(s) {
  return String(s ?? "")
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&([a-z])(acute|grave|circ|uml|cedil|tilde);/gi, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Every calendar date a piece of text names, as [{ iso, index }] in order.
 * Day-first throughout (a European site): "12-10-2026" is 12 October. A date
 * with no year takes the year that puts it nearest after `today` — a deal
 * page in late December listing "3 Jan" means next year's.
 */
export function findDates(text, { today } = {}) {
  const s = decodeText(text).toLowerCase();
  const out = [];
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const push = (index, length, y, m, d) => {
    if (!free(index, index + length)) return;
    let year = y;
    if (year != null && year < 100) year += 2000;
    if (year == null) {
      const base = Number(String(today ?? "").slice(0, 4)) || new Date().getUTCFullYear();
      const iso = isoOf(base, m, d);
      year = iso && today && isoMs(iso) < isoMs(today) - 30 * DAY_MS ? base + 1 : base;
    }
    const iso = isoOf(year, m, d);
    if (!iso) return;
    taken.push([index, index + length]);
    out.push({ iso, index });
  };
  let m;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(s))) push(m.index, m[0].length, +m[1], +m[2], +m[3]);
  const numeric = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g;
  while ((m = numeric.exec(s))) push(m.index, m[0].length, +m[3], +m[2], +m[1]);
  const dayMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th|e|er|\\.)?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}|\\d{2}(?![\\d:.,])))?\\b`,
    "g",
  );
  while ((m = dayMonth.exec(s))) push(m.index, m[0].length, m[3] ? +m[3] : null, MONTH_INDEX.get(m[2]), +m[1]);
  const monthDay = new RegExp(
    `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`,
    "g",
  );
  while ((m = monthDay.exec(s))) push(m.index, m[0].length, m[3] ? +m[3] : null, MONTH_INDEX.get(m[1]), +m[2]);
  return out.sort((a, b) => a.index - b.index);
}

/** "&euro;40" / "€ 40,00" / "40 EUR" → 40; anything else → null. */
export function parseEuroAmount(text) {
  const s = decodeText(text);
  const m =
    s.match(/€\s*(\d{1,4}(?:[.,]\d{1,2})?)/) ??
    s.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euro\b)/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const PRIVATE_CUE = /privat|prive|whole compartment|entire compartment|hele coupe|eigen coupe|ganzes abteil|compartiment entier|compartiment prive/i;
const SHARED_CUE = /shared|gedeeld|geteilt|partage|per person|per persoon|pro person|par personne|per bed|1 bed|one bed|\bp\.\s?p\.|\bpp\b/i;

function cueAt(text) {
  const s = decodeText(text);
  if (PRIVATE_CUE.test(s)) return "private";
  if (SHARED_CUE.test(s)) return "couchette";
  return null;
}

const stripTags = (html) => decodeText(String(html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};
const isDealId = (v) => /^\d{2,5}$/.test(String(v ?? "").trim());

/**
 * Every deal id the page carries, with the text that belongs to it:
 * [{ id, index, own }] where `own` is the id's own option / label text.
 * Shapes recognised: <option> inside <select name="price">, <input
 * name="price" value=…> (radio or hidden) with the label text after it,
 * data-price / data-price-id / data-deal(-id) attributes, links to
 * /receipt/price/{n}/{id}, and "price(Id)": N in an inline script.
 */
export function findDealIds(html) {
  const src = String(html ?? "");
  const found = new Map();
  const add = (id, index, own) => {
    const key = String(id).trim();
    if (!isDealId(key)) return;
    const prev = found.get(key);
    if (!prev || (!prev.own && own)) found.set(key, { id: key, index, own: own ?? "" });
  };
  let m;
  const selects = /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selects.exec(src))) {
    const open = m[0].slice(0, m[0].indexOf(">") + 1);
    if (!/price|deal/i.test(attr(open, "name") ?? attr(open, "id") ?? "")) continue;
    const options = /<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/select>|$)/gi;
    let o;
    while ((o = options.exec(m[1]))) {
      add(attr(`<x ${o[1]}>`, "value"), m.index + m[0].indexOf(m[1]) + o.index, stripTags(o[2]));
    }
  }
  // The live pages (2026-10): one <button name="price" value="1062"> per
  // deal, its own text the date and price — "Fri 02 Oct 26 €40 p.p.".
  const buttons = /<button\b([^>]*)>([\s\S]{0,600}?)<\/button>/gi;
  while ((m = buttons.exec(src))) {
    const tag = `<button ${m[1]}>`;
    if (!/^price$|^deal|price.?id/i.test(attr(tag, "name") ?? "")) continue;
    add(attr(tag, "value"), m.index, stripTags(m[2]));
  }
  const inputs = /<input\b[^>]*>/gi;
  while ((m = inputs.exec(src))) {
    const tag = m[0];
    if (!/^price$|^deal|price.?id/i.test(attr(tag, "name") ?? "")) continue;
    const after = src.slice(m.index + tag.length, m.index + tag.length + 600);
    const stop = after.search(/<input\b|<\/label>|<\/li>|<\/tr>|<\/form>/i);
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    const labelStart = before.lastIndexOf("<label");
    const leading = labelStart >= 0 && !/<\/label>/i.test(before.slice(labelStart)) ? before.slice(labelStart) : "";
    add(attr(tag, "value"), m.index, stripTags(leading + (stop >= 0 ? after.slice(0, stop) : after.slice(0, 200))));
  }
  const dataAttr = /<([a-z][a-z0-9]*)\b([^>]*\bdata-(?:price-id|price|deal-id|deal)\s*=\s*["']?(\d{2,5})["']?[^>]*)>([\s\S]{0,400}?)<\/\1>/gi;
  while ((m = dataAttr.exec(src))) add(m[3], m.index, stripTags(`<x ${m[2]}>${m[4]}`) + " " + (attr(`<x ${m[2]}>`, "data-date") ?? ""));
  const receipt = /\/receipt\/price\/\d+\/(\d{2,5})/g;
  while ((m = receipt.exec(src))) add(m[1], m.index, "");
  const json = /["']?(?:price_?id|priceId|dealId|deal_id)["']?\s*:\s*["']?(\d{2,5})/gi;
  while ((m = json.exec(src))) add(m[1], m.index, src.slice(m.index, m.index + 200).replace(/[{}"']/g, " "));
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/**
 * The deals a landing page offers, dated: { deals: [{ id, date, amount,
 * kind, trainNumber }], undated: [id], ids }.
 *
 * A deal's date comes from its own option/label text first, then the nearest
 * date the page names BEFORE it (a "Friday 10 October" heading over a list of
 * radio buttons) within a few kilobytes. Dates before today or more than
 * `horizonDays` out are not deal dates (a footer copyright, a season notice)
 * and are skipped. `amount` is the page's own figure where its label states
 * one; the caller confirms it against /receipt/price.
 */
export function parseLastMinutePage(html, { today, horizonDays = 60, trainNumbers = [] } = {}) {
  const src = String(html ?? "");
  const visible = src.replace(/<script\b[\s\S]*?<\/script>/gi, (s) => " ".repeat(s.length))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (s) => " ".repeat(s.length));
  const inWindow = (iso) =>
    iso && today && iso >= today && isoMs(iso) <= isoMs(today) + horizonDays * DAY_MS;
  // Dates in the visible markup, keyed by their offset in the page, so "the
  // nearest one before this input" is a lookup. Tags are blanked rather than
  // removed to keep offsets aligned with the source.
  const blanked = visible.replace(/<[^>]+>/g, (s) => {
    const value = attr(s, "data-date") ?? attr(s, "datetime");
    return value ? ` ${value} `.padEnd(s.length, " ").slice(0, s.length) : " ".repeat(s.length);
  });
  const pageDates = findDates(blanked, { today }).filter((d) => inWindow(d.iso));
  const wanted = new Set(trainNumbers.map(String));
  const trainIn = (text) => {
    const m = decodeText(text).match(/\b(?:es|train|trein|zug|nachtzug)\s*(\d{3})\b/i);
    return m && (!wanted.size || wanted.has(m[1])) ? m[1] : null;
  };

  const deals = [];
  const undated = [];
  const ids = findDealIds(src);
  const ownDate = (own) => findDates(own, { today }).map((d) => d.iso).find(inWindow) ?? null;
  // Deals whose own text dates them. A date sitting in such a deal's own
  // element belongs to that deal, not to the next one along — a heading is
  // inherited, a sibling's date is not.
  const selfDated = ids.filter((d) => ownDate(d.own)).map((d) => d.index);
  for (const { id, index, own } of ids) {
    let date = ownDate(own);
    if (!date) {
      const before = pageDates.filter((d) => d.index < index && index - d.index < 4000);
      const nearest = before[before.length - 1];
      const owned = nearest && selfDated.some((i) => i >= nearest.index - 300 && i < index);
      date = nearest && !owned ? nearest.iso : null;
    }
    if (!date) {
      undated.push(id);
      continue;
    }
    const context = visible.slice(Math.max(0, index - 1500), index);
    deals.push({
      id,
      date,
      amount: parseEuroAmount(own),
      // Only the deal's own text says what it is: the text before it is the
      // previous deal's label as often as a heading. With no word for it,
      // dealKind() reads the price tier.
      kind: cueAt(own),
      trainNumber: trainIn(own) ?? trainIn(stripTags(context).slice(-400)),
    });
  }
  return { deals, undated, ids: ids.length };
}

/** Every /last-minutes-… landing page an index page links to, as site paths. */
export function findLandingPaths(html) {
  const out = new Set();
  const re = /href\s*=\s*["'](?:https?:\/\/(?:www\.)?europeansleeper\.eu)?(\/(?:[a-z]{2}\/)?last-minutes?-[a-z0-9-]+)\/?["'?#]/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) out.add(m[1].toLowerCase());
  return [...out].sort();
}

/**
 * A deal's kind when the page did not say: the promo tiers are per bed
 * (€40/€60) or per compartment (€160/€240), so the figure itself tells them
 * apart — nobody pays €160 for one couchette.
 */
export function dealKind(deal) {
  if (deal.kind) return deal.kind;
  if (!Number.isFinite(deal.amount)) return null;
  return deal.amount >= 100 ? "private" : "couchette";
}

async function getText(url, fetchImpl, timeoutMs = 20_000) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      ...(controller ? { signal: controller.signal } : {}),
    });
    return { status: res.status, ok: res.ok, body: await res.text() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tonight's deals across every landing page, as
 * { ok, deals: [{ train, date, kind, amount, landing, id }], pages: [...] }.
 *
 * `pages` is the registry's [{ path, trains: ["453"] }] — which train a
 * landing page sells, since the page itself may not print a number. A
 * page the index links to that the registry does not know is read too, and
 * used only for deals whose own text names a train we carry. Each deal's
 * price is read from /receipt/price/1/{id}: it is the operator's own figure,
 * and an empty answer means the deal is gone, whatever the page still says.
 * `ok` is false only when no page could be read at all — the caller then
 * keeps yesterday's deals rather than wiping them on a network blip.
 */
export async function fetchLastMinuteDeals({
  pages = [],
  indexPath = "/last-minute",
  site = SITE,
  trainKeys = [],
  today,
  fetchImpl = fetch,
  log = console.log,
  spacingMs = 300,
  maxPriceChecks = 150,
} = {}) {
  const tracked = new Set(trainKeys.map(String));
  const configured = new Map(pages.map((p) => [String(p.path).toLowerCase(), p]));
  const toRead = new Map(configured);
  try {
    const index = await getText(`${site}${indexPath}`, fetchImpl);
    if (index.ok) {
      const found = findLandingPaths(index.body);
      const unknown = found.filter((p) => !configured.has(p));
      for (const p of unknown) toRead.set(p, { path: p, trains: [] });
      log(`[es-deals] ${indexPath} links ${found.length} landing page(s)${unknown.length ? `, ${unknown.length} not in the registry: ${unknown.join(", ")}` : ""}`);
    } else {
      log(`[es-deals] ${indexPath} answered HTTP ${index.status}`);
    }
  } catch (err) {
    log(`[es-deals] ${indexPath} failed: ${err.message}`);
  }

  const report = [];
  const raw = [];
  let readable = 0;
  for (const page of toRead.values()) {
    const entry = { path: page.path, status: null, ids: 0, dated: 0, undated: 0, used: 0 };
    report.push(entry);
    try {
      const res = await getText(`${site}${page.path}`, fetchImpl);
      entry.status = res.status;
      if (!res.ok) continue;
      readable++;
      const pageTrains = (page.trains ?? []).map(String).filter((t) => tracked.has(t));
      const parsed = parseLastMinutePage(res.body, { today, trainNumbers: [...tracked] });
      entry.ids = parsed.ids;
      entry.dated = parsed.deals.length;
      entry.undated = parsed.undated.length;
      for (const d of parsed.deals) {
        const train = d.trainNumber && tracked.has(d.trainNumber) ? d.trainNumber : pageTrains[0];
        if (!train) continue;
        raw.push({ ...d, train, landing: page.path });
      }
    } catch (err) {
      entry.error = err.message;
    }
    if (spacingMs) await sleep(spacingMs);
  }

  // The operator's own price per deal. A transport failure keeps the page's
  // figure; an empty answer (expired) drops the deal.
  const priceById = new Map();
  for (const id of [...new Set(raw.map((d) => d.id))].slice(0, maxPriceChecks)) {
    try {
      const res = await getText(`${site}/receipt/price/1/${id}`, fetchImpl);
      if (res.ok && !/systeemfout|<html/i.test(res.body)) priceById.set(id, parseEuroAmount(res.body));
    } catch {
      /* keep the page's own figure */
    }
    if (spacingMs) await sleep(spacingMs);
  }

  const deals = [];
  let expired = 0;
  for (const d of raw) {
    let amount = d.amount;
    if (priceById.has(d.id)) {
      amount = priceById.get(d.id);
      if (amount == null) {
        expired++;
        continue;
      }
    }
    const kind = dealKind({ ...d, amount });
    if (!Number.isFinite(amount) || !kind) continue;
    deals.push({ train: d.train, date: d.date, kind, amount, landing: d.landing, id: d.id });
  }
  for (const entry of report) entry.used = deals.filter((d) => d.landing === entry.path).length;
  for (const e of report) {
    log(
      `[es-deals] ${e.path}: ${e.status ?? "no answer"}${e.error ? ` (${e.error})` : ""} — ` +
        `${e.ids} deal id(s), ${e.dated} dated, ${e.undated} undated, ${e.used} used`,
    );
  }
  if (expired) log(`[es-deals] ${expired} deal(s) the page lists have expired (empty /receipt/price answer)`);
  return { ok: readable > 0, deals, pages: report };
}
