import { useState, useEffect } from 'react';

const OPERATORS = [
  { key: 'nightjet', label: 'NightJet / EuroNight', endpoint: '/api/nightjet-trains', stopsKey: 'stations' },
  { key: 'cd', label: 'Czech Railways (ČD)', endpoint: '/api/cd-trains', stopsKey: 'stops' },
  { key: 'chinese', label: 'Chinese Railways', endpoint: '/api/chinese-trains', stopsKey: 'stops' },
  { key: 'italian', label: 'Italian (Trenitalia)', endpoint: '/api/italian-trains', stopsKey: 'stops' },
  { key: 'caucasus', label: 'Caucasus Railways', endpoint: '/api/caucasus-trains', stopsKey: 'stops' },
];

export default function TimetablesTab() {
  const [operatorKey, setOperatorKey] = useState('nightjet');
  const [trains, setTrains] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTrain, setSelectedTrain] = useState('');
  const [cache, setCache] = useState({});

  const operator = OPERATORS.find((o) => o.key === operatorKey);

  useEffect(() => {
    if (cache[operatorKey]) {
      setTrains(cache[operatorKey]);
      setSelectedTrain('');
      return;
    }
    setLoading(true);
    setError(null);
    fetch(operator.endpoint)
      .then((r) => r.json())
      .then((data) => {
        const t = data.trains || {};
        setCache((c) => ({ ...c, [operatorKey]: t }));
        setTrains(t);
        setSelectedTrain('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [operatorKey]);

  const trainKeys = Object.keys(trains).sort();
  const selectedData = selectedTrain ? trains[selectedTrain] : null;
  const stops = selectedData ? selectedData[operator.stopsKey] ?? [] : [];

  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <div className="shrink-0 flex gap-3 flex-wrap">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Operator</label>
          <select
            value={operatorKey}
            onChange={(e) => setOperatorKey(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
          >
            {OPERATORS.map((op) => (
              <option key={op.key} value={op.key}>
                {op.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Train {loading ? '(loading…)' : `(${trainKeys.length})`}
          </label>
          <select
            value={selectedTrain}
            onChange={(e) => setSelectedTrain(e.target.value)}
            disabled={loading || trainKeys.length === 0}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 min-w-[200px]"
          >
            <option value="">— select a train —</option>
            {trainKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          Failed to load: {error}
        </div>
      )}

      {selectedData && (
        <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="shrink-0 px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">{selectedTrain}</h3>
            {selectedData.trainLabel && (
              <p className="text-xs text-gray-400 mt-0.5">{selectedData.trainLabel}</p>
            )}
            {selectedData.lineName && (
              <p className="text-xs text-gray-400 mt-0.5">{selectedData.lineName}</p>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr className="border-b border-gray-200">
                  <th className="text-left px-4 py-2 font-medium text-gray-500">#</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500">Station</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500">Arrival</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500">Departure</th>
                </tr>
              </thead>
              <tbody>
                {stops.map((stop, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50"
                  >
                    <td className="px-4 py-1.5 text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-4 py-1.5 text-gray-800">{stop.name}</td>
                    <td className="px-4 py-1.5 font-mono text-gray-600">
                      {stop.arrival || '—'}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-gray-600">
                      {stop.departure || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
