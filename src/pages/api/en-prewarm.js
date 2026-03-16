// pages/api/en-prewarm.js
// Prewarm EuroNight caches: fetch all trains from partner endpoint and cache them (.next/cache or /tmp on Vercel).
// Uses shared fetchAndCacheTrains / fetchPartnerTrainNumbers (same logic as en-list in-process fetching).

import fs from 'fs'
import { getCacheDir, ensureDir as ensureDirHelper } from './lib/cache-dir'
import { fetchAndCacheTrains, fetchPartnerTrainNumbers } from './lib/train-fetcher'

const CACHE_DIR = getCacheDir('euronight')

function ensureDir() {
  return ensureDirHelper(fs, CACHE_DIR)
}

export default async function handler(req, res) {
  try {
    const max = Math.max(1, Math.min(50, parseInt(req.query.max ?? '25', 10)))
    const date = (req.query.date || (() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()).toString()

    ensureDir()

    // Discover EuroNight train numbers from NightJet partner API
    let trainNumbers
    try {
      trainNumbers = await fetchPartnerTrainNumbers(date, max)
    } catch (err) {
      return res.status(502).json({ error: `upstream: ${err.message}` })
    }

    // Use shared fetchAndCacheTrains (same logic list endpoints use)
    const results = await fetchAndCacheTrains(CACHE_DIR, trainNumbers, date, {
      operator: 'EuroNight',
      source: 'nightjet-com-train',
      concurrency: 3,
    })

    return res.status(200).json({ ok: true, date, requested: trainNumbers.length, ...results })
  } catch (e) {
    console.error('[api/en-prewarm] error', e)
    return res.status(500).json({ ok: false, error: 'internal_error' })
  }
}
