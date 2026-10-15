"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceKm, nearestStops } from "../../lib/geo";
import { normalizeStationNameForLookup } from "../../hooks/requests/useCities";
import { MOBILE_MQ } from "../../hooks/useIsMobile";

/**
 * Bottom sheet listing the nearest sleeper stations to the user.
 * Reuses the search-select shape so Layout can fly-to + select as usual.
 */
export default function NearbyStationsSheet({
  open,
  onClose,
  stops,
  cities,
  onSelect,
}) {
  const sheetRef = useRef(null);
  const dragRef = useRef({ active: false, startY: 0 });
  const [status, setStatus] = useState("idle"); // idle | locating | ready | error
  const [message, setMessage] = useState("");
  const [results, setResults] = useState([]);
  const [userPos, setUserPos] = useState(null);

  // Only rank stations actually served by a sleeper route — the same membership
  // test the map uses (a `cities` entry with route ids). This drops the ~28k
  // intermediate/GTFS stops (and any mislabeled coordinates) that would
  // otherwise dominate the list. Co-located platforms are collapsed by rounded
  // location, keeping the shortest name (usually the main terminal).
  const sleeperStops = useMemo(() => {
    if (!Array.isArray(stops) || !cities) return [];
    const byLoc = new Map();
    for (const s of stops) {
      if (
        !s?.stop_id ||
        !Number.isFinite(s.stop_lat) ||
        !Number.isFinite(s.stop_lon)
      ) {
        continue;
      }
      const n = normalizeStationNameForLookup(s.stop_id);
      const info = cities[n] || cities[s.stop_id];
      if (!info?.stop_route_ids) continue;
      const key = `${s.stop_lat.toFixed(3)},${s.stop_lon.toFixed(3)}`;
      const existing = byLoc.get(key);
      if (!existing || (s.stop_id || "").length < (existing.stop_id || "").length) {
        byLoc.set(key, s);
      }
    }
    return [...byLoc.values()];
  }, [stops, cities]);

  useEffect(() => {
    if (!open) return undefined;

    setStatus("locating");
    setMessage("Finding your location…");
    setResults([]);

    if (!navigator.geolocation) {
      setStatus("error");
      setMessage("Geolocation is not supported by your browser.");
      return undefined;
    }

    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        const { latitude, longitude } = pos.coords;
        setUserPos([latitude, longitude]);
        const ranked = nearestStops(sleeperStops, latitude, longitude, 10);
        setResults(ranked);
        setStatus("ready");
        setMessage(
          ranked.length
            ? "Sleeper stations near you"
            : "No sleeper stations found nearby.",
        );
      },
      (error) => {
        if (cancelled) return;
        let errorMessage = "Unable to retrieve your location.";
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage =
              "Location permission denied. Enable it in browser settings to see nearby stations.";
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = "Location information is unavailable.";
            break;
          case error.TIMEOUT:
            errorMessage = "Location request timed out. Try again.";
            break;
          default:
            break;
        }
        setStatus("error");
        setMessage(errorMessage);
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 60_000,
      },
    );

    return () => {
      cancelled = true;
    };
  }, [open, sleeperStops]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onSheetDragStart = (e) => {
    if (!window.matchMedia(MOBILE_MQ).matches) return;
    if ((sheetRef.current?.scrollTop ?? 0) > 0) return;
    dragRef.current = { active: true, startY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onSheetDragMove = (e) => {
    if (!dragRef.current.active || !sheetRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    if (dy <= 0 || sheetRef.current.scrollTop > 0) {
      sheetRef.current.style.transform = "";
      return;
    }
    sheetRef.current.style.transition = "none";
    sheetRef.current.style.transform = `translateY(${dy}px)`;
  };

  const onSheetDragEnd = (e) => {
    if (!dragRef.current.active || !sheetRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    dragRef.current.active = false;
    sheetRef.current.style.transition = "";
    sheetRef.current.style.transform = "";
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (dy > 72) onClose?.();
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[1100] bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={sheetRef}
        className="fixed bottom-0 left-0 right-0 z-[1101] max-h-[70dvh] overflow-y-auto overscroll-y-contain rounded-t-2xl bg-white dark:bg-zinc-900 shadow-2xl pb-[env(safe-area-inset-bottom,0px)]"
        role="dialog"
        aria-modal="true"
        aria-label="Sleeper stations near you"
      >
        <div
          className="sticky top-0 z-10 flex touch-none cursor-grab active:cursor-grabbing items-center justify-center border-b border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3"
          onPointerDown={onSheetDragStart}
          onPointerMove={onSheetDragMove}
          onPointerUp={onSheetDragEnd}
          onPointerCancel={onSheetDragEnd}
        >
          <div className="h-1 w-10 rounded-full bg-gray-300 dark:bg-zinc-600" aria-hidden />
          <button
            type="button"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800"
          >
            ✖
          </button>
        </div>

        <div className="px-4 pt-3 pb-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-zinc-100">
            {status === "error"
              ? "Location unavailable"
              : status === "locating"
                ? "Finding your location…"
                : "Sleeper stations near you"}
          </h2>
          {status === "locating" && (
            <p className="mt-3 flex items-center gap-2 text-sm text-gray-500 dark:text-zinc-400">
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 dark:border-zinc-600 border-t-blue-500"
                aria-hidden
              />
              Locating…
            </p>
          )}
          {status === "error" && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{message}</p>
          )}
          {status === "ready" && results.length === 0 && (
            <p className="mt-2 text-sm text-gray-500 dark:text-zinc-400">{message}</p>
          )}
          {status === "ready" && results.length > 0 && (
            <ul className="mt-3 divide-y divide-gray-100 dark:divide-zinc-800">
              {results.map(({ stop, distanceKm }) => {
                const label = stop.stop_id;
                return (
                  <li key={stop.stop_id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-zinc-800/60 active:bg-gray-100 dark:active:bg-zinc-800"
                      onClick={() => {
                        onSelect?.({
                          type: "station",
                          displayName: stop.stop_id,
                          flyTo: { lat: stop.stop_lat, lon: stop.stop_lon },
                          stop,
                          zoom: 10,
                          userPos,
                        });
                        onClose?.();
                      }}
                    >
                      <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-zinc-100">
                        {label}
                      </span>
                      <span className="shrink-0 text-xs text-gray-500 dark:text-zinc-400">
                        {formatDistanceKm(distanceKm)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
