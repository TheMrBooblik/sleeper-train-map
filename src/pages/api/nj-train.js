// pages/api/nj-train.js
// Server-side proxy to Nightjet train endpoint with 24h file cache

import fs from 'fs'
import path from 'path'

const CACHE_DIR = path.join(process.cwd(), '.next', 'cache', 'nightjet')
const TTL_MS = 24 * 60 * 60 * 1000

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
}
function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.json`)
}
function readCache(key) {
  try {
    const p = cachePath(key)
    if (!fs.existsSync(p)) return null
    const age = Date.now() - fs.statSync(p).mtimeMs
    if (age > TTL_MS) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
function writeCache(key, payload) {
  try {
    ensureCacheDir()
    fs.writeFileSync(cachePath(key), JSON.stringify(payload, null, 2), 'utf8')
  } catch {}
}

export default async function handler(req, res) {
  try {
    const train = (req.query.train || 'NJ 403').toString()
    const date = (req.query.date || '').toString()
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "missing 'date' (YYYY-MM-DD)" })
    }

    const key = `${train.replace(/\s+/g, '')}-${date}`
    const cached = readCache(key)
    if (cached) {
      res.setHeader('X-Cache', 'HIT')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      return res.status(200).json(cached)
    }

    const url = `https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(train)}/${date}`
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    if (!r.ok) {
      return res.status(r.status).json({ error: 'upstream_failed', status: r.status })
    }
    const nj = await r.json()

    const stops = Array.isArray(nj?.route?.stops) ? nj.route.stops : []
    const stations = stops
      .map((s) => {
        const coords = s?.station?.coords || []
        const [lat, lon] = coords
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
      })
      .filter(Boolean)

    const payload = {
      lineName: nj?.trainNumber || train,
      operator: nj?.operator || 'Nightjet',
      date,
      stations,
      fetchedAt: new Date().toISOString(),
      source: 'nightjet-com'
    }

    if (stations.length) writeCache(key, payload)
    res.setHeader('X-Cache', 'MISS')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    return res.status(200).json(payload)
  } catch (err) {
    console.error('[api/nj-train] error', err)
    return res.status(500).json({ error: 'internal_error' })
  }
}
