"use client";

import React, { useMemo, useEffect, useState } from "react";
import { FiChevronDown, FiExternalLink } from "react-icons/fi";
import { useAgencies } from "../../hooks/requests/useAgencies";
import { useRoutes } from "../../hooks/requests/useRoutes";
import { useTrips } from "../../hooks/requests/useTrips";
import { getRouteFrequencyOverride } from "../../lib/routeFrequencyOverrides";
import {
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
} from "../Map/utils/routeStyleUtils";
import { getOperatorBaseColor, hexWithAlpha } from "../Map/utils/operatorColors";

const GTFS_ROUTE_KIND = {
  chop: "chop",
  premysl: "premysl",
};

const GTFS_TIMETABLE_FILE_BY_KIND = {
  [GTFS_ROUTE_KIND.chop]: "/data/gtfs/rjChopTimetable.json",
  [GTFS_ROUTE_KIND.premysl]: "/data/gtfs/rjPremyslTimetable.json",
};

function detectGtfsRouteKindFromRoutes(selectedRouteIds, routes) {
  if (!selectedRouteIds?.length || !routes) return null;

  for (const routeId of selectedRouteIds) {
    const route = routes[routeId];
    if (!route) continue;
    if (checkRegioJetPrahaChop(route)) return GTFS_ROUTE_KIND.chop;
    if (checkRegioJetPrahaPrzemysl(route)) return GTFS_ROUTE_KIND.premysl;
  }

  return null;
}

function isECTrip(relevantTrips) {
  return relevantTrips?.some((trip) =>
    /^\s*EC\s+\d+/i.test(trip.trip_short_name || ""),
  );
}

function detectGtfsRouteKindFromTrips(relevantTrips) {
  if (!relevantTrips?.length) return null;

  const trainNumbers = new Set(
    relevantTrips
      .map((trip) => (trip.trip_short_name || "").toString().trim())
      .filter(Boolean),
  );

  if (trainNumbers.has("RJ 1020") || trainNumbers.has("RJ 1021")) {
    return GTFS_ROUTE_KIND.chop;
  }
  if (trainNumbers.has("RJ 1022") || trainNumbers.has("RJ 1023")) {
    return GTFS_ROUTE_KIND.premysl;
  }

  return null;
}

function formatCalendarDate(value) {
  if (!value || value.length !== 8) return value || "";
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${day}.${month}.${year}`;
}

function normalizeTrainNumber(value) {
  return (value || "").toString().trim().toUpperCase();
}

function extractTrainNumberDigits(value) {
  const normalized = normalizeTrainNumber(value);
  const match = normalized.match(/\d{3,5}/);
  return match ? match[0] : "";
}

function isNightJetOrEuroNightTrainNumber(value) {
  return /^\s*(NJ|EN)\s+\d+/i.test((value || "").toString());
}

function normalizeStationToken(value) {
  return (value || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Some letters like Polish "ł" are not removed by the combining-mark regex.
    .replace(/ł/g, "l")
    .replace(/\bgl\.?\b/g, "hlavni")
    .replace(/\bhl\.\s*n\.\b/g, "hlavni")
    .replace(/\bhlavni nadrazi\b/g, "hlavni")
    .replace(/\bhl\.?\b/g, "hlavni")
    // Czech/Polish spelling variance used in Back on Track vs GTFS names.
    .replace(/\bpremysl\b/g, "przemysl")
    .replace(/\bn\.\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesEndpoint(stopName, tripEndpoint) {
  const a = normalizeStationToken(stopName);
  const b = normalizeStationToken(tripEndpoint);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

const TrainDetailPanel = ({
  isOpen,
  onClose,
  selectedRouteIds,
  tripsData,
  viewMapData,
}) => {
  const { agencies } = useAgencies();
  const { routes: fetchedRoutes, isLoading: routesLoading } = useRoutes();
  const { trips: fetchedTrips, isLoading: tripsLoading } = useTrips();
  const trips = tripsData || fetchedTrips;
  const [gtfsTimetableData, setGtfsTimetableData] = useState(null);
  const [gtfsLoadFailed, setGtfsLoadFailed] = useState(false);
  const [nightjetData, setNightjetData] = useState(null);
  const [nightjetLoadFailed, setNightjetLoadFailed] = useState(false);
  const [cdTimetableData, setCdTimetableData] = useState(null);
  const [cdLoadFailed, setCdLoadFailed] = useState(false);

  // IMPORTANT: `useRoutes()` fetches `/api/trains?type=view_ontd_map` which filters out NJ/EN.
  // For NJ/EN fallback we must use unfiltered `viewMapData` from `/api/initial-data` when provided.
  const routes = viewMapData || fetchedRoutes;

  // Handle ESC key press
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Get all trips for the selected routes
  const relevantTrips = useMemo(() => {
    if (!selectedRouteIds || !trips || !routes) return [];

    const tripsList = [];
    Object.values(trips).forEach((trip) => {
      if (selectedRouteIds.includes(trip.route_id?.toString())) {
        tripsList.push(trip);
      }
    });
    return tripsList;
  }, [selectedRouteIds, trips, routes]);

  /**
   * NightJet/EuroNight: Back-on-Track often has route rows (view_ontd_map) but no trips rows.
   * For that case, synthesize "trip-like" objects from the selected routes so the panel can
   * still render useful details (train number + endpoints) and attach the official NJ timetable.
   */
  const fallbackTrips = useMemo(() => {
    if (!selectedRouteIds?.length || !routes) return [];
    if (relevantTrips.length > 0) return [];

    const next = [];
    selectedRouteIds.forEach((routeId) => {
      const route = routes[routeId?.toString()];
      if (!route) return;

      const pushDirection = (suffix) => {
        const shortName = route[`trip_short_name_${suffix}`];
        const origin = route[`origin_trip_${suffix}`];
        const dest = route[`destination_trip_${suffix}`];
        const via = route[`via_${suffix}`];
        if (!shortName || !origin || !dest) return;

        next.push({
          // Keep the same field names as Back-on-Track trips so the existing UI can render it.
          trip_id: `synthetic-${routeId}-${suffix}-${shortName}`,
          route_id: routeId?.toString(),
          // Use ÖBB so operator color/logo work with existing agency data when present.
          agency_id: "ÖBB",
          trip_short_name: shortName,
          trip_origin: origin,
          trip_headsign: dest,
          via: via || "",
          // Times will be filled from official NJ timetable when available.
          origin_departure_time: null,
          destination_arrival_time: null,
        });
      };

      pushDirection("0");
      pushDirection("1");
    });

    // Only keep trains we can recognize as NJ/EN; otherwise fall back to empty-state.
    return next.filter((t) => isNightJetOrEuroNightTrainNumber(t.trip_short_name));
  }, [selectedRouteIds, routes, relevantTrips.length]);

  const tripsToRender = relevantTrips.length > 0 ? relevantTrips : fallbackTrips;

  const gtfsRouteKind = useMemo(() => {
    const fromRoutes = detectGtfsRouteKindFromRoutes(selectedRouteIds, routes);
    if (fromRoutes) return fromRoutes;
    return detectGtfsRouteKindFromTrips(relevantTrips);
  }, [selectedRouteIds, routes, relevantTrips]);

  const timetableByTrainNumber = useMemo(() => {
    if (!gtfsTimetableData?.trips?.length) return new Map();
    const next = new Map();
    gtfsTimetableData.trips.forEach((trip) => {
      const fullKey = normalizeTrainNumber(trip.trainNumber);
      const numericKey = extractTrainNumberDigits(trip.trainNumber);

      if (fullKey) {
        next.set(fullKey, trip);
      }
      if (numericKey) {
        next.set(numericKey, trip);
      }
    });
    return next;
  }, [gtfsTimetableData]);

  useEffect(() => {
    if (!isOpen || !gtfsRouteKind) {
      setGtfsTimetableData(null);
      setGtfsLoadFailed(false);
      return;
    }

    let active = true;
    const loadGtfsTimetable = async () => {
      try {
        setGtfsLoadFailed(false);
        const url = GTFS_TIMETABLE_FILE_BY_KIND[gtfsRouteKind];
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to load ${url}`);
        }
        const data = await response.json();
        if (active) {
          setGtfsTimetableData(data);
        }
      } catch (_error) {
        if (active) {
          // Fallback is intentional: keep showing Back-on-Track details.
          setGtfsTimetableData(null);
          setGtfsLoadFailed(true);
        }
      }
    };

    loadGtfsTimetable();
    return () => {
      active = false;
    };
  }, [isOpen, gtfsRouteKind]);

  useEffect(() => {
    if (!isOpen || !isECTrip(relevantTrips)) {
      setCdTimetableData(null);
      setCdLoadFailed(false);
      return;
    }

    let active = true;
    const loadCDTimetable = async () => {
      try {
        setCdLoadFailed(false);
        const response = await fetch("/api/cd-trains");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setCdTimetableData(data);
      } catch {
        if (active) {
          setCdTimetableData(null);
          setCdLoadFailed(true);
        }
      }
    };

    loadCDTimetable();
    return () => {
      active = false;
    };
  }, [isOpen, relevantTrips]);

  useEffect(() => {
    if (!isOpen || fallbackTrips.length === 0) {
      setNightjetData(null);
      setNightjetLoadFailed(false);
      return;
    }

    let active = true;
    const loadNightjet = async () => {
      try {
        setNightjetLoadFailed(false);
        const response = await fetch("/api/nightjet-trains");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setNightjetData(data);
      } catch (_error) {
        if (active) {
          setNightjetData(null);
          setNightjetLoadFailed(true);
        }
      }
    };

    loadNightjet();
    return () => {
      active = false;
    };
  }, [isOpen, fallbackTrips.length]);

  const nightjetTrainByNumber = useMemo(() => {
    const trains = nightjetData?.trains || {};
    const next = new Map();
    Object.entries(trains).forEach(([key, train]) => {
      next.set(normalizeTrainNumber(key), train);
    });
    return next;
  }, [nightjetData]);

  // Format time from ISO string (NightJet API uses ISO timestamps)
  function formatTime(isoString) {
    if (!isoString) return "";
    const date = new Date(isoString);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  /**
   * RegioJet-style: build trainNumber -> schedule map so the existing `schedule` accordion
   * can render NightJet / EuroNight stops without special-case UI.
   */
  const nightjetScheduleByTrainNumber = useMemo(() => {
    const next = new Map();
    nightjetTrainByNumber.forEach((train, key) => {
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length === 0) return;
      next.set(key, {
        tripId: key,
        // Keep shape compatible with GTFS timetable stops.
        // Note: schedule accordion expects arrival/departure as strings, not ISO.
        stops: stations.map((s, i) => ({
          stopId: s.id || s.name || String(i),
          sequence: i + 1,
          name: s.name || s.id || "Station",
          arrival: formatTime(s.arrival),
          departure: formatTime(s.departure),
        })),
        // NightJet data is date-based; we intentionally omit validity window.
        validFrom: null,
        validUntil: null,
        source: "nightjet",
      });
    });
    return next;
  }, [nightjetTrainByNumber]);

  const cdScheduleByTrainNumber = useMemo(() => {
    if (!cdTimetableData?.trains) return new Map();
    const next = new Map();
    Object.entries(cdTimetableData.trains).forEach(([key, train]) => {
      next.set(key, train);
      next.set(`EC ${key}`, train);
      next.set(normalizeTrainNumber(`EC ${key}`), train);
    });
    return next;
  }, [cdTimetableData]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className={`fixed top-12 right-0 h-full bg-white shadow-lg transition-transform duration-300 z-[1000] overflow-y-auto overscroll-y-none ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ width: "300px" }}
    >
      {/* Header */}
      <div className="sticky bg-white border-b border-gray-200 pl-5 py-1 flex items-center justify-between z-10">
        <h2 className="text-base font-semibold text-gray-900">Train Details</h2>
        <button
          onClick={onClose}
          className="text-xl leading-none text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded w-5 h-5 p-5 cursor-pointer flex items-center justify-center transition-colors"
          aria-label="Close panel"
          title="Close (ESC)"
        >
          ✖
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4 mb-10">
        {tripsToRender.length === 0 ? (
          <div className="text-gray-500 text-sm">
            {routesLoading || tripsLoading
              ? "Loading train information..."
              : "No Back on Track trip data for this selection."}
          </div>
        ) : (
          <>
            {gtfsLoadFailed && gtfsRouteKind && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                Detailed stop schedule is currently unavailable.
              </div>
            )}
            {nightjetLoadFailed && fallbackTrips.length > 0 && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                NightJet timetable is currently unavailable.
              </div>
            )}
            {cdLoadFailed && isECTrip(relevantTrips) && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                Czech Railways timetable is currently unavailable.
              </div>
            )}

            {tripsToRender.map((trip, index) => {
              // Trip list uses trip fields; route rows from useRoutes are only for GTFS-kind detection.
              const agency = agencies[trip.agency_id];
              // Operator brand color for accent styling
              const operatorColor = getOperatorBaseColor(trip);
              const normalizedTrainNumber = normalizeTrainNumber(
                trip.trip_short_name,
              );
              const numericTrainNumber = extractTrainNumberDigits(
                trip.trip_short_name,
              );
              const nightjetTrain =
                nightjetTrainByNumber.get(normalizedTrainNumber) || null;
              const operatorName =
                nightjetTrain?.operator ||
                agency?.agency_name ||
                "Operator";
              // Synthetic NJ/EN trips use agency_id="ÖBB" for styling, but the actual
              // operator can be different (e.g. partner EuroNight trains).
              // Avoid showing a misleading ÖBB logo when we have a better operator label.
              const shouldShowAgencyLogo =
                !!agency?.agency_logo_url &&
                (!!agency?.agency_name &&
                  (!nightjetTrain?.operator ||
                    nightjetTrain.operator === agency.agency_name));
              const nightjetStations = Array.isArray(nightjetTrain?.stations)
                ? nightjetTrain.stations
                : [];
              const nightjetOriginDeparture =
                nightjetStations?.[0]?.departure || nightjetStations?.[0]?.arrival || null;
              const nightjetDestinationArrival =
                nightjetStations?.[nightjetStations.length - 1]?.arrival ||
                nightjetStations?.[nightjetStations.length - 1]?.departure ||
                null;

              const detailedSchedule =
                timetableByTrainNumber.get(normalizedTrainNumber) ||
                timetableByTrainNumber.get(numericTrainNumber) ||
                null;
              const cdSchedule =
                cdScheduleByTrainNumber.get(numericTrainNumber) ||
                cdScheduleByTrainNumber.get(normalizedTrainNumber) ||
                null;
              const endpointMatchedSchedule =
                !detailedSchedule && gtfsTimetableData?.trips?.length
                  ? gtfsTimetableData.trips.find((candidate) => {
                      const stops = candidate?.stops || [];
                      if (stops.length < 2) return false;
                      const firstStop = stops[0]?.name;
                      const lastStop = stops[stops.length - 1]?.name;
                      return (
                        matchesEndpoint(firstStop, trip.trip_origin) &&
                        matchesEndpoint(lastStop, trip.trip_headsign)
                      );
                    }) || null
                  : null;
              const nightjetSchedule =
                nightjetScheduleByTrainNumber.get(normalizedTrainNumber) || null;
              const schedule =
                detailedSchedule || endpointMatchedSchedule || nightjetSchedule;
              const validFrom = formatCalendarDate(schedule?.validFrom);
              const validUntil = formatCalendarDate(schedule?.validUntil);

              return (
                <div
                  key={`${trip.trip_id}-${index}`}
                  className="rounded-xl space-y-2 bg-white pb-3 border-b border-gray-100 last:border-b-0"
                  style={{ borderLeft: `3px solid ${operatorColor}`, paddingLeft: "12px" }}
                >
                  {/* Header: operator + train number */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-2 min-w-0">
                      {shouldShowAgencyLogo && (
                        <img
                          src={agency.agency_logo_url}
                          alt={agency.agency_name}
                          className="h-9 object-contain"
                          onError={(e) => {
                            e.target.style.display = "none";
                          }}
                        />
                      )}
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {operatorName}
                      </div>
                    </div>
                    {trip.trip_short_name && (
                      <div
                        className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold"
                        style={{
                          backgroundColor: hexWithAlpha(operatorColor, 0.12),
                          color: operatorColor,
                        }}
                      >
                        {trip.trip_short_name}
                      </div>
                    )}
                  </div>

                  {/* Route */}
                  <div className="space-y-1">
                    <div className="text-xs text-gray-500 uppercase">Route</div>
                    <div className="text-sm font-medium text-gray-900">
                      {trip.trip_origin} {"->"} {trip.trip_headsign}
                    </div>
                    {trip.via && (
                      <div className="text-xs text-gray-600">
                        via {trip.via}
                      </div>
                    )}
                  </div>

                  {/* Main times */}
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-gray-50 p-2">
                      <div className="text-xs text-gray-500 uppercase">
                        Departure
                      </div>
                      <div className="font-semibold text-gray-900">
                        {formatTime(trip.origin_departure_time || nightjetOriginDeparture)}
                      </div>
                    </div>
                    <div className="rounded-md bg-gray-50 p-2">
                      <div className="text-xs text-gray-500 uppercase">
                        Arrival
                      </div>
                      <div className="font-semibold text-gray-900">
                        {formatTime(trip.destination_arrival_time || nightjetDestinationArrival)}
                      </div>
                    </div>
                  </div>

                  {trip.duration && (
                    <div className="text-xs text-gray-600">
                      Duration: {formatTime(trip.duration)}
                    </div>
                  )}

                  {/* Frequency */}
                  {(trip.service_id ||
                    getRouteFrequencyOverride(trip.route_id)) && (
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 uppercase">
                        Frequency
                      </div>
                      <div className="text-sm">
                        {(() => {
                          const override = getRouteFrequencyOverride(
                            trip.route_id,
                          );
                          if (override) {
                            return (
                              <>
                                {override.text}
                                {override.sourceUrl && (
                                  <>
                                    {" "}
                                    <a
                                      href={override.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:underline"
                                    >
                                      Details
                                    </a>
                                  </>
                                )}
                              </>
                            );
                          }
                          return trip.service_id;
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Classes Available */}
                  {trip.classes && (
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 uppercase">
                        Classes
                      </div>
                      <div className="text-sm capitalize">{trip.classes}</div>
                    </div>
                  )}

                  {/* Irregularities/Notes */}
                  {trip.irregularities && (
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 uppercase">
                        Notes
                      </div>
                      <div className="text-xs text-amber-700 bg-amber-50 p-2 rounded">
                        {trip.irregularities}
                      </div>
                    </div>
                  )}

                  {/* Accordion: all stations with arrival/departure times */}
                  {schedule?.stops?.length > 0 && (
                    <details className="rounded-md bg-gray-50">
                      <summary className="cursor-pointer list-none px-2 py-1.5 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-900">
                          Show all stations ({schedule.stops.length})
                        </span>
                        <span
                          className="inline-flex items-center justify-center h-5 w-5 text-gray-500 transition-transform duration-200 group-open:rotate-180"
                          aria-hidden
                        >
                          <FiChevronDown className="h-4 w-4" />
                        </span>
                      </summary>
                      <div className="px-2 pb-2 space-y-1">
                        <div className="text-xs text-gray-600">
                          Valid: {validFrom || "?"} - {validUntil || "?"}
                        </div>
                        <div className="rounded bg-white">
                          {schedule.stops.map((stop) => (
                            <div
                              key={`${schedule.tripId}-${stop.sequence}-${stop.stopId}`}
                              className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5 text-xs border-b border-gray-50 last:border-b-0"
                            >
                              <div className="text-gray-800">{stop.name}</div>
                              <div className="text-gray-600 tabular-nums whitespace-nowrap">
                                {stop.arrival || "--"} /{" "}
                                {stop.departure || "--"}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </details>
                  )}

                  {/* Accordion: Czech Railways station timetable */}
                  {cdSchedule?.stops?.length > 0 && (
                    <details className="rounded-md bg-gray-50">
                      <summary className="cursor-pointer list-none px-2 py-1.5 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-900">
                          Show all stations ({cdSchedule.stops.length})
                        </span>
                        <span
                          className="inline-flex items-center justify-center h-5 w-5 text-gray-500 transition-transform duration-200 group-open:rotate-180"
                          aria-hidden
                        >
                          <FiChevronDown className="h-4 w-4" />
                        </span>
                      </summary>
                      <div className="px-2 pb-2 space-y-1">
                        <div className="rounded bg-white">
                          {cdSchedule.stops.map((stop, i) => (
                            <div
                              key={`cd-${cdSchedule.trainNumber}-${i}`}
                              className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5 text-xs border-b border-gray-50 last:border-b-0"
                            >
                              <div className="text-gray-800">{stop.name}</div>
                              <div className="text-gray-600 tabular-nums whitespace-nowrap">
                                {stop.arrival || "--"} /{" "}
                                {stop.departure || "--"}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="text-xs text-gray-400 pt-1">
                          <a
                            href={`https://www.cd.cz/en/vlak/${numericTrainNumber}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            Source: Czech Railways (cd.cz)
                          </a>
                        </div>
                      </div>
                    </details>
                  )}

                  {/* Operator Website Link */}
                  {agency?.agency_url && (
                    <a
                      href={agency.agency_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group block w-full text-center bg-slate-100 text-slate-800 py-2.5 px-3 rounded-md border border-slate-200 hover:bg-slate-200 hover:border-slate-300 active:translate-y-px transition-all duration-150 text-sm font-semibold"
                    >
                      <span className="inline-flex items-center gap-1">
                        Book / view details&nbsp;
                        <FiExternalLink
                          className="h-4 w-4 shrink-0 text-slate-500 transition-all duration-300 ease-out group-hover:text-slate-800 translate-x-0.5 -translate-y-px group-hover:translate-x-1 group-hover:-translate-y-0.5"
                          aria-hidden
                        />
                      </span>
                    </a>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};

export default TrainDetailPanel;
