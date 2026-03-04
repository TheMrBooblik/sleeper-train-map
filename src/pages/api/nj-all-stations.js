// pages/api/nj-all-stations.js
// Fetch all Nightjet stations by iterating through countries and destinations. Cache in .next/cache or /tmp on Vercel.
// NOTE: On Vercel, each request runs in an isolated container with its own /tmp.
// Progress file writes are skipped on Vercel because other containers can't read them.

import fs from "fs";
import path from "path";
import { discoverAllTrainNumbers } from "./lib/nj-discovery";
import { getCacheDir, ensureDir as ensureDirHelper } from "./lib/cache-dir";

// On Vercel, each serverless invocation has its own isolated /tmp — progress
// written in one container is never visible to the polling container.
const IS_VERCEL = process.env.VERCEL === "1";

const CACHE_DIR = getCacheDir("nightjet");
const CACHE_FILE = path.join(CACHE_DIR, "all-stations.json");
const PROGRESS_FILE = path.join(CACHE_DIR, "all-stations-progress.json");
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cache

function ensureDir() {
  return ensureDirHelper(fs, CACHE_DIR);
}

function isFresh(p) {
  try {
    return fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs < TTL_MS;
  } catch {
    return false;
  }
}

function updateProgress(progress) {
  // Skip on Vercel — progress file is local to each container and invisible
  // to the separate containers that handle progress-poll requests.
  if (IS_VERCEL) return;
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

  const allStations = new Map(); // Use Map to deduplicate by EVA number
  
  // Use shared discovery utility to find all train numbers
  // This combines cache, Back-on-Track, and comprehensive API discovery
  log("Step 1: Discovering train numbers...");
  const trainNumbers = await discoverAllTrainNumbers(
    date,
    "", // Base URL not needed for nj-all-stations (Back-on-Track discovery will be skipped)
    (progress) => {
      log(progress.message);
      if (onProgress) {
        onProgress(progress);
      }
    }
  );

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
    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        if (cached?.stations?.length) {
          cachedTrains.push({ trainNumber, cached });
        } else {
          uncachedTrains.push(trainNumber);
        }
      } else {
        uncachedTrains.push(trainNumber);
      }
    } catch {
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
    const progressOnly = req.query.progress === "true";

    ensureDir();

    // Progress poll: return last written progress (e.g. "Checking routes: 120/132 country pairs").
    // On Vercel, progress file is per-container and not shared, so we return a static message.
    if (progressOnly) {
      if (IS_VERCEL) {
        return res.status(200).json({
          progress: 50,
          message: "Loading NightJet stations…",
          step: "fetching",
        });
      }
      const p = getProgress();
      return res
        .status(200)
        .json(
          p || {
            progress: 0,
            message: "Starting…",
            step: "",
          },
        );
    }

    // Return cached if fresh and not forcing refresh
    if (!forceRefresh && isFresh(CACHE_FILE)) {
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(cached);
      } catch {}
    }

    // Fetch fresh data; write progress to file so progress poll can show status
    const data = await fetchAllStations(date, (p) => updateProgress(p));

    // Cache it (may fail on read-only fs; we still return the data)
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch {}

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
