// pages/api/nj-prewarm.js
// Prewarm Nightjet caches without hurting performance: discover NJ trains from Back-on-Track trips,
// fetch Nightjet's per-train endpoint, normalize, and write .next/cache/nightjet/<train>-<date>.json

import fs from 'fs'
import path from 'path'

const CACHE_DIR = path.join(process.cwd(), '.next', 'cache', 'nightjet')
const TTL_MS = 24 * 60 * 60 * 1000

function ensureDir() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }) }
function cachePath(train, date) {
  const key = `${String(train).replace(/\s+/g,'').toUpperCase()}-${date}`
  return path.join(CACHE_DIR, `${key}.json`)
}
function isFresh(p) {
  try { return fs.existsSync(p) && (Date.now() - fs.statSync(p).mtimeMs) < TTL_MS } catch { return false }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`upstream ${r.status}`)
  return r.json()
}

function normalize(nj, date) {
  const stops = Array.isArray(nj?.route?.stops) ? nj.route.stops : []
  const stations = stops.map(s => {
    const [lat, lon] = s?.station?.coords || []
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    const name = s?.station?.name?.en || s?.station?.name?.int || s?.station?.name?.de
    return {
      id: s?.station?.eva || s?.station?.evaMeta || null,
      name,
      location: { latitude: lat, longitude: lon },
      arrival: s?.arr ? new Date(s.arr).toISOString() : null,
      departure: s?.dep ? new Date(s.dep).toISOString() : null,
      pickup: !!s?.pickup, dropoff: !!s?.dropoff,
    }
  }).filter(Boolean)
  return {
    lineName: nj?.trainNumber,
    operator: nj?.operator || 'Nightjet',
    date,
    stations,
    polyline: nj?.route?.polyline || null,
    fetchedAt: new Date().toISOString(),
    source: 'nightjet-com'
  }
}

export default async function handler(req, res) {
  try {
    const max = Math.max(1, Math.min(50, parseInt(req.query.max ?? '12', 10)))
    const date = (req.query.date || (() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()).toString()

    // 1) Discover NJ trains from existing Back-on-Track data via our proxy
    let trains = []
    try {
      const tripsRes = await fetch(`${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}/api/trains?type=trips`)
      if (tripsRes.ok) {
        const trips = await tripsRes.json()
        const nums = new Set()
        Object.values(trips || {}).forEach(t => {
          const n = (t?.trip_short_name || t?.route_short_name || '').toString()
          if (/^\s*NJ\s*\d+/.test(n)) nums.add(n.replace(/\s+/g,' ').trim())
        })
        trains = Array.from(nums)
      }
    } catch {}

    // 2) Comprehensive fallback: Discover all NightJet trains from country-to-country destinations API
    // This ensures we get ALL possible NightJet trains, not just a hardcoded subset
    if (trains.length === 0) {
      try {
        console.log('[nj-prewarm] Back-on-Track discovery failed, using comprehensive discovery...')
        const trainNumbers = new Set()
        
        // Check cached train files first
        if (fs.existsSync(CACHE_DIR)) {
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
        }
        
        // Discover trains from NightJet country-to-country destinations API
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
        
        trains = Array.from(trainNumbers)
        console.log(`[nj-prewarm] Comprehensive discovery found ${trains.length} NightJet trains`)
      } catch (err) {
        console.error('[nj-prewarm] Comprehensive discovery failed:', err)
        // Last resort fallback - use common NightJet trains
        trains = ['NJ 402', 'NJ 403', 'NJ 404', 'NJ 406', 'NJ 407', 'NJ 420', 'NJ 421', 'NJ 424', 'NJ 425', 'NJ 468', 'NJ 469', 'NJ 470', 'NJ 471', 'NJ 490', 'NJ 491']
      }
    }

    // 2) Limit and prewarm with low concurrency (3)
    trains = trains.slice(0, max)
    ensureDir()

    const queue = [...trains]
    const results = { date, requested: trains.length, skippedFresh: 0, fetched: 0, errors: [] }

    async function worker() {
      while (queue.length) {
        const train = queue.shift()
        const p = cachePath(train, date)
        if (isFresh(p)) { results.skippedFresh++; continue }
        try {
          const nj = await fetchJson(`https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(train)}/${date}`)
          const payload = normalize(nj, date)
          if (payload?.stations?.length) {
            fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
            results.fetched++
          }
        } catch (e) {
          results.errors.push({ train, message: e.message })
        }
      }
    }

    await Promise.all([worker(), worker(), worker()])

    return res.status(200).json({ ok: true, ...results, trains })
  } catch (e) {
    console.error('[api/nj-prewarm] error', e)
    return res.status(500).json({ ok: false, error: 'internal_error' })
  }
}
