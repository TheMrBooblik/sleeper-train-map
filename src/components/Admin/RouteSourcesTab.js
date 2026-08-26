/**
 * Route sources — every route on the map, and where its data actually comes
 * from. The point of this tab is one question answered in one click: which
 * routes still depend on Back-on-Track?
 *
 * Same single fetch as the Integrations tab; filtering is local.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  ErrorBanner,
  FEED_FRESHNESS,
  PRIORITY_BANDS,
  SOURCE_STATUS,
  SourceLink,
  formatDate,
  formatUtc,
  inputCls,
  useIntegrations,
} from "./integrationsUi";

const ALL = "all";

function chipCls(active) {
  return `text-xs px-2 py-1 rounded border whitespace-nowrap ${
    active
      ? "bg-gray-900 text-white border-gray-900"
      : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
  }`;
}

export default function RouteSourcesTab() {
  const { data, loading, error } = useIntegrations();

  const [query, setQuery] = useState("");
  const [operator, setOperator] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [automation, setAutomation] = useState(ALL);
  const [freshness, setFreshness] = useState(ALL);
  const [priority, setPriority] = useState(ALL);

  // Priority is an operator-level verdict; index it so a route can inherit the
  // band of whichever of its operators is most urgent.
  const priorityByOperator = useMemo(() => {
    const map = new Map();
    for (const op of data?.operators ?? []) map.set(op.id, op.priority);
    return map;
  }, [data]);

  const officialSourceByOperator = useMemo(() => {
    const map = new Map();
    for (const op of data?.operators ?? [])
      map.set(op.id, op.officialSources?.[0] ?? null);
    return map;
  }, [data]);

  const operatorOptions = useMemo(
    () =>
      [...(data?.operators ?? [])]
        .map((o) => ({ id: o.id, name: o.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );

  const sourceOptions = useMemo(() => {
    const ids = new Set();
    for (const r of data?.routes ?? []) ids.add(r.primarySourceId);
    return [...ids].sort();
  }, [data]);

  const routeBand = (route) => {
    let best = null;
    for (const id of route.operatorIds) {
      const p = priorityByOperator.get(id);
      if (!p) continue;
      if (!best || p.score > best.score) best = p;
    }
    return best;
  };

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.routes ?? []).filter((r) => {
      if (operator !== ALL && !r.operatorIds.includes(operator)) return false;
      if (source !== ALL && r.primarySourceId !== source) return false;
      if (automation === "automated" && !r.automated) return false;
      if (automation === "manual" && r.automated) return false;
      if (
        freshness === "stale" &&
        r.feedFreshness !== "stale" &&
        r.contentFreshness !== "stale"
      )
        return false;
      if (freshness === "fresh" && r.feedFreshness !== "fresh") return false;
      if (priority !== ALL && routeBand(r)?.band !== priority) return false;
      if (!needle) return true;
      return (
        r.routeName.toLowerCase().includes(needle) ||
        r.routeKey.toLowerCase().includes(needle) ||
        (r.origin ?? "").toLowerCase().includes(needle) ||
        (r.destination ?? "").toLowerCase().includes(needle) ||
        r.trainNumbers.some((n) => n.toLowerCase().includes(needle)) ||
        r.operatorIds.some((id) => id.toLowerCase().includes(needle))
      );
    });
    // routeBand reads state captured above; recompute whenever any of it moves.
  }, [
    data,
    query,
    operator,
    source,
    automation,
    freshness,
    priority,
    priorityByOperator,
  ]);

  const botCount = (data?.routes ?? []).filter((r) => !r.automated).length;

  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <div className="shrink-0 space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-medium text-gray-600">
            Route sources — {rows.length} of {data?.routes?.length ?? 0} routes
          </h2>
          <button
            type="button"
            className={chipCls(automation === "manual")}
            onClick={() =>
              setAutomation(automation === "manual" ? ALL : "manual")
            }
          >
            {SOURCE_STATUS.backontrack.icon} Back-on-Track only ({botCount})
          </button>
        </div>

        {loading && <p className="text-sm text-gray-400">Loading routes…</p>}
        {error && <ErrorBanner>{error}</ErrorBanner>}

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search train number, station, route key…"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
        />

        <div className="flex flex-wrap gap-1.5 items-center">
          <select
            className={inputCls}
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          >
            <option value={ALL}>All operators</option>
            {operatorOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value={ALL}>All current sources</option>
            {sourceOptions.map((id) => (
              <option key={id} value={id}>
                {data?.sources?.[id]?.label ?? id}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={automation}
            onChange={(e) => setAutomation(e.target.value)}
          >
            <option value={ALL}>Automated + manual</option>
            <option value="automated">Automated (first-party)</option>
            <option value="manual">Manual / Back-on-Track</option>
          </select>
          <select
            className={inputCls}
            value={freshness}
            onChange={(e) => setFreshness(e.target.value)}
          >
            <option value={ALL}>Any freshness</option>
            <option value="fresh">Fresh feed</option>
            <option value="stale">Stale (feed or content)</option>
          </select>
          <select
            className={inputCls}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value={ALL}>Any priority</option>
            <option value="high">High priority</option>
            <option value="medium">Medium priority</option>
            <option value="low">Low priority</option>
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-white rounded-xl border border-gray-200 shadow-sm">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
            <tr className="text-left text-gray-500">
              <th className="px-2 py-1.5 font-medium">Route</th>
              <th className="px-2 py-1.5 font-medium">Operator</th>
              <th className="px-2 py-1.5 font-medium">Current source</th>
              <th className="px-2 py-1.5 font-medium">Official source</th>
              <th className="px-2 py-1.5 font-medium">Automated</th>
              <th className="px-2 py-1.5 font-medium">Last update</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const band = routeBand(r);
              const official = r.operatorIds
                .map((id) => officialSourceByOperator.get(id))
                .find(Boolean);
              const feed =
                FEED_FRESHNESS[r.feedFreshness] ?? FEED_FRESHNESS.never;
              return (
                <tr
                  key={r.routeKey}
                  className={`border-b border-gray-100 align-top ${r.automated ? "" : "bg-orange-50/40"}`}
                >
                  <td className="px-2 py-1.5 min-w-[14rem]">
                    <div className="text-gray-900">{r.routeName}</div>
                    <div className="text-[11px] text-gray-400 font-mono">
                      {r.trainNumbers.join(" / ") || r.routeKey}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className="text-gray-700">
                      {r.operatorIds.join(" / ")}
                    </span>
                    {band && (
                      <div>
                        <Badge className={PRIORITY_BANDS[band.band].cls}>
                          {PRIORITY_BANDS[band.band].dot}{" "}
                          {PRIORITY_BANDS[band.band].label}
                        </Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 max-w-[18rem]">
                    <div className="text-gray-800">{r.sourceLabel}</div>
                    <SourceLink url={r.sourceEndpoint} />
                  </td>
                  <td className="px-2 py-1.5 max-w-[18rem]">
                    {official ? (
                      <>
                        <div className="text-gray-600">
                          {official.format ?? "source"}
                        </div>
                        <SourceLink url={official.url} />
                      </>
                    ) : (
                      <span className="text-gray-400">None found</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {r.automated ? "✅ auto" : "⚠️ manual"}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">
                    <div>{formatUtc(r.lastSuccessAt)}</div>
                    <div className="text-[11px]">
                      {r.lastChanged
                        ? `content changed ${formatDate(r.lastChanged)}`
                        : "no history yet"}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className={feed.cls}>
                      {feed.dot} {feed.label}
                    </div>
                    {Number.isFinite(r.daysSinceChange) && (
                      <div className="text-[11px] text-gray-400">
                        unchanged {r.daysSinceChange}d
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <p className="text-sm text-gray-400 px-3 py-4">
            No routes match these filters.
          </p>
        )}
      </div>
    </div>
  );
}
