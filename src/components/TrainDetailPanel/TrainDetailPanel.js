"use client";

import React, { useMemo, useEffect, useState } from "react";
import Link from "next/link";
import { FiChevronDown, FiExternalLink } from "react-icons/fi";
import { useAgencies } from "../../hooks/requests/useAgencies";
import { useRoutes } from "../../hooks/requests/useRoutes";
import { useTrips } from "../../hooks/requests/useTrips";
import { getRouteFrequencyOverride } from "../../lib/routeFrequencyOverrides";
import { buildTrainSlug } from "../../lib/seo/slugify";
import {
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
} from "../Map/utils/routeStyleUtils";
import {
  getOperatorBaseColor,
  hexWithAlpha,
} from "../Map/utils/operatorColors";
import { abbreviateStationName } from "../Map/utils/stationNameUtils";
import {
  getOperatorPricing,
  formatPricingLabel,
  getPricingBadgeStyle,
} from "../../lib/operatorPricing";
import BookingActions from "./BookingActions";
import SuggestEditModal from "../SuggestEdit/SuggestEditModal";
import {
  buildMajorViaContext,
  selectMajorViaStations,
} from "../../lib/viaDisplay.mjs";

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

function isChinaRailwayTrainNumber(value) {
  return /^\s*(Z|K)\s+\d+/i.test((value || "").toString());
}

function isItalianICNTrainNumber(value) {
  return /^\s*ICN\s+\d+/i.test((value || "").toString());
}

function isCaucasusTrainNumber(value) {
  return /^\s*(GR|ADY|SCR)\s+\d+/i.test((value || "").toString());
}

// North American synthetic routes (Amtrak / VIA Rail) are keyed by their
// route-id prefix rather than a train-number pattern — the label is the service
// name (e.g. "California Zephyr"), not a number.
function isNorthAmericaRoute(routeId) {
  const id = String(routeId || "");
  return id.startsWith("amtrak_") || id.startsWith("via_");
}

function normalizeStationToken(value) {
  return (
    (value || "")
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
      .trim()
  );
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
  selectedStation,
}) => {
  const { agencies } = useAgencies();
  const { routes: fetchedRoutes, isLoading: routesLoading } = useRoutes();
  const { trips: fetchedTrips, isLoading: tripsLoading } = useTrips();
  const trips = tripsData || fetchedTrips;
  const [gtfsTimetableData, setGtfsTimetableData] = useState(null);
  const [gtfsLoadFailed, setGtfsLoadFailed] = useState(false);
  const [gtfsLoading, setGtfsLoading] = useState(false);
  const [nightjetData, setNightjetData] = useState(null);
  const [nightjetLoadFailed, setNightjetLoadFailed] = useState(false);
  const [nightjetLoading, setNightjetLoading] = useState(false);
  const [cdTimetableData, setCdTimetableData] = useState(null);
  const [cdLoadFailed, setCdLoadFailed] = useState(false);
  const [cdLoading, setCdLoading] = useState(false);
  const [chineseTrainData, setChineseTrainData] = useState(null);
  const [chineseLoadFailed, setChineseLoadFailed] = useState(false);
  const [chineseLoading, setChineseLoading] = useState(false);
  const [italianTrainData, setItalianTrainData] = useState(null);
  const [italianLoadFailed, setItalianLoadFailed] = useState(false);
  const [italianLoading, setItalianLoading] = useState(false);
  const [caucasusTrainData, setCaucasusTrainData] = useState(null);
  const [caucasusLoadFailed, setCaucasusLoadFailed] = useState(false);
  const [caucasusLoading, setCaucasusLoading] = useState(false);
  const [curatedTrainData, setCuratedTrainData] = useState(null);
  const [curatedLoadFailed, setCuratedLoadFailed] = useState(false);
  const [curatedLoading, setCuratedLoading] = useState(false);
  const [naTrainData, setNaTrainData] = useState(null);
  const [naLoadFailed, setNaLoadFailed] = useState(false);
  const [naLoading, setNaLoading] = useState(false);
  const [suggestContext, setSuggestContext] = useState(null);

  // IMPORTANT: `useRoutes()` fetches `/api/trains?type=view_ontd_map` which filters out NJ/EN.
  // For NJ/EN fallback we must use unfiltered `viewMapData` from `/api/initial-data` when provided.
  const routes = viewMapData || fetchedRoutes;

  // Hub/main-station context for the compact via summary (full via stays on the row).
  const majorViaContext = useMemo(
    () => buildMajorViaContext(routes),
    [routes],
  );

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
          agency_id: route.agency_id || "ÖBB",
          trip_short_name: shortName,
          trip_origin: origin,
          trip_headsign: dest,
          via: via || "",
          // Service string carried from the route row (synthetic sources with
          // withService:true, e.g. Amtrak/VIA/curated) so Frequency can render.
          service_id: route[`service_id_${suffix}`] || null,
          // Times will be filled from the official operator timetable when available.
          origin_departure_time: null,
          destination_arrival_time: null,
        });
      };

      pushDirection("0");
      pushDirection("1");
    });

    // Only keep trains we can recognize as NJ/EN, CR, Italian ICN, Caucasus,
    // North American (Amtrak/VIA), or admin-curated routes; otherwise fall back
    // to empty-state.
    return next.filter(
      (t) =>
        isNightJetOrEuroNightTrainNumber(t.trip_short_name) ||
        isChinaRailwayTrainNumber(t.trip_short_name) ||
        isItalianICNTrainNumber(t.trip_short_name) ||
        isCaucasusTrainNumber(t.trip_short_name) ||
        isNorthAmericaRoute(t.route_id) ||
        String(t.route_id || "").startsWith("curated_"),
    );
  }, [selectedRouteIds, routes, relevantTrips.length]);

  const tripsToRender =
    relevantTrips.length > 0 ? relevantTrips : fallbackTrips;

  // When a station is selected, show the direction with the bigger onward
  // journey from that station first. A route has two directions; the more
  // useful one to the traveller is usually the one with more of the trip still
  // ahead of the selected station (i.e. they board here and ride onward).
  const orderedTrips = useMemo(() => {
    if (!selectedStation || tripsToRender.length < 2) return tripsToRender;

    // Stations remaining toward the destination after the selected station.
    const onwardCount = (trip) => {
      const sequence = [
        trip.trip_origin,
        ...String(trip.via || "").split(" - "),
        trip.trip_headsign,
      ]
        .map((s) => (s || "").trim())
        .filter(Boolean);
      const idx = sequence.findIndex((s) =>
        matchesEndpoint(s, selectedStation),
      );
      if (idx < 0) return -1; // selected station not on this direction → keep last
      return sequence.length - 1 - idx;
    };

    // Stable sort (preserve original order on ties): bigger onward part first.
    return tripsToRender
      .map((trip, i) => ({ trip, i, n: onwardCount(trip) }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((x) => x.trip);
  }, [tripsToRender, selectedStation]);

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
      setGtfsLoading(false);
      return;
    }

    let active = true;
    const loadGtfsTimetable = async () => {
      setGtfsLoading(true);
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
          setGtfsTimetableData(null);
          setGtfsLoadFailed(true);
        }
      } finally {
        if (active) setGtfsLoading(false);
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
      setCdLoading(false);
      return;
    }

    let active = true;
    const loadCDTimetable = async () => {
      setCdLoading(true);
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
      } finally {
        if (active) setCdLoading(false);
      }
    };

    loadCDTimetable();
    return () => {
      active = false;
    };
  }, [isOpen, relevantTrips]);

  const hasNJFallback = fallbackTrips.some((t) =>
    isNightJetOrEuroNightTrainNumber(t.trip_short_name),
  );
  const hasCRFallback = fallbackTrips.some((t) =>
    isChinaRailwayTrainNumber(t.trip_short_name),
  );
  const hasFSFallback = fallbackTrips.some((t) =>
    isItalianICNTrainNumber(t.trip_short_name),
  );
  const hasCaucasusFallback = fallbackTrips.some((t) =>
    isCaucasusTrainNumber(t.trip_short_name),
  );
  const hasCuratedFallback = fallbackTrips.some((t) =>
    String(t.route_id || "").startsWith("curated_"),
  );
  const hasNAFallback = fallbackTrips.some((t) =>
    isNorthAmericaRoute(t.route_id),
  );

  useEffect(() => {
    if (!isOpen || !hasNJFallback) {
      setNightjetData(null);
      setNightjetLoadFailed(false);
      setNightjetLoading(false);
      return;
    }

    let active = true;
    const loadNightjet = async () => {
      setNightjetLoading(true);
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
      } finally {
        if (active) setNightjetLoading(false);
      }
    };

    loadNightjet();
    return () => {
      active = false;
    };
  }, [isOpen, hasNJFallback]);

  useEffect(() => {
    if (!isOpen || !hasCRFallback) {
      setChineseTrainData(null);
      setChineseLoadFailed(false);
      setChineseLoading(false);
      return;
    }

    let active = true;
    const loadChineseTrains = async () => {
      setChineseLoading(true);
      try {
        setChineseLoadFailed(false);
        const response = await fetch("/api/chinese-trains");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setChineseTrainData(data);
      } catch {
        if (active) {
          setChineseTrainData(null);
          setChineseLoadFailed(true);
        }
      } finally {
        if (active) setChineseLoading(false);
      }
    };

    loadChineseTrains();
    return () => {
      active = false;
    };
  }, [isOpen, hasCRFallback]);

  useEffect(() => {
    if (!isOpen || !hasFSFallback) {
      setItalianTrainData(null);
      setItalianLoadFailed(false);
      setItalianLoading(false);
      return;
    }

    let active = true;
    const loadItalianTrains = async () => {
      setItalianLoading(true);
      try {
        setItalianLoadFailed(false);
        const response = await fetch("/api/italian-trains");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setItalianTrainData(data);
      } catch {
        if (active) {
          setItalianTrainData(null);
          setItalianLoadFailed(true);
        }
      } finally {
        if (active) setItalianLoading(false);
      }
    };

    loadItalianTrains();
    return () => {
      active = false;
    };
  }, [isOpen, hasFSFallback]);

  useEffect(() => {
    if (!isOpen || !hasCaucasusFallback) {
      setCaucasusTrainData(null);
      setCaucasusLoadFailed(false);
      setCaucasusLoading(false);
      return;
    }

    let active = true;
    const loadCaucasusTrains = async () => {
      setCaucasusLoading(true);
      try {
        setCaucasusLoadFailed(false);
        const response = await fetch("/api/caucasus-trains");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setCaucasusTrainData(data);
      } catch {
        if (active) {
          setCaucasusTrainData(null);
          setCaucasusLoadFailed(true);
        }
      } finally {
        if (active) setCaucasusLoading(false);
      }
    };

    loadCaucasusTrains();
    return () => {
      active = false;
    };
  }, [isOpen, hasCaucasusFallback]);

  useEffect(() => {
    if (!isOpen || !hasCuratedFallback) {
      setCuratedTrainData(null);
      setCuratedLoadFailed(false);
      setCuratedLoading(false);
      return;
    }

    let active = true;
    const loadCuratedTrains = async () => {
      setCuratedLoading(true);
      try {
        setCuratedLoadFailed(false);
        const response = await fetch("/api/operator-trains?source=curated");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setCuratedTrainData(data);
      } catch {
        if (active) {
          setCuratedTrainData(null);
          setCuratedLoadFailed(true);
        }
      } finally {
        if (active) setCuratedLoading(false);
      }
    };

    loadCuratedTrains();
    return () => {
      active = false;
    };
  }, [isOpen, hasCuratedFallback]);

  // North America (Amtrak + VIA Rail): both are separate registry sources, so
  // fetch each generic per-source trains file and merge (route names are unique
  // across the two). Station times arrive as plain "HH:MM" strings.
  useEffect(() => {
    if (!isOpen || !hasNAFallback) {
      setNaTrainData(null);
      setNaLoadFailed(false);
      setNaLoading(false);
      return;
    }

    let active = true;
    const loadNATrains = async () => {
      setNaLoading(true);
      try {
        setNaLoadFailed(false);
        const fetchSource = (source) =>
          fetch(`/api/operator-trains?source=${source}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
        const [amtrak, viarail] = await Promise.all([
          fetchSource("amtrak"),
          fetchSource("viarail"),
        ]);
        if (!active) return;
        if (!amtrak && !viarail) {
          setNaTrainData(null);
          setNaLoadFailed(true);
        } else {
          setNaTrainData({
            trains: { ...(amtrak?.trains || {}), ...(viarail?.trains || {}) },
          });
        }
      } catch {
        if (active) {
          setNaTrainData(null);
          setNaLoadFailed(true);
        }
      } finally {
        if (active) setNaLoading(false);
      }
    };

    loadNATrains();
    return () => {
      active = false;
    };
  }, [isOpen, hasNAFallback]);

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

  const crScheduleByTrainNumber = useMemo(() => {
    if (!chineseTrainData?.trains) return new Map();
    const next = new Map();
    Object.entries(chineseTrainData.trains).forEach(([key, train]) => {
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length === 0) return;
      next.set(normalizeTrainNumber(key), {
        tripId: key,
        stops: stations.map((s, i) => ({
          stopId: s.name || String(i),
          sequence: i + 1,
          name: s.name || "Station",
          arrival: null,
          departure: null,
        })),
        validFrom: null,
        validUntil: null,
        source: "cr",
      });
    });
    return next;
  }, [chineseTrainData]);

  const itScheduleByTrainNumber = useMemo(() => {
    if (!italianTrainData?.trains) return new Map();
    const next = new Map();
    Object.entries(italianTrainData.trains).forEach(([key, train]) => {
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length === 0) return;
      next.set(normalizeTrainNumber(key), {
        tripId: key,
        stops: stations.map((s, i) => ({
          stopId: s.name || String(i),
          sequence: i + 1,
          name: s.name || "Station",
          arrival: s.arrival ? formatTime(s.arrival) : null,
          departure: s.departure ? formatTime(s.departure) : null,
        })),
        validFrom: null,
        validUntil: null,
        source: "it",
      });
    });
    return next;
  }, [italianTrainData]);

  const caucasusScheduleByTrainNumber = useMemo(() => {
    if (!caucasusTrainData?.trains) return new Map();
    const next = new Map();
    Object.entries(caucasusTrainData.trains).forEach(([key, train]) => {
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length === 0) return;
      next.set(normalizeTrainNumber(key), {
        tripId: key,
        stops: stations.map((s, i) => ({
          stopId: s.name || String(i),
          sequence: i + 1,
          name: s.name || "Station",
          arrival: null,
          departure: null,
        })),
        validFrom: null,
        validUntil: null,
        source: "caucasus",
      });
    });
    return next;
  }, [caucasusTrainData]);

  const curatedScheduleByTrainNumber = useMemo(() => {
    if (!curatedTrainData?.trains) return new Map();
    // Curated route times are plain "HH:MM" local strings (ISO tolerated).
    const asTime = (value) =>
      value ? (String(value).includes("T") ? formatTime(value) : value) : null;
    const next = new Map();
    Object.entries(curatedTrainData.trains).forEach(([key, train]) => {
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length === 0) return;
      next.set(normalizeTrainNumber(key), {
        tripId: key,
        stops: stations.map((s, i) => ({
          stopId: s.name || String(i),
          sequence: i + 1,
          name: s.name || "Station",
          arrival: asTime(s.arrival),
          departure: asTime(s.departure),
        })),
        validFrom: null,
        validUntil: null,
        source: "curated",
      });
    });
    return next;
  }, [curatedTrainData]);

  const naScheduleByTrainNumber = useMemo(() => {
    if (!naTrainData?.trains) return new Map();
    // Amtrak/VIA station times are plain "HH:MM" strings (ISO tolerated).
    const asTime = (value) =>
      value ? (String(value).includes("T") ? formatTime(value) : value) : null;
    const next = new Map();
    Object.entries(naTrainData.trains).forEach(([key, train]) => {
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length === 0) return;
      next.set(normalizeTrainNumber(key), {
        tripId: key,
        stops: stations.map((s, i) => ({
          stopId: s.name || String(i),
          sequence: i + 1,
          name: s.name || "Station",
          code: s.code || null,
          arrival: asTime(s.arrival),
          departure: asTime(s.departure),
        })),
        validFrom: null,
        validUntil: null,
        source: "na",
      });
    });
    return next;
  }, [naTrainData]);

  if (!isOpen) {
    return null;
  }

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-[999] md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <div
        className={`fixed z-[1000] bg-white shadow-lg transition-transform duration-300 overflow-y-auto overscroll-y-none bottom-0 left-0 right-0 rounded-t-2xl h-[80vh] md:top-13 md:right-0 md:bottom-auto md:left-auto md:rounded-none md:h-[calc(100vh-3rem)] md:w-[300px] md:translate-y-0 ${
          isOpen
            ? "translate-y-0 md:translate-x-0"
            : "translate-y-full md:translate-x-full"
        }`}
      >
        {/* Mobile drag handle */}
        <div className="md:hidden flex justify-center pt-2 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>
        {/* Header */}
        <div className="sticky bg-white border-b border-gray-200 pl-5 py-1 flex items-center justify-between z-10">
          <h2 className="text-base font-semibold text-gray-900">
            Train Details
          </h2>
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
              {routesLoading ||
              tripsLoading ||
              nightjetLoading ||
              cdLoading ||
              gtfsLoading ||
              chineseLoading ||
              italianLoading ||
              caucasusLoading ||
              curatedLoading ||
              naLoading ? (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block w-3.5 h-3.5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin"
                    aria-hidden
                  />
                  Loading train details...
                </span>
              ) : (
                "No Back on Track trip data for this selection."
              )}
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
              {chineseLoadFailed && hasCRFallback && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  China Railway station list is currently unavailable.
                </div>
              )}
              {italianLoadFailed && hasFSFallback && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  Italian Railways timetable is currently unavailable.
                </div>
              )}
              {caucasusLoadFailed && hasCaucasusFallback && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  Caucasus Railways station list is currently unavailable.
                </div>
              )}
              {curatedLoadFailed && hasCuratedFallback && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  Detailed timetable is currently unavailable.
                </div>
              )}
              {naLoadFailed && hasNAFallback && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  Amtrak / VIA Rail timetable is currently unavailable.
                </div>
              )}

              {orderedTrips.map((trip, index) => {
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

                // PKP (Polish GTFS): per-station timetable + service calendar
                // were merged onto the route in pkpGtfsMerge. Pick the direction
                // whose origin matches this trip's origin.
                const tripRoute = routes?.[trip.route_id?.toString()];
                const viaSummary = selectMajorViaStations(
                  trip.via,
                  majorViaContext,
                );

                // SEO per-train page slug. Built strictly from the route row's
                // endpoints (mirroring routeEndpoints() in src/lib/seo/data.js) so
                // it matches the statically generated /trains/[slug] page exactly.
                // Only routes present in the viewMap have a page, so we link only
                // when a route row exists (no link for orphan/legacy trip rows).
                const trainPageSlug = tripRoute
                  ? buildTrainSlug({
                      origin:
                        tripRoute.origin_trip_0 || tripRoute.origin_trip_1 || "",
                      destination:
                        tripRoute.destination_trip_0 ||
                        tripRoute.destination_trip_1 ||
                        "",
                      trainNumber:
                        tripRoute.trip_short_name_0 ||
                        tripRoute.trip_short_name_1 ||
                        "",
                    })
                  : "";
                const isDir1 =
                  tripRoute &&
                  trip.trip_origin &&
                  (tripRoute.origin_trip_1 || "")
                    .toLowerCase()
                    .includes(
                      (trip.trip_origin || "").toLowerCase().split(" ")[0],
                    );
                const pkpStops = isDir1
                  ? tripRoute?.pkp_schedule_1
                  : tripRoute?.pkp_schedule_0;
                const pkpValid = isDir1
                  ? tripRoute?.pkp_valid_1
                  : tripRoute?.pkp_valid_0;
                const pkpSchedule = pkpStops?.length
                  ? {
                      tripId: `pkp-${trip.route_id}-${isDir1 ? 1 : 0}`,
                      stops: pkpStops.map((s, i) => ({
                        stopId: s.name || String(i),
                        sequence: i + 1,
                        name: s.name,
                        arrival: s.arr || null,
                        departure: s.dep || null,
                      })),
                      validFrom: pkpValid?.validFrom || null,
                      validUntil: pkpValid?.validUntil || null,
                      days: pkpValid?.days || null,
                      source: "pkp",
                    }
                  : null;
                // PKP is the source of truth for Polish trains: its GTFS
                // origin-departure / destination-arrival win over the BoT times.
                const pkpOriginDeparture =
                  pkpSchedule?.stops?.[0]?.departure || null;
                const pkpDestinationArrival =
                  pkpSchedule?.stops?.[pkpSchedule.stops.length - 1]?.arrival ||
                  null;

                const nightjetTrain =
                  nightjetTrainByNumber.get(normalizedTrainNumber) || null;
                const crTrain =
                  chineseTrainData?.trains?.[normalizedTrainNumber] || null;
                const itTrain =
                  italianTrainData?.trains?.[normalizedTrainNumber] || null;
                const caucasusTrain =
                  caucasusTrainData?.trains?.[normalizedTrainNumber] || null;
                const curatedTrain =
                  curatedTrainData?.trains?.[normalizedTrainNumber] || null;
                const naTrain =
                  naTrainData?.trains?.[trip.trip_short_name] ||
                  naTrainData?.trains?.[normalizedTrainNumber] ||
                  null;
                const operatorName =
                  nightjetTrain?.operator ||
                  crTrain?.operator ||
                  caucasusTrain?.operator ||
                  curatedTrain?.operator ||
                  naTrain?.operator ||
                  agency?.agency_name ||
                  "Operator";
                // Synthetic NJ/EN trips use agency_id="ÖBB" for styling, but the actual
                // operator can be different (e.g. partner EuroNight trains).
                // Avoid showing a misleading ÖBB logo when we have a better operator label.
                const shouldShowAgencyLogo =
                  !!agency?.agency_logo_url &&
                  !!agency?.agency_name &&
                  (!nightjetTrain?.operator ||
                    nightjetTrain.operator === agency.agency_name);
                const nightjetStations = Array.isArray(nightjetTrain?.stations)
                  ? nightjetTrain.stations
                  : [];
                const nightjetOriginDeparture =
                  nightjetStations?.[0]?.departure ||
                  nightjetStations?.[0]?.arrival ||
                  null;
                const nightjetDestinationArrival =
                  nightjetStations?.[nightjetStations.length - 1]?.arrival ||
                  nightjetStations?.[nightjetStations.length - 1]?.departure ||
                  null;
                const itStations = Array.isArray(itTrain?.stations)
                  ? itTrain.stations
                  : [];
                const itOriginDeparture =
                  itStations?.[0]?.departure ||
                  itStations?.[0]?.arrival ||
                  null;
                const itDestinationArrival =
                  itStations?.[itStations.length - 1]?.arrival ||
                  itStations?.[itStations.length - 1]?.departure ||
                  null;
                // Amtrak/VIA stations carry "HH:MM" local strings straight from
                // GTFS — used directly, like PKP (not via formatTime).
                const naStations = Array.isArray(naTrain?.stations)
                  ? naTrain.stations
                  : [];
                const naOriginDeparture =
                  naStations?.[0]?.departure || naStations?.[0]?.arrival || null;
                const naDestinationArrival =
                  naStations?.[naStations.length - 1]?.arrival ||
                  naStations?.[naStations.length - 1]?.departure ||
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
                  nightjetScheduleByTrainNumber.get(normalizedTrainNumber) ||
                  null;
                const crSchedule =
                  crScheduleByTrainNumber.get(normalizedTrainNumber) || null;
                const itSchedule =
                  itScheduleByTrainNumber.get(normalizedTrainNumber) || null;
                const caucasusSchedule =
                  caucasusScheduleByTrainNumber.get(normalizedTrainNumber) ||
                  null;
                const curatedSchedule =
                  curatedScheduleByTrainNumber.get(normalizedTrainNumber) ||
                  null;
                const naSchedule =
                  naScheduleByTrainNumber.get(normalizedTrainNumber) || null;
                const schedule =
                  // PKP GTFS is the source of truth for Polish trains.
                  pkpSchedule ||
                  detailedSchedule ||
                  endpointMatchedSchedule ||
                  nightjetSchedule ||
                  crSchedule ||
                  itSchedule ||
                  caucasusSchedule ||
                  curatedSchedule ||
                  naSchedule;
                const validFrom = formatCalendarDate(schedule?.validFrom);
                const validUntil = formatCalendarDate(schedule?.validUntil);

                const busSeg = isDir1
                  ? tripRoute?.pkp_bus_segments_1
                  : tripRoute?.pkp_bus_segments_0;
                const busConnectors = (busSeg || []).filter(
                  (s) =>
                    s?.positions?.length >= 2 ||
                    (Array.isArray(s) && s.length >= 2),
                );

                const pricing = getOperatorPricing(trip);
                const pricingLabel = formatPricingLabel(pricing);
                const pricingBadgeStyle = getPricingBadgeStyle(pricing);

                // Booking origin: prefer the station the user clicked on the map
                // (so the deep link starts from where they are), but only when it
                // isn't the destination. Otherwise use the train's own origin.
                const bookingOrigin =
                  selectedStation && selectedStation !== trip.trip_headsign
                    ? selectedStation
                    : trip.trip_origin;

                return (
                  <div
                    key={`${trip.trip_id}-${index}`}
                    className="rounded-xl space-y-2 bg-white pb-3 border-b border-gray-100 last:border-b-0"
                    style={{
                      borderLeft: `3px solid ${operatorColor}`,
                      paddingLeft: "12px",
                    }}
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
                      {trip.trip_short_name &&
                        (trainPageSlug ? (
                          <Link
                            href={`/trains/${trainPageSlug}`}
                            className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold underline decoration-transparent underline-offset-2 transition hover:decoration-current hover:opacity-90"
                            style={{
                              backgroundColor: hexWithAlpha(operatorColor, 0.12),
                              color: operatorColor,
                            }}
                            title={`View ${trip.trip_short_name} timetable & route`}
                          >
                            {trip.trip_short_name}
                          </Link>
                        ) : (
                          <div
                            className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold"
                            style={{
                              backgroundColor: hexWithAlpha(operatorColor, 0.12),
                              color: operatorColor,
                            }}
                          >
                            {trip.trip_short_name}
                          </div>
                        ))}
                    </div>

                    {/* Pricing */}
                    {pricingLabel && pricingBadgeStyle && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 uppercase">
                          Price
                        </span>
                        <span
                          className="rounded-md px-2 py-0.5 text-xs font-medium"
                          style={{
                            ...pricingBadgeStyle,
                          }}
                        >
                          {pricingLabel}
                        </span>
                      </div>
                    )}

                    {/* Route */}
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 uppercase">
                        Route
                      </div>
                      <div className="text-sm font-medium text-gray-900">
                        {abbreviateStationName(trip.trip_origin)} {"->"}{" "}
                        {abbreviateStationName(trip.trip_headsign)}
                      </div>
                      {viaSummary && (
                        <div className="text-xs text-gray-600">
                          via {abbreviateStationName(viaSummary)}
                        </div>
                      )}
                      {/* Optional informational link about the route (e.g. the
                          operator's destination page). Distinct from the booking
                          CTA below — purely "learn more". */}
                      {tripRoute?.info_url && (
                        <a
                          href={tripRoute.info_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
                        >
                          About this route
                          <FiExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                        </a>
                      )}
                    </div>

                    {/* Bus replacement notice */}
                    {busConnectors.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs text-gray-500 uppercase">
                          Connections
                        </div>
                        {busConnectors.map((seg, i) => {
                          const from = seg?.from;
                          const to = seg?.to;
                          return (
                            <div
                              key={i}
                              className="flex items-start gap-2 text-xs rounded p-2"
                              style={{
                                background: "#fff4ec",
                                border: "1px solid #f5c09a",
                                color: "#a3450c",
                              }}
                            >
                              <span style={{ fontSize: "0.9em" }}>🚌</span>
                              <span>
                                {from && to
                                  ? `Bus replacement: ${from} → ${to}`
                                  : "Bus replacement (shown as orange dashed line on map)"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Main times — hidden when neither endpoint has a time.
                        PKP GTFS times take priority; BoT is the fallback. */}
                    {(pkpOriginDeparture ||
                      pkpDestinationArrival ||
                      naOriginDeparture ||
                      naDestinationArrival ||
                      formatTime(
                        trip.origin_departure_time ||
                          nightjetOriginDeparture ||
                          itOriginDeparture,
                      ) ||
                      formatTime(
                        trip.destination_arrival_time ||
                          nightjetDestinationArrival ||
                          itDestinationArrival,
                      )) && (
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div className="rounded-md bg-gray-50 p-2">
                          <div className="text-xs text-gray-500 uppercase">
                            Departure
                          </div>
                          <div className="font-semibold text-gray-900">
                            {pkpOriginDeparture ||
                              naOriginDeparture ||
                              formatTime(
                                trip.origin_departure_time ||
                                  nightjetOriginDeparture ||
                                  itOriginDeparture,
                              )}
                          </div>
                        </div>
                        <div className="rounded-md bg-gray-50 p-2">
                          <div className="text-xs text-gray-500 uppercase">
                            Arrival
                          </div>
                          <div className="font-semibold text-gray-900">
                            {pkpDestinationArrival ||
                              naDestinationArrival ||
                              formatTime(
                                trip.destination_arrival_time ||
                                  nightjetDestinationArrival ||
                                  itDestinationArrival,
                              )}
                          </div>
                        </div>
                      </div>
                    )}

                    {trip.duration && (
                      <div className="text-xs text-gray-600">
                        Duration: {formatTime(trip.duration)}
                      </div>
                    )}

                    {/* Frequency — PKP GTFS run-days win; BoT/override fallback */}
                    {(pkpSchedule?.days ||
                      trip.service_id ||
                      getRouteFrequencyOverride(trip.route_id)) && (
                      <div className="space-y-1">
                        <div className="text-xs text-gray-500 uppercase">
                          Frequency
                        </div>
                        <div className="text-sm">
                          {(() => {
                            // PKP is the source of truth for Polish trains.
                            if (pkpSchedule?.days) return pkpSchedule.days;
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
                                      <br />
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
                          {(validFrom || validUntil) && (
                            <div className="text-xs text-gray-600">
                              Valid: {validFrom || "?"} - {validUntil || "?"}
                            </div>
                          )}
                          {schedule?.days && (
                            <div className="text-xs text-gray-600">
                              Runs: {schedule.days}
                            </div>
                          )}
                          <div className="rounded bg-white">
                            {schedule.stops.map((stop) => (
                              <div
                                key={`${schedule.tripId}-${stop.sequence}-${stop.stopId}`}
                                className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5 text-xs border-b border-gray-50 last:border-b-0"
                              >
                                <div className="text-gray-800">{stop.name}</div>
                                {(stop.arrival || stop.departure) && (
                                  <div className="text-gray-600 tabular-nums whitespace-nowrap">
                                    {stop.arrival || "--"} /{" "}
                                    {stop.departure || "--"}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </details>
                    )}

                    {/* Accordion: Czech Railways station timetable.
                        Hidden for PKP trains — the Polish GTFS feed already
                        covers the full corridor and takes priority. */}
                    {!pkpSchedule && cdSchedule?.stops?.length > 0 && (
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

                    {/* Booking: deep link with preselected stations + fare */}
                    <BookingActions
                      agencyId={trip.agency_id}
                      agencyUrl={agency?.agency_url}
                      origin={bookingOrigin}
                      dest={trip.trip_headsign}
                      pricing={pricing}
                      routeId={trip.route_id}
                      scheduleStops={schedule?.stops}
                    />

                    {/* Community corrections feed the admin review queue */}
                    <button
                      type="button"
                      onClick={() =>
                        setSuggestContext({
                          routeKey:
                            trip.route_id != null
                              ? String(trip.route_id)
                              : null,
                          trainName: trip.trip_short_name || null,
                          agencyId: trip.agency_id || null,
                        })
                      }
                      className="w-full text-center text-xs text-gray-400 hover:text-gray-700 underline underline-offset-2 pt-1"
                    >
                      Suggest an edit / report wrong data
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {suggestContext && (
        <SuggestEditModal
          context={suggestContext}
          onClose={() => setSuggestContext(null)}
        />
      )}
    </>
  );
};

export default TrainDetailPanel;
