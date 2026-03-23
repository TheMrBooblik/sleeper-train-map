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
  isOBBRoute,
} from "../Map/utils/routeStyleUtils";

const GTFS_ROUTE_KIND = {
  chop: "chop",
  premysl: "premysl",
  obb: "obb",
};

const GTFS_TIMETABLE_FILE_BY_KIND = {
  [GTFS_ROUTE_KIND.chop]: "/data/gtfs/rjChopTimetable.json",
  [GTFS_ROUTE_KIND.premysl]: "/data/gtfs/rjPremyslTimetable.json",
  [GTFS_ROUTE_KIND.obb]: "/data/gtfs/obbTimetable.json",
};

function detectGtfsRouteKindFromRoutes(selectedRouteIds, routes) {
  if (!selectedRouteIds?.length || !routes) return null;

  for (const routeId of selectedRouteIds) {
    const route = routes[routeId];
    if (!route) continue;
    if (checkRegioJetPrahaChop(route)) return GTFS_ROUTE_KIND.chop;
    if (checkRegioJetPrahaPrzemysl(route)) return GTFS_ROUTE_KIND.premysl;
    if (isOBBRoute(route)) return GTFS_ROUTE_KIND.obb;
  }

  return null;
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

  // OBB detection by train number prefix (RJ, RJX, D, EC, IC, NJ, EN)
  const obbPrefixes = ["RJ ", "RJX ", "D ", "EC ", "IC ", "ICE ", "NJ ", "EN "];
  for (const number of trainNumbers) {
    const upper = number.toUpperCase();
    if (obbPrefixes.some((p) => upper.startsWith(p))) {
      return GTFS_ROUTE_KIND.obb;
    }
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
}) => {
  const { agencies } = useAgencies();
  const { routes, isLoading: routesLoading } = useRoutes();
  const { trips: fetchedTrips, isLoading: tripsLoading } = useTrips();
  const trips = tripsData || fetchedTrips;
  const [gtfsTimetableData, setGtfsTimetableData] = useState(null);
  const [gtfsLoadFailed, setGtfsLoadFailed] = useState(false);

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

  const gtfsRouteKind = useMemo(() => {
    const fromRoutes = detectGtfsRouteKindFromRoutes(selectedRouteIds, routes);
    if (fromRoutes) return fromRoutes;
    return detectGtfsRouteKindFromTrips(relevantTrips);
  }, [selectedRouteIds, routes, relevantTrips]);

  // Flatten trips from both single-route (RegioJet) and multi-route (OBB) formats
  const allGtfsTrips = useMemo(() => {
    if (!gtfsTimetableData) return [];
    // OBB format: { operator, routes: [{ trips }] }
    if (gtfsTimetableData.routes?.length) {
      return gtfsTimetableData.routes.flatMap((r) => r.trips || []);
    }
    // RegioJet format: { routeId, trips }
    return gtfsTimetableData.trips || [];
  }, [gtfsTimetableData]);

  const timetableByTrainNumber = useMemo(() => {
    if (!allGtfsTrips.length) return new Map();
    const next = new Map();
    allGtfsTrips.forEach((trip) => {
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
  }, [allGtfsTrips]);

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

  // Format time from ISO string
  const formatTime = (isoString) => {
    if (!isoString) return "";
    const date = new Date(isoString);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

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
        {relevantTrips.length === 0 ? (
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

            {relevantTrips.map((trip, index) => {
              const route = routes[trip.route_id];
              const agency = agencies[trip.agency_id];
              const normalizedTrainNumber = normalizeTrainNumber(
                trip.trip_short_name,
              );
              const numericTrainNumber = extractTrainNumberDigits(
                trip.trip_short_name,
              );
              const detailedSchedule =
                timetableByTrainNumber.get(normalizedTrainNumber) ||
                timetableByTrainNumber.get(numericTrainNumber) ||
                null;
              const endpointMatchedSchedule =
                !detailedSchedule && allGtfsTrips.length
                  ? allGtfsTrips.find((candidate) => {
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
              const schedule = detailedSchedule || endpointMatchedSchedule;
              const validFrom = formatCalendarDate(schedule?.validFrom);
              const validUntil = formatCalendarDate(schedule?.validUntil);

              return (
                <div
                  key={`${trip.trip_id}-${index}`}
                  className="rounded-xl space-y-2 bg-white pb-3 border-b border-gray-100 last:border-b-0"
                >
                  {/* Header: operator + train number */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-2 min-w-0">
                      {agency?.agency_logo_url && (
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
                        {agency?.agency_name || "Operator"}
                      </div>
                    </div>
                    {trip.trip_short_name && (
                      <div className="shrink-0 bg-blue-50 text-blue-700 rounded-md px-2 py-1 text-sm font-semibold">
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
                        {formatTime(trip.origin_departure_time)}
                      </div>
                    </div>
                    <div className="rounded-md bg-gray-50 p-2">
                      <div className="text-xs text-gray-500 uppercase">
                        Arrival
                      </div>
                      <div className="font-semibold text-gray-900">
                        {formatTime(trip.destination_arrival_time)}
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
