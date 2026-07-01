// scripts/lib/scrape-helpers.mjs
// Small shared helpers for the scrape adapters. Dependency-free.

export const FETCH_TIMEOUT_MS = 15_000;

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(id),
  );
}

export function titleCase(str) {
  if (!str) return str;
  return str
    .toLowerCase()
    .replace(
      /(?:^|\s|[-'(])(\p{L})/gu,
      (_, c) => _.slice(0, -1) + c.toUpperCase(),
    );
}

/**
 * Map over items with a bounded concurrency, preserving input order. Used by
 * adapters that fetch many resources under a rate limit (e.g. PKP PLK per-train
 * route detail). `fn` receives (item, index).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function pMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}
