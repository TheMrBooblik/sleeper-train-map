// lib/operator-trains-handler.mjs
// Shared handler for serving a per-source scraped trains file
// ({ uploadedAt, trains } envelope under public/data/scraped/).
//
// missing: "empty" → 200 with { uploadedAt: null, trains: {} } when absent
//          "404"   → 404 when absent or stale (legacy cd-trains behaviour)

import { getTrainsBySource, isFresh } from "./file-store.mjs";
import { journeyTimesTheEnds, nightTimesSummary } from "../../../lib/nightTimes.mjs";

/**
 * The trains file as the browser needs it: without each train's fareCalendar.
 * Six to thirteen weeks of nights a train is for the connection pages, which
 * read it off the published rows (fare_calendar_{dir}); no client reads it
 * from here, and the panel fetches this file whole — Nightjet's calendars
 * alone are ~87 KB of it. The cached blob is never mutated: the copy is
 * memoised per blob, so a warm lambda strips once.
 *
 * What the panel does need from the calendar is how the train's clock moves
 * from night to night, so a train whose calendar times its own ends gets
 * `nightTimes` in its place (src/lib/nightTimes.mjs): a few dozen bytes
 * saying NJ 403 leaves between 20:01 and 21:01.
 */
const served = new WeakMap();
export function servedTrainsData(data) {
  const trains = data?.trains;
  if (!trains || !Object.values(trains).some((t) => t?.fareCalendar || t?.timetableVariants)) {
    return data;
  }
  if (served.has(data)) return served.get(data);
  const out = {
    ...data,
    trains: Object.fromEntries(
      Object.entries(trains).map(([key, train]) => {
        if (!train?.fareCalendar && !train?.timetableVariants) return [key, train];
        // Each night's own timetable (timetableVariants) is the connection
        // page's, read at build time from the file itself.
        const { fareCalendar: calendar, timetableVariants: _variants, ...rest } = train;
        if (!calendar) return [key, rest];
        const stations = Array.isArray(train.stations) ? train.stations : [];
        const ownEnds = journeyTimesTheEnds(
          calendar.journey,
          stations[0]?.name,
          stations[stations.length - 1]?.name,
        );
        const nightTimes = ownEnds ? nightTimesSummary(calendar) : null;
        return [key, nightTimes ? { ...rest, nightTimes } : rest];
      }),
    ),
  };
  served.set(data, out);
  return out;
}

export function createTrainsFileHandler({ file, label, missing = "empty" }) {
  return async function handler(_req, res) {
    try {
      const blob = await getTrainsBySource(file);

      if (missing === "404") {
        if (!blob || !isFresh(blob.uploadedAt)) {
          return res.status(404).json({ error: `${label} data not available` });
        }
      } else if (!blob?.data?.trains) {
        res.setHeader(
          "Cache-Control",
          "public, s-maxage=300, stale-while-revalidate=3600",
        );
        return res.status(200).json({ uploadedAt: null, trains: {} });
      }

      // Cached for 1 hour when fresh; shorter when stale.
      res.setHeader(
        "Cache-Control",
        isFresh(blob.uploadedAt)
          ? "public, s-maxage=3600, stale-while-revalidate=86400"
          : "public, s-maxage=300, stale-while-revalidate=3600",
      );
      res.setHeader("Content-Type", "application/json");

      return res.status(200).json(servedTrainsData(blob.data));
    } catch (error) {
      console.error(`[${label}] Error:`, error);
      return res.status(500).json({ error: `Failed to load ${label} data` });
    }
  };
}
