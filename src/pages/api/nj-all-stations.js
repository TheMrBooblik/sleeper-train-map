// pages/api/nj-all-stations.js
// Fetch all Nightjet stations by iterating through countries and destinations

import fs from 'fs'
import path from 'path'

const CACHE_DIR = path.join(process.cwd(), '.next', 'cache', 'nightjet')
const CACHE_FILE = path.join(CACHE_DIR, 'all-stations.json')
const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days cache

function ensureDir() { 
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }) 
}

function isFresh(p) {
  try { 
    return fs.existsSync(p) && (Date.now() - fs.statSync(p).mtimeMs) < TTL_MS 
  } catch { 
    return false 
  }
}

async function fetchAllStations(date) {
  console.log('[nj-all-stations] Starting to fetch all stations for date:', date)
  
  // All known Nightjet country IDs
  const countries = [
    { eva: '88', name: 'Belgium' },
    { eva: '55', name: 'Hungary' },
    { eva: '78', name: 'Croatia' },
    { eva: '79', name: 'Slovenia' },
    { eva: '80', name: 'Germany' },
    { eva: '81', name: 'Austria' },
    { eva: '83', name: 'Italy' },
    { eva: '84', name: 'Netherlands' },
    { eva: '51', name: 'Poland' },
    { eva: '85', name: 'Switzerland' },
    { eva: '87', name: 'France' },
    { eva: '54', name: 'Czech Republic' },
  ]
  
  const allStations = new Map() // Use Map to deduplicate by EVA number
  const trainNumbers = new Set() // Track unique train numbers to fetch full routes
  
  // Step 1: Discover all train numbers from destinations endpoint
  console.log('[nj-all-stations] Step 1: Discovering train numbers from destinations...')
  for (const fromCountry of countries) {
    console.log(`[nj-all-stations] Processing from country: ${fromCountry.name} (${fromCountry.eva})`)
    
    for (const toCountry of countries) {
      try {
        // Use the destinations endpoint pattern: /destinations/country/{from}/country/{to}/{date}
        const destinationsUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${fromCountry.eva}/country/${toCountry.eva}/${date}`
        
        const destResponse = await fetch(destinationsUrl, {
          headers: { accept: 'application/json' }
        })
        
        if (!destResponse.ok) {
          if (destResponse.status === 404) {
            // No routes between these countries, skip silently
            continue
          }
          console.warn(`[nj-all-stations] Failed to fetch destinations from ${fromCountry.name} to ${toCountry.name}: ${destResponse.status}`)
          continue
        }
        
        const destinations = await destResponse.json()
        
        // Extract train numbers from destinations
        if (Array.isArray(destinations) && destinations.length > 0) {
          destinations.forEach(dest => {
            if (dest.trainNumber) {
              trainNumbers.add(dest.trainNumber)
            }
          })
        }
      } catch (err) {
        console.error(`[nj-all-stations] Error fetching destinations from ${fromCountry.name} to ${toCountry.name}:`, err.message)
        // Continue with next country pair
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  
  console.log(`[nj-all-stations] Found ${trainNumbers.size} unique train numbers:`, Array.from(trainNumbers).slice(0, 10))
  
  // Step 2: Fetch full route data for each train (includes all intermediate stops)
  console.log('[nj-all-stations] Step 2: Fetching full routes for each train...')
  const trainArray = Array.from(trainNumbers)
  for (let i = 0; i < trainArray.length; i++) {
    const trainNumber = trainArray[i]
    try {
      const trainUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(trainNumber)}/${date}`
      console.log(`[nj-all-stations] Fetching route for ${trainNumber} (${i + 1}/${trainArray.length})`)
      
      const trainResponse = await fetch(trainUrl, {
        headers: { accept: 'application/json' }
      })
      
      if (!trainResponse.ok) {
        if (trainResponse.status === 404) {
          console.warn(`[nj-all-stations] Train ${trainNumber} not found for date ${date}`)
          continue
        }
        console.warn(`[nj-all-stations] Failed to fetch train ${trainNumber}: ${trainResponse.status}`)
        continue
      }
      
      const trainData = await trainResponse.json()
      
      // Extract all stops from the route (includes intermediate stops)
      const stops = Array.isArray(trainData?.route?.stops) ? trainData.route.stops : []
      
      stops.forEach(stop => {
        const station = stop?.station
        if (!station) return
        
        const eva = station.eva || station.evaMeta
        const coords = station.coords || []
        
        if (eva && coords.length === 2) {
          const [lat, lon] = coords
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const stationName = station.name?.en || station.name?.int || station.name?.de || station.name
            
            // Use existing station if found, or create new one
            if (!allStations.has(eva)) {
              allStations.set(eva, {
                id: eva,
                name: stationName,
                location: {
                  latitude: lat,
                  longitude: lon
                },
                country: station.country || null,
                countryCode: station.country || null
              })
            }
          }
        }
      })
      
      console.log(`[nj-all-stations] Train ${trainNumber}: ${stops.length} stops, ${allStations.size} unique stations so far`)
    } catch (err) {
      console.error(`[nj-all-stations] Error fetching train ${trainNumber}:`, err.message)
      // Continue with next train
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  
  const stationsArray = Array.from(allStations.values())
  console.log('[nj-all-stations] Total unique stations found:', stationsArray.length)
  
  return {
    stations: stationsArray,
    count: stationsArray.length,
    fetchedAt: new Date().toISOString(),
    date
  }
}

export default async function handler(req, res) {
  try {
    const date = (req.query.date || (() => { 
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` 
    })()).toString()
    
    const forceRefresh = req.query.refresh === 'true'
    
    ensureDir()
    
    // Return cached if fresh and not forcing refresh
    if (!forceRefresh && isFresh(CACHE_FILE)) {
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
        res.setHeader('X-Cache', 'HIT')
        return res.status(200).json(cached)
      } catch {}
    }
    
    // Fetch fresh data
    const data = await fetchAllStations(date)
    
    // Cache it
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8')
    
    res.setHeader('X-Cache', 'MISS')
    res.setHeader('Cache-Control', 'public, max-age=604800') // 7 days
    return res.status(200).json(data)
  } catch (e) {
    console.error('[api/nj-all-stations] error:', e)
    return res.status(500).json({ error: 'internal_error', message: e.message })
  }
}
