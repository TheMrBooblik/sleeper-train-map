// scripts/adapters/ecb-fx.mjs
// The European Central Bank's daily euro reference rates (plus, for a
// currency the ECB does not publish — the dong — the European Commission's
// monthly InforEuro rate, `params.supplements`), for one thing only:
// printing an approximate euro figure beside a fare quoted in yen, yuan or any
// other currency (src/lib/fx.mjs). Not an operator and feeds no route.
//
// The ECB publishes one XML file a working day around 16:00 CET:
//   <Cube time='2026-09-25'><Cube currency='USD' rate='1.1750'/>…</Cube>
// Rates are units of the currency per euro. A failed fetch throws, so the
// runner records it in source-health.json and the last committed rates stay —
// a day-old rate is a fine basis for an "≈" figure; no rate at all is not.

import fs from "node:fs";
import path from "node:path";

const FETCH_TIMEOUT_MS = 20_000;

/**
 * The rate an InforEuro answer gives for `today`: the month whose window
 * covers it, else the latest month listed. InforEuro (the European
 * Commission's monthly accounting rates) covers every currency, the dong
 * included, which the ECB does not publish. Answer shape:
 *   [{ currencyIso: "VND", refCurrencyIso: "EUR", amount: 29494.04475,
 *      dateStart: "01/10/2026", dateEnd: "31/10/2026" }, …]
 * Returns { rate, month: "2026-10" } or null.
 */
export function parseInforEuro(json, currency, today) {
  const iso = (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? ""));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };
  const rows = (Array.isArray(json) ? json : [])
    .filter((r) => r?.currencyIso === currency && (r.refCurrencyIso ?? "EUR") === "EUR" && Number(r.amount) > 0)
    .map((r) => ({ rate: Number(r.amount), start: iso(r.dateStart), end: iso(r.dateEnd) }))
    .filter((r) => r.start)
    .sort((a, b) => (a.start < b.start ? 1 : -1));
  const hit = rows.find((r) => r.start <= today && (!r.end || today <= r.end)) ?? rows[0];
  return hit ? { rate: hit.rate, month: hit.start.slice(0, 7) } : null;
}

/**
 * Rates for the currencies the ECB does not publish, from
 * `params.supplements` ([{ currency, url }], InforEuro). Never fatal: a
 * supplement that cannot be read keeps last night's rate for it.
 */
async function readSupplements(entry, ctx, fetchImpl) {
  const out = { rates: {}, rateSources: {} };
  let previous = null;
  try {
    const file = path.join(ctx.rootDir ?? "", "public/data/scraped", entry.output);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    previous = json?.data ?? json;
  } catch {
    previous = null;
  }
  for (const { currency, url } of entry.params?.supplements ?? []) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hit = parseInforEuro(JSON.parse(await res.text()), currency, ctx.today);
      if (!hit) throw new Error(`no ${currency} rate in the answer`);
      out.rates[currency] = hit.rate;
      out.rateSources[currency] = { source: "InforEuro", month: hit.month, url };
    } catch (err) {
      const kept = previous?.rates?.[currency];
      console.log(`[scrape] ecb-fx: ${currency} from ${url}: ${err.message}${kept ? " — keeping last night's rate" : ""}`);
      if (kept) {
        out.rates[currency] = kept;
        if (previous?.rateSources?.[currency]) out.rateSources[currency] = previous.rateSources[currency];
      }
    }
  }
  return out;
}

/** { date, rates } from the ECB daily XML. Throws when it carries no rates. */
export function parseEcbDaily(xml) {
  const text = String(xml ?? "");
  const date = /time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]/.exec(text)?.[1] ?? null;
  const rates = {};
  for (const m of text.matchAll(/currency\s*=\s*['"]([A-Z]{3})['"]\s+rate\s*=\s*['"]([\d.]+)['"]/g)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) rates[m[1]] = rate;
  }
  if (!date || !Object.keys(rates).length) {
    throw new Error("the ECB file carried no dated rates");
  }
  return { date, rates };
}

export async function run(entry, ctx) {
  const url = entry.params?.feedUrl;
  const fetchImpl = ctx.fetch ?? fetch;
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PingwiSleeperMap/1.0; +https://pingwi.com)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
  const { date, rates } = parseEcbDaily(await res.text());
  const missing = (entry.params?.requiredCurrencies ?? []).filter((c) => !rates[c]);
  if (missing.length) {
    throw new Error(`ECB rates for ${date} lack ${missing.join(", ")} — keeping the last committed rates`);
  }
  const extra = await readSupplements(entry, ctx, fetchImpl);
  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    source: "ECB euro foreign exchange reference rates",
    sourceUrl: url,
    date,
    // The ECB's own rates win: a supplement only fills a currency it lacks.
    rates: { ...extra.rates, ...rates },
    ...(Object.keys(extra.rateSources).length ? { rateSources: extra.rateSources } : {}),
  });
  console.log(`[scrape] ecb-fx: ${Object.keys(rates).length} rates for ${date}`);
}
