// pages/api/nj-route.js
import { createClient } from 'hafas-client'
import { profile as oebbProfile } from 'hafas-client/p/oebb'
import fs from 'fs'
import path from 'path'

const client = createClient(oebbProfile, 'train-map-nj')

// Simple 24h cache under .next/cache/nightjet
const CACHE_DIR = path.join(process.cwd(), '.next', 'cache', 'nightjet')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

function ensureCache() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
}
function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.json`)
}
function readCache(key) {
  try {
    const p = cachePath(key)
    if (!fs.existsSync(p)) return null
    const age = Date.now() - fs.statSync(p).mtime.getTime()
    if (age > CACHE_TTL_MS) return null
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    // If cache contains no stations, treat as miss to self-heal bad entries
    if (!parsed || !Array.isArray(parsed.stations) || parsed.stations.length === 0) return null
    return parsed
  } catch (_) {
    return null
  }
}
function writeCache(key, data) {
  try {
    ensureCache()
    fs.writeFileSync(cachePath(key), JSON.stringify(data, null, 2), 'utf8')
  } catch (_) {}
}

// Find a station by name/id with a few heuristics
async function resolveStationId({ stationName, stationId }) {
  if (stationId) return stationId
  if (!stationName) return null

  const candidates = await client.locations(stationName, { results: 8 })
  if (!candidates || candidates.length === 0) return null

  // Prefer a rail stop that contains Hauptbahnhof/Hbf if present, else the first stop
  const byHbf = candidates.find(
    (c) => c.type === 'stop' && /hauptbahnhof|hbf/i.test(c.name || '')
  )
  const firstStop = candidates.find((c) => c.type === 'stop')
  return (byHbf || firstStop || candidates[0]).id
}

// Scan a day in 3h chunks to find a Nightjet trip starting from the station
async function findNJDepartureTrip({ stationId, trainFilter = 'NJ 403' }) {
  const unique = new Map() // tripId -> departure
  const now = new Date()
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)

  for (let h = 0; h < 24; h += 3) {
    const when = new Date(base)
    when.setHours(h, 0, 0, 0)
    // station board: returns {departures}
    const res = await client.departures(stationId, { when, duration: 180 })
    const deps = res?.departures || res || []

    for (const d of deps) {
      const name = d?.line?.name || ''
      if (!name) continue
      const normalized = name.replace(/\s+/g, ' ').trim().toUpperCase()
      const match = trainFilter
        ? normalized.includes(trainFilter.replace(/\s+/g, ' ').toUpperCase())
        : /\bNJ\s*\d{2,5}\b/.test(normalized)
      if (match && d.tripId && !unique.has(d.tripId)) {
        unique.set(d.tripId, d)
      }
    }
  }

  // Prefer exact train number match; otherwise return any NJ found
  const exact = [...unique.values()].find((d) =>
    (d.line?.name || '').replace(/\s+/g, '').toUpperCase().includes(
      trainFilter.replace(/\s+/g, '').toUpperCase()
    )
  )
  return exact || [...unique.values()][0] || null
}

async function fetchTripWithStops(tripId, lineName) {
  // Some backends require lineName to resolve a trip; include if available
  const opt = { stopovers: true }
  if (lineName) opt.lineName = lineName
  const trip = await client.trip(tripId, opt)
  const leg = trip?.journey || trip // depending on profile, trip shape
  const stopovers = leg?.stopovers || trip?.stopovers || []
  const stations = (stopovers || [])
    .map((s) => {
      const loc = s?.stop?.location
      if (!loc) return null
      return {
        id: s.stop.id,
        name: s.stop.name,
        location: { latitude: loc.latitude, longitude: loc.longitude },
        arrival: s.arrival || null,
        departure: s.departure || null,
        platform: s.platform || null,
      }
    })
    .filter(Boolean)
  return { trip, stations }
}

export default async function handler(req, res) {
  try {
    const { stationName, stationId, train = 'NJ 403' } = req.query

    const resolvedStationId = await resolveStationId({ stationName, stationId })
    if (!resolvedStationId) {
      return res.status(400).json({ error: 'Unable to resolve station' })
    }

    // cache key by train+station so different stations don't share entries
    const trainKey = (train || '').replace(/\s+/g, '').toUpperCase()
    const cacheKey = `route-${trainKey}-${resolvedStationId}`
    const cached = readCache(cacheKey)
    if (cached) {
      res.setHeader('X-Cache', 'HIT')
      return res.status(200).json(cached)
    }

    const dep = await findNJDepartureTrip({ stationId: resolvedStationId, trainFilter: train })
    if (!dep) {
      return res.status(404).json({ error: 'No Nightjet trip found for given station/train' })
    }

    let { stations } = await fetchTripWithStops(dep.tripId, dep.line?.name)

    // Fallback: some backends may not expose stopovers via trip().
    // Try building them via journeys(origin -> direction) and matching the NJ leg.
    if (!stations || stations.length === 0) {
      try {
        const destId = dep.direction
          ? await resolveStationId({ stationName: dep.direction })
          : null
        if (destId) {
          const when = dep.when ? new Date(dep.when) : new Date()
          const journeys = await client.journeys(resolvedStationId, destId, {
            departure: when,
            results: 6,
            stopovers: true,
          })
          const list = journeys?.journeys || []
          const needle = (dep.line?.name || '').replace(/\s+/g, '').toUpperCase()
          const leg = list.flatMap(j => j.legs || []).find(l =>
            (l.line?.name || '').replace(/\s+/g, '').toUpperCase().includes(needle)
          )
          if (leg && Array.isArray(leg.stopovers)) {
            stations = leg.stopovers
              .map((s) => {
                const loc = s?.stop?.location
                if (!loc) return null
                return {
                  id: s.stop.id,
                  name: s.stop.name,
                  location: { latitude: loc.latitude, longitude: loc.longitude },
                  arrival: s.arrival || null,
                  departure: s.departure || null,
                  platform: s.platform || null,
                }
              })
              .filter(Boolean)
          }
        }
      } catch (e) {
        // ignore and return empty stations
      }
    }

    const payload = {
      trainRequested: train,
      lineName: dep.line?.name || null,
      tripId: dep.tripId,
      direction: dep.direction || null,
      origin: dep.stop?.name || null,
      departure: dep.when || null,
      stations,
      fetchedAt: new Date().toISOString(),
    }

    // only cache if we have stations
    if (Array.isArray(stations) && stations.length > 0) {
      writeCache(cacheKey, payload)
      res.setHeader('X-Cache', 'MISS')
    } else {
      res.setHeader('X-Cache', 'BYPASS')
    }
    res.setHeader('Cache-Control', 'public, max-age=3600')
    return res.status(200).json(payload)
  } catch (err) {
    console.error('[api/nj-route] error', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
