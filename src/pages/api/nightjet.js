// pages/api/nightjet.js
// Fetch Nightjet train data from official endpoint with caching

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
      pickup: !!s?.pickup,
      dropoff: !!s?.dropoff,
    }
  }).filter(Boolean)
  return {
    lineName: nj?.trainNumber,
    operator: 'Nightjet',
    date,
    stations,
    polyline: nj?.route?.polyline || null,
    fetchedAt: new Date().toISOString(),
    source: 'nightjet-com-train'
  }
}

export default async function handler(req, res) {
  try {
    const train = (req.query.train || '').toString()
    const date = (req.query.date || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()).toString()

    if (!train) return res.status(400).json({ error: 'train parameter required' })

    ensureDir()
    const p = cachePath(train, date)
    
    // Return cached if fresh
    if (isFresh(p)) {
      try {
        const cached = JSON.parse(fs.readFileSync(p, 'utf8'))
        res.setHeader('X-Cache', 'HIT')
        return res.status(200).json(cached)
      } catch {}
    }

    // Fetch from upstream (train endpoint works for both Nightjet and EuroNight)
    const url = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(train)}/${date}`
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return res.status(response.status).json({ error: `upstream ${response.status}` })
    }

    const data = await response.json()
    const payload = normalize(data, date)
    
    // Cache it
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
    
    res.setHeader('X-Cache', 'MISS')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.status(200).json(payload)
  } catch (e) {
    console.error('[api/nightjet] error', e)
    return res.status(500).json({ error: 'internal_error' })
  }
}
