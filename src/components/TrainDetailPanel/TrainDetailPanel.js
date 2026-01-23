"use client";

import React, { useMemo } from "react";
import { useAgencies } from "../../hooks/requests/useAgencies";
import { useRoutes } from "../../hooks/requests/useRoutes";
import { useTrips } from "../../hooks/requests/useTrips";

const TrainDetailPanel = ({ isOpen, onClose, selectedRouteIds }) => {
  const { agencies } = useAgencies();
  const { routes } = useRoutes();
  const { trips } = useTrips();

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
      className={`fixed top-0 right-0 h-full bg-white shadow-lg transition-transform duration-300 z-[1001] overflow-y-auto ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ width: "300px" }}
    >
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Train Details</h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded-full transition-colors"
          aria-label="Close panel"
        >
          <svg
            className="w-6 h-6 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {relevantTrips.length === 0 ? (
          <div className="text-gray-500 text-sm">Loading train information...</div>
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
                  <div className="text-xs text-gray-500 uppercase">
                    Schedule
                  </div>
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
                {trip.service_id && (
                  <div className="space-y-1">
                    <div className="text-xs text-gray-500 uppercase">
                      Frequency
                    </div>
                    <div className="text-sm">{trip.service_id}</div>
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

                {/* Operator Website Link */}
                {agency?.agency_url && (
                  <a
                    href={agency.agency_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full text-center bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 transition-colors text-sm font-medium"
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
