"use client";

import React, {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { normalizeStationNameForLookup } from "../../../hooks/requests/useCities";
import { normalizeStationNameForDisplay } from "../utils/stationNameUtils";

const MAX_CITIES = 6;
const MAX_STATIONS_PER_CITY = 4;

export default function StationSearchBar({ stops, isLoading, onSelect }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Pre-group ALL stops by display city name and pre-compute normalized strings.
  // Runs once when stops change — never per keystroke.
  const { searchIndex, displayToAllStops } = useMemo(() => {
    if (!stops?.length) return { searchIndex: [], displayToAllStops: new Map() };
    const index = [];
    const map = new Map();
    for (const stop of stops) {
      if (!stop.stop_lat || !stop.stop_lon) continue;
      const displayName = normalizeStationNameForDisplay(stop.stop_id || "");
      const normalizedId = normalizeStationNameForLookup(stop.stop_id || "").toLowerCase();
      const normalizedDisplay = normalizeStationNameForLookup(displayName).toLowerCase();
      index.push({ stop, displayName, normalizedId, normalizedDisplay });
      if (!map.has(displayName)) map.set(displayName, []);
      map.get(displayName).push(stop);
    }
    return { searchIndex: index, displayToAllStops: map };
  }, [stops]);

  // Build grouped results: city header items + individual station items
  const items = useMemo(() => {
    const q = debouncedQuery.trim();
    if (!q || !searchIndex.length) return [];

    const normalizedQuery = normalizeStationNameForLookup(q);
    if (!normalizedQuery) return [];

    // Group matching stops by display city name
    const cityMap = new Map(); // displayName → { stops[], score }

    const lowerQuery = normalizedQuery.toLowerCase();

    for (const { stop, displayName, normalizedId, normalizedDisplay } of searchIndex) {
      if (!normalizedId.includes(lowerQuery) && !displayName.toLowerCase().includes(lowerQuery)) continue;

      if (!cityMap.has(displayName)) {
        let score = 2;
        if (normalizedDisplay === lowerQuery) score = 0;
        else if (normalizedDisplay.startsWith(lowerQuery)) score = 1;
        cityMap.set(displayName, { stops: [], score });
      }
      cityMap.get(displayName).stops.push(stop);
    }

    // Sort cities by score then name, take top N
    const sortedCities = [...cityMap.entries()]
      .sort(
        ([nameA, a], [nameB, b]) =>
          a.score - b.score || nameA.localeCompare(nameB),
      )
      .slice(0, MAX_CITIES);

    const result = [];
    for (const [displayName, { stops: cityStops }] of sortedCities) {
      // Use ALL stops for this city (not just query-matched ones) for center + representative.
      // Fixes: "Vienna" query only finds "Vienna Biocenter" but center should be near "Wien Hbf".
      const allCityStops = displayToAllStops.get(displayName) ?? cityStops;

      // City center = median lat/lon (robust against outlier airports etc.)
      const lats = allCityStops.map((s) => s.stop_lat).sort((a, b) => a - b);
      const lons = allCityStops.map((s) => s.stop_lon).sort((a, b) => a - b);
      const mid = Math.floor(allCityStops.length / 2);
      const medianLat =
        allCityStops.length % 2 === 0
          ? (lats[mid - 1] + lats[mid]) / 2
          : lats[mid];
      const medianLon =
        allCityStops.length % 2 === 0
          ? (lons[mid - 1] + lons[mid]) / 2
          : lons[mid];

      // Representative stop = shortest stop_id in full city set (tends to be the main terminal)
      const representative = [...allCityStops].sort(
        (a, b) => (a.stop_id || "").length - (b.stop_id || "").length,
      )[0];

      result.push({
        type: "city",
        displayName,
        flyTo: { lat: medianLat, lon: medianLon },
        stop: representative,
        zoom: 8,
      });

      // Individual stations (deduplicated by stop_id, sorted by stop_id)
      // Skip the bare city-name stop (e.g. "Eindhoven") when more specific stations exist (e.g. "Eindhoven Centraal")
      const sorted = [...cityStops]
        .filter((s) => cityStops.length === 1 || s.stop_id !== displayName)
        .sort((a, b) => (a.stop_id || "").localeCompare(b.stop_id || ""))
        .slice(0, MAX_STATIONS_PER_CITY);

      for (const stop of sorted) {
        result.push({
          type: "station",
          displayName: stop.stop_id,
          flyTo: { lat: stop.stop_lat, lon: stop.stop_lon },
          stop,
          zoom: 10,
        });
      }
    }

    return result;
  }, [debouncedQuery, searchIndex, displayToAllStops]);

  const isOpen = items.length > 0;

  // Selectable items only (skip city headers for keyboard nav)
  const selectableIndices = useMemo(
    () =>
      items.reduce((acc, item, i) => {
        acc.push(i);
        return acc;
      }, []),
    [items],
  );

  const handleSelect = useCallback(
    (item) => {
      setQuery("");
      setActiveIndex(-1);
      onSelect(item);
    },
    [onSelect],
  );

  useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setQuery("");
        setActiveIndex(-1);
      }
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", handleOutsideClick);
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = activeIndex >= 0 ? activeIndex : (selectableIndices[0] ?? -1);
      if (items[idx]) handleSelect(items[idx]);
    } else if (e.key === "Escape") {
      setQuery("");
      setDebouncedQuery("");
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        {/* type="search" draws a native clear control; we already render our own × */}
        <input
          ref={inputRef}
          type="text"
          placeholder={isLoading ? "Loading…" : "Search stations…"}
          disabled={isLoading}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full rounded border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder-white/50 focus:outline-none focus:border-white/60 focus:bg-white/20 disabled:opacity-40 transition-colors"
          aria-label="Search stations"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          role="combobox"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              setDebouncedQuery("");
              setActiveIndex(-1);
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-white/50 hover:text-white text-lg leading-none cursor-pointer"
            aria-label="Clear search"
            tabIndex={-1}
          >
            ×
          </button>
        )}
      </div>

      {isOpen && (
        <ul
          className="absolute left-0 right-0 top-full mt-1 bg-white rounded-lg shadow-xl border border-gray-100 overflow-y-auto max-h-80 z-[1100]"
          role="listbox"
        >
          {items.map((item, i) =>
            item.type === "city" ? (
              <li
                key={`city-${item.displayName}`}
                role="option"
                aria-selected={i === activeIndex}
                className={`px-3 py-2 cursor-pointer flex justify-between items-center gap-2 ${
                  i === activeIndex ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleSelect(item);
                }}
              >
                <span className="font-semibold text-sm text-gray-900">
                  {item.displayName}
                </span>
                <span className="text-xs text-gray-400 shrink-0">city</span>
              </li>
            ) : (
              <li
                key={`station-${item.stop.stop_id}`}
                role="option"
                aria-selected={i === activeIndex}
                className={`pl-6 pr-3 py-1.5 cursor-pointer flex justify-between items-center gap-2 border-t border-gray-50 ${
                  i === activeIndex
                    ? "bg-blue-50 text-blue-900"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleSelect(item);
                }}
              >
                <span className="truncate text-xs">{item.stop.stop_id}</span>
                {item.stop.stop_country && (
                  <span className="text-xs text-gray-400 shrink-0">
                    {item.stop.stop_country}
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
