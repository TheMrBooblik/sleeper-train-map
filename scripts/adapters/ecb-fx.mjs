// scripts/adapters/ecb-fx.mjs
// The European Central Bank's daily euro reference rates, for one thing only:
// printing an approximate euro figure beside a fare quoted in yen, yuan or any
// other currency (src/lib/fx.mjs). Not an operator and feeds no route.
//
// The ECB publishes one XML file a working day around 16:00 CET:
//   <Cube time='2026-09-25'><Cube currency='USD' rate='1.1750'/>…</Cube>
// Rates are units of the currency per euro. A failed fetch throws, so the
// runner records it in source-health.json and the last committed rates stay —
// a day-old rate is a fine basis for an "≈" figure; no rate at all is not.

const FETCH_TIMEOUT_MS = 20_000;

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
  ctx.write(entry.output, {
    uploadedAt: ctx.today,
    source: "ECB euro foreign exchange reference rates",
    sourceUrl: url,
    date,
    rates,
  });
  console.log(`[scrape] ecb-fx: ${Object.keys(rates).length} rates for ${date}`);
}
