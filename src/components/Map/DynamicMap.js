"use client";

import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
} from "react";
import Leaflet from "leaflet";
import * as ReactLeaflet from "react-leaflet";
import polyline from "@mapbox/polyline";

const { MapContainer, Marker, TileLayer, Tooltip, Polyline, useMapEvents } =
  ReactLeaflet;
import "leaflet/dist/leaflet.css";

import Filter from "src/components/Filter";
import { useStops } from "../../hooks/requests/useStops";
import { useCities } from "../../hooks/requests/useCities";
import { normalizeStationNameForLookup } from "../../hooks/requests/useCities";
import { useViewMap } from "../../hooks/requests/useViewMap";
import { useTrips } from "../../hooks/requests/useTrips";
import TrainSidebar from "@components/TrainSidebar";
import TrainDetailPanel from "@components/TrainDetailPanel";
import ZoomControl from "@components/ZoomControl";
import LocationControl from "@components/LocationControl";
import { stationsToSkip } from "../../data/stationsToSkip";

const TrainMap = ({
  children,
  className,
  isGrouped,
  setIsGrouped,
  showRoutes = true,
  hideIntermediateStations = false,
  ...rest
}) => {
  const [sidebarDisabled, setSidebarDisabled] = useState(false);
  const {
    stops,
    filteredStops,
    setFilteredStops,
    isLoading: stopsLoading,
  } = useStops();
  const { cities, isLoading: citiesLoading, refreshCities } = useCities();
  const { viewMapData } = useViewMap(); // Add viewMapData to check station types
  const { trips } = useTrips(); // Access trips to check for "From <Date>" notes
  // Note: useAllStations disabled for now due to CORS/API issues
  // const { allStations, isLoading: allStationsLoading } = useAllStations(!hideIntermediateStations);

  // State declarations - must be before hooks that use them
  const [selected, setSelected] = useState(false);
  const [stopId, setStopId] = useState();
  const [isMapInitialized, setIsMapInitialized] = useState(false);
  const [showTooltips, setShowTooltips] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("Starting...");
  const [stopRouteIds, setStopRouteIds] = useState();
  const [currentZoom, setCurrentZoom] = useState(5);
  const [selectedStationName, setSelectedStationName] = useState("");
  const [selectedNormalizedName, setSelectedNormalizedName] = useState(""); // For filtering via stations
  const [selectedStationLat, setSelectedStationLat] = useState(null);
  const [selectedStationLon, setSelectedStationLon] = useState(null);
  const [selectedTrainRouteIds, setSelectedTrainRouteIds] = useState([]);
  const [isTrainDetailPanelOpen, setIsTrainDetailPanelOpen] = useState(false);
  // Nightjet prototype overlay: one route only (e.g., NJ 403)
  // Nightjet overlays
  // Each overlay: { key, lineName, coords, stations, color }
  const [njOverlays, setNjOverlays] = useState([]);
  // All Nightjet stations for display on map (not filtered by clicked station)
  const [allNjStations, setAllNjStations] = useState([]);
  // Filtered NJ stations (shown when a station is selected)
  const [filteredNjStations, setFilteredNjStations] = useState([]);
  // EuroNight overlays and stations
  const [enOverlays, setEnOverlays] = useState([]);
  const [allEnStations, setAllEnStations] = useState([]);
  // Filtered EN stations (shown when a station is selected)
  const [filteredEnStations, setFilteredEnStations] = useState([]);
  // All routes for "Show All Routes" mode
  const [allNjRoutes, setAllNjRoutes] = useState([]);
  const [allEnRoutes, setAllEnRoutes] = useState([]);
  // NightJet loading progress
  const [njLoadingProgress, setNjLoadingProgress] = useState({
    progress: 0,
    message: "",
    step: "",
  });
  // True only after NightJet + EuroNight stations and routes have finished loading (or failed)
  const [nightTrainsReady, setNightTrainsReady] = useState(false);

  const mapRef = useRef();
  const sidebarRef = useRef(null);

  const mapClassName = `w-full h-full ${className || ""}`;

  // Function to normalize station name for display
  const normalizeStationName = useCallback((stationName) => {
    if (!stationName) return stationName;

    // Group Paris stations together
    if (stationName.includes("Paris")) {
      return "Paris";
    }
    // Group Brussels stations together
    else if (
      stationName.includes("Bruxelles") ||
      stationName.includes("Brussels")
    ) {
      return "Brussels";
    }
    // Group other major cities with multiple stations
    else if (
      stationName.includes("Antwerpen") ||
      stationName.includes("Antwerp")
    ) {
      return "Antwerpen";
    } else if (
      stationName.includes("Liège") ||
      stationName.includes("Liege") ||
      stationName.includes("Luik")
    ) {
      return "Liège";
    } else if (stationName.includes("Wien") || stationName.includes("Vienna")) {
      return "Vienna";
    } else if (
      stationName.includes("Milano") ||
      stationName.includes("Milan")
    ) {
      return "Milan";
    } else if (
      stationName.includes("Torino") ||
      stationName.includes("Turin")
    ) {
      return "Torino";
    } else if (
      // Check for "Roma" or "Rome" but exclude "Roman" (Romanian station)
      // Match if starts with "Roma" or "Rome", or contains " Roma " or " Rome " (with spaces)
      // But exclude if starts with "Roman"
      (stationName.startsWith("Roma") ||
        stationName.startsWith("Rome") ||
        stationName.includes(" Roma ") ||
        stationName.includes(" Rome ")) &&
      !stationName.startsWith("Roman")
    ) {
      return "Rome";
    } else if (stationName.includes("Berlin")) {
      return "Berlin";
    } else if (
      stationName.includes("München") ||
      stationName.includes("Munich")
    ) {
      return "Munich";
    } else if (stationName.includes("Hamburg")) {
      return "Hamburg";
    } else if (
      stationName.includes("Köln") ||
      stationName.includes("Cologne")
    ) {
      return "Cologne";
    } else if (stationName.includes("Frankfurt")) {
      return "Frankfurt";
    } else if (stationName.includes("Amsterdam")) {
      return "Amsterdam";
    } else if (
      stationName.includes("Zürich") ||
      stationName.includes("Zurich")
    ) {
      return "Zurich";
    } else if (stationName.includes("Barcelona")) {
      return "Barcelona";
    } else if (stationName.includes("Madrid")) {
      return "Madrid";
    } else if (
      stationName.includes("Lisboa") ||
      stationName.includes("Lisbon")
    ) {
      return "Lisbon";
    } else if (stationName.includes("Stockholm")) {
      return "Stockholm";
    } else if (stationName.includes("Oslo")) {
      return "Oslo";
    } else if (
      stationName.includes("København") ||
      stationName.includes("Copenhagen")
    ) {
      return "Copenhagen";
    } else if (
      stationName.includes("Helsinki") ||
      stationName.includes("Helsingfors")
    ) {
      return "Helsinki";
    } else if (
      stationName.includes("Warszawa") ||
      stationName.includes("Warsaw")
    ) {
      return "Warsaw";
    } else if (
      stationName.includes("Kraków") ||
      stationName.includes("Krakow")
    ) {
      return "Krakow";
    } else if (stationName.includes("Budapest")) {
      return "Budapest";
    } else if (
      stationName.includes("Praha") ||
      stationName.includes("Prague")
    ) {
      return "Prague";
    } else if (
      stationName.includes("București") ||
      stationName.includes("Bucharest")
    ) {
      return "Bucharest";
    } else if (stationName.includes("Sofia")) {
      return "Sofia";
    } else if (stationName.includes("Zagreb")) {
      return "Zagreb";
    } else if (stationName.includes("Ljubljana")) {
      return "Ljubljana";
    } else if (stationName.includes("Bratislava")) {
      return "Bratislava";
    } else if (stationName.includes("Vilnius")) {
      return "Vilnius";
    } else if (stationName.includes("Riga")) {
      return "Riga";
    } else if (stationName.includes("Tallinn")) {
      return "Tallinn";
    } else if (stationName.includes("Kyiv") || stationName.includes("Kiev")) {
      return "Kyiv";
    } else if (stationName.includes("Minsk")) {
      return "Minsk";
    } else if (stationName.includes("Ankara")) {
      return "Ankara";
    } else if (stationName.includes("London")) {
      return "London";
    } else if (
      stationName.includes("İstanbul") ||
      stationName.includes("Istanbul")
    ) {
      return "Istanbul";
    } else if (stationName.includes("İzmir") || stationName.includes("Izmir")) {
      return "Izmir";
    }

    return stationName;
  }, []);

  const removeFilter = () => {
    setNjOverlays([]);
    setEnOverlays([]);
    setFilteredNjStations([]);
    setFilteredEnStations([]);
    setStopId(null);
    setSelected(false);
    setSelectedStationName("");
    setSelectedNormalizedName("");
    setSelectedStationLat(null);
    setSelectedStationLon(null);
    setStopRouteIds([]); // Clear route IDs to hide route paths
    setFilteredStops(stops);
  };

  // Handle polyline (route line) click to show train details
  const handlePolylineClick = useCallback((routeIds) => {
    console.log("Polyline clicked! Route ID:", routeIds);
    // routeIds can be a single ID or an array (for overlapping routes)
    const idsArray = Array.isArray(routeIds) ? routeIds : [routeIds];
    console.log("Opening panel with route IDs:", idsArray);
    setSelectedTrainRouteIds(idsArray);
    setIsTrainDetailPanelOpen(true);
  }, []);

  const closeTrainDetailPanel = useCallback(() => {
    setIsTrainDetailPanelOpen(false);
    setSelectedTrainRouteIds([]);
  }, []);

  // Component to handle map click events
  const MapClickHandler = () => {
    useMapEvents({
      click: (e) => {
        // Only clear filter if clicking on empty map (not on markers or polylines)
        // Check if the click was on a map layer (marker, polyline, etc.)
        const isClickOnFeature = e.originalEvent.target.classList.contains(
          "leaflet-interactive",
        );

        if (selected && !isClickOnFeature) {
          removeFilter();
        }
      },
    });
    return null;
  };

  const escFunction = useCallback(
    (event) => {
      if (event.key === "Escape") {
        removeFilter();
      }
    },
    [setFilteredStops, stops],
  );

  useEffect(() => {
    document.addEventListener("keydown", escFunction, false);

    return () => {
      document.removeEventListener("keydown", escFunction, false);
    };
  }, [escFunction]);

  // Calculate overall loading state
  const overallLoading = stopsLoading || citiesLoading;

  // Reflect real loading: Back-on-Track phase (stops + cities)
  useEffect(() => {
    if (overallLoading) {
      setLoadingProgress(stopsLoading ? 5 : 25);
      setLoadingMessage(
        stopsLoading
          ? "Loading stations..."
          : "Processing routes...",
      );
    } else {
      setLoadingProgress(30);
      setLoadingMessage("Preparing night trains...");
    }
  }, [overallLoading, stopsLoading, citiesLoading]);

  // Hide loading modal only when both Back-on-Track and NightJet+EuroNight are ready
  useEffect(() => {
    if (!overallLoading && nightTrainsReady) {
      setLoadingProgress(100);
      const t = setTimeout(() => {
        setIsLoading(false);
      }, 500); // Small delay to show 100% completion
      return () => clearTimeout(t);
    }
  }, [overallLoading, nightTrainsReady]);

  // When "Show All Routes" is on and no station is selected, show all NightJet and EuroNight routes
  useEffect(() => {
    if (selected) {
      // Overlays are set by loadNightTrainsForStation when a station is clicked; don't override
      return;
    }
    if (showRoutes) {
      setNjOverlays(allNjRoutes);
      setEnOverlays(allEnRoutes);
    } else {
      setNjOverlays([]);
      setEnOverlays([]);
    }
  }, [showRoutes, selected, allNjRoutes, allEnRoutes]);

  // Immediate loading of map elements without delay
  useEffect(() => {
    if (stops && stops.length > 0 && cities && !overallLoading) {
      // Ensure filtered stops is set to all stops initially
      setFilteredStops(stops);

      // Load night train stations BEFORE showing map
      (async () => {
        try {
          const today = new Date();
          const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

          console.log("[DEBUG] Starting to load night train data...");
          setLoadingProgress(35);
          setLoadingMessage("Prewarming NightJet & EuroNight...");

          // Prewarm both Nightjet and EuroNight in parallel
          await Promise.all([
            fetch("/api/nj-prewarm?max=30", { method: "GET" }),
            fetch("/api/en-prewarm", { method: "GET" }),
          ]);

          console.log("[DEBUG] Prewarming complete, loading stations...");
          setLoadingProgress(45);
          setLoadingMessage("Loading NightJet stations...");

          // Load all Nightjet stations from comprehensive API with progress tracking
          console.log(
            "[DEBUG] Fetching Nightjet stations from /api/nj-all-stations",
          );
          let njStationsFromApi = [];

          // Poll real progress and map to 45–75% for main bar
          const progressInterval = setInterval(async () => {
            try {
              const progressRes = await fetch(
                `/api/nj-all-stations?progress=true&date=${date}`,
              );
              if (progressRes.ok) {
                const progress = await progressRes.json();
                setNjLoadingProgress(progress);
                const p = progress?.progress;
                if (typeof p === "number") {
                  setLoadingProgress(45 + (p / 100) * 30);
                  if (progress?.message) setLoadingMessage(progress.message);
                }
              }
            } catch (err) {
              console.error("[DEBUG] Failed to fetch progress:", err);
            }
          }, 500); // Poll every 500ms

          try {
            const njStationsRes = await fetch(
              `/api/nj-all-stations?date=${date}&_t=${Date.now()}`,
              {
                cache: "no-store",
              },
            );

            // Clear progress polling
            clearInterval(progressInterval);

            if (njStationsRes.ok) {
              const stationsData = await njStationsRes.json();
              console.log("[DEBUG] nj-all-stations data:", stationsData);
              if (stationsData?.stations?.length) {
                console.log(
                  "[DEBUG] Sample stations:",
                  stationsData.stations.slice(0, 3),
                );
                njStationsFromApi = stationsData.stations;
                setAllNjStations(stationsData.stations);
                setLoadingProgress(75);
                setLoadingMessage(`NightJet: ${stationsData.count} stations`);
                setNjLoadingProgress({
                  progress: 100,
                  message: `Found ${stationsData.count} stations`,
                  step: "complete",
                });
              } else {
                console.log("[DEBUG] No stations in response");
                setNjLoadingProgress({
                  progress: 0,
                  message: "No stations found",
                  step: "complete",
                });
              }
            } else {
              console.error(
                "[DEBUG] Failed to fetch nj-all-stations:",
                njStationsRes.status,
                njStationsRes.statusText,
              );
              setNjLoadingProgress({
                progress: 0,
                message: "Failed to load stations",
                step: "error",
              });
            }
          } catch (err) {
            clearInterval(progressInterval);
            console.error("[DEBUG] Error fetching nj-all-stations:", err);
            setNjLoadingProgress({
              progress: 0,
              message: `Error: ${err.message}`,
              step: "error",
            });
          }

          setLoadingProgress(80);
          setLoadingMessage("Loading NightJet routes...");
          // Load all Nightjet routes for display
          const njRes = await fetch(`/api/nj-list?date=${date}`);
          if (njRes.ok) {
            const data = await njRes.json();
            if (data?.items?.length) {
              // Store all routes for Show All Routes mode
              const njColors = [
                "#0ea5e9",
                "#14b8a6",
                "#06b6d4",
                "#22d3ee",
                "#0891b2",
                "#0e7490",
                "#0284c7",
                "#0369a1",
              ];
              // Process routes: decode polyline if available for smoother curves, otherwise use station coords
              const routes = data.items.map((item, idx) => {
                // Decode polyline if available, otherwise use station coords
                let coords = item.coords;
                if (item.polyline) {
                  try {
                    coords = polyline.decode(item.polyline);
                  } catch (e) {
                    console.error("Failed to decode Nightjet polyline:", e);
                  }
                }
                return {
                  key: item.key,
                  lineName: item.lineName,
                  coords,
                  stations: item.stations,
                  color: njColors[idx % njColors.length],
                  type: "nightjet",
                };
              });
              setAllNjRoutes(routes);

              // Extract unique stations from routes and merge with stations from API
              // This ensures we have stations even if nj-all-stations API is slow or fails
              const stationMap = new Map();
              // Add stations from API first
              njStationsFromApi.forEach((station) => {
                const key =
                  station.id ||
                  `${station.location?.latitude}-${station.location?.longitude}`;
                if (key) stationMap.set(key, station);
              });
              // Add stations from routes
              data.items.forEach((route) => {
                route.stations?.forEach((station) => {
                  const key =
                    station.id ||
                    `${station.location?.latitude}-${station.location?.longitude}`;
                  if (
                    key &&
                    station.location?.latitude &&
                    station.location?.longitude
                  ) {
                    if (!stationMap.has(key)) {
                      stationMap.set(key, station);
                    }
                  }
                });
              });
              // Update stations with merged set
              const mergedStations = Array.from(stationMap.values());
              if (mergedStations.length > njStationsFromApi.length) {
                console.log(
                  "[DEBUG] Merged stations from nj-list:",
                  mergedStations.length,
                  "total stations (was",
                  njStationsFromApi.length,
                  ")",
                );
                setAllNjStations(mergedStations);
              }
            }
          }

          setLoadingProgress(90);
          setLoadingMessage("Loading EuroNight routes...");
          // Load all EuroNight stations and routes for display
          const enRes = await fetch(`/api/en-list?date=${date}`);
          if (enRes.ok) {
            const data = await enRes.json();
            if (data?.items?.length) {
              // Store all routes for Show All Routes mode
              const enColors = [
                "#a855f7",
                "#c026d3",
                "#d946ef",
                "#e879f9",
                "#9333ea",
                "#a21caf",
                "#86198f",
                "#701a75",
              ];
              // Process routes: decode polyline if available for smoother curves, otherwise use station coords
              const routes = data.items.map((item, idx) => {
                // Decode polyline if available, otherwise use station coords
                let coords = item.coords;
                if (item.polyline) {
                  try {
                    coords = polyline.decode(item.polyline);
                  } catch (e) {
                    console.error("Failed to decode EuroNight polyline:", e);
                  }
                }
                return {
                  key: item.key,
                  lineName: item.lineName,
                  coords,
                  stations: item.stations,
                  color: enColors[idx % enColors.length],
                  type: "euronight",
                };
              });
              setAllEnRoutes(routes);

              // Extract unique stations
              const stationMap = new Map();
              data.items.forEach((route) => {
                route.stations?.forEach((station) => {
                  const key = `${station.location?.latitude}-${station.location?.longitude}`;
                  if (!stationMap.has(key)) {
                    stationMap.set(key, station);
                  }
                });
              });
              setAllEnStations(Array.from(stationMap.values()));
            }
          }

          console.log("[DEBUG] All night train data loaded, showing map");
          setLoadingProgress(100);
          setLoadingMessage("Ready!");
          // Mark night trains ready so loading modal can hide
          setNightTrainsReady(true);
          setIsMapInitialized(true);
          setShowTooltips(true);
        } catch (err) {
          console.error("[DEBUG] Error loading night train data:", err);
          // Mark ready even on error so modal doesn't block forever
          setNightTrainsReady(true);
          setIsMapInitialized(true);
          setShowTooltips(true);
        }
      })();
    }
  }, [stops, cities, setFilteredStops, overallLoading]);

  const defaultIcon = useMemo(() => {
    // Create a beautiful blue dot for main stations
    const stationDot = new Leaflet.DivIcon({
      className: "station-dot",
      html: '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    return stationDot;
  }, []);

  const selectedIcon = useMemo(() => {
    // Create a beautiful dot for selected stations (same size as main stations)
    const selectedDot = new Leaflet.DivIcon({
      className: "selected-station-dot",
      html: '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #FF5722, #E64A19); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(255, 87, 34, 0.5), 0 0 0 1px rgba(255, 87, 34, 0.3); transition: all 0.3s ease; cursor: pointer; z-index: 2000;"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    return selectedDot;
  }, []);

  const viaIcon = useMemo(() => {
    // Create a bigger circular dot for intermediate stations
    const dotIcon = new Leaflet.DivIcon({
      className: "via-dot",
      html: '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    return dotIcon;
  }, []);

  // Heuristic matcher for station names (handles 'Centraal', 'Hbf', 'HB', brackets, diacritics via city normalizer)
  const matchStationNames = useCallback(
    (a, b) => {
      if (!a || !b) return false;
      const simplify = (s) => {
        const n = normalizeStationNameForLookup(String(s) || "")
          .toLowerCase()
          .replace(/\(.*?\)/g, "") // remove parentheses
          .replace(/\b(centraal|central|bahnhof|station|hbf|hb)\b/gi, "")
          .replace(/[^a-zà-ÿ\s-]/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        return n;
      };
      const A = simplify(a);
      const B = simplify(b);
      if (!A || !B) return false;
      if (A === B) return true;
      return A.includes(B) || B.includes(A);
    },
    [normalizeStationNameForLookup],
  );

  // Load ALL Nightjet and EuroNight routes passing through the clicked station
  // Accepts both originalStationName (for exact matching) and normalizedStationName (for grouped cities)
  const loadNightTrainsForStation = useCallback(
    async (normalizedStationName, originalStationName = null) => {
      console.log(
        "[DEBUG loadNightTrainsForStation] Called with normalizedStationName:",
        normalizedStationName,
        "originalStationName:",
        originalStationName,
      );
      try {
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        // Try fetching with both the normalized name and original name (if different)
        // This ensures we catch all routes that pass through the station
        // Use separate Sets to deduplicate routes by their key for each type
        const njRouteKeys = new Set();
        const enRouteKeys = new Set();
        const njRoutes = [];
        const enRoutes = [];

        // Try with normalized name first
        const [njRes1, enRes1] = await Promise.all([
          fetch(
            `/api/nj-list?date=${date}&stationName=${encodeURIComponent(normalizedStationName)}`,
          ),
          fetch(
            `/api/en-list?date=${date}&stationName=${encodeURIComponent(normalizedStationName)}`,
          ),
        ]);

        // Process normalized name results
        if (njRes1.ok) {
          const data = await njRes1.json();
          if (data?.items?.length) {
            data.items.forEach((item) => {
              if (!njRouteKeys.has(item.key)) {
                njRouteKeys.add(item.key);
                njRoutes.push(item);
              }
            });
          }
        }

        if (enRes1.ok) {
          const data = await enRes1.json();
          if (data?.items?.length) {
            data.items.forEach((item) => {
              if (!enRouteKeys.has(item.key)) {
                enRouteKeys.add(item.key);
                enRoutes.push(item);
              }
            });
          }
        }

        // If original name is different, also try with original name
        if (
          originalStationName &&
          originalStationName !== normalizedStationName
        ) {
          const [njRes2, enRes2] = await Promise.all([
            fetch(
              `/api/nj-list?date=${date}&stationName=${encodeURIComponent(originalStationName)}`,
            ),
            fetch(
              `/api/en-list?date=${date}&stationName=${encodeURIComponent(originalStationName)}`,
            ),
          ]);

          // Process original name results
          if (njRes2.ok) {
            const data = await njRes2.json();
            if (data?.items?.length) {
              data.items.forEach((item) => {
                if (!njRouteKeys.has(item.key)) {
                  njRouteKeys.add(item.key);
                  njRoutes.push(item);
                }
              });
            }
          }

          if (enRes2.ok) {
            const data = await enRes2.json();
            if (data?.items?.length) {
              data.items.forEach((item) => {
                if (!enRouteKeys.has(item.key)) {
                  enRouteKeys.add(item.key);
                  enRoutes.push(item);
                }
              });
            }
          }
        }

        // Fallback: If no routes found with station name filter, try fetching all routes
        // and filter client-side. This helps when API matching isn't working correctly.
        if (njRoutes.length === 0 && enRoutes.length === 0) {
          console.log(
            "[DEBUG loadNightTrainsForStation] No routes found with name filter, trying all routes...",
          );
          const [njResAll, enResAll] = await Promise.all([
            fetch(`/api/nj-list?date=${date}`),
            fetch(`/api/en-list?date=${date}`),
          ]);

          // Helper function to check if a route passes through the station
          const routePassesThroughStation = (route, stationNameToMatch) => {
            if (!route?.stations?.length) return false;
            return route.stations.some((station) => {
              const stationName = station?.name || "";
              // Try matching with both normalized and original names
              if (matchStationNames(stationName, normalizedStationName))
                return true;
              if (
                originalStationName &&
                matchStationNames(stationName, originalStationName)
              )
                return true;
              // Also try direct substring matching as fallback
              const simplifiedStationName = stationName
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
              const simplifiedMatch = normalizedStationName
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
              if (
                simplifiedStationName.includes(simplifiedMatch) ||
                simplifiedMatch.includes(simplifiedStationName)
              ) {
                return true;
              }
              if (originalStationName) {
                const simplifiedOriginal = originalStationName
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, "");
                if (
                  simplifiedStationName.includes(simplifiedOriginal) ||
                  simplifiedOriginal.includes(simplifiedStationName)
                ) {
                  return true;
                }
              }
              return false;
            });
          };

          // Process all NightJet routes and filter client-side
          if (njResAll.ok) {
            const data = await njResAll.json();
            if (data?.items?.length) {
              data.items.forEach((item) => {
                if (routePassesThroughStation(item, normalizedStationName)) {
                  if (!njRouteKeys.has(item.key)) {
                    njRouteKeys.add(item.key);
                    njRoutes.push(item);
                  }
                }
              });
            }
          }

          // Process all EuroNight routes and filter client-side
          if (enResAll.ok) {
            const data = await enResAll.json();
            if (data?.items?.length) {
              data.items.forEach((item) => {
                if (routePassesThroughStation(item, normalizedStationName)) {
                  if (!enRouteKeys.has(item.key)) {
                    enRouteKeys.add(item.key);
                    enRoutes.push(item);
                  }
                }
              });
            }
          }

          if (njRoutes.length > 0 || enRoutes.length > 0) {
            console.log(
              "[DEBUG loadNightTrainsForStation] Found routes via client-side filtering:",
              njRoutes.length,
              "NightJet,",
              enRoutes.length,
              "EuroNight",
            );
          }
        }

        console.log(
          "[DEBUG loadNightTrainsForStation] Found",
          njRoutes.length,
          "NightJet routes and",
          enRoutes.length,
          "EuroNight routes",
        );

        // Nightjet colors (cyan/teal shades)
        const njColors = [
          "#0ea5e9",
          "#14b8a6",
          "#06b6d4",
          "#22d3ee",
          "#0891b2",
          "#0e7490",
          "#0284c7",
          "#0369a1",
        ];
        // EuroNight colors (purple/magenta shades)
        const enColors = [
          "#a855f7",
          "#c026d3",
          "#d946ef",
          "#e879f9",
          "#9333ea",
          "#a21caf",
          "#86198f",
          "#701a75",
        ];

        // Process Nightjet routes
        const njOverlays = njRoutes.map((item, idx) => {
          // Decode polyline if available, otherwise use station coords
          let coords = item.coords;
          if (item.polyline) {
            try {
              coords = polyline.decode(item.polyline);
            } catch (e) {
              console.error("Failed to decode Nightjet polyline:", e);
            }
          }
          return {
            key: item.key,
            lineName: item.lineName,
            coords,
            stations: item.stations,
            color: njColors[idx % njColors.length],
            type: "nightjet",
          };
        });

        // Process EuroNight routes
        const enOverlays = enRoutes.map((item, idx) => {
          // Decode polyline if available, otherwise use station coords
          let coords = item.coords;
          if (item.polyline) {
            try {
              coords = polyline.decode(item.polyline);
            } catch (e) {
              console.error("Failed to decode EuroNight polyline:", e);
            }
          }
          return {
            key: item.key,
            lineName: item.lineName,
            coords,
            stations: item.stations,
            color: enColors[idx % enColors.length],
            type: "euronight",
          };
        });

        setNjOverlays(njOverlays);
        setEnOverlays(enOverlays);

        console.log(
          "[DEBUG] Night train routes for",
          normalizedStationName,
          ":",
          {
            nightjetRoutes: njOverlays.length,
            euronightRoutes: enOverlays.length,
            njRouteNames: njOverlays.map((o) => o.lineName),
            enRouteNames: enOverlays.map((o) => o.lineName),
          },
        );

        // Helper function to check if a station name matches the clicked station
        // Try matching with both normalized and original names
        const matchesStation = (stationNameToCheck) => {
          if (!stationNameToCheck) return false;
          // Try matching with normalized name
          if (matchStationNames(stationNameToCheck, normalizedStationName)) {
            return true;
          }
          // Try matching with original name if available
          if (
            originalStationName &&
            matchStationNames(stationNameToCheck, originalStationName)
          ) {
            return true;
          }
          return false;
        };

        // Extract unique stations from Nightjet overlays
        // IMPORTANT: For each route, only show stations that are directly reachable
        // (on the same train/route) from the clicked station
        if (njOverlays.length > 0) {
          const njStationMap = new Map();
          njOverlays.forEach((overlay) => {
            // Find the clicked station in this route - try matching with both names
            const clickedStationIndex = overlay.stations?.findIndex((s) =>
              matchesStation(s.name),
            );

            if (clickedStationIndex !== -1 && overlay.stations) {
              // Only include stations on the same route (same train)
              // All stations on this route are directly reachable without transfer
              overlay.stations.forEach((station) => {
                const key = `${station.location?.latitude}-${station.location?.longitude}`;
                if (!njStationMap.has(key)) {
                  njStationMap.set(key, station);
                }
              });
            }
          });
          setFilteredNjStations(Array.from(njStationMap.values()));
        } else {
          // No Nightjet routes found - clear filtered stations
          setFilteredNjStations([]);
        }

        // Extract unique stations from EuroNight overlays
        // IMPORTANT: For each route, only show stations that are directly reachable
        // (on the same train/route) from the clicked station
        if (enOverlays.length > 0) {
          const enStationMap = new Map();
          enOverlays.forEach((overlay) => {
            // Find the clicked station in this route - try matching with both names
            const clickedStationIndex = overlay.stations?.findIndex((s) =>
              matchesStation(s.name),
            );

            if (clickedStationIndex !== -1 && overlay.stations) {
              // Only include stations on the same route (same train)
              // All stations on this route are directly reachable without transfer
              overlay.stations.forEach((station) => {
                const key = `${station.location?.latitude}-${station.location?.longitude}`;
                if (!enStationMap.has(key)) {
                  enStationMap.set(key, station);
                }
              });
            }
          });
          setFilteredEnStations(Array.from(enStationMap.values()));
        } else {
          // No EuroNight routes found - clear filtered stations
          setFilteredEnStations([]);
        }
      } catch (e) {
        console.error("Night trains fetch error", e);
        setNjOverlays([]);
        setEnOverlays([]);
      }
    },
    [stops, matchStationNames, setFilteredStops],
  );

  const handleMarkerClick = useCallback(
    (filteredStop) => {
      const { stop_id } = filteredStop;

      // If clicking on the already selected marker, unselect it
      if (stopId === stop_id && selected) {
        removeFilter();
        return;
      }

      setStopId(stop_id);
      // Store station coordinates for HAFAS API
      setSelectedStationLat(filteredStop.stop_lat);
      setSelectedStationLon(filteredStop.stop_lon);
      // IMPORTANT: Normalize stop_id before looking it up in cities
      // Use normalizeStationNameForLookup for matching city keys
      const normalizedStopId = normalizeStationNameForLookup(stop_id);
      const cityInfo = cities[normalizedStopId] || cities[stop_id];

      // Set station name for display: always normalize for cleaner display
      // Use normalized name (e.g., "Amsterdam" instead of "Amsterdam Centraal")
      const filterName = normalizeStationName(stop_id);
      setSelectedStationName(filterName);

      // Set normalized name for filtering via stations
      setSelectedNormalizedName(normalizeStationName(stop_id));

      // Handle stations that might only have night train routes (no Back-on-Track data)
      if (cityInfo && cityInfo.stop_route_ids) {
        const { stop_route_ids } = cityInfo;

        // If this is a grouped marker, collect all route IDs from all stations in the group
        let routeIdsArray;
        if (filteredStop.isGrouped && filteredStop.groupedStations) {
          // Collect all route IDs from all stations in the group
          const allRouteIds = new Set();
          filteredStop.groupedStations.forEach((station) => {
            // IMPORTANT: Normalize station.stop_id before looking it up in cities
            // Use normalizeStationNameForLookup for matching city keys
            const normalizedId = normalizeStationNameForLookup(station.stop_id);
            const stationInfo = cities[normalizedId] || cities[station.stop_id];
            if (stationInfo?.stop_route_ids) {
              stationInfo.stop_route_ids.split(",").forEach((id) => {
                allRouteIds.add(id);
              });
            }
          });
          routeIdsArray = Array.from(allRouteIds);
        } else {
          // Deduplicate route IDs to prevent duplicate paths with same keys
          // This ensures React properly unmounts old polylines when switching stations
          const routeIdsSet = new Set(
            stop_route_ids.split(",").filter((el) => el),
          );
          routeIdsArray = Array.from(routeIdsSet);
        }

        setStopRouteIds(routeIdsArray);

        // Find all cities (stations) that are part of the selected routes
        const routeCities = Object.values(cities).filter((viewCity) => {
          if (!viewCity || !viewCity.stop_route_ids) return false;
          const arr = viewCity.stop_route_ids.split(",");
          return arr.some((item) => routeIdsArray.includes(item));
        });

        // PERFORMANCE: Create Map for fast station lookup
        // Key: normalized station name, Value: stop object
        const stopsMap = new Map();
        stops.forEach((stop) => {
          if (!stop.stop_id) return;
          const normalizedId = normalizeStationNameForLookup(stop.stop_id);
          // Store by normalized name (primary key)
          if (!stopsMap.has(normalizedId)) {
            stopsMap.set(normalizedId, stop);
          }
          // Also store by original name for fallback
          if (!stopsMap.has(stop.stop_id)) {
            stopsMap.set(stop.stop_id, stop);
          }
        });

        // Find stops that match route cities
        const routeStops = routeCities
          .map((city) => {
            // city.stop_id is normalized, so use it directly for lookup
            return stopsMap.get(city.stop_id);
          })
          .filter(Boolean);

        // IMPORTANT: Set filtered stops to only show stations from selected routes
        // This hides all other stations when a filter is applied
        console.log(
          "[DEBUG handleMarkerClick] Filtered stops for",
          stop_id,
          ":",
          {
            selectedRouteIds: routeIdsArray,
            routeCitiesCount: routeCities.length,
            routeStopsCount: routeStops.length,
            routeStopNames: routeStops.map((s) => s.stop_id).slice(0, 10),
          },
        );
        setFilteredStops(routeStops);
      } else {
        // Station has no Back-on-Track routes
        // We'll filter based on night train routes after they're loaded
        // For now, set empty to hide all Back-on-Track stations
        setStopRouteIds([]);
        setFilteredStops([]);
      }

      setSelected(true);

      // Fetch and overlay both Nightjet and EuroNight routes for this station
      // Pass both normalized name (for grouped cities) and original name (for exact matching)
      console.log(
        "[DEBUG handleMarkerClick] filterName:",
        filterName,
        "stop_id:",
        stop_id,
      );
      if (filterName) {
        // Always pass the original stop_id as the second parameter
        // This ensures we search with both normalized and original names
        // Even if they're the same, having both helps with API matching
        loadNightTrainsForStation(filterName, stop_id);
      }
    },
    [
      cities,
      stops,
      setFilteredStops,
      stopId,
      selected,
      removeFilter,
      normalizeStationName,
      normalizeStationNameForLookup,
      isGrouped,
      loadNightTrainsForStation,
    ],
  );

  // Function to group overlapping city markers based on toggle
  const groupCityMarkers = useCallback(
    (stops) => {
      if (!stops || !stops.length) return [];

      // If grouping is disabled, return individual stations
      if (!isGrouped) {
        return stops.map((stop) => ({
          ...stop,
          originalName: stop.stop_id,
          normalizedName: stop.stop_id,
          displayName: stop.stop_id,
          isGrouped: false,
        }));
      }

      // Group stations by city name (normalized)
      const cityGroups = {};

      stops.forEach((stop) => {
        if (!stop?.stop_id || !stop?.stop_lat || !stop?.stop_lon) return;

        // IMPORTANT: Normalize stop_id before looking it up in cities
        // Use normalizeStationNameForLookup for matching city keys
        const normalizedStopId = normalizeStationNameForLookup(stop.stop_id);
        const cityInfo = cities[normalizedStopId] || cities[stop.stop_id];
        if (!cityInfo?.stop_route_ids) return;

        // Use normalizeStationName for grouping (returns city name like "Antwerpen")
        const normalizedCityName = normalizeStationName(stop.stop_id);

        if (!cityGroups[normalizedCityName]) {
          cityGroups[normalizedCityName] = [];
        }

        cityGroups[normalizedCityName].push({
          ...stop,
          originalName: stop.stop_id,
          normalizedName: normalizedCityName,
        });
      });

      // Convert groups to individual markers or grouped markers
      const groupedMarkers = [];

      Object.entries(cityGroups).forEach(([cityName, stations]) => {
        if (stations.length === 1) {
          // Single station - show as normal marker
          groupedMarkers.push({
            ...stations[0],
            displayName: cityName,
            isGrouped: false,
          });
        } else {
          // Multiple stations - create grouped marker
          // Find the most important station (main station, not via station)
          const mainStation =
            stations.find((station) => {
              // Use normalizeStationNameForLookup for matching city keys
              const normalizedId = normalizeStationNameForLookup(
                station.stop_id,
              );
              const cityInfo = cities[normalizedId] || cities[station.stop_id];
              return cityInfo && !cityInfo.isViaStation;
            }) || stations[0];

          // For grouped stations, prefer using coordinates from stations with custom coordinates
          // If main station has custom coordinates (coordinatesSource === "custom"), use it
          // Otherwise, calculate average but prioritize stations with custom coordinates
          let finalLat, finalLon;

          if (mainStation.coordinatesSource === "custom") {
            // Use main station's custom coordinates
            finalLat = mainStation.stop_lat;
            finalLon = mainStation.stop_lon;
          } else {
            // Check if any station in the group has custom coordinates
            const stationsWithCustomCoords = stations.filter(
              (s) => s.coordinatesSource === "custom",
            );

            if (stationsWithCustomCoords.length > 0) {
              // Use average of stations with custom coordinates only
              finalLat =
                stationsWithCustomCoords.reduce(
                  (sum, station) => sum + station.stop_lat,
                  0,
                ) / stationsWithCustomCoords.length;
              finalLon =
                stationsWithCustomCoords.reduce(
                  (sum, station) => sum + station.stop_lon,
                  0,
                ) / stationsWithCustomCoords.length;
            } else {
              // Fallback to average of all stations
              finalLat =
                stations.reduce((sum, station) => sum + station.stop_lat, 0) /
                stations.length;
              finalLon =
                stations.reduce((sum, station) => sum + station.stop_lon, 0) /
                stations.length;
            }
          }

          groupedMarkers.push({
            ...mainStation,
            stop_lat: finalLat,
            stop_lon: finalLon,
            groupedStations: stations,
            isGrouped: true,
            groupSize: stations.length,
            displayName: cityName,
          });
        }
      });

      return groupedMarkers;
    },
    [cities, normalizeStationName, isGrouped],
  );

  // Build a Set of endpoint station names/IDs for NightJet and EuroNight routes
  // Endpoints are first or last station in any route
  const nightTrainEndpointStations = useMemo(() => {
    const endpointSet = new Set();
    
    // Check NightJet routes
    allNjRoutes.forEach((route) => {
      if (route.stations && route.stations.length > 0) {
        // First station is an endpoint
        const firstStation = route.stations[0];
        if (firstStation?.name) {
          endpointSet.add(firstStation.name);
          if (firstStation.id) endpointSet.add(firstStation.id);
        }
        // Last station is an endpoint
        if (route.stations.length > 1) {
          const lastStation = route.stations[route.stations.length - 1];
          if (lastStation?.name) {
            endpointSet.add(lastStation.name);
            if (lastStation.id) endpointSet.add(lastStation.id);
          }
        }
      }
    });
    
    // Check EuroNight routes
    allEnRoutes.forEach((route) => {
      if (route.stations && route.stations.length > 0) {
        // First station is an endpoint
        const firstStation = route.stations[0];
        if (firstStation?.name) {
          endpointSet.add(firstStation.name);
          if (firstStation.id) endpointSet.add(firstStation.id);
        }
        // Last station is an endpoint
        if (route.stations.length > 1) {
          const lastStation = route.stations[route.stations.length - 1];
          if (lastStation?.name) {
            endpointSet.add(lastStation.name);
            if (lastStation.id) endpointSet.add(lastStation.id);
          }
        }
      }
    });
    
    return endpointSet;
  }, [allNjRoutes, allEnRoutes]);

  // Helper: check if a route should be filtered out due to future "From <Date>" note
  // Must be defined before markers and routePaths useMemos that use it
  const shouldHideRouteDueToFutureDate = useCallback((routeId) => {
    if (!trips || !routeId) return false;

    const routeTrips = Object.values(trips).filter(
      (trip) => trip.route_id?.toString() === routeId.toString()
    );
    if (routeTrips.length === 0) return false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const trip of routeTrips) {
      const irregularities = trip.irregularities;
      if (!irregularities || typeof irregularities !== "string") continue;

      const fromDateMatch = irregularities.match(/From\s+(\d{4}-\d{2}-\d{2})/i);
      if (fromDateMatch) {
        const fromDate = new Date(fromDateMatch[1]);
        fromDate.setHours(0, 0, 0, 0);
        if (fromDate > today) return true;
      }
    }
    return false;
  }, [trips]);

  const markers = useMemo(() => {
    // Combine night train stops with all stations based on filter
    let stopsToShow = [];

    if (hideIntermediateStations && viewMapData) {
      // Only show stations that are part of night train routes
      if (!filteredStops || !filteredStops.length) return [];

      const nightTrainStationIds = new Set();
      Object.values(viewMapData).forEach((route) => {
        // Skip routes with future "From <Date>" notes
        if (route?.route_id && shouldHideRouteDueToFutureDate(route.route_id.toString())) {
          return;
        }
        if (route) {
          [
            route.origin_trip_0,
            route.destination_trip_0,
            route.origin_trip_1,
            route.destination_trip_1,
            route.via_0,
            route.via_1,
          ]
            .filter(Boolean)
            .forEach((stationName) => {
              // Add normalized and original names
              const normalized = normalizeStationNameForLookup(stationName);
              nightTrainStationIds.add(stationName);
              nightTrainStationIds.add(normalized);
            });
        }
      });

      stopsToShow = filteredStops.filter((stop) => {
        if (!stop?.stop_id) return false;
        const normalizedId = normalizeStationNameForLookup(stop.stop_id);
        return (
          nightTrainStationIds.has(stop.stop_id) ||
          nightTrainStationIds.has(normalizedId)
        );
      });
    } else {
      // Show all stations from filteredStops (night train database)
      // Note: Additional stations from DB REST API are disabled for now
      if (!filteredStops || !filteredStops.length) return [];
      stopsToShow = filteredStops;
    }

    // Filter out stations that should be skipped
    // Create a Set of normalized skip station names for fast lookup
    // Check both original and normalized names to catch all variations
    const skipStationNames = new Set();
    stationsToSkip.forEach((stationName) => {
      skipStationNames.add(stationName);
      skipStationNames.add(normalizeStationNameForLookup(stationName));
    });

    stopsToShow = stopsToShow.filter((stop) => {
      if (!stop?.stop_id) return false;
      const normalizedId = normalizeStationNameForLookup(stop.stop_id);
      // Skip if station name (original or normalized) matches any skip list entry
      return (
        !skipStationNames.has(stop.stop_id) &&
        !skipStationNames.has(normalizedId)
      );
    });

    if (!stopsToShow || !stopsToShow.length) {
      console.log("No stations to show");
      return [];
    }

    // Group overlapping city markers based on current zoom
    const groupedStops = groupCityMarkers(stopsToShow);

    // PERFORMANCE OPTIMIZATION: Create Maps for fast lookups
    // This avoids repeated expensive operations
    const routeIdMap = new Map();
    const normalizedNameCache = new Map();

    // Cache route lookups
    // Guard against undefined viewMapData to prevent runtime errors
    if (selected && stopRouteIds && stopRouteIds.length > 0 && viewMapData) {
      Object.values(viewMapData).forEach((route) => {
        if (route?.route_id) {
          routeIdMap.set(route.route_id.toString(), route);
        }
      });
    }

    // Helper to get cached normalized name for lookup in cities
    // This uses normalizeStationNameForLookup (not grouping function)
    const getCachedNormalizedName = (name) => {
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    return groupedStops
      .map((filteredStop, index) => {
        // For grouped stations, check if ANY station in the group is selected
        const isSelected = filteredStop.isGrouped
          ? filteredStop.groupedStations?.some(
              (station) => station.stop_id === stopId,
            )
          : stopId === filteredStop?.stop_id;
        const stopLat = filteredStop?.stop_lat;
        const stopLon = filteredStop?.stop_lon;

        const { stop_id } = filteredStop;
        // IMPORTANT: Normalize stop_id before looking it up in cities
        // because cities keys are normalized (e.g., "Antwerpen Centraal")
        // but stops may have original names (e.g., "Antwerpen-Centraal / Anvers-Central")
        const normalizedStopId = getCachedNormalizedName(stop_id);
        const cityInfo = cities[normalizedStopId] || cities[stop_id];
        const { stop_route_ids } = cityInfo || {};

        if (!stopLat || !stopLon || !stop_route_ids || !cityInfo) return null;

        // When filter is applied, ensure this station is part of selected routes
        // This provides an extra safety check to hide unrelated stations
        if (selected && stopRouteIds && stopRouteIds.length > 0) {
          const stationRouteIds = stop_route_ids
            .split(",")
            .filter((id) => id.trim());
          const isPartOfSelectedRoutes = stationRouteIds.some((id) =>
            stopRouteIds.includes(id),
          );
          if (!isPartOfSelectedRoutes) {
            return null; // Hide station if it's not part of selected routes
          }
        }

        // Dynamically determine if this station is a via station for the FILTERED routes
        // This fixes the bug where stations that are origins for OTHER routes
        // incorrectly show as origins instead of via stations
        let isViaStationForFilteredRoutes = cityInfo.isViaStation; // Default to global flag

        if (
          selected &&
          stopRouteIds &&
          stopRouteIds.length > 0 &&
          !isSelected
        ) {
          // When a filter is active, check if this station is origin/destination
          // for ANY of the filtered routes

          // Normalize the stop_id for comparison
          // For grouped stations, we need to check all stations in the group
          const stationsToCheck =
            filteredStop.isGrouped && filteredStop.groupedStations
              ? filteredStop.groupedStations.map((s) => s.stop_id)
              : [stop_id];

          const isOriginOrDestination = stopRouteIds.some((routeId) => {
            // PERFORMANCE: Use Map for O(1) lookup instead of O(n) find
            const route = routeIdMap.get(routeId);
            if (!route) return false;

            // Get all origin/destination names from the route
            const routeStations = [
              route.origin_trip_0,
              route.destination_trip_0,
              route.origin_trip_1,
              route.destination_trip_1,
            ].filter(Boolean);

            // Check if any of our stations (normalized) match any route station (normalized)
            // Use cached normalized names for better performance
            return stationsToCheck.some((stationId) => {
              const normalizedStationId = getCachedNormalizedName(stationId);
              return routeStations.some((routeStation) => {
                const normalizedRouteStation =
                  getCachedNormalizedName(routeStation);
                // Also check direct match for non-normalized names
                return (
                  routeStation === stationId ||
                  normalizedRouteStation === normalizedStationId ||
                  normalizedRouteStation === stationId ||
                  routeStation === normalizedStationId
                );
              });
            });
          });

          // If this station is NOT origin/destination for any filtered route,
          // then it must be a via station (even if globally it's a main station)
          isViaStationForFilteredRoutes = !isOriginOrDestination;
        }

        // Choose the appropriate icon based on station type and selection
        let iconToUse = defaultIcon;
        if (isSelected) {
          iconToUse = selectedIcon;
        } else if (isViaStationForFilteredRoutes) {
          iconToUse = viaIcon;
        }

        // Create grouped icon for cities with multiple stations
        if (filteredStop.isGrouped) {
          // Use orange gradient when selected, blue when not selected
          const bgGradient = isSelected
            ? "linear-gradient(135deg, #FF9800, #F57C00)"
            : "linear-gradient(135deg, #2196F3, #1976D2)";

          const groupIcon = new Leaflet.DivIcon({
            className: isSelected
              ? "grouped-station-dot selected"
              : "grouped-station-dot",
            html: `<div style="width: 20px; height: 20px; background: ${bgGradient}; border-radius: 50%; border: 3px solid white; box-shadow: ${isSelected ? "0 3px 8px rgba(255, 152, 0, 0.6)" : "0 3px 8px rgba(33, 150, 243, 0.4)"}, 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000; position: relative;">
              <div style="position: absolute; top: -8px; left: -8px; background: linear-gradient(135deg, #FF9800, #F57C00); color: white; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 6px rgba(255, 152, 0, 0.5); z-index: 2000;">
                ${filteredStop.groupSize}
              </div>
            </div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          iconToUse = groupIcon;
        }

        // Performance optimization: Only render tooltips for selected markers
        // Use stable key without currentZoom to avoid recreating DOM on every zoom
        return (
          <Marker
            key={filteredStop?.stop_id || `marker-${index}`}
            position={[stopLat, stopLon]}
            icon={iconToUse}
            eventHandlers={{
              click: (e) => {
                handleMarkerClick(filteredStop);
              },
            }}
            title={filteredStop.displayName || stop_id}
          ></Marker>
        );
      })
      .filter(Boolean);
  }, [
    filteredStops,
    handleMarkerClick,
    groupCityMarkers,
    stopId,
    cities,
    defaultIcon,
    selectedIcon,
    viaIcon,
    selected,
    stopRouteIds,
    viewMapData,
    normalizeStationName,
    normalizeStationNameForLookup,
    hideIntermediateStations,
    shouldHideRouteDueToFutureDate,
  ]);

  // Route colors for visualization (defined outside useMemo to avoid recreation)
  const ROUTE_COLORS = [
    "#FF6B35", // Orange-red
    "#4A90E2", // Blue
    "#50C878", // Green
    "#9B59B6", // Purple
    "#F39C12", // Orange
    "#E74C3C", // Red
    "#3498DB", // Light blue
    "#2ECC71", // Light green
  ];

  // State for destination stations with coordinates
  const [destinationStations, setDestinationStations] = useState([]);
  // Track if effect is cancelled to prevent state updates after unmount
  const isCancelledRef = useRef(false);

  // Destination station names - empty since train departures are removed
  const destinationStationNames = useMemo(() => {
    return [];
  }, []);

  // Load coordinates for destination stations
  useEffect(() => {
    if (!destinationStationNames.length) {
      setDestinationStations([]);
      return;
    }

    // Reset cancelled flag for new effect run
    isCancelledRef.current = false;

    const loadStationCoordinates = async () => {
      // Check if effect was cancelled (dependency changed)
      if (isCancelledRef.current) return;
      const stationsWithCoords = [];

      // First pass: try to find coordinates from known sources
      // Also check if station is already in destinationStations to avoid duplicate work
      const existingStationNames = new Set(
        destinationStations.map((s) => s.name),
      );

      for (const stationName of destinationStationNames) {
        // Skip if already processed
        if (existingStationNames.has(stationName)) {
          continue;
        }

        // Try night train database
        const normalizedName = normalizeStationNameForLookup(stationName);
        const stop = stops?.find(
          (s) =>
            normalizeStationNameForLookup(s.stop_id) === normalizedName ||
            normalizeStationNameForLookup(s.stop_name) === normalizedName,
        );

        if (stop && stop.stop_lat && stop.stop_lon) {
          stationsWithCoords.push({
            name: stationName,
            lat: stop.stop_lat,
            lon: stop.stop_lon,
            id: stop.stop_id,
            source: "night-train-db",
          });
          continue;
        }

        // If not found in night train database, skip (no geocoding)
      }

      // Update stations found immediately
      setDestinationStations(stationsWithCoords);
    };

    loadStationCoordinates();

    // Cleanup function to cancel in-flight requests if dependencies change
    return () => {
      isCancelledRef.current = true;
    };
    // Note: normalizeStationNameForLookup is a stable function from useCities hook,
    // so it doesn't need to be in dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationStationNames, stops]);

  // Train departure paths removed - train departures functionality removed
  const trainDeparturePaths = useMemo(() => {
    return [];
  }, []);

  // Build route paths (polylines) for selected station or all stations when showRoutes is enabled
  // This visualizes train routes as lines connecting stations
  // PERFORMANCE OPTIMIZATIONS:
  // - Uses Map for O(1) route lookup instead of O(n) find
  // - Uses Map for O(1) station coordinate lookup instead of O(n) find
  // - Caches normalized station names to avoid repeated calculations
  // - Pre-computes pathOptions to avoid recalculation on each render
  const routePaths = useMemo(() => {
    // Always show routes when a station is selected (even if showRoutes is off)
    // If showRoutes is enabled and no station is selected, show all routes
    let routesToShow = [];

    if (!viewMapData || !stops || !stops.length) {
      return [];
    }

    // Create a Set of normalized skip station names for fast lookup
    // This is used to filter out skipped stations from route paths
    const skipStationNames = new Set();
    stationsToSkip.forEach((stationName) => {
      skipStationNames.add(stationName);
      skipStationNames.add(normalizeStationNameForLookup(stationName));
    });

    // Helper function to check if a station should be skipped
    const isStationSkipped = (stationName) => {
      if (!stationName) return false;
      const normalizedName = normalizeStationNameForLookup(stationName);
      return (
        skipStationNames.has(stationName) ||
        skipStationNames.has(normalizedName)
      );
    };

    // If a station is selected, show routes for that station (regardless of showRoutes setting)
    if (selected && stopRouteIds && stopRouteIds.length > 0) {
      // Filter out routes with future "From <Date>" notes
      routesToShow = stopRouteIds.filter(
        (routeId) => !shouldHideRouteDueToFutureDate(routeId)
      );
    }
    // If showRoutes is enabled but no station is selected, show all routes
    else if (showRoutes && !selected) {
      // Show all routes from all stations
      const allRouteIds = new Set();

      // Get route IDs from cities (stations) data
      Object.values(cities).forEach((city) => {
        if (city?.stop_route_ids) {
          city.stop_route_ids.split(",").forEach((id) => {
            const routeId = id.trim();
            if (routeId) allRouteIds.add(routeId);
          });
        }
      });

      // Also get all routes from viewMapData
      if (viewMapData) {
        Object.values(viewMapData).forEach((route) => {
          if (route?.route_id) {
            allRouteIds.add(route.route_id.toString());
          }
        });
      }

      // Filter out routes with future "From <Date>" notes (from both cities and viewMapData)
      routesToShow = Array.from(allRouteIds).filter(
        (routeId) => !shouldHideRouteDueToFutureDate(routeId)
      );
    } else {
      // No station selected and showRoutes is off - don't show routes
      return [];
    }

    if (routesToShow.length === 0) {
      return [];
    }

    // PERFORMANCE OPTIMIZATION: Create Maps for O(1) lookups
    // Map for fast route lookup by route_id
    const routeMap = new Map();
    Object.values(viewMapData).forEach((route) => {
      if (route?.route_id) {
        routeMap.set(route.route_id.toString(), route);
      }
    });

    // Map for fast station coordinate lookup
    // Key: normalized station name, Value: [lat, lon]
    const stationCoordsMap = new Map();
    const normalizedNameCache = new Map();

    // Helper to get cached normalized name
    const getCachedNormalizedName = (name) => {
      if (!normalizedNameCache.has(name)) {
        normalizedNameCache.set(name, normalizeStationNameForLookup(name));
      }
      return normalizedNameCache.get(name);
    };

    // Build station coordinates map once
    stops.forEach((stop) => {
      if (!stop.stop_id || !stop.stop_lat || !stop.stop_lon) return;

      const normalizedId = getCachedNormalizedName(stop.stop_id);
      // Store by normalized name
      if (!stationCoordsMap.has(normalizedId)) {
        stationCoordsMap.set(normalizedId, [stop.stop_lat, stop.stop_lon]);
      }
      // Also store by original name for fallback
      if (!stationCoordsMap.has(stop.stop_id)) {
        stationCoordsMap.set(stop.stop_id, [stop.stop_lat, stop.stop_lon]);
      }
    });

    // Helper function to find station coordinates by name (O(1) lookup)
    const findStationCoords = (stationName) => {
      if (!stationName) return null;

      // Try normalized name first
      const normalizedName = getCachedNormalizedName(stationName);
      return (
        stationCoordsMap.get(normalizedName) ||
        stationCoordsMap.get(stationName) ||
        null
      );
    };

    const paths = [];
    // Use a key that includes all routes when showing all routes
    const stationKey = selected ? stopId || "none" : "all-routes";

    // Process each route
    routesToShow.forEach((routeId) => {
      // O(1) lookup instead of O(n) find
      const route = routeMap.get(routeId);

      if (!route) return;

      // Helper function to build path for one direction
      // Filters out skipped stations from the route path
      const buildPathForDirection = (origin, destination, viaStations) => {
        // Skip entire route if origin or destination is in skip list
        if (isStationSkipped(origin) || isStationSkipped(destination)) {
          return null;
        }

        const stationSequence = [];

        // Add origin (only if not skipped)
        if (origin && !isStationSkipped(origin)) {
          const originCoords = findStationCoords(origin);
          if (originCoords) {
            stationSequence.push(originCoords);
          }
        }

        // Add via stations (if they exist), filtering out skipped stations
        if (viaStations) {
          const viaList = viaStations.split(" - ").filter((s) => s.trim());
          viaList.forEach((viaStation) => {
            const trimmedVia = viaStation.trim();
            // Only add via station if it's not in the skip list
            if (!isStationSkipped(trimmedVia)) {
              const viaCoords = findStationCoords(trimmedVia);
              if (viaCoords) {
                stationSequence.push(viaCoords);
              }
            }
          });
        }

        // Add destination (only if not skipped)
        if (destination && !isStationSkipped(destination)) {
          const destCoords = findStationCoords(destination);
          if (destCoords) {
            stationSequence.push(destCoords);
          }
        }

        // Return path only if we have at least 2 valid stations (origin and destination)
        return stationSequence.length >= 2 ? stationSequence : null;
      };

      // Get color for this route (consistent across both directions)
      const routeColor = ROUTE_COLORS[parseInt(routeId) % ROUTE_COLORS.length];
      const pathOptions = {
        color: routeColor,
        weight: 4,
        opacity: 0.8,
        dashArray: "15, 10",
        lineCap: "round",
        lineJoin: "round",
      };

      // Build path for direction 0 (origin_trip_0 -> via_0 -> destination_trip_0)
      const path0 = buildPathForDirection(
        route.origin_trip_0,
        route.destination_trip_0,
        route.via_0,
      );
      if (path0) {
        paths.push({
          positions: path0,
          routeId: routeId,
          key: `route-${stationKey}-${routeId}-0`, // Include stationKey to ensure unique keys per station
          pathOptions: pathOptions,
        });
      }

      // Build path for direction 1 (origin_trip_1 -> via_1 -> destination_trip_1) if exists
      if (route.origin_trip_1 && route.destination_trip_1) {
        const path1 = buildPathForDirection(
          route.origin_trip_1,
          route.destination_trip_1,
          route.via_1,
        );
        if (path1) {
          paths.push({
            positions: path1,
            routeId: routeId,
            key: `route-${stationKey}-${routeId}-1`, // Include stationKey to ensure unique keys per station
            pathOptions: pathOptions, // Same color for reverse direction
          });
        }
      }
    });

    return paths;
  }, [
    selected,
    stopId, // Add stopId to dependencies to ensure recalculation when station changes
    stopRouteIds,
    viewMapData,
    stops,
    stationsToSkip, // Recalculate when skip list changes
    normalizeStationNameForLookup, // Recalculate when normalization function changes
    showRoutes,
    cities,
    shouldHideRouteDueToFutureDate, // Recalculate when filtering function changes
    trips, // Recalculate when trips data changes (for "From <Date>" filtering)
  ]);

  // Trains per destination removed - train departures functionality removed
  const trainsPerDestination = useMemo(() => {
    return new Map();
  }, []);

  // Destination station markers are disabled - only showing route lines
  const destinationMarkers = useMemo(() => {
    // Return empty array - destination stations are not displayed
    return [];
  }, []);

  return (
    <>
      {(isLoading || overallLoading || !nightTrainsReady) && (
        <div
          style={{
            position: "absolute",
            zIndex: 1001,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            backgroundColor: "rgba(255,255,255,0.95)",
            padding: "30px 40px",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            textAlign: "center",
            minWidth: "300px",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          <div style={{ marginBottom: "20px" }}>
            <div style={{ fontSize: "48px", marginBottom: "10px" }}>🚂</div>
            <h3
              style={{ margin: "0 0 10px 0", color: "#333", fontSize: "18px" }}
            >
              Loading European Trains
            </h3>
            <p
              style={{ margin: "0 0 20px 0", color: "#666", fontSize: "14px" }}
            >
              Discovering stations and routes across Europe...
            </p>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <div
              style={{
                width: "100%",
                height: "8px",
                backgroundColor: "#e0e0e0",
                borderRadius: "4px",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: `${Math.min(loadingProgress, 100)}%`,
                  height: "100%",
                  backgroundColor: "#4CAF50",
                  borderRadius: "4px",
                  transition: "width 0.3s ease",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background:
                      "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
                    animation: "shimmer 1.5s infinite",
                  }}
                />
              </div>
            </div>
            <div
              style={{
                marginTop: "12px",
                fontSize: "14px",
                color: "#333",
                fontWeight: "500",
              }}
            >
              {Math.round(loadingProgress)}% Complete
            </div>
            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                color: "#888",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  {stopsLoading ? "Loading stations..." : "✓ Stations loaded"}
                </span>
                <span>
                  {citiesLoading
                    ? "Processing routes..."
                    : "✓ Routes processed"}
                </span>
              </div>
              {/* NightJet loading progress */}
              {njLoadingProgress.progress > 0 && (
                <div
                  style={{
                    marginTop: "8px",
                    padding: "8px",
                    backgroundColor: "#f0f9ff",
                    borderRadius: "4px",
                    border: "1px solid #bae6fd",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: "600",
                      color: "#0369a1",
                      marginBottom: "4px",
                    }}
                  >
                    NightJet Stations
                  </div>
                  <div style={{ fontSize: "11px", color: "#075985" }}>
                    {njLoadingProgress.message ||
                      `Progress: ${njLoadingProgress.progress}%`}
                  </div>
                  {njLoadingProgress.step === "discovering" &&
                    njLoadingProgress.trainsFound !== undefined && (
                      <div
                        style={{
                          fontSize: "10px",
                          color: "#64748b",
                          marginTop: "2px",
                        }}
                      >
                        Found {njLoadingProgress.trainsFound} trains
                      </div>
                    )}
                  {njLoadingProgress.step === "fetching" &&
                    njLoadingProgress.stationsFound !== undefined && (
                      <div
                        style={{
                          fontSize: "10px",
                          color: "#64748b",
                          marginTop: "2px",
                        }}
                      >
                        {njLoadingProgress.stationsFound} stations discovered
                      </div>
                    )}
                </div>
              )}
            </div>
          </div>

          <div style={{ fontSize: "12px", color: "#999" }}>
            {loadingMessage}
          </div>
        </div>
      )}

      {/* Skeleton loading for map */}
      {!isMapInitialized && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#f0f0f0",
            backgroundImage: `
              linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%),
              linear-gradient(45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%),
              linear-gradient(-45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%)
            `,
            backgroundSize: "200% 100%, 20px 20px, 20px 20px",
            backgroundPosition: "-200% 0, 0 0, 0 0",
            animation: "shimmer 2s infinite",
            zIndex: 1,
          }}
        />
      )}

      <MapContainer
        className={mapClassName}
        ref={mapRef}
        zoomControl={false}
        preferCanvas={true}
        {...rest}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <MapClickHandler />
        <Filter
          selected={selected}
          filterName={selectedStationName || stopId}
          onClose={removeFilter}
        />
        <ZoomControl className="outline-none" />
        <LocationControl />

        {/* All Nightjet stations - show filtered ones when filter is active, or all when no filter */}
        {(() => {
          let stationsToRender = selected
            ? filteredNjStations
            : allNjStations;
          
          // Filter out intermediate stations if hideIntermediateStations is enabled
          if (hideIntermediateStations) {
            stationsToRender = stationsToRender.filter((s) => {
              if (!s?.name && !s?.id) return false;
              // Check if station is an endpoint (first or last in any route)
              return (
                nightTrainEndpointStations.has(s.name) ||
                (s.id && nightTrainEndpointStations.has(s.id))
              );
            });
          }
          
          console.log(
            "[DEBUG RENDER] Nightjet stations to render:",
            stationsToRender.length,
            "selected:",
            selected,
            "hideIntermediate:",
            hideIntermediateStations,
          );
          return stationsToRender.map((s, idx) => {
            const lat = s?.location?.latitude;
            const lon = s?.location?.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              console.log(
                "[DEBUG] Invalid coords for station:",
                s.name,
                lat,
                lon,
              );
              return null;
            }
            console.log(
              "[DEBUG] Rendering station marker:",
              s.name,
              "at",
              lat,
              lon,
            );

            // Use cyan/teal gradient for Nightjet stations
            const icon = new Leaflet.DivIcon({
              className: "nj-station-marker",
              html: '<div style="width: 16px; height: 16px; background: linear-gradient(135deg, #0ea5e9, #14b8a6); border-radius: 50%; border: 2.5px solid white; box-shadow: 0 2px 6px rgba(14, 165, 233, 0.5), 0 0 0 1px rgba(14, 165, 233, 0.3); transition: all 0.3s ease; cursor: pointer; z-index: 500;"></div>',
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            });

            return (
              <Marker
                key={`nj-all-station-${idx}-${s.id || s.name}`}
                position={[lat, lon]}
                icon={icon}
                eventHandlers={{
                  click: (e) => {
                    e.originalEvent?.stopPropagation();
                    console.log(
                      "[DEBUG NJ marker] Clicked station:",
                      s.name,
                      "at",
                      lat,
                      lon,
                    );
                    // Find matching station in stops to trigger selection
                    const matchingStop = stops?.find(
                      (stop) =>
                        matchStationNames(s.name, stop.stop_id) ||
                        matchStationNames(s.name, stop.stop_name),
                    );
                    console.log(
                      "[DEBUG NJ marker] Matched stop:",
                      matchingStop?.stop_id,
                      matchingStop?.stop_name,
                    );

                    // Create a filteredStop object with Nightjet station name
                    // Use the original Nightjet station name for display, not the matched stop_id
                    const filteredStop = {
                      ...(matchingStop || {}),
                      stop_id: s.name, // Use Nightjet station name instead of matched stop_id
                      stop_name: s.name,
                      stop_lat: lat,
                      stop_lon: lon,
                      isGrouped: false,
                    };
                    handleMarkerClick(filteredStop);
                  },
                }}
              >
                <Tooltip
                  direction="top"
                  offset={[0, -10]}
                  opacity={1}
                  permanent={false}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    {s.departure && (
                      <div>
                        Dep:{" "}
                        {new Date(s.departure).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                    {s.arrival && (
                      <div>
                        Arr:{" "}
                        {new Date(s.arrival).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                </Tooltip>
              </Marker>
            );
          });
        })()}

        {/* Nightjet overlays: draw polylines and station markers for each included direction */}
        {njOverlays.map((ov) => (
          <Polyline
            key={`nj-route-${ov.key}`}
            positions={ov.coords}
            pathOptions={{ color: ov.color, weight: 6, opacity: 0.9 }}
          >
            <Tooltip sticky>{ov.lineName}</Tooltip>
          </Polyline>
        ))}

        {njOverlays.flatMap((ov, idxOv) =>
          (ov.stations || [])
            .map((s, idx) => {
              // If hideIntermediateStations is enabled, skip intermediate stations
              if (hideIntermediateStations) {
                const isEnd = idx === 0 || idx === ov.stations.length - 1;
                if (!isEnd) return null;
              }
              
              const lat = s?.location?.latitude;
              const lon = s?.location?.longitude;
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
              const isEnd = idx === 0 || idx === ov.stations.length - 1;

            // Use regular station marker styles (gradient dots)
            const icon = new Leaflet.DivIcon({
              className: "nightjet-station-dot",
              html: isEnd
                ? '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>'
                : '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
              iconSize: isEnd ? [20, 20] : [14, 14],
              iconAnchor: isEnd ? [10, 10] : [7, 7],
            });

            return (
              <Marker
                key={`nj-station-${idxOv}-${idx}-${s.id || s.name}`}
                position={[lat, lon]}
                icon={icon}
                eventHandlers={{
                  click: (e) => {
                    // Find matching station in stops to trigger selection
                    const matchingStop = stops?.find(
                      (stop) =>
                        matchStationNames(s.name, stop.stop_id) ||
                        matchStationNames(s.name, stop.stop_name),
                    );
                    if (matchingStop) {
                      handleMarkerClick(matchingStop);
                    }
                  },
                }}
              >
                <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    {s.departure && (
                      <div>
                        Dep:{" "}
                        {new Date(s.departure).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                    {s.arrival && (
                      <div>
                        Arr:{" "}
                        {new Date(s.arrival).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                </Tooltip>
              </Marker>
            );
          }),
        )}

        {/* All EuroNight stations - show filtered ones when filter is active, or all when no filter */}
        {(() => {
          let stationsToRender = selected ? filteredEnStations : allEnStations;
          
          // Filter out intermediate stations if hideIntermediateStations is enabled
          if (hideIntermediateStations) {
            stationsToRender = stationsToRender.filter((s) => {
              if (!s?.name && !s?.id) return false;
              // Check if station is an endpoint (first or last in any route)
              return (
                nightTrainEndpointStations.has(s.name) ||
                (s.id && nightTrainEndpointStations.has(s.id))
              );
            });
          }
          
          return stationsToRender;
        })().map((s, idx) => {
          const lat = s?.location?.latitude;
          const lon = s?.location?.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

          // Use purple/magenta gradient for EuroNight stations
          const icon = new Leaflet.DivIcon({
            className: "en-station-marker",
            html: '<div style="width: 16px; height: 16px; background: linear-gradient(135deg, #a855f7, #c026d3); border-radius: 50%; border: 2.5px solid white; box-shadow: 0 2px 6px rgba(168, 85, 247, 0.5), 0 0 0 1px rgba(168, 85, 247, 0.3); transition: all 0.3s ease; cursor: pointer; z-index: 500;"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          });

          return (
            <Marker
              key={`en-all-station-${idx}-${s.id || s.name}`}
              position={[lat, lon]}
              icon={icon}
              eventHandlers={{
                click: (e) => {
                  e.originalEvent?.stopPropagation();
                  const matchingStop = stops?.find(
                    (stop) =>
                      matchStationNames(s.name, stop.stop_id) ||
                      matchStationNames(s.name, stop.stop_name),
                  );

                  // Create a filteredStop object with EuroNight station name
                  // Use the original EuroNight station name for display, not the matched stop_id
                  const filteredStop = {
                    ...(matchingStop || {}),
                    stop_id: s.name, // Use EuroNight station name instead of matched stop_id
                    stop_name: s.name,
                    stop_lat: lat,
                    stop_lon: lon,
                    isGrouped: false,
                  };
                  handleMarkerClick(filteredStop);
                },
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -10]}
                opacity={1}
                permanent={false}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  {s.departure && (
                    <div>
                      Dep:{" "}
                      {new Date(s.departure).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  )}
                  {s.arrival && (
                    <div>
                      Arr:{" "}
                      {new Date(s.arrival).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  )}
                </div>
              </Tooltip>
            </Marker>
          );
        })}

        {/* EuroNight overlays: draw polylines and station markers */}
        {enOverlays.map((ov) => (
          <Polyline
            key={`en-route-${ov.key}`}
            positions={ov.coords}
            pathOptions={{ color: ov.color, weight: 6, opacity: 0.9 }}
          >
            <Tooltip sticky>{ov.lineName}</Tooltip>
          </Polyline>
        ))}

        {enOverlays.flatMap((ov, idxOv) =>
          (ov.stations || [])
            .map((s, idx) => {
              // If hideIntermediateStations is enabled, skip intermediate stations
              if (hideIntermediateStations) {
                const isEnd = idx === 0 || idx === ov.stations.length - 1;
                if (!isEnd) return null;
              }
              
              const lat = s?.location?.latitude;
              const lon = s?.location?.longitude;
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
              const isEnd = idx === 0 || idx === ov.stations.length - 1;

            const icon = new Leaflet.DivIcon({
              className: "euronight-station-dot",
              html: isEnd
                ? '<div style="width: 20px; height: 20px; background: linear-gradient(135deg, #2196F3, #1976D2); border-radius: 50%; border: 3px solid white; box-shadow: 0 3px 8px rgba(33, 150, 243, 0.4), 0 0 0 1px rgba(33, 150, 243, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 1000;"></div>'
                : '<div style="width: 14px; height: 14px; background: linear-gradient(135deg, #4CAF50, #388E3C); border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4), 0 0 0 1px rgba(76, 175, 80, 0.2); transition: all 0.3s ease; cursor: pointer; z-index: 100;"></div>',
              iconSize: isEnd ? [20, 20] : [14, 14],
              iconAnchor: isEnd ? [10, 10] : [7, 7],
            });

            return (
              <Marker
                key={`en-station-${idxOv}-${idx}-${s.id || s.name}`}
                position={[lat, lon]}
                icon={icon}
                eventHandlers={{
                  click: (e) => {
                    const matchingStop = stops?.find(
                      (stop) =>
                        matchStationNames(s.name, stop.stop_id) ||
                        matchStationNames(s.name, stop.stop_name),
                    );
                    if (matchingStop) {
                      handleMarkerClick(matchingStop);
                    }
                  },
                }}
              >
                <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    {s.departure && (
                      <div>
                        Dep:{" "}
                        {new Date(s.departure).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                    {s.arrival && (
                      <div>
                        Arr:{" "}
                        {new Date(s.arrival).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                </Tooltip>
              </Marker>
            );
          }),
        )}

        {routePaths.length > 0 &&
          routePaths.map((path) => (
            <Polyline
              key={path.key}
              positions={path.positions}
              pathOptions={{
                ...path.pathOptions,
                cursor: "pointer",
              }}
              eventHandlers={{
                click: (e) => {
                  e.originalEvent.stopPropagation();
                  handlePolylineClick(path.routeId);
                },
              }}
            />
          ))}
        {markers}
        {/* Destination station markers - stations we can reach */}
        {destinationMarkers}
        {children && children({ MapContainer, Marker, TileLayer }, Leaflet)}
      </MapContainer>

      <div ref={sidebarRef}>
        <TrainSidebar
          isOpen={selected}
          sidebarDisabled={sidebarDisabled}
          setSidebarDisabled={setSidebarDisabled}
          stopId={stopId}
          stopRouteIds={stopRouteIds}
          selectedNormalizedName={selectedNormalizedName}
        />
      </div>

      {/* Train Detail Panel - shows when clicking on route lines */}
      <TrainDetailPanel
        isOpen={isTrainDetailPanelOpen}
        onClose={closeTrainDetailPanel}
        selectedRouteIds={
          selectedTrainRouteIds?.filter(
            (id) => !shouldHideRouteDueToFutureDate(id)
          ) ?? []
        }
      />
    </>
  );
};

export default TrainMap;
