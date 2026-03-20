"use client";

import React, { useMemo, useEffect } from "react";
import { useAgencies } from "../../hooks/requests/useAgencies";
import { useRoutes } from "../../hooks/requests/useRoutes";
import { useTrips } from "../../hooks/requests/useTrips";
import { getRouteFrequencyOverride } from "../../lib/routeFrequencyOverrides";

const TrainDetailPanel = ({
  isOpen,
  onClose,
  selectedRouteIds,
}) => {
  const { agencies } = useAgencies();
  const { routes } = useRoutes();
  const { trips } = useTrips();

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
      className={`fixed top-10 right-0 h-full bg-white shadow-lg transition-transform duration-300 z-[1000] overflow-y-auto ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ width: "300px" }}
    >
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-gray-200 pl-5 py-1 flex items-center justify-between z-10">
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
            Loading train information...
          </div>
        ) : (
          relevantTrips.map((trip, index) => {
            const route = routes[trip.route_id];
            const agency = agencies[trip.agency_id];

            return (
              <div
                key={`${trip.trip_id}-${index}`}
                className="border border-gray-200 rounded-lg p-4 space-y-3"
              >
                {/* Operator Logo and Name */}
                {agency && (
                  <div className="space-y-2">
                    {agency.agency_logo_url && (
                      <img
                        src={agency.agency_logo_url}
                        alt={agency.agency_name}
                        className="h-12 object-contain"
                        onError={(e) => {
                          e.target.style.display = "none";
                        }}
                      />
                    )}
                    <div className="text-sm font-medium text-gray-900">
                      {agency.agency_name}
                    </div>
                  </div>
                )}

                {/* Route Name */}
                {trip.trip_short_name && (
                  <div className="space-y-1">
                    <div className="text-xs text-gray-500 uppercase">
                      Train Number
                    </div>
                    <div className="text-base font-semibold text-blue-600">
                      {trip.trip_short_name}
                    </div>
                  </div>
                )}

                {/* Route */}
                <div className="space-y-1">
                  <div className="text-xs text-gray-500 uppercase">Route</div>
                  <div className="text-sm">
                    <div className="font-medium">
                      {trip.trip_origin} → {trip.trip_headsign}
                    </div>
                    {trip.via && (
                      <div className="text-xs text-gray-600 mt-1">
                        via {trip.via}
                      </div>
                    )}
                  </div>
                </div>

                {/* Schedule */}
                <div className="space-y-1">
                  <div className="text-sm space-y-1">
                    <div>
                      <span className="font-medium">Departure:</span>{" "}
                      {formatTime(trip.origin_departure_time)}
                    </div>
                    <div>
                      <span className="font-medium">Arrival:</span>{" "}
                      {formatTime(trip.destination_arrival_time)}
                    </div>
                    {trip.duration && (
                      <div className="text-xs text-gray-600">
                        Duration: {formatTime(trip.duration)}
                      </div>
                    )}
                  </div>
                </div>

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
                    <div className="text-xs text-gray-500 uppercase">Notes</div>
                    <div className="text-xs text-amber-700 bg-amber-50 p-2 rounded">
                      {trip.irregularities}
                    </div>
                  </div>
                )}

                {/* Operator Website Link */}
                {agency?.agency_url && (
                  <a
                    href={agency.agency_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full text-center bg-blue-600 !text-white py-2 px-4 rounded hover:bg-blue-700 transition-colors text-sm font-medium"
                  >
                    Visit Operator Website
                  </a>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default TrainDetailPanel;
