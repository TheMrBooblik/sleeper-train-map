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
  
  // Step 1: Fetch all countries - using Vienna as reference station
  const countriesUrl = 'https://www.nightjet.com/nj-booking-ocp/countries/to/station/1190100'
  console.log('[nj-all-stations] Fetching countries from:', countriesUrl)
  
  const countriesResponse = await fetch(countriesUrl, {
    headers: { accept: 'application/json' }
  })
  
  if (!countriesResponse.ok) {
    throw new Error(`Failed to fetch countries: ${countriesResponse.status}`)
  }
  
  const countries = await countriesResponse.json()
  console.log('[nj-all-stations] Found countries:', countries.length)
  
  // Step 2: Fetch destinations for each country
  const allStations = new Map() // Use Map to deduplicate by EVA number
  
  for (const country of countries) {
    const countryId = country.eva || country.countryId || country.id
    if (!countryId) continue
    
    try {
      const destinationsUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${countryId}/station/1190100/${date}`
      console.log(`[nj-all-stations] Fetching stations for country ${country.name || countryId}`)
      
      const destResponse = await fetch(destinationsUrl, {
        headers: { accept: 'application/json' }
      })
      
      if (!destResponse.ok) {
        console.warn(`[nj-all-stations] Failed to fetch destinations for country ${countryId}: ${destResponse.status}`)
        continue
      }
      
      const destinations = await destResponse.json()
      
      // Extract stations from destinations
      // Each destination is a train connection with stationFrom and stationTo
      if (Array.isArray(destinations)) {
        destinations.forEach(dest => {
          // Process both stationFrom and stationTo
          const stations = [dest.stationFrom, dest.stationTo].filter(Boolean)
          
          stations.forEach(station => {
            const eva = station.eva || station.evaMeta
            
            if (eva && station.coords && station.coords.length === 2) {
              const [lat, lon] = station.coords
              if (Number.isFinite(lat) && Number.isFinite(lon)) {
                allStations.set(eva, {
                  id: eva,
                  name: station.name?.en || station.name?.int || station.name?.de || station.name,
                  location: {
                    latitude: lat,
                    longitude: lon
                  },
                  country: country.name?.int || country.name?.en || country.name?.de,
                  countryCode: country.iso
                })
              }
            }
          })
        })
      }
    } catch (err) {
      console.error(`[nj-all-stations] Error fetching country ${countryId}:`, err.message)
    }
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
