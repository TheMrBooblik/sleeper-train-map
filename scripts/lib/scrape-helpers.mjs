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
  return str.toLowerCase().replace(/(?:^|\s|[-'(])(\p{L})/gu, (_, c) => _.slice(0, -1) + c.toUpperCase());
}
