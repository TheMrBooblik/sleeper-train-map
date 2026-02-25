// pages/api/nj-list.js
// Lists cached Nightjet routes for a given date and optionally returns only the segments
// starting at a provided station name. Uses cache from nj-train/nj-prewarm (.next/cache or /tmp on Vercel).

import fs from 'fs'
import path from 'path'
import { discoverAllTrainNumbers } from './lib/nj-discovery'
import { getCacheDir, ensureDir as ensureDirHelper } from './lib/cache-dir'

const CACHE_DIR = getCacheDir('nightjet')

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
        
        // Use shared discovery utility to find all train numbers
        const baseUrl = `${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}`
        const trainNumbers = await discoverAllTrainNumbers(date, baseUrl, (progress) => {
          console.log(`[nj-list] ${progress.message}`)
        })
        
        console.log(`[nj-list] Discovered ${trainNumbers.size} unique train numbers`)
        
        // Step 4: Fetch and cache routes for discovered trains (if not already cached)
        // Use nj-prewarm to fetch and cache trains efficiently
        const trainArray = Array.from(trainNumbers)
        const uncachedTrains = trainArray.filter(trainNumber => {
          const cacheKey = `${trainNumber.replace(/\s+/g, '')}-${date}.json`
          const cachePath = path.join(CACHE_DIR, cacheKey)
          return !fs.existsSync(cachePath)
        })
        
        if (uncachedTrains.length > 0) {
          console.log(`[nj-list] Fetching ${uncachedTrains.length} uncached trains via nj-prewarm...`)
          const baseUrl = `${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}`
          try {
            await fetch(`${baseUrl}/api/nj-prewarm?max=${uncachedTrains.length}&date=${encodeURIComponent(date)}`)
          } catch (err) {
            console.error('[nj-list] Error calling nj-prewarm:', err)
          }
        }

        // Re-read cache after prewarm
        let files2 = []
        try {
          files2 = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))
        } catch {}
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
          try {
            const url = `${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}/api/nj-prewarm?max=30&date=${encodeURIComponent(date)}`
            await fetch(url)
          } catch {}
          let files2 = []
          try {
            files2 = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))
          } catch {}
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
