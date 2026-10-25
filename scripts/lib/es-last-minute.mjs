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
  "Mozilla/5.0 (compatible; sleeper-train-map/1.0; +https://pingwi.com)";

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

// Words that make the date after them a deadline rather than a travel date.
const DEADLINE_CUE =
  /\b(?:ends?|ending|until|till|book (?:by|before)|valid (?:until|through)|deadline|t\/m|tot en met|bis(?: zum)?|jusqu'?(?:au)?)\s*(?:on\s+)?(?:[a-z]+day,?\s+)?$/i;

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
 * kind, trainNumber }], undated: [id], outside: [id], ids }.
 *
 * A deal's date comes from its own option/label text first, then the nearest
 * date the page names BEFORE it (a "Mon 07 Dec 26" label over its button)
 * within a few kilobytes. A deal whose date is before today or more than
 * `horizonDays` out is `outside`, and dropped — never moved onto an earlier
 * date the page also names. That is the failure this rule exists for: the
 * flash-sale pages (2026-10-01) list Mondays from 2 November to 14 December,
 * and with the nearest date picked among the in-window ones only, the two
 * December Mondays past a 60-day horizon both read as Monday 30 November.
 * `undated` is a deal no date sits near at all. `amount` is the page's own
 * figure where its label states one; the caller confirms it against
 * /receipt/price.
 */
export function parseLastMinutePage(html, { today, horizonDays = 92, trainNumbers = [] } = {}) {
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
  // Every date, in or out of the window: the nearest one before a deal is its
  // date whichever it is, and an out-of-window one drops the deal rather than
  // handing it the in-window date before that. A deadline is not a heading,
  // though: every offer page opens "Offer ends 6 October" right above its
  // list, and a deal whose own label did not read would otherwise be sold on
  // the sale's last day — which is what the first flash scrape did to the
  // Milan → Brussels page's 14 December.
  const decoded = decodeText(blanked).toLowerCase();
  const pageDates = findDates(blanked, { today }).filter(
    (d) => !DEADLINE_CUE.test(decoded.slice(Math.max(0, d.index - 40), d.index)),
  );
  const wanted = new Set(trainNumbers.map(String));
  const trainIn = (text) => {
    const m = decodeText(text).match(/\b(?:es|train|trein|zug|nachtzug)\s*(\d{3})\b/i);
    return m && (!wanted.size || wanted.has(m[1])) ? m[1] : null;
  };

  const deals = [];
  const undated = [];
  const outside = [];
  const ids = findDealIds(src);
  const ownDates = (own) => findDates(own, { today }).map((d) => d.iso);
  // Deals whose own text dates them. A date sitting in such a deal's own
  // element belongs to that deal, not to the next one along — a heading is
  // inherited, a sibling's date is not.
  const selfDated = ids.filter((d) => ownDates(d.own).length).map((d) => d.index);
  for (const { id, index, own } of ids) {
    const mine = ownDates(own);
    let date = null;
    if (mine.length) {
      date = mine.find(inWindow) ?? null;
      if (!date) {
        outside.push(id);
        continue;
      }
    } else {
      const before = pageDates.filter((d) => d.index < index && index - d.index < 4000);
      const nearest = before[before.length - 1];
      const owned = nearest && selfDated.some((i) => i >= nearest.index - 300 && i < index);
      if (nearest && !owned) {
        if (!inWindow(nearest.iso)) {
          outside.push(id);
          continue;
        }
        date = nearest.iso;
      }
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
  return { deals, undated, outside, ids: ids.length };
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
 * Every offer page an index page links to, as [{ path, text }]: the anchors
 * whose href is a page on the site and whose text or path says it is an offer.
 * The flash-sale index (2026-10-01) names its six per-direction pages only in
 * link text — "Flash Sale offer from Brussels and Cologne to Switzerland and
 * Milan" — so the text is kept: it is what says which train a page sells.
 */
export function findOfferLinks(html, { pathPattern = /last-minutes?-|flash/i, indexPath = "" } = {}) {
  const out = new Map();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const href = m[1].replace(/^https?:\/\/(?:www\.)?europeansleeper\.eu/i, "").replace(/\/$/, "").toLowerCase();
    if (!/^\/[a-z0-9/_-]+$/.test(href) || href === indexPath.toLowerCase()) continue;
    // A translation (/de/flash-sale, /nl/…) is the same offers again, and the
    // live index links all four languages' copies of itself.
    if (/^\/[a-z]{2}\//.test(href)) continue;
    const text = stripTags(m[2]);
    if (!pathPattern.test(href) && !/\boffer from .+ to /i.test(text)) continue;
    // Of two anchors to one page, the one naming a route says the most.
    const prev = out.get(href);
    const better = !prev || (!prev.text && text) || (!ROUTE_TEXT.test(prev.text) && ROUTE_TEXT.test(text));
    if (better) out.set(href, { path: href, text });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

const ROUTE_TEXT = /\bfrom\s+.+\s+to\s+/i;
const foldCity = (s) => decodeText(s).toLowerCase().replace(/[^a-z]+/g, " ").trim();
const slugCity = (s) => foldCity(s).replace(/ /g, "-");
const placeList = (s) =>
  s.split(/\s*(?:,|&|\band\b|\bund\b|\ben\b|\bet\b)\s*/i).map(foldCity).filter(Boolean);

/**
 * The train an offer's own words describe — "… from Brussels and Cologne to
 * Switzerland and Milan" — among `trainCities` ({ key: [fromCity, toCity] }):
 * the one whose first city is among the "from" places and whose last city is
 * among the "to" places. Unique or nothing.
 */
export function trainForOfferText(text, trainCities) {
  const m = decodeText(text).match(/\bfrom\s+(.+?)\s+to\s+(.+?)[.!]?\s*$/i);
  if (!m) return null;
  const from = placeList(m[1]);
  const to = placeList(m[2]);
  const hits = Object.entries(trainCities ?? {}).filter(
    ([, [a, b]]) => from.includes(foldCity(a)) && to.includes(foldCity(b)),
  );
  return hits.length === 1 ? hits[0][0] : null;
}

/**
 * The train an offer page's own address names, for when its link text does
 * not: the live flash-sale index (2026-10-01) links /flash-berlin-paris with
 * the words "to Brussels and Paris" and nothing else, so the route is in the
 * slug. A slug is read as "{first city}-{last city}" and matches the one
 * train that starts in the first and ends in the second — an exact endpoint
 * pair, because the last-minute pages slug a stretch of the route instead
 * (/last-minutes-hamburg-berlin sells Paris → Berlin), which must read as no
 * train rather than a wrong one. Where the link text says where the offer
 * goes ("to Brussels and Paris"), the train has to end there too.
 */
export function trainForOfferPath(path, trainCities, { text = "" } = {}) {
  const slug = String(path ?? "")
    .toLowerCase()
    .replace(/^\/(?:[a-z]{2}\/)?/, "")
    .replace(/^(?:flash(?:-sale)?|last-minutes?)-/, "");
  const hits = Object.entries(trainCities ?? {}).filter(
    ([, [a, b]]) => a && b && slug === `${slugCity(a)}-${slugCity(b)}`,
  );
  if (hits.length !== 1) return null;
  const to = decodeText(text).match(/\bto\s+(.+?)[.!]?\s*$/i);
  if (to && !placeList(to[1]).includes(foldCity(hits[0][1][1]))) return null;
  return hits[0][0];
}

/** "ends 6 October" / "Book by 6 October" on a sale page → "2026-10-06", or null. */
export function saleEndDate(html, { today } = {}) {
  const text = stripTags(String(html ?? "").replace(/<script\b[\s\S]*?<\/script>/gi, " "));
  const m = text.match(/\b(?:ends?|book (?:by|before)|until|valid until|t\/m)\s+([^.!|]{3,40})/i);
  if (!m) return null;
  const d = findDates(m[1], { today })[0];
  return d && (!today || d.iso >= today) ? d.iso : null;
}

/**
 * Tonight's deals across every promotional programme's pages, as
 * { ok, deals: [{ train, date, kind, amount, landing, id, programme, until }],
 *   pages: [...] }.
 *
 * `programmes`: [{ id: "lastMinute" | "flashSale", indexPath, pages:
 * [{ path, trains }] }]. A programme's index page is read for the offer pages
 * it links to; a page's train is the registry's word for it where it has one,
 * else what the link text names ("offer from Paris and Brussels to Hamburg and
 * Berlin"), else what its address names (/flash-paris-berlin), else a train
 * number in the deal's own text. `horizonDays` is how far ahead a deal date
 * may lie — the calendar's own window, since a flash sale sells nights months
 * out. Each deal's price is
 * read from /receipt/price/1/{id}: the operator's own figure, and an empty
 * answer means the deal is gone, whatever the page still says. `ok` is false
 * only when no page could be read at all — the caller then keeps yesterday's
 * deals rather than wiping them on a network blip.
 */
export async function fetchDeals({
  programmes = [],
  site = SITE,
  trains = {},
  trainCities = null,
  today,
  fetchImpl = fetch,
  log = console.log,
  spacingMs = 300,
  maxPriceChecks = 200,
  horizonDays = 92,
} = {}) {
  const tracked = new Set(Object.keys(trains).map(String));
  const cities = trainCities ?? {};
  const toRead = new Map(); // path → { path, trains, text, programme, until }
  let readable = 0;
  for (const prog of programmes) {
    const configured = (prog.pages ?? []).map((p) => ({ ...p, path: String(p.path).toLowerCase() }));
    for (const p of configured) toRead.set(p.path, { ...p, programme: prog.id, until: null });
    if (!prog.indexPath) continue;
    try {
      const index = await getText(`${site}${prog.indexPath}`, fetchImpl);
      if (index.ok) {
        readable++;
        const until = prog.id === "flashSale" ? saleEndDate(index.body, { today }) : null;
        const links = findOfferLinks(index.body, {
          pathPattern: prog.id === "flashSale" ? /flash/i : /last-minutes?-/i,
          indexPath: prog.indexPath,
        });
        const fresh = links.filter((l) => !toRead.has(l.path));
        for (const l of links) {
          const known = toRead.get(l.path);
          toRead.set(l.path, {
            path: l.path,
            trains: known?.trains ?? [],
            text: l.text,
            programme: prog.id,
            until: until ?? known?.until ?? null,
          });
        }
        log(
          `[es-deals] ${prog.indexPath} links ${links.length} offer page(s)` +
            (fresh.length ? `, ${fresh.length} not in the registry: ${fresh.map((l) => l.path).join(", ")}` : "") +
            (until ? `; sale ends ${until}` : ""),
        );
      } else {
        log(`[es-deals] ${prog.indexPath} answered HTTP ${index.status}`);
      }
    } catch (err) {
      log(`[es-deals] ${prog.indexPath} failed: ${err.message}`);
    }
    if (spacingMs) await sleep(spacingMs);
  }

  const report = [];
  const raw = [];
  for (const page of toRead.values()) {
    const entry = {
      path: page.path, programme: page.programme, status: null, ids: 0, dated: 0, undated: 0, outside: 0, used: 0, train: null,
    };
    report.push(entry);
    try {
      const res = await getText(`${site}${page.path}`, fetchImpl);
      entry.status = res.status;
      if (!res.ok) continue;
      readable++;
      const pageTrain =
        (page.trains ?? []).map(String).find((t) => tracked.has(t)) ??
        trainForOfferText(page.text, cities) ??
        trainForOfferPath(page.path, cities, { text: page.text }) ??
        null;
      entry.train = pageTrain;
      const until = page.until ?? (page.programme === "flashSale" ? saleEndDate(res.body, { today }) : null);
      const parsed = parseLastMinutePage(res.body, { today, horizonDays, trainNumbers: [...tracked] });
      entry.ids = parsed.ids;
      entry.dated = parsed.deals.length;
      entry.undated = parsed.undated.length;
      entry.outside = parsed.outside.length;
      for (const d of parsed.deals) {
        const train = d.trainNumber && tracked.has(d.trainNumber) ? d.trainNumber : pageTrain;
        if (!train) continue;
        raw.push({ ...d, train, landing: page.path, programme: page.programme, until });
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
    deals.push({
      train: d.train,
      date: d.date,
      kind,
      amount,
      landing: d.landing,
      id: d.id,
      programme: d.programme ?? "lastMinute",
      ...(d.until ? { until: d.until } : {}),
    });
  }
  for (const entry of report) entry.used = deals.filter((d) => d.landing === entry.path).length;
  for (const e of report) {
    log(
      `[es-deals] ${e.path}: ${e.status ?? "no answer"}${e.error ? ` (${e.error})` : ""} — ` +
        `${e.ids} deal id(s), ${e.dated} dated, ${e.undated} undated` +
        `${e.outside ? `, ${e.outside} outside the ${horizonDays}-night window` : ""}, ${e.used} used` +
        (e.train ? ` (ES ${e.train})` : e.ids ? " (no train: neither the registry, the link text nor the address names one)" : ""),
    );
  }
  if (expired) log(`[es-deals] ${expired} deal(s) the page lists have expired (empty /receipt/price answer)`);
  return { ok: readable > 0, deals, pages: report };
}

/**
 * The last-minute programme alone — the original entry point, kept for the
 * tests and callers that name one index and its pages.
 */
export function fetchLastMinuteDeals({ pages = [], indexPath = "/last-minute", trainKeys = [], ...rest } = {}) {
  return fetchDeals({
    ...rest,
    programmes: [{ id: "lastMinute", indexPath, pages }],
    trains: Object.fromEntries(trainKeys.map((k) => [String(k), {}])),
  });
}
