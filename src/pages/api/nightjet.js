// pages/api/nightjet.js
import { createClient } from "hafas-client";
import { profile as oebbProfile } from "hafas-client/p/oebb";
import fs from "fs";
import path from "path";

// Cache directory in .next/cache
const CACHE_DIR = path.join(process.cwd(), ".next", "cache", "nightjet");
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Ensure cache directory exists
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// Get cache file path for a train
function getCacheFilePath(trainNumber) {
  return path.join(CACHE_DIR, `${trainNumber}.json`);
}

// Check if cache is valid
function isCacheValid(cacheFilePath) {
  try {
    if (!fs.existsSync(cacheFilePath)) {
      return false;
    }
    
    const stats = fs.statSync(cacheFilePath);
    const now = Date.now();
    const cacheAge = now - stats.mtime.getTime();
    
    return cacheAge < CACHE_DURATION_MS;
  } catch (error) {
    console.error("Error checking cache:", error);
    return false;
  }
}

// Read cached data
function readCache(cacheFilePath) {
  try {
    const data = fs.readFileSync(cacheFilePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading cache:", error);
    return null;
  }
}

// Write data to cache
function writeCache(cacheFilePath, data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(cacheFilePath, JSON.stringify(data, null, 2), "utf8");
    console.log(`Cache written to ${cacheFilePath}`);
  } catch (error) {
    console.error("Error writing cache:", error);
  }
}

// Fetch journey data from ÖBB API
async function fetchNightjetData(trainNumber) {
  try {
    console.log(`Fetching data for train ${trainNumber} from ÖBB API...`);
    
    // The oebb API doesn't have a direct "get train by number" method,
    // so we'll need to search for journeys on a typical route.
    // For NJ402/NJ403, this is typically Vienna to various destinations.
    // We'll search for journeys and filter by train number.
    
    // Common origin/destination for Nightjet routes
    // NJ402/403 runs between various cities - we'll use Vienna as a reference
    const viennaStationId = "1190100"; // Wien Hauptbahnhof
    
    // Search for stations first to get journey info
    // Note: The oebb package has limitations - we might need to adjust this approach
    // based on actual API responses
    
    // For now, we'll return a structured placeholder that matches expected format
    const journeyData = {
      trainNumber,
      fetched: new Date().toISOString(),
      note: "This is a placeholder. The oebb package primarily supports journey search, not direct train lookup.",
      stations: [],
      // In a full implementation, we'd fetch and parse journey data here
    };
    
    return journeyData;
  } catch (error) {
    console.error(`Error fetching Nightjet data for ${trainNumber}:`, error);
    throw error;
  }
}

export default async function handler(req, res) {
  const { train } = req.query;
  
  // Validate train parameter
  if (!train) {
    return res.status(400).json({ error: "Missing 'train' parameter" });
  }
  
  // Normalize train number (remove spaces)
  const trainNumber = train.replace(/\s+/g, "").toUpperCase();
  
  // Currently only supporting NJ402 and NJ403
  const supportedTrains = ["NJ402", "NJ403"];
  if (!supportedTrains.includes(trainNumber)) {
    return res.status(400).json({ 
      error: `Unsupported train number. Currently supported: ${supportedTrains.join(", ")}` 
    });
  }
  
  try {
    const cacheFilePath = getCacheFilePath(trainNumber);
    
    // Check if we have valid cached data
    if (isCacheValid(cacheFilePath)) {
      console.log(`Serving cached data for ${trainNumber}`);
      const cachedData = readCache(cacheFilePath);
      
      if (cachedData) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("Cache-Control", "public, max-age=3600"); // Cache on client for 1 hour
        return res.status(200).json(cachedData);
      }
    }
    
    // Fetch fresh data from ÖBB API
    console.log(`Cache miss or invalid for ${trainNumber}, fetching from API...`);
    const data = await fetchNightjetData(trainNumber);
    
    // Write to cache
    writeCache(cacheFilePath, data);
    
    // Return response
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json(data);
    
  } catch (error) {
    console.error("Error in nightjet API handler:", error);
    res.status(500).json({ 
      error: "Error fetching Nightjet data",
      message: error.message 
    });
  }
}
