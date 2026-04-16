// Shared train fetching logic for NightJet and EuroNight routes.
// Data is stored in Vercel Blob via scrape-backontrack.js (daily cron).

const FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(id),
  );
}

/**
 * Normalize NightJet/EuroNight train data from the API into our storage format.
 */
export function normalize(data, date, operator = "Nightjet", source = "nightjet-com") {
  const stops = Array.isArray(data?.route?.stops) ? data.route.stops : [];
  const stations = stops
    .map((s) => {
      const [lat, lon] = s?.station?.coords || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const name =
        s?.station?.name?.de || s?.station?.name?.int || s?.station?.name?.en;
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
 * Fetch a single train from the NightJet API and return normalized data.
 * No file system writes — suitable for use in the scrape cron.
 */
export async function fetchSingleTrain(trainNumber, date) {
  const encoded = encodeURIComponent(trainNumber);
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encoded}/${date}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[train-fetcher] upstream ${res.status} for ${trainNumber}`);
      return null;
    }
    const data = await res.json();
    if (!data?.route?.stops?.length) return null;
    const operator = data.partnerTrain ? "EuroNight" : "Nightjet";
    return normalize(data, date, operator, "nightjet-com");
  } catch (e) {
    console.warn(`[train-fetcher] fetch failed for ${trainNumber}: ${e.message}`);
    return null;
  }
}

/**
 * Discover NightJet (non-partner) train numbers by querying the country-pair endpoint.
 * Country codes are UIC standard: 80=DE, 81=AT, 83=IT, 84=NL, 85=CH, 88=BE.
 * Querying all pairs guarantees we find trains regardless of what BoT data contains.
 *
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<string[]>} Array of NJ train numbers
 */
export async function fetchNJTrainNumbers(date) {
  // Countries served by NightJet (non-partner) trains
  const NJ_COUNTRIES = [80, 81, 83, 84, 85, 88]; // DE, AT, IT, NL, CH, BE

  // Query all N×N ordered pairs — the endpoint is directional (AT→DE ≠ DE→AT)
  const pairs = [];
  for (const from of NJ_COUNTRIES) {
    for (const to of NJ_COUNTRIES) {
      pairs.push([from, to]);
    }
  }

  const njNumbers = new Set();
  await Promise.all(
    pairs.map(async ([from, to]) => {
      const url = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from}/country/${to}/${date}`;
      try {
        const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const trains = await res.json();
        if (!Array.isArray(trains)) return;
        trains.forEach((t) => {
          if (t?.trainNumber && !t.partnerTrain) njNumbers.add(t.trainNumber);
        });
      } catch (e) {
        console.warn(`[train-fetcher] country ${from}/${to} failed: ${e.message}`);
      }
    }),
  );

  return Array.from(njNumbers);
}

/**
 * Discover EuroNight partner train numbers from NightJet API.
 *
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {number} max - Max number of trains to return
 * @returns {Promise<string[]>} Array of train numbers
 */
export async function fetchPartnerTrainNumbers(date, max = 25) {
  const url = `https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`;
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      console.warn(`[train-fetcher] partner endpoint returned ${response.status}`);
      return [];
    }
    const data = await response.json();
    const trains = Array.isArray(data) ? data : [];
    return trains.map((t) => t?.trainNumber).filter(Boolean).slice(0, max);
  } catch (e) {
    console.warn(`[train-fetcher] partner fetch failed: ${e.message}`);
    return [];
  }
}
