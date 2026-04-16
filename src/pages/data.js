import Head from "next/head";
import Link from "next/link";
import { useEffect, useState } from "react";
import { HEADER_HEIGHT } from "../constants/header";

// ─── Simple header (black, logo links to map, no map controls) ────────────────

function SimpleHeader() {
  return (
    <header
      className={`h-[${HEADER_HEIGHT}px] bg-black px-2 py-2 min-[640px]:px-4 text-white flex items-center justify-between`}
      style={{ position: "sticky", top: 0, zIndex: 100 }}
    >
      <p className="text-sm leading-none whitespace-nowrap min-[640px]:text-base">
        <Link href="/">
          Pingwi <i>night trains</i> map
        </Link>
      </p>
      <Link
        href="/"
        className="text-xs text-white/60 hover:text-white transition-colors whitespace-nowrap"
      >
        ← Map
      </Link>
    </header>
  );
}

// ─── Freshness indicator ───────────────────────────────────────────────────────

function FreshnessDot({ status }) {
  const colors = {
    fresh: "bg-green-500",
    stale: "bg-amber-400",
    old: "bg-red-500",
    missing: "bg-gray-300",
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${colors[status] ?? colors.missing}`}
      title={status}
    />
  );
}

function FreshnessLabel({ status, hoursAgo }) {
  if (status === "missing" || hoursAgo === null) {
    return <span className="text-gray-400 text-xs">No data</span>;
  }
  const label =
    hoursAgo < 1
      ? "Updated just now"
      : hoursAgo === 1
      ? "Updated 1 hour ago"
      : `Updated ${hoursAgo}h ago`;
  const color =
    status === "fresh"
      ? "text-green-600"
      : status === "stale"
      ? "text-amber-600"
      : "text-red-600";
  return <span className={`text-xs ${color}`}>{label}</span>;
}

// ─── Collapsible list of trains/routes ────────────────────────────────────────

function TrainList({ items, label }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;

  return (
    <div className="mt-2 border-t border-gray-100 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors w-full text-left"
      >
        <span
          className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        {open ? "Hide" : `Show ${items.length} ${label}`}
      </button>
      {open && (
        <ul className="mt-2 space-y-0.5 max-h-64 overflow-y-auto">
          {items.map((item, i) => (
            <li
              key={item.trainNumber || item.id || item.name || i}
              className="flex items-baseline gap-2 text-xs py-0.5"
            >
              {(item.trainNumber || item.name) && (
                <span className="font-mono font-medium text-gray-800 shrink-0 min-w-[60px]">
                  {item.trainNumber || item.name}
                </span>
              )}
              {(item.origin || item.destination) && (
                <span className="text-gray-500 truncate">
                  {item.origin}
                  {item.origin && item.destination ? " → " : ""}
                  {item.destination}
                  {item.stationCount > 0 && (
                    <span className="text-gray-400 ml-1">({item.stationCount} stops)</span>
                  )}
                </span>
              )}
              {item.coordinateCount != null && (
                <span className="text-gray-400">{item.coordinateCount.toLocaleString()} pts</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Single dataset row (count + freshness) ───────────────────────────────────

function DataRow({ label, count, status, hoursAgo, items, itemLabel }) {
  return (
    <div className="py-2 border-b border-gray-100 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FreshnessDot status={status} />
          <span className="text-sm font-medium text-gray-700 truncate">{label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-mono text-gray-600">
            {count != null ? count.toLocaleString() : "—"}
          </span>
          <FreshnessLabel status={status} hoursAgo={hoursAgo} />
        </div>
      </div>
      {items && items.length > 0 && (
        <TrainList items={items} label={itemLabel || "items"} />
      )}
    </div>
  );
}

// ─── Source card ──────────────────────────────────────────────────────────────

function SourceCard({ title, description, priority, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            {priority && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                ★ Official operator
              </span>
            )}
          </div>
          {description && (
            <p className="text-xs text-gray-400 mt-0.5">{description}</p>
          )}
        </div>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
          <div className="h-3 bg-gray-100 rounded w-2/3 mb-2" />
          <div className="h-3 bg-gray-100 rounded w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DataPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/data-status")
      .then((r) => r.json())
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const s = data?.sources;

  return (
    <div className="min-h-screen bg-gray-50" style={{ overflowY: "auto", height: "100vh" }}>
      <Head>
        <title>Data status – Pingwi</title>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚂</text></svg>"
        />
      </Head>
      <SimpleHeader />
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Data status</h1>
          {data?.generatedAt && (
            <span className="text-xs text-gray-400">
              {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>

        {loading && <Skeleton />}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
            Failed to load data status: {error}
          </div>
        )}

        {data?.error && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
            {data.error}
          </div>
        )}

        {s && (
          <>
            {/* NightJet — official operator, highest priority */}
            {s.nightjet && (
              <SourceCard
                title="NightJet / EuroNight"
                description="Official ÖBB NightJet API — accurate polylines and timetables"
                priority
              >
                <DataRow
                  label="Trains"
                  count={s.nightjet.count}
                  status={s.nightjet.status}
                  hoursAgo={s.nightjet.hoursAgo}
                  items={s.nightjet.items}
                  itemLabel="trains"
                />
              </SourceCard>
            )}

            {/* Czech Railways — official operator */}
            {s.cdRailways && (
              <SourceCard
                title="Czech Railways (ČD)"
                description="Official cd.cz EC train timetables"
                priority
              >
                <DataRow
                  label="EC trains"
                  count={s.cdRailways.count}
                  status={s.cdRailways.status}
                  hoursAgo={s.cdRailways.hoursAgo}
                  items={s.cdRailways.items}
                  itemLabel="trains"
                />
              </SourceCard>
            )}

            {/* Back-on-Track — community GTFS dataset */}
            {s.backontrack && (
              <SourceCard
                title="Back-on-Track"
                description="Community night train dataset scraped from GitHub (back-on-track.eu)"
              >
                <DataRow
                  label="Stops"
                  count={s.backontrack.stops.count}
                  status={s.backontrack.stops.status}
                  hoursAgo={s.backontrack.stops.hoursAgo}
                />
                <DataRow
                  label="Routes"
                  count={s.backontrack.routes.count}
                  status={s.backontrack.routes.status}
                  hoursAgo={s.backontrack.routes.hoursAgo}
                  items={s.backontrack.routes.items}
                  itemLabel="routes"
                />
                <DataRow
                  label="Trips"
                  count={s.backontrack.trips.count}
                  status={s.backontrack.trips.status}
                  hoursAgo={s.backontrack.trips.hoursAgo}
                />
              </SourceCard>
            )}

            {/* PKP — checked-in GTFS shapes (same model as RegioJet files under /data/gtfs) */}
            {s.pkpGtfs && (
              <SourceCard
                title="PKP Intercity (Polish GTFS shapes)"
                description={
                  s.pkpGtfs.sourceUrl
                    ? `Committed as public/data/gtfs/pkpTrainShapes.json. Regenerate: npm run parse-pkp-gtfs. Feed: ${s.pkpGtfs.sourceUrl}`
                    : "Committed as public/data/gtfs/pkpTrainShapes.json. Regenerate: npm run parse-pkp-gtfs (polish_trains.zip, scoped by BoT PKP trips)."
                }
              >
                <DataRow
                  label="Train keys (map polylines)"
                  count={s.pkpGtfs.count}
                  status={s.pkpGtfs.status}
                  hoursAgo={s.pkpGtfs.hoursAgo}
                  items={s.pkpGtfs.items}
                  itemLabel="trains"
                />
              </SourceCard>
            )}

            {/* OSM Relations — route geometries */}
            {s.osmRelations?.length > 0 && (
              <SourceCard
                title="OpenStreetMap Relations"
                description="Route geometries (polylines) cached from Overpass API"
              >
                {s.osmRelations.map((rel) => (
                  <DataRow
                    key={rel.id}
                    label={rel.name || `Relation ${rel.id}`}
                    count={rel.coordinateCount}
                    status={rel.status}
                    hoursAgo={rel.hoursAgo}
                  />
                ))}
              </SourceCard>
            )}

            {/* Legend */}
            <div className="grid grid-cols-2 min-[480px]:flex min-[480px]:flex-row gap-x-4 gap-y-1.5 min-[480px]:gap-4 pt-1 pb-4 text-xs text-gray-400">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500 inline-block shrink-0" /> Fresh (&lt;25h)</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block shrink-0" /> Stale (25–50h)</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500 inline-block shrink-0" /> Old (&gt;50h)</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-300 inline-block shrink-0" /> Missing</span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
