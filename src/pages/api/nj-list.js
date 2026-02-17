// pages/api/nj-list.js
// Lists cached Nightjet routes for a given date and optionally returns only the segments
// starting at a provided station name. Uses the same cache files written by /api/nj-train and /api/nj-prewarm.

import fs from 'fs'
import path from 'path'

const CACHE_DIR = path.join(process.cwd(), '.next', 'cache', 'nightjet')

function ensureDir() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }) }

function simplifyName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\b(centraal|central|bahnhof|station|hbf|hb)\b/gi, '')
    .replace(/[^a-z\s-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchName(a, b) {
  const A = simplifyName(a)
  const B = simplifyName(b)
  if (!A || !B) return false
  return A === B || A.includes(B) || B.includes(A)
}

export default async function handler(req, res) {
  try {
    const date = (req.query.date || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()).toString()
    const stationName = (req.query.stationName || '').toString()

    ensureDir()
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))

    let items = []
    for (const f of files) {
      try {
        const p = path.join(CACHE_DIR, f)
        const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (!obj?.stations?.length) continue
        let stations = obj.stations
        if (stationName) {
          const idx = stations.findIndex(s => matchName(stationName, s.name))
          if (idx < 0) continue
          // Keep all stations on this route since you can travel in both directions
          // Don't slice - show the entire route
        }
        const coords = stations
          .map((s) => [s?.location?.latitude, s?.location?.longitude])
          .filter((a) => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]))
        items.push({
          key: `${obj.lineName}-${date}`,
          lineName: obj.lineName,
          operator: obj.operator || 'Nightjet',
          date,
          stations,
          coords,
          polyline: obj.polyline || null,
        })
      } catch {}
    }

    // Comprehensive discovery: if no routes found (or when explicitly requested), discover all trains
    // This ensures we get ALL possible NightJet trains, not just cached ones
    // Only do comprehensive discovery when:
    // 1. No items found AND no station filter (to populate cache)
    // 2. Explicitly requested via ?discover=true (even with station filter, to ensure all trains are cached)
    const shouldDiscover = (items.length === 0 && !stationName) || req.query.discover === 'true'
    
    if (shouldDiscover && !stationName) {
      try {
        console.log('[nj-list] Starting comprehensive train discovery...')
        
        // Step 1: Check cached train files to extract known train numbers
        const trainNumbers = new Set()
        const cachedFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`) && f.startsWith('NJ'))
        cachedFiles.forEach(file => {
          try {
            const filePath = path.join(CACHE_DIR, file)
            const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            if (cached?.lineName) {
              trainNumbers.add(cached.lineName)
            }
          } catch {}
        })
        
        // Step 2: Discover trains from Back-on-Track data
        try {
          const tripsRes = await fetch(`${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}/api/trains?type=trips`)
          if (tripsRes.ok) {
            const trips = await tripsRes.json()
            Object.values(trips || {}).forEach(t => {
              const n = (t?.trip_short_name || t?.route_short_name || '').toString()
              if (/^\s*NJ\s*\d+/.test(n)) {
                trainNumbers.add(n.replace(/\s+/g,' ').trim())
              }
            })
          }
        } catch {}
        
        // Step 3: Discover trains from NightJet country-to-country destinations API
        // This is the comprehensive discovery method used in nj-all-stations
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
        ]
        
        const countryPairs = []
        for (const fromCountry of countries) {
          for (const toCountry of countries) {
            if (fromCountry.eva !== toCountry.eva) {
              countryPairs.push({ from: fromCountry, to: toCountry })
            }
          }
        }
        
        // Fetch destinations in batches to discover train numbers
        const batchSize = 5
        for (let i = 0; i < countryPairs.length; i += batchSize) {
          const batch = countryPairs.slice(i, i + batchSize)
          const promises = batch.map(async ({ from, to }) => {
            try {
              const destinationsUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/country/${from.eva}/country/${to.eva}/${date}`
              const destResponse = await fetch(destinationsUrl, {
                headers: { accept: "application/json" },
              })
              if (!destResponse.ok) return []
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
          
          // Small delay between batches
          if (i + batchSize < countryPairs.length) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
        
        console.log(`[nj-list] Discovered ${trainNumbers.size} unique train numbers`)
        
        // Step 4: Fetch and cache routes for discovered trains (if not already cached)
        const trainArray = Array.from(trainNumbers)
        const trainBatchSize = 3
        const uncachedTrains = trainArray.filter(trainNumber => {
          const cacheKey = `${trainNumber.replace(/\s+/g, '')}-${date}.json`
          const cachePath = path.join(CACHE_DIR, cacheKey)
          return !fs.existsSync(cachePath)
        })
        
        console.log(`[nj-list] Fetching ${uncachedTrains.length} uncached trains...`)
        
        for (let i = 0; i < uncachedTrains.length; i += trainBatchSize) {
          const batch = uncachedTrains.slice(i, i + trainBatchSize)
          const promises = batch.map(async (trainNumber) => {
            try {
              const trainUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(trainNumber)}/${date}`
              const trainResponse = await fetch(trainUrl, {
                headers: { accept: "application/json" },
              })
              
              if (!trainResponse.ok) return null
              
              const trainData = await trainResponse.json()
              const stops = Array.isArray(trainData?.route?.stops) ? trainData.route.stops : []
              
              const stations = stops.map(s => {
                const station = s?.station
                if (!station) return null
                
                const eva = station.eva || station.evaMeta
                const coords = station.coords || []
                const [lat, lon] = coords
                
                if (eva && coords.length === 2 && Number.isFinite(lat) && Number.isFinite(lon)) {
                  const stationName = station.name?.en || station.name?.int || station.name?.de || station.name
                  return {
                    id: eva,
                    name: stationName,
                    location: { latitude: lat, longitude: lon },
                    country: station.country || null,
                    countryCode: station.country || null,
                    arrival: s?.arr ? new Date(s.arr).toISOString() : null,
                    departure: s?.dep ? new Date(s.dep).toISOString() : null,
                    pickup: !!s?.pickup,
                    dropoff: !!s?.dropoff,
                  }
                }
                return null
              }).filter(Boolean)
              
              if (stations.length > 0) {
                const cacheKey = `${trainNumber.replace(/\s+/g, '')}-${date}.json`
                const cachePath = path.join(CACHE_DIR, cacheKey)
                const payload = {
                  lineName: trainData?.trainNumber || trainNumber,
                  operator: trainData?.operator || 'Nightjet',
                  date,
                  stations,
                  polyline: trainData?.route?.polyline || null,
                  fetchedAt: new Date().toISOString(),
                  source: 'nightjet-com-discovery'
                }
                fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8')
                return payload
              }
              return null
            } catch (err) {
              console.error(`[nj-list] Error fetching train ${trainNumber}:`, err.message)
              return null
            }
          })
          
          await Promise.all(promises)
          
          // Small delay between batches
          if (i + trainBatchSize < uncachedTrains.length) {
            await new Promise(resolve => setTimeout(resolve, 150))
          }
        }
        
        // Step 5: Re-read all cached files and build items list
        const files2 = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))
        items = []
        for (const f of files2) {
          try {
            const p = path.join(CACHE_DIR, f)
            const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
            if (!obj?.stations?.length) continue
            let stations = obj.stations
            if (stationName) {
              const idx = stations.findIndex(s => matchName(stationName, s.name))
              if (idx < 0) continue
            }
            const coords = stations
              .map((s) => [s?.location?.latitude, s?.location?.longitude])
              .filter((a) => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]))
            items.push({
              key: `${obj.lineName}-${date}`,
              lineName: obj.lineName,
              operator: obj.operator || 'Nightjet',
              date,
              stations,
              coords,
              polyline: obj.polyline || null,
            })
          } catch {}
        }
        
        console.log(`[nj-list] Discovery complete. Found ${items.length} routes.`)
      } catch (err) {
        console.error('[nj-list] Discovery error:', err)
        // Fallback to simple prewarm if comprehensive discovery fails
        try {
          const url = `${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}/api/nj-prewarm?max=30&date=${encodeURIComponent(date)}`
          await fetch(url)
          // Re-read cache after fallback prewarm
          const files2 = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))
          for (const f of files2) {
            try {
              const p = path.join(CACHE_DIR, f)
              const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
              if (!obj?.stations?.length) continue
              let stations = obj.stations
              if (stationName) {
                const idx = stations.findIndex(s => matchName(stationName, s.name))
                if (idx < 0) continue
              }
              const coords = stations
                .map((s) => [s?.location?.latitude, s?.location?.longitude])
                .filter((a) => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]))
              items.push({
                key: `${obj.lineName}-${date}`,
                lineName: obj.lineName,
                operator: obj.operator || 'Nightjet',
                date,
                stations,
                coords,
                polyline: obj.polyline || null,
              })
            } catch {}
          }
        } catch {}
      }
    }

    return res.status(200).json({ date, count: items.length, items })
  } catch (e) {
    console.error('[api/nj-list] error', e)
    return res.status(500).json({ error: 'internal_error' })
  }
}
