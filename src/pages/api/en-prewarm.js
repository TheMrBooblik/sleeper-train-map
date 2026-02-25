// pages/api/en-prewarm.js
// Prewarm EuroNight caches: fetch all trains from partner endpoint and cache them (.next/cache or /tmp on Vercel)

import fs from 'fs'
import path from 'path'
import { getCacheDir, ensureDir as ensureDirHelper } from './lib/cache-dir'

const CACHE_DIR = getCacheDir('euronight')
const TTL_MS = 24 * 60 * 60 * 1000

function ensureDir() {
  return ensureDirHelper(fs, CACHE_DIR)
}
function cachePath(train, date) {
  const key = `${String(train).replace(/\s+/g,'').toUpperCase()}-${date}`
  return path.join(CACHE_DIR, `${key}.json`)
}
function isFresh(p) {
  try { return fs.existsSync(p) && (Date.now() - fs.statSync(p).mtimeMs) < TTL_MS } catch { return false }
}

function normalize(en, date) {
  // EuroNight uses same structure as Nightjet with route.stops
  const stops = Array.isArray(en?.route?.stops) ? en.route.stops : []
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
    lineName: en?.trainNumber,
    operator: 'EuroNight',
    date,
    stations,
    polyline: en?.route?.polyline || null,
    fetchedAt: new Date().toISOString(),
    source: 'nightjet-com-train'
  }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`upstream ${r.status}`)
  return r.json()
}

export default async function handler(req, res) {
  try {
    const date = (req.query.date || (() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()).toString()

    ensureDir()

    // Fetch all partner trains (EuroNight) to discover train numbers
    const partnerUrl = `https://www.nightjet.com/nj-booking-ocp/destinations/partner/${date}`
    const response = await fetch(partnerUrl, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return res.status(response.status).json({ error: `upstream ${response.status}` })
    }

    const data = await response.json()
    const trains = Array.isArray(data) ? data : []
    const trainNumbers = trains.map(t => t?.trainNumber).filter(Boolean)

    const results = { date, requested: trainNumbers.length, skippedFresh: 0, fetched: 0, errors: [] }

    // Process with limited concurrency - fetch full route for each train
    const queue = [...trainNumbers]
    
    async function worker() {
      while (queue.length) {
        const trainNumber = queue.shift()
        const p = cachePath(trainNumber, date)
        if (isFresh(p)) { results.skippedFresh++; continue }
        
        try {
          // Fetch full route from train endpoint
          const en = await fetchJson(`https://www.nightjet.com/nj-booking-ocp/destinations/train/${encodeURIComponent(trainNumber)}/${date}`)
          const payload = normalize(en, date)
          if (payload?.stations?.length) {
            try {
              fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
            } catch {}
            results.fetched++
          }
        } catch (e) {
          results.errors.push({ train: trainNumber, message: e.message })
        }
      }
    }

    await Promise.all([worker(), worker(), worker()])

    return res.status(200).json({ ok: true, ...results })
  } catch (e) {
    console.error('[api/en-prewarm] error', e)
    return res.status(500).json({ ok: false, error: 'internal_error' })
  }
}
