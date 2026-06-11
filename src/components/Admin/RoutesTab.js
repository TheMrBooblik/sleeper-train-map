import { useState, useEffect, useDeferredValue, useMemo } from 'react';
import useAdminOverrides from '../../hooks/useAdminOverrides';

// Buttons styled to match the Overrides tab so the admin reads as one surface.
const dangerBtnCls =
  'text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap';
const showBtnCls =
  'text-xs px-2 py-1 rounded border border-green-200 text-green-700 hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap';

// Build a uniform row from a viewMap route or, for a hidden route that the
// gated /api/initial-data no longer returns, from its seen.json fingerprint.
function fingerprintRow(routeKey, fp = {}) {
  return {
    route_id: routeKey,
    trip_short_name_0: (fp.trains || '').split('|')[0] || null,
    agency_id: fp.agency || null,
    origin_trip_0: fp.o || null,
    destination_trip_0: fp.d || null,
  };
}

export default function RoutesTab() {
  // Reuse the shared admin override hook for the disabled-routes list, the
  // read-only seen.json (for hidden-route labels), and the commit/mutate path.
  const { overrides, seenState, busy, error: saveError, notice, mutate } = useAdminOverrides();

  const [viewMap, setViewMap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // all | visible | hidden
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    // Routes currently on the map (already review-gated and disabled-stripped).
    fetch('/api/initial-data')
      .then((r) => r.json())
      .then((data) => setViewMap(data.viewMap || {}))
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const disabledList = useMemo(() => overrides?.['disabled-routes'] || [], [overrides]);
  const disabledSet = useMemo(() => new Set(disabledList.map(String)), [disabledList]);

  // Combine the visible routes with the hidden ones into one toggleable list.
  // Hidden rows are removed from the visible set immediately (driven by the
  // disabled-routes list, not the CDN-cached /api/initial-data response).
  const rows = useMemo(() => {
    const byId = viewMap || {};
    const visible = [];
    for (const route of Object.values(byId)) {
      const key = String(route.route_id);
      if (disabledSet.has(key)) continue;
      visible.push({ ...route, _disabled: false });
    }
    const hidden = disabledList.map((key) => {
      const live = byId[key];
      const row = live || fingerprintRow(key, seenState?.routes?.[key]?.fingerprint);
      return { ...row, _disabled: true };
    });
    return [...visible, ...hidden];
  }, [viewMap, disabledList, disabledSet, seenState]);

  const q = deferredQuery.toLowerCase().trim();
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'visible' && r._disabled) return false;
      if (filter === 'hidden' && !r._disabled) return false;
      if (!q) return true;
      const haystack = [
        r.route_id,
        r.trip_short_name_0,
        r.trip_short_name_1,
        r.origin_trip_0,
        r.destination_trip_0,
        r.origin_trip_1,
        r.destination_trip_1,
        r.via_0,
        r.via_1,
        r.agency_id,
        r.route_long_name,
      ];
      return haystack.some((f) => f && String(f).toLowerCase().includes(q));
    });
  }, [rows, filter, q]);

  const shown = filtered.slice(0, 500);
  const hiddenCount = disabledList.length;

  function toggle(route) {
    const key = String(route.route_id);
    if (route._disabled) {
      mutate(
        'disabled-routes',
        'remove',
        { routeKey: key },
        `chore(override): disabled-routes remove ${key}`,
        `disabled-routes:remove:${key}`,
      );
      return;
    }
    const label = route.trip_short_name_0 || route.trip_short_name_1 || key;
    if (window.confirm(`Hide ${label} from the map? It will be withheld on the next deploy (reversible).`)) {
      mutate(
        'disabled-routes',
        'add',
        { routeKey: key },
        `chore(override): disabled-routes add ${key}`,
        `disabled-routes:add:${key}`,
      );
    }
  }

  const chip = (value, label) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
        filter === value
          ? 'bg-gray-900 text-white border-gray-900'
          : 'border-gray-300 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <input
        type="search"
        placeholder="Search by train number, origin, destination, via, operator…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="shrink-0 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
      />

      <div className="shrink-0 flex items-center gap-2">
        {chip('all', 'All')}
        {chip('visible', 'On map')}
        {chip('hidden', `Hidden${hiddenCount ? ` (${hiddenCount})` : ''}`)}
      </div>

      {(loading || (viewMap === null && !loadError)) && (
        <div className="text-sm text-gray-400">Loading routes…</div>
      )}

      {(loadError || saveError) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {loadError ? `Failed to load: ${loadError}` : saveError}
        </div>
      )}

      {notice && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-700">
          {notice.text}
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noreferrer" className="ml-1 underline">
              view commit
            </a>
          )}
        </div>
      )}

      {!loading && !loadError && (
        <div className="text-xs text-gray-400">
          {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} routes
        </div>
      )}

      {shown.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr className="border-b border-gray-200">
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">Train</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">Operator</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">Direction 1</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">Direction 2</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">Map</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-500 whitespace-nowrap"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((route, i) => {
                  const key = String(route.route_id);
                  return (
                    <tr
                      key={key || i}
                      className={`border-b border-gray-50 last:border-b-0 hover:bg-gray-50 ${
                        route._disabled ? 'opacity-60' : ''
                      }`}
                    >
                      <td className="px-3 py-1.5 font-mono font-medium text-gray-800 whitespace-nowrap">
                        {route.trip_short_name_0 || route.trip_short_name_1 || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{route.agency_id || '—'}</td>
                      <td className="px-3 py-1.5 text-gray-700">
                        {route.origin_trip_0 && route.destination_trip_0
                          ? `${route.origin_trip_0} → ${route.destination_trip_0}`
                          : '—'}
                        {route.via_0 && <span className="text-gray-400 ml-1">via {route.via_0}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-gray-700">
                        {route.origin_trip_1 && route.destination_trip_1
                          ? `${route.origin_trip_1} → ${route.destination_trip_1}`
                          : '—'}
                        {route.via_1 && <span className="text-gray-400 ml-1">via {route.via_1}</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {route._disabled ? (
                          <span className="text-gray-400" title="Hidden from the map">○ Hidden</span>
                        ) : (
                          <span className="text-green-600" title="On the map">● On</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => toggle(route)}
                          className={route._disabled ? showBtnCls : dangerBtnCls}
                        >
                          {route._disabled ? 'Show' : 'Hide'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 500 && (
            <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-400">
              Showing first 500 of {filtered.length.toLocaleString()} results — refine your search.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
