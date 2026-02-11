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
          stations = stations.slice(idx)
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
        })
      } catch {}
    }

    // Optional auto-prewarm if nothing cached yet and no station filter (best-effort)
    if (items.length === 0 && !stationName) {
      try {
        const url = `${req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'}://${req.headers.host}/api/nj-prewarm?max=30&date=${encodeURIComponent(date)}`
        await fetch(url)
        // read again
        const files2 = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(`${date}.json`))
        for (const f of files2) {
          try {
            const p = path.join(CACHE_DIR, f)
            const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
            if (!obj?.stations?.length) continue
            const coords = obj.stations
              .map((s) => [s?.location?.latitude, s?.location?.longitude])
              .filter((a) => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]))
            items.push({
              key: `${obj.lineName}-${date}`,
              lineName: obj.lineName,
              operator: obj.operator || 'Nightjet',
              date,
              stations: obj.stations,
              coords,
            })
          } catch {}
        }
      } catch {}
    }

    return res.status(200).json({ date, count: items.length, items })
  } catch (e) {
    console.error('[api/nj-list] error', e)
    return res.status(500).json({ error: 'internal_error' })
  }
}
