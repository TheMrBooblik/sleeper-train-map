// pages/api/nj-all-stations.js
// Fetch all Nightjet stations by iterating through countries and destinations

import fs from "fs";
import path from "path";

const CACHE_DIR = path.join(process.cwd(), ".next", "cache", "nightjet");
const CACHE_FILE = path.join(CACHE_DIR, "all-stations.json");
const PROGRESS_FILE = path.join(CACHE_DIR, "all-stations-progress.json");
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cache

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function isFresh(p) {
  try {
    return fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs < TTL_MS;
  } catch {
    return false;
  }
}

function updateProgress(progress) {
  try {
    fs.writeFileSync(
      PROGRESS_FILE,
      JSON.stringify({
        ...progress,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch (err) {
    console.error("[nj-all-stations] Failed to update progress:", err.message);
  }
}

function getProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    }
  } catch {}
  return null;
}

async function fetchAllStations(date, onProgress) {
  const log = (message, ...args) => {
    console.log(`[nj-all-stations] ${message}`, ...args);
    if (onProgress) {
      onProgress({ message, args: args.length > 0 ? args : undefined });
    }
  };

  log("Starting to fetch all stations for date:", date);

  // All known Nightjet country IDs
  const countries = [
    { eva: "88", name: "Belgium" },
    { eva: "55", name: "Hungary" },
    { eva: "78", name: "Croatia" },
    { eva: "79", name: "Slovenia" },
    { eva: "80", name: "Germany" },
    { eva: "81", name: "Austria" },
    { eva: "83", name: "Italy" },
    { eva: "84", name: "Netherlands" },
    { eva: "51", name: "Poland" },
    { eva: "85", name: "Switzerland" },
    { eva: "87", name: "France" },
    { eva: "54", name: "Czech Republic" },
  ];

  const allStations = new Map(); // Use Map to deduplicate by EVA number
  const trainNumbers = new Set(); // Track unique train numbers to fetch full routes

  // Step 1: Check cached train files first to avoid unnecessary API calls
  log("Step 1: Checking cached train data...");
  const cachedTrainFiles = fs.existsSync(CACHE_DIR)
    ? fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.endsWith(`${date}.json`) && f.startsWith("NJ"))
    : [];

  if (cachedTrainFiles.length > 0) {
    log(
      `Found ${cachedTrainFiles.length} cached train files, extracting train numbers...`,
    );
    cachedTrainFiles.forEach((file) => {
      try {
        const filePath = path.join(CACHE_DIR, file);
        const cached = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (cached?.lineName) {
          trainNumbers.add(cached.lineName);
        }
      } catch {}
    });
    log(`Extracted ${trainNumbers.size} train numbers from cache`);
  }

  // Step 2: Discover additional train numbers from destinations endpoint (parallelized)
  log("Step 2: Discovering train numbers from destinations API...");
  const countryPairs = [];
  for (const fromCountry of countries) {
    for (const toCountry of countries) {
      // Skip same-country pairs to reduce requests
      if (fromCountry.eva !== toCountry.eva) {
        countryPairs.push({ from: fromCountry, to: toCountry });
      }
    }
  }

  log(`Fetching destinations from ${countryPairs.length} country pairs...`);
  const batchSize = 5; // Process 5 requests in parallel
  let processed = 0;

  for (let i = 0; i < countryPairs.length; i += batchSize) {
    const batch = countryPairs.slice(i, i + batchSize);
    const promises = batch.map(async ({ from, to }) => {
      try {
        const destinationsUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from.eva}/country/${to.eva}/${date}`;
        const destResponse = await fetch(destinationsUrl, {
          headers: { accept: "application/json" },
        });

        if (!destResponse.ok) {
          if (destResponse.status === 404) return [];
          return [];
        }

        const destinations = await destResponse.json();
        return Array.isArray(destinations) ? destinations : [];
      } catch (err) {
        return [];
      }
    });

    const results = await Promise.all(promises);
    results.forEach((destinations) => {
      destinations.forEach((dest) => {
        if (dest.trainNumber) {
          trainNumbers.add(dest.trainNumber);
        }
      });
    });

    processed += batch.length;
    const progress = Math.round((processed / countryPairs.length) * 30); // 30% for discovery
    log(
      `Discovered ${trainNumbers.size} trains so far (${processed}/${countryPairs.length} pairs checked)`,
    );
    if (onProgress) {
      onProgress({
        step: "discovering",
        progress,
        message: `Checking routes: ${processed}/${countryPairs.length} country pairs`,
        trainsFound: trainNumbers.size,
      });
    }

    // Small delay between batches
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  log(`Found ${trainNumbers.size} unique train numbers total`);

  // Step 3: Fetch full route data for each train (parallelized in batches)
  log("Step 3: Fetching full routes for each train...");
  const trainArray = Array.from(trainNumbers);
  const trainBatchSize = 3; // Process 3 trains in parallel
  let trainsProcessed = 0;

  // First, check cached train files
  const cachedTrains = [];
  const uncachedTrains = [];

  trainArray.forEach((trainNumber) => {
    const cacheKey = `${trainNumber.replace(/\s+/g, "")}-${date}.json`;
    const cachePath = path.join(CACHE_DIR, cacheKey);
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        if (cached?.stations?.length) {
          cachedTrains.push({ trainNumber, cached });
        } else {
          uncachedTrains.push(trainNumber);
        }
      } catch {
        uncachedTrains.push(trainNumber);
      }
    } else {
      uncachedTrains.push(trainNumber);
    }
  });

  log(
    `Found ${cachedTrains.length} cached trains, fetching ${uncachedTrains.length} from API...`,
  );

  // Process cached trains first
  cachedTrains.forEach(({ trainNumber, cached }) => {
    cached.stations?.forEach((station) => {
      if (
        station.id &&
        station.location?.latitude &&
        station.location?.longitude
      ) {
        if (!allStations.has(station.id)) {
          allStations.set(station.id, station);
        }
      }
    });
    trainsProcessed++;
  });

  // Fetch uncached trains in parallel batches
  for (let i = 0; i < uncachedTrains.length; i += trainBatchSize) {
    const batch = uncachedTrains.slice(i, i + trainBatchSize);
    const promises = batch.map(async (trainNumber) => {
      try {
        const trainUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(trainNumber)}/${date}`;
        const trainResponse = await fetch(trainUrl, {
          headers: { accept: "application/json" },
        });

        if (!trainResponse.ok) {
          if (trainResponse.status === 404) return null;
          return null;
        }

        const trainData = await trainResponse.json();
        const stops = Array.isArray(trainData?.route?.stops)
          ? trainData.route.stops
          : [];

        const stations = [];
        stops.forEach((stop) => {
          const station = stop?.station;
          if (!station) return;

          const eva = station.eva || station.evaMeta;
          const coords = station.coords || [];

          if (eva && coords.length === 2) {
            const [lat, lon] = coords;
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              const stationName =
                station.name?.en ||
                station.name?.int ||
                station.name?.de ||
                station.name;
              stations.push({
                id: eva,
                name: stationName,
                location: { latitude: lat, longitude: lon },
                country: station.country || null,
                countryCode: station.country || null,
              });
            }
          }
        });

        return { trainNumber, stations, stops: stops.length };
      } catch (err) {
        return null;
      }
    });

    const results = await Promise.all(promises);
    results.forEach((result) => {
      if (result) {
        result.stations.forEach((station) => {
          if (!allStations.has(station.id)) {
            allStations.set(station.id, station);
          }
        });
        trainsProcessed++;
        log(
          `Train ${result.trainNumber}: ${result.stops} stops, ${allStations.size} unique stations`,
        );
      }
    });

    const progress =
      30 + Math.round((trainsProcessed / trainArray.length) * 70); // 30-100% for fetching
    if (onProgress) {
      onProgress({
        step: "fetching",
        progress,
        message: `Fetching routes: ${trainsProcessed}/${trainArray.length} trains`,
        stationsFound: allStations.size,
        currentTrain: batch[0],
      });
    }

    // Small delay between batches
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const stationsArray = Array.from(allStations.values());
  log(`Complete! Found ${stationsArray.length} unique stations`);

  return {
    stations: stationsArray,
    count: stationsArray.length,
    fetchedAt: new Date().toISOString(),
    date,
  };
}

export default async function handler(req, res) {
  try {
    const date = (
      req.query.date ||
      (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })()
    ).toString();

    const forceRefresh = req.query.refresh === "true";

    ensureDir();

    // Return cached if fresh and not forcing refresh
    if (!forceRefresh && isFresh(CACHE_FILE)) {
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(cached);
      } catch {}
    }

    // Fetch fresh data
    const data = await fetchAllStations(date);

    // Cache it
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");

    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, max-age=604800"); // 7 days
    return res.status(200).json(data);
  } catch (e) {
    console.error("[api/nj-all-stations] error:", e);
    return res
      .status(500)
      .json({ error: "internal_error", message: e.message });
  }
}
