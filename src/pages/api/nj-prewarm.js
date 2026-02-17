// pages/api/nj-prewarm.js
// Prewarm Nightjet caches without hurting performance: discover NJ trains from Back-on-Track trips,
// fetch Nightjet's per-train endpoint, normalize, and write .next/cache/nightjet/<train>-<date>.json

import fs from 'fs'
import path from 'path'
import { discoverAllTrainNumbers } from './lib/nj-discovery'

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

    // Discover all NightJet trains using shared discovery utility
    // This combines cache, Back-on-Track, and comprehensive API discovery
    const baseUrl = `${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}`
    let trains = []
    
    try {
      const trainNumbers = await discoverAllTrainNumbers(date, baseUrl, (progress) => {
        console.log(`[nj-prewarm] ${progress.message}`)
      })
      trains = Array.from(trainNumbers)
      console.log(`[nj-prewarm] Discovered ${trains.length} NightJet trains`)
    } catch (err) {
      console.error('[nj-prewarm] Discovery failed:', err)
      // Last resort fallback - use common NightJet trains
      trains = ['NJ 402', 'NJ 403', 'NJ 404', 'NJ 406', 'NJ 407', 'NJ 420', 'NJ 421', 'NJ 424', 'NJ 425', 'NJ 468', 'NJ 469', 'NJ 470', 'NJ 471', 'NJ 490', 'NJ 491']
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
