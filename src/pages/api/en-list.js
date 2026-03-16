// pages/api/en-list.js
// Lists cached EuroNight routes for a given date and optionally filters by station name (.next/cache or /tmp on Vercel)
//
// FIX: Previously called en-prewarm via HTTP to populate cache, but on Vercel each API route
// runs in a separate serverless function with isolated /tmp. Now fetches and caches trains
// in-process using shared fetchAndCacheTrains / fetchPartnerTrainNumbers utilities.

import fs from 'fs'
import path from 'path'
import { getCacheDir, ensureDir as ensureDirHelper } from './lib/cache-dir'
import { fetchAndCacheTrains, fetchPartnerTrainNumbers } from './lib/train-fetcher'

const CACHE_DIR = getCacheDir('euronight')

function ensureDir() {
  return ensureDirHelper(fs, CACHE_DIR)
}

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
    let files = []
    try {
      files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))
    } catch {
      // Cache dir may not exist on Vercel cold start
    }

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
          operator: obj.operator || 'EuroNight',
          date,
          stations,
          coords,
          polyline: obj.polyline || null,
        })
      } catch {}
    }

    // If nothing cached yet (e.g. Vercel /tmp cold start), discover and fetch EuroNight
    // trains directly in this process. We can't HTTP-call en-prewarm because on Vercel
    // each API route is a separate serverless function with its own /tmp.
    if (items.length === 0) {
      try {
        const trainNumbers = await fetchPartnerTrainNumbers(date)
        if (trainNumbers.length > 0) {
          await fetchAndCacheTrains(CACHE_DIR, trainNumbers, date, {
            operator: 'EuroNight',
            source: 'nightjet-com-train',
            concurrency: 3,
          })
          // Re-read cache after in-process fetch
          try {
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
                  operator: obj.operator || 'EuroNight',
                  date,
                  stations,
                  coords,
                  polyline: obj.polyline || null,
                })
              } catch {}
            }
          } catch {}
        }
      } catch (err) {
        console.error('[en-list] Error fetching trains:', err)
      }
    }

    // CDN caches for 1 hour; serve stale while revalidating for up to 1 day
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
    return res.status(200).json({ date, count: items.length, items })
  } catch (e) {
    console.error('[api/en-list] error', e)
    return res.status(500).json({ error: 'internal_error' })
  }
}
