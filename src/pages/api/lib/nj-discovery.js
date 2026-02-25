// Shared utilities for NightJet train discovery
// Used by nj-all-stations, nj-prewarm, and nj-list APIs

import fs from 'fs'
import path from 'path'
import { getCacheDir } from './cache-dir'

const CACHE_DIR = getCacheDir('nightjet')

// All known NightJet country IDs
export const NIGHTJET_COUNTRIES = [
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
]

/**
 * Get train numbers from cached train files
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Set<string>} Set of train numbers
 */
export function getTrainNumbersFromCache(date) {
  const trainNumbers = new Set()
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return trainNumbers
    }
    const cachedFiles = fs.readdirSync(CACHE_DIR).filter(
      f => f.endsWith(`${date}.json`) && f.startsWith('NJ')
    )
    cachedFiles.forEach(file => {
      try {
        const filePath = path.join(CACHE_DIR, file)
        const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        if (cached?.lineName) {
          trainNumbers.add(cached.lineName)
        }
      } catch {
        // Ignore errors reading individual cache files
      }
    })
  } catch {
    // Cache dir may not exist or be unreadable (e.g. Vercel cold start)
  }
  return trainNumbers
}

/**
 * Get train numbers from Back-on-Track trips data
 * @param {string} baseUrl - Base URL for API requests (for internal API calls)
 * @returns {Promise<Set<string>>} Set of train numbers
 */
export async function getTrainNumbersFromBackOnTrack(baseUrl) {
  const trainNumbers = new Set()
  
  try {
    const tripsRes = await fetch(`${baseUrl}/api/trains?type=trips`)
    if (tripsRes.ok) {
      const trips = await tripsRes.json()
      Object.values(trips || {}).forEach(t => {
        const n = (t?.trip_short_name || t?.route_short_name || '').toString()
        if (/^\s*NJ\s*\d+/.test(n)) {
          trainNumbers.add(n.replace(/\s+/g, ' ').trim())
        }
      })
    }
  } catch {
    // Ignore errors - Back-on-Track data is optional
  }
  
  return trainNumbers
}

// In-memory cache for discovery result to avoid re-running 132 requests on every prewarm/list call
// TTL 5 minutes
const discoveryCache = new Map()
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000

function getCachedDiscovery(date) {
  const entry = discoveryCache.get(date)
  if (!entry) return null
  if (Date.now() - entry.at > DISCOVERY_CACHE_TTL_MS) {
    discoveryCache.delete(date)
    return null
  }
  return entry.trains
}

function setCachedDiscovery(date, trains) {
  discoveryCache.set(date, { trains: new Set(trains), at: Date.now() })
}

/**
 * Discover train numbers from NightJet country-to-country destinations API
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {Function} onProgress - Optional progress callback
 * @returns {Promise<Set<string>>} Set of discovered train numbers
 */
export async function discoverTrainNumbersFromDestinations(date, onProgress = null) {
  const trainNumbers = new Set()
  
  // Generate country pairs
  const countryPairs = []
  for (const fromCountry of NIGHTJET_COUNTRIES) {
    for (const toCountry of NIGHTJET_COUNTRIES) {
      if (fromCountry.eva !== toCountry.eva) {
        countryPairs.push({ from: fromCountry, to: toCountry })
      }
    }
  }
  
  const batchSize = 12
  let processed = 0
  
  for (let i = 0; i < countryPairs.length; i += batchSize) {
    const batch = countryPairs.slice(i, i + batchSize)
    const promises = batch.map(async ({ from, to }) => {
      try {
        const destinationsUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from.eva}/country/${to.eva}/${date}`
        const destResponse = await fetch(destinationsUrl, {
          headers: { accept: "application/json" },
        })
        
        if (!destResponse.ok) {
          return []
        }
        
        const destinations = await destResponse.json()
        return Array.isArray(destinations) ? destinations : []
      } catch {
        return []
      }
    })
    
    const results = await Promise.all(promises)
    results.forEach(destinations => {
      destinations.forEach(dest => {
        if (dest.trainNumber) {
          trainNumbers.add(dest.trainNumber)
        }
      })
    })
    
    processed += batch.length
    
    if (onProgress) {
      onProgress({
        step: "discovering",
        progress: Math.round((processed / countryPairs.length) * 100),
        message: `Checking routes: ${processed}/${countryPairs.length} country pairs`,
        trainsFound: trainNumbers.size,
      })
    }
    
    if (i + batchSize < countryPairs.length) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  
  return trainNumbers
}

// Skip slow country-pair discovery when we already have at least this many trains (cache + Back-on-Track)
const MIN_TRAINS_TO_SKIP_DESTINATION_DISCOVERY = 10

/**
 * Comprehensive train discovery: combines all discovery methods
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {string} baseUrl - Base URL for API requests (optional, for Back-on-Track discovery)
 * @param {Function} onProgress - Optional progress callback
 * @returns {Promise<Set<string>>} Set of all discovered train numbers
 */
export async function discoverAllTrainNumbers(date, baseUrl = null, onProgress = null) {
  const trainNumbers = new Set()
  
  // Step 1: Get from cache
  const cached = getTrainNumbersFromCache(date)
  cached.forEach(t => trainNumbers.add(t))
  
  if (onProgress) {
    onProgress({
      step: "cache",
      progress: 0,
      message: `Found ${trainNumbers.size} trains in cache`,
      trainsFound: trainNumbers.size,
    })
  }
  
  // Step 2: Get from Back-on-Track (if baseUrl provided)
  if (baseUrl) {
    const backOnTrack = await getTrainNumbersFromBackOnTrack(baseUrl)
    backOnTrack.forEach(t => trainNumbers.add(t))
    
    if (onProgress) {
      onProgress({
        step: "backontrack",
        progress: 10,
        message: `Found ${trainNumbers.size} trains total (including Back-on-Track)`,
        trainsFound: trainNumbers.size,
      })
    }
  }
  
  // Step 3: Discover from NightJet destinations API (skip if we have enough trains or cached discovery)
  const cachedDiscovery = getCachedDiscovery(date)
  if (cachedDiscovery) {
    cachedDiscovery.forEach(t => trainNumbers.add(t))
    if (onProgress) {
      onProgress({
        step: "discovering",
        progress: 100,
        message: `Using cached discovery: ${trainNumbers.size} trains`,
        trainsFound: trainNumbers.size,
      })
    }
    return trainNumbers
  }
  
  if (trainNumbers.size >= MIN_TRAINS_TO_SKIP_DESTINATION_DISCOVERY) {
    if (onProgress) {
      onProgress({
        step: "discovering",
        progress: 100,
        message: `Skipping discovery (${trainNumbers.size} trains from cache/Back-on-Track)`,
        trainsFound: trainNumbers.size,
      })
    }
    return trainNumbers
  }
  
  const startProgress = baseUrl ? 10 : 0
  const progressRange = baseUrl ? 90 : 100
  
  const discovered = await discoverTrainNumbersFromDestinations(date, (progress) => {
    if (onProgress) {
      onProgress({
        ...progress,
        progress: startProgress + Math.round(progress.progress * (progressRange / 100)),
      })
    }
  })
  
  discovered.forEach(t => trainNumbers.add(t))
  setCachedDiscovery(date, trainNumbers)
  
  return trainNumbers
}
