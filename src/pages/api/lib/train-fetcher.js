// Shared train fetching and caching logic for NJ and EN endpoints.
// Extracted so list endpoints can fetch trains in-process instead of HTTP-calling
// prewarm endpoints — which run in separate serverless functions on Vercel with
// isolated /tmp filesystems.

import fs from "fs";
import path from "path";

const TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(cacheDir, train, date) {
  const key = `${String(train).replace(/\s+/g, "").toUpperCase()}-${date}`;
  return path.join(cacheDir, `${key}.json`);
}

/** Check if a cache file exists and is less than 24h old */
export function isFresh(filePath) {
  try {
    return (
      fs.existsSync(filePath) &&
      Date.now() - fs.statSync(filePath).mtimeMs < TTL_MS
    );
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

/**
 * Normalize NightJet/EuroNight train data from the API into our cache format.
 * Shared between prewarm and list endpoints.
 */
export function normalize(
  data,
  date,
  operator = "Nightjet",
  source = "nightjet-com",
) {
  const stops = Array.isArray(data?.route?.stops) ? data.route.stops : [];
  const stations = stops
    .map((s) => {
      const [lat, lon] = s?.station?.coords || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const name =
        s?.station?.name?.en || s?.station?.name?.int || s?.station?.name?.de;
      return {
        id: s?.station?.eva || s?.station?.evaMeta || null,
        name,
        location: { latitude: lat, longitude: lon },
        arrival: s?.arr ? new Date(s.arr).toISOString() : null,
        departure: s?.dep ? new Date(s.dep).toISOString() : null,
        pickup: !!s?.pickup,
        dropoff: !!s?.dropoff,
      };
    })
    .filter(Boolean);

  return {
    lineName: data?.trainNumber,
    operator,
    date,
    stations,
    polyline: data?.route?.polyline || null,
    fetchedAt: new Date().toISOString(),
    source,
  };
}

/**
 * Fetch and cache a batch of trains in-process (no HTTP call to prewarm).
 * Solves Vercel /tmp isolation: list endpoints write directly to their own /tmp.
 *
 * @param {string} cacheDir - Absolute path to cache directory
 * @param {string[]} trainNumbers - Train numbers to fetch
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {object} opts - Options: operator, source, concurrency
 * @returns {Promise<{skippedFresh: number, fetched: number, errors: Array}>}
 */
export async function fetchAndCacheTrains(
  cacheDir,
  trainNumbers,
  date,
  { operator = "Nightjet", source = "nightjet-com", concurrency = 6 } = {},
) {
  const results = { skippedFresh: 0, fetched: 0, errors: [] };
  const queue = [...trainNumbers];

  async function worker() {
    while (queue.length) {
      const train = queue.shift();
      const p = cachePath(cacheDir, train, date);
      if (isFresh(p)) {
        results.skippedFresh++;
        continue;
      }
      try {
        const data = await fetchJson(
          `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(train)}/${date}`,
        );
        const payload = normalize(data, date, operator, source);
        if (payload?.stations?.length) {
          try {
            fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
          } catch {}
          results.fetched++;
        }
      } catch (e) {
        results.errors.push({ train, message: e.message });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Discover EuroNight partner train numbers from NightJet API.
 *
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {number} max - Max number of trains to return
 * @returns {Promise<string[]>} Array of train numbers
 */
export async function fetchPartnerTrainNumbers(date, max = 25) {
  const partnerUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`;
  const response = await fetch(partnerUrl, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const data = await response.json();
  const trains = Array.isArray(data) ? data : [];
  return trains
    .map((t) => t?.trainNumber)
    .filter(Boolean)
    .slice(0, max);
}
