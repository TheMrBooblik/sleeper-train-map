// scripts/lib/http-block.mjs
// How a scraper tells "the operator is turning automated clients away" apart
// from an ordinary error, and the name it gives itself while asking.
//
// This map never works around an operator's bot protection: no captcha or
// proof-of-work solving, no browser User-Agent, no headless browser, no
// alternate host. So a block is final for the run — the caller stops asking
// that host, says so in the log, and keeps whatever it already had. What
// counts as a block is kept here, in one place, so the nightly fare pass and
// the verification probes read a refusal the same way.
//
// Dependency-free and pure. Covered by tests/verify-nj-fares.mjs.

/**
 * Who is asking. Honest and reachable: an operator that wants us to stop can
 * see who we are and where to say so.
 */
export const HONEST_USER_AGENT = "Pingwi/1.0 (+https://pingwi.com; night-train fare calendar)";

/** Statuses a WAF or rate limiter answers with. A plain 5xx is not one. */
const BLOCK_STATUSES = new Set([403, 429, 451]);

/** Cloudflare's own error range: the origin was never asked. */
const isCloudflareError = (status) => status >= 520 && status <= 530;

/**
 * Text a challenge or block page carries. Matched case-insensitively against
 * the start of the body only, so a JSON answer that happens to mention one of
 * these words in a station name cannot trip it.
 */
const BLOCK_MARKERS = [
  "just a moment",
  "cf-chl",
  "/cdn-cgi/challenge-platform/",
  "challenges.cloudflare.com",
  "attention required! | cloudflare",
  "sorry, you have been blocked",
  "zugriff vorübergehend eingeschränkt",
  "access denied",
  "the request is blocked",
  "captcha",
];

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/**
 * Whether a response is the host refusing automated clients, and what said so.
 *
 * @param {{ status: number, headers?: Headers|object, body?: string }} res
 * @param {{ expectJson?: boolean }} [opts] expectJson: an HTML page where JSON
 *   was asked for is a block page on any status, 200 included
 * @returns {null | { status: number, reason: string, vendor: string|null }}
 */
export function detectBlock({ status, headers, body = "" }, { expectJson = true } = {}) {
  const server = header(headers, "server");
  const cfRay = header(headers, "cf-ray");
  const azure = header(headers, "x-azure-ref") ?? header(headers, "x-msedge-ref");
  const vendor = cfRay || /cloudflare/i.test(server ?? "")
    ? "cloudflare"
    : azure
      ? "azure"
      : server || null;
  const mitigated = header(headers, "cf-mitigated");
  if (mitigated) return { status, reason: `cf-mitigated: ${mitigated}`, vendor: "cloudflare" };
  if (BLOCK_STATUSES.has(status)) return { status, reason: `HTTP ${status}`, vendor };
  if (isCloudflareError(status)) return { status, reason: `HTTP ${status} (Cloudflare)`, vendor: "cloudflare" };

  const head = String(body ?? "").slice(0, 4000).toLowerCase();
  const marker = BLOCK_MARKERS.find((m) => head.includes(m));
  const type = header(headers, "content-type") ?? "";
  const html = /text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(head);
  // A challenge page is HTML; where JSON was asked for, a page that is HTML
  // and says one of the above is a block on any status, 200 included. Where
  // a page was asked for, the marker alone has to do.
  if (marker && (html || !expectJson)) return { status, reason: `block page ("${marker}")`, vendor };
  return null;
}

/** One line for a log: "blocked by cloudflare (HTTP 403)". */
export function describeBlock(block) {
  if (!block) return "";
  return `blocked${block.vendor ? ` by ${block.vendor}` : ""} (${block.reason})`;
}
