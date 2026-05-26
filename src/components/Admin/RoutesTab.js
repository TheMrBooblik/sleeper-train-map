import { useState, useEffect, useDeferredValue } from 'react';

export default function RoutesTab() {
  const [viewMap, setViewMap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    fetch('/api/initial-data')
      .then((r) => r.json())
      .then((data) => setViewMap(data.viewMap || {}))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const routes = viewMap ? Object.values(viewMap) : [];
  const q = deferredQuery.toLowerCase().trim();

  const filtered = q
    ? routes.filter((r) => {
        const haystack = [
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
      })
    : routes;

  const shown = filtered.slice(0, 500);

  return (
    <div className="space-y-4">
      <input
        type="search"
        placeholder="Search by train number, origin, destination, via, operator…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
      />

      {loading && <div className="text-sm text-gray-400">Loading routes…</div>}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          Failed to load: {error}
        </div>
      )}

      {!loading && !error && (
        <div className="text-xs text-gray-400">
          {filtered.length.toLocaleString()} of {routes.length.toLocaleString()} routes
        </div>
      )}

      {shown.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr className="border-b border-gray-200">
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">
                    Train
                  </th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">
                    Operator
                  </th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">
                    Direction 1
                  </th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">
                    Direction 2
                  </th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">
                    Active
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((route, i) => (
                  <tr
                    key={route.route_id || i}
                    className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50"
                  >
                    <td className="px-3 py-1.5 font-mono font-medium text-gray-800 whitespace-nowrap">
                      {route.trip_short_name_0 || route.trip_short_name_1 || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">
                      {route.agency_id || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700">
                      {route.origin_trip_0 && route.destination_trip_0
                        ? `${route.origin_trip_0} → ${route.destination_trip_0}`
                        : '—'}
                      {route.via_0 && (
                        <span className="text-gray-400 ml-1">via {route.via_0}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700">
                      {route.origin_trip_1 && route.destination_trip_1
                        ? `${route.origin_trip_1} → ${route.destination_trip_1}`
                        : '—'}
                      {route.via_1 && (
                        <span className="text-gray-400 ml-1">via {route.via_1}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={route.is_active ? 'text-green-600' : 'text-gray-400'}>
                        {route.is_active ? '●' : '○'}
                      </span>
                    </td>
                  </tr>
                ))}
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
