"use client";

import React, { useMemo, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { FiChevronDown, FiExternalLink } from "react-icons/fi";
import { useAgencies } from "../../hooks/requests/useAgencies";
import { useRoutes } from "../../hooks/requests/useRoutes";
import { useTrips } from "../../hooks/requests/useTrips";
import { getRouteFrequencyOverride } from "../../lib/routeFrequencyOverrides";
import { buildPairSlug } from "../../lib/seo/slugify.mjs";
import { viaScheduleForTrip } from "../../lib/viaSchedule.mjs";
import {
  sourceFeedIdForRoute,
  sourceFeedSchedule,
} from "../../lib/sourceFeedSchedule.mjs";
import { cityForStation } from "../../lib/seo/cities.mjs";
import {
  checkRegioJetPrahaChop,
  checkRegioJetPrahaPrzemysl,
} from "../Map/utils/routeStyleUtils";
import {
  getOperatorBaseColor,
  hexWithAlpha,
} from "../Map/utils/operatorColors";
import { abbreviateStationName } from "../Map/utils/stationNameUtils";
import PricingExplainer from "../PricingExplainer";
import {
  getOperatorPricing,
  formatPricingLabel,
  getPricingBadgeStyle,
  pricingAdvice,
  formatCheckedAt,
} from "../../lib/operatorPricing";
import {
  directionFare,
  panelFareRows,
  fareDirectionForTrip,
  formatTravelDate,
  formatTravelDateShort,
  pricingForDirection,
  splitDealFare,
} from "../../lib/fareClasses.mjs";
import {
  formatTrainNumber,
  resolveOperatorComponents,
  resolveScheduleLink,
  splitAgencyIds,
} from "../../lib/operatorAgencies.mjs";
import {
  buildBookingUrl,
  hasLastMinuteDeals,
  buildDealsLandingUrl,
} from "../../lib/operatorBooking";
import { formatPlanDate } from "../../lib/plan/format.mjs";
import {
  esScheduleForTrip,
  isEuropeanSleeperRoute,
  isEuropeanSleeperTrip,
} from "../../lib/europeanSleeper.mjs";
import BookingActions from "./BookingActions";
import BookingGuide from "../BookingGuide";
import { getBookingGuide, guideProps } from "../../lib/bookingGuide.mjs";
import SuggestEditModal from "../SuggestEdit/SuggestEditModal";
import {
  buildMajorViaContext,
  selectMajorViaStations,
} from "../../lib/viaDisplay.mjs";
import { MOBILE_MQ } from "../../hooks/useIsMobile";
import { splitViaString } from "../../lib/viaSplit.mjs";
import {
  orderTripsStationFirst,
  tripDirection,
} from "../../lib/stationFirst.mjs";
import {
  officialRowSchedule,
  durationMinutesBetween,
  formatDurationShort,
} from "../../lib/officialRowSchedule.mjs";

/**
 * How much of the viewport the panel occupies, so the map can frame a selected
 * route into the part it does NOT cover (see FitSelectedRoute in DynamicMap).
 * Keep in sync with the sheet's height classes below — Tailwind needs those as
 * static strings, so they can't be derived from these.
 */
export const MOBILE_SHEET_PEEK_VH = 0.55; // h-[55dvh]
export const DESKTOP_PANEL_WIDTH_PX = 300; // md:w-[300px]

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
  // Z/T/K classic sleepers + D EMU sleepers (动卧) from the chinese allowlist.
  return /^\s*(Z|T|K|D)\s+\d+/i.test((value || "").toString());
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

// A trip one of the per-operator feeds below already knows how to time. Only a
// trip none of them claims reads its row's `timetable_source` instead, so no
// trains file is fetched twice under two names.
function isKnownFeedTrip(t) {
  return (
    isNightJetOrEuroNightTrainNumber(t.trip_short_name) ||
    isChinaRailwayTrainNumber(t.trip_short_name) ||
    isItalianICNTrainNumber(t.trip_short_name) ||
    isCaucasusTrainNumber(t.trip_short_name) ||
    isNorthAmericaRoute(t.route_id) ||
    isEuropeanSleeperRoute(t.route_id) ||
    String(t.route_id || "").startsWith("curated_")
  );
}

/**
 * Journey length between two wall-clock "HH:MM" strings.
 *
 * Sleepers arrive the next morning, so a plain subtraction goes negative; the
 * wrap assumes under 24 hours, which holds for every night train that reaches
 * this helper (the longest European Sleeper run is under 20).
 */
function durationBetween(departure, arrival) {
  const minutes = (value) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = minutes(departure);
  const to = minutes(arrival);
  if (from === null || to === null) return null;
  const span = (to - from + 24 * 60) % (24 * 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(span / 60))}:${pad(span % 60)}`;
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
  firstDirectionByRoute,
}) => {
  const { agencies } = useAgencies();
  // Both of these are fallbacks for rendering this panel without the map's own
  // data, and the map always passes it (see `routes` / `trips` below, which
  // take the prop whenever there is one). Fetching them anyway cost 146 KB
  // gzip of a second copy of the view map and trips on every page load —
  // downloaded, parsed, then discarded by the `||`.
  const { routes: fetchedRoutes, isLoading: routesLoading } = useRoutes({
    enabled: !viewMapData,
  });
  const { trips: fetchedTrips, isLoading: tripsLoading } = useTrips({
    enabled: !tripsData,
  });
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
  const [esTrainData, setEsTrainData] = useState(null);
  const [esLoadFailed, setEsLoadFailed] = useState(false);
  const [esLoading, setEsLoading] = useState(false);
  // Synthetic rows built by any other registry source, keyed by source id.
  const [sourceFeedData, setSourceFeedData] = useState({});
  const [sourceFeedLoadFailed, setSourceFeedLoadFailed] = useState(false);
  const [sourceFeedLoading, setSourceFeedLoading] = useState(false);
  const [suggestContext, setSuggestContext] = useState(null);
  const sheetRef = useRef(null);
  // Tracks a drag on the sheet handle: down collapses/dismisses, up expands.
  const dragRef = useRef({ active: false, startY: 0, pointerId: null });
  // The sheet opens at the collapsed "peek" height so the route stays visible on
  // the map behind it; dragging the handle up gives the full-height reading view.
  const [expanded, setExpanded] = useState(false);

  // Every fresh open (and every route switch) starts back at the peek height.
  useEffect(() => {
    if (isOpen) setExpanded(false);
  }, [isOpen, selectedRouteIds]);

  const onSheetDragStart = (e) => {
    if (!window.matchMedia(MOBILE_MQ).matches) return;
    if ((sheetRef.current?.scrollTop ?? 0) > 0) return;
    dragRef.current = {
      active: true,
      startY: e.clientY,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onSheetDragMove = (e) => {
    if (!dragRef.current.active || !sheetRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    // Only drags downward get live translate feedback; an upward drag just
    // arms the expand, so the sheet must not lift off its anchored bottom.
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
    if (dy > 72) {
      // Collapse first from the expanded state, so a single drag down never
      // throws away a sheet the user deliberately opened up.
      if (expanded) setExpanded(false);
      else onClose?.();
    } else if (dy < -48) {
      setExpanded(true);
    }
  };

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
          // The row direction this card describes. Without it every card
          // read as direction 0, so ICN 797's "Official timetable" link was
          // built with 796's origin station (Salerno for a train leaving Torino).
          direction_id: Number(suffix),
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

    // Keep trains we can recognize as NJ/EN, CR, Italian ICN, Caucasus,
    // North American (Amtrak/VIA), European Sleeper, or admin-curated routes —
    // and any other synthetic row, whose timetable comes from the registry
    // source that built it (`source_feed`, see sourceFeedSchedule.mjs). Only a
    // row none of those can place falls back to the empty state.
    return next
      .map((t) => {
        if (isKnownFeedTrip(t)) return t;
        const sourceFeed = sourceFeedIdForRoute(routes[t.route_id]);
        return sourceFeed ? { ...t, source_feed: sourceFeed } : null;
      })
      .filter(Boolean);
  }, [selectedRouteIds, routes, relevantTrips.length]);

  const tripsToRender =
    relevantTrips.length > 0 ? relevantTrips : fallbackTrips;

  // When a station is selected, show the direction with the bigger onward
  // journey from that station first. A route has two directions; the more
  // useful one to the traveller is usually the one with more of the trip still
  // ahead of the selected station (i.e. they board here and ride onward).
  const orderedTrips = useMemo(() => {
    if (!selectedStation || tripsToRender.length < 2) return tripsToRender;

    // The train the bottom bar's chip named goes first — the same rule, from
    // DynamicMap (src/lib/stationFirst.mjs), so picking "Milano Porta
    // Garibaldi – Bruxelles Midi" opens on that train, not on its return.
    const stationFirst = orderTripsStationFirst(
      tripsToRender,
      firstDirectionByRoute,
      (trip) => tripDirection(routes?.[String(trip.route_id)], trip),
    );
    if (stationFirst) return stationFirst;

    // Stations remaining toward the destination after the selected station.
    const onwardCount = (trip) => {
      const sequence = [
        trip.trip_origin,
        // Split by station name: a torn name matches no endpoint, so the
        // selected station is not found and the direction ordering flips.
        ...splitViaString(trip.via),
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
  }, [tripsToRender, selectedStation, firstDirectionByRoute, routes]);

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
  // Unlike the flags above, this reads the trips actually being rendered:
  // European Sleeper appears both as synthetic rows and as enriched
  // Back-on-Track ones, and only the former go through fallbackTrips.
  const hasESTrips = tripsToRender.some(isEuropeanSleeperTrip);
  // The trains file each rendered trip is timed from when no per-operator feed
  // claims it: a synthetic row's own source, or the official source that
  // corroborated a Back-on-Track row (Trafiklab for SJ 91, whose card otherwise
  // lists 13 stops with a time only at each end).
  const sourceFeedIdForTrip = (t) =>
    t.source_feed ||
    (!isKnownFeedTrip(t) && !isEuropeanSleeperTrip(t)
      ? sourceFeedIdForRoute(routes?.[String(t.route_id)])
      : null);
  // One key per distinct source, so the effect below refetches only when the
  // set of sources changes rather than on every render.
  const sourceFeedIds = [
    ...new Set(tripsToRender.map(sourceFeedIdForTrip).filter(Boolean)),
  ]
    .sort()
    .join(",");
  // Only a synthetic row depends on that file for its stop list at all; a
  // corroborated Back-on-Track row still has its via names, so a failed fetch
  // there is not worth a warning.
  const sourceFeedRequired = fallbackTrips.some((t) => t.source_feed);

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

  // European Sleeper: the GTFS-derived trains file, keyed by bare train number.
  useEffect(() => {
    if (!isOpen || !hasESTrips) {
      setEsTrainData(null);
      setEsLoadFailed(false);
      setEsLoading(false);
      return;
    }

    let active = true;
    const loadESTrains = async () => {
      setEsLoading(true);
      try {
        setEsLoadFailed(false);
        const response = await fetch(
          "/api/operator-trains?source=europeansleeper",
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (active) setEsTrainData(data);
      } catch {
        if (active) {
          setEsTrainData(null);
          setEsLoadFailed(true);
        }
      } finally {
        if (active) setEsLoading(false);
      }
    };

    loadESTrains();
    return () => {
      active = false;
    };
  }, [isOpen, hasESTrips]);

  // Any other registry source's trains file, for its synthetic rows.
  useEffect(() => {
    if (!isOpen || !sourceFeedIds) {
      setSourceFeedData({});
      setSourceFeedLoadFailed(false);
      setSourceFeedLoading(false);
      return;
    }

    let active = true;
    const loadSourceFeeds = async () => {
      setSourceFeedLoading(true);
      setSourceFeedLoadFailed(false);
      const ids = sourceFeedIds.split(",");
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/operator-trains?source=${encodeURIComponent(id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      );
      if (!active) return;
      const next = {};
      ids.forEach((id, i) => {
        if (results[i]?.trains) next[id] = results[i].trains;
      });
      setSourceFeedData(next);
      setSourceFeedLoadFailed(Object.keys(next).length < ids.length);
      setSourceFeedLoading(false);
    };

    loadSourceFeeds();
    return () => {
      active = false;
    };
  }, [isOpen, sourceFeedIds]);

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

  /**
   * European Sleeper, in two maps rather than one.
   *
   * A train keeps its number across the December timetable change, so `es_400`
   * and `es_400_from_20261214` both render trips 400 and 401 — but they are
   * different journeys (September leaves Milan at 15:45 via Aachen; December at
   * 17:12 via Eindhoven). One map per period lets each route show its own.
   */
  const esScheduleByTrainNumber = useMemo(() => {
    const empty = { current: new Map(), upcoming: new Map() };
    if (!esTrainData?.trains) return empty;
    // Times are ISO here, but tolerate plain "HH:MM" the way the other sources do.
    const asTime = (value) =>
      value ? (String(value).includes("T") ? formatTime(value) : value) : null;
    const toSchedule = (key, stations, days) => ({
      tripId: key,
      stops: stations.map((s, i) => ({
        stopId: s.id || s.name || String(i),
        sequence: i + 1,
        name: s.name || "Station",
        arrival: asTime(s.arrival),
        departure: asTime(s.departure),
      })),
      // The feed's own service string, already in the display format Frequency
      // renders ("2026/08/20-12/10: Tue, Thu, Sun").
      days: days || null,
      validFrom: null,
      validUntil: null,
      source: "europeansleeper",
    });

    const { current, upcoming } = empty;
    Object.entries(esTrainData.trains).forEach(([key, train]) => {
      const number = normalizeTrainNumber(key);
      const stations = Array.isArray(train?.stations) ? train.stations : [];
      if (stations.length > 0) {
        current.set(number, toSchedule(key, stations, train.frequency));
      }

      const future = Array.isArray(train?.future?.stations)
        ? train.future.stations
        : [];
      // Falling back to the current period keeps a route that only some
      // directions have a future timetable for from rendering half-empty.
      if (future.length > 0) {
        upcoming.set(number, toSchedule(key, future, train.future.frequency));
      } else if (stations.length > 0) upcoming.set(number, current.get(number));
    });
    return empty;
  }, [esTrainData]);

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
        ref={sheetRef}
        className={`fixed z-[1000] bg-white shadow-lg transition-all duration-300 overflow-y-auto overscroll-y-none bottom-0 left-0 right-0 rounded-t-2xl ${
          expanded ? "h-[88dvh]" : "h-[55dvh]"
        } pb-[env(safe-area-inset-bottom,0px)] md:top-13 md:right-0 md:bottom-auto md:left-auto md:rounded-none md:h-[calc(100vh-3rem)] md:w-[300px] md:translate-y-0 md:pb-0 ${
          isOpen
            ? "translate-y-0 md:translate-x-0"
            : "translate-y-full md:translate-x-full"
        }`}
      >
        {/* Mobile drag handle — swipe down to dismiss (same pattern as WelcomeTour). */}
        <div
          className="md:hidden sticky top-0 z-20 flex touch-none cursor-grab active:cursor-grabbing justify-center pt-2 pb-1 shrink-0 bg-white"
          onPointerDown={onSheetDragStart}
          onPointerMove={onSheetDragMove}
          onPointerUp={onSheetDragEnd}
          onPointerCancel={onSheetDragEnd}
        >
          <div className="w-10 h-1 rounded-full bg-gray-300" aria-hidden />
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
              naLoading ||
              esLoading ? (
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
              {esLoadFailed && hasESTrips && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  European Sleeper timetable is currently unavailable.
                </div>
              )}
              {sourceFeedLoadFailed && sourceFeedRequired && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  Detailed timetable is currently unavailable.
                </div>
              )}

              {orderedTrips.map((trip, index) => {
                // Operator brand color for accent styling
                const operatorColor = getOperatorBaseColor(trip);
                const normalizedTrainNumber = normalizeTrainNumber(
                  trip.trip_short_name,
                );
                const numericTrainNumber = extractTrainNumberDigits(
                  trip.trip_short_name,
                );

                // Keyed by BARE number, because Back-on-Track's
                // trip_short_name is bare — and a bare number is only unique
                // WITHIN an operator. Back-on-Track carries a CFM/CFR 401
                // (Chişinău–București) and an SJN 475 (Trondheim–Bodø) next to
                // European Sleeper's ES 401/475, so without the operator check
                // those two trains rendered European Sleeper's stops, endpoints,
                // duration and service days. Same hazard the registry names in
                // `synthetic.botMatchAgencies`.
                const esSchedule = esScheduleForTrip(
                  trip,
                  esScheduleByTrainNumber,
                  normalizedTrainNumber,
                );
                // Already formatted "HH:MM" in the schedule's stops, so used
                // directly like PKP and Amtrak/VIA rather than via formatTime.
                const esStops = esSchedule?.stops || [];
                const esOriginDeparture =
                  esStops[0]?.departure || esStops[0]?.arrival || null;
                const esDestinationArrival =
                  esStops[esStops.length - 1]?.arrival ||
                  esStops[esStops.length - 1]?.departure ||
                  null;
                // The feed is the operator's own timetable, so where it covers a
                // train it supersedes Back-on-Track's copy throughout — not just
                // in the stop list. BoT still routes ES 452 via Dresden Neustadt
                // and Berlin Hbf (the feed calls at Berlin Gesundbrunnen, Den
                // Haag and Roosendaal), and its duration predates the times
                // above, so leaving either in place would contradict the rest of
                // the card. Trains the feed does not carry — ES 454/455, still
                // postponed — keep BoT's values.
                const esVia =
                  esStops.length > 2
                    ? esStops
                        .slice(1, -1)
                        .map((s) => s.name)
                        .join(" - ")
                    : null;
                const esDuration = durationBetween(
                  esOriginDeparture,
                  esDestinationArrival,
                );
                // Endpoints too, so one card doesn't end at "Bruxelles Midi /
                // Brussel Zuid" in the route line and "Bruxelles Midi" in the
                // stop list below it. Display only — booking links, connection
                // slugs and endpoint matching keep the canonical names, which
                // are what the rest of the app indexes stations by.
                const esOrigin = esStops[0]?.name || null;
                const esDestination = esStops[esStops.length - 1]?.name || null;

                // PKP (Polish GTFS): per-station timetable + service calendar
                // were merged onto the route in pkpGtfsMerge. Pick the direction
                // whose origin matches this trip's origin.
                const tripRoute = routes?.[trip.route_id?.toString()];
                // Two agency ids per route: who SELLS through our main CTA
                // (the route row's styling agency — ÖBB for synthetic NJ/EN
                // rows, whose nightjet deep link is the best booking path) vs
                // who OPERATES the train (BoT's attribution, carried through
                // the dedup as bot_agency_id — e.g. "PKP/ČD" for partner
                // EuroNights). Logos and the operator name follow BoT.
                const bookingAgencyId = tripRoute?.agency_id || trip.agency_id;
                const operatorAgencyId =
                  tripRoute?.bot_agency_id || bookingAgencyId;
                const agency =
                  agencies[operatorAgencyId] || agencies[bookingAgencyId];
                // "Official timetable": the operator's own schedule page for
                // THIS train, so it follows who operates it, not who sells it.
                // Per-direction — Ukrainian Railways numbers the two legs 35
                // and 36 where Back-on-Track records one number for both.
                const scheduleDirection =
                  Number(trip.direction_id) === 1 ? 1 : 0;

                // The row the enrichment corrected, when an official feed
                // corroborated it. Enrichment rewrites the ROW and never the
                // trips table, so every value below that falls through to
                // `trip.*` is Back-on-Track's copy of a timetable the operator
                // has already replaced — 183 minutes out on IC Nuit 3750, and a
                // 2-stop via list where the row carries 14. Sits directly above
                // the trip fallback and below every per-operator feed: a feed
                // that knows this train is still the better answer, and where
                // one exists it is usually what stamped the row anyway.
                const officialRow = officialRowSchedule(
                  tripRoute,
                  trip.direction_id,
                );
                const scheduleLink = resolveScheduleLink({
                  agencyId: operatorAgencyId,
                  agencies,
                  train: trip.trip_short_name,
                  routeId: trip.route_id,
                  originCountry:
                    tripRoute?.[`origin_country_${scheduleDirection}`],
                  destCountry:
                    tripRoute?.[`destination_country_${scheduleDirection}`],
                  originCode:
                    tripRoute?.[`schedule_origin_code_${scheduleDirection}`],
                });
                // European Sleeper's feed publishes bare numbers ("400"); the
                // operator writes them "ES 400". Display only — every lookup
                // above still uses the raw trip_short_name.
                const trainLabel = formatTrainNumber(
                  trip.trip_short_name,
                  operatorAgencyId,
                );
                const viaSummary = selectMajorViaStations(
                  esVia || officialRow?.via || trip.via,
                  majorViaContext,
                );

                // SEO connection-page slug. Built from the route row's endpoints
                // (mirroring buildSummary() in src/lib/seo/data.js) so it matches
                // the statically generated /connections/[pair] page exactly. Only
                // routes present in the viewMap have a page, so we link only when
                // a route row exists (no link for orphan/legacy trip rows).
                const trainPageSlug = tripRoute
                  ? buildPairSlug(
                      cityForStation(
                        tripRoute.origin_trip_0 || tripRoute.origin_trip_1 || "",
                      ),
                      cityForStation(
                        tripRoute.destination_trip_0 ||
                          tripRoute.destination_trip_1 ||
                          "",
                      ),
                    )
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

                // Last resort: the row's own via list. Every schedule above is
                // keyed by train number into one of nine operator feeds, so a
                // train no feed carries — which is every Back-on-Track-only
                // route, all of Norway and SNCF's Intercités de Nuit among them
                // — showed NO stop list here at all, while the connection page
                // for the same train showed one. This is that page's fallback,
                // brought over: origin, the via names, destination, with the
                // endpoint times the row already carries and no invented ones
                // in between. Placed last in the chain below, so it never
                // displaces a feed that does know the train, and it improves on
                // its own when an enrichment rewrites via_* from official data.
                const viaSchedule = viaScheduleForTrip(
                  tripRoute,
                  isDir1 ? 1 : 0,
                );
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
                // Booking origin: prefer the station the user clicked on the map
                // (so the deep link starts from where they are), but only when it
                // isn't the destination. Otherwise use the train's own origin.
                // The corrected row's endpoints when an official feed moved
                // them (Trafiklab runs SJ 91 from Umeå; the trip still says
                // Luleå), so the deep link searches the train the card shows.
                const bookingDest =
                  officialRow?.destination || trip.trip_headsign;
                const bookingOrigin =
                  selectedStation && selectedStation !== bookingDest
                    ? selectedStation
                    : officialRow?.origin || trip.trip_origin;
                // One entry per operating company ("PKP/ČD" → PKP + ČD), each
                // carrying its logo plus the best link that operator sells this
                // ticket through (deep link → booking page → fare portal →
                // homepage) — the logos below double as booking links.
                const operatorComponents = resolveOperatorComponents({
                  agencyId: operatorAgencyId,
                  agencies,
                  routeId: trip.route_id,
                  origin: bookingOrigin,
                  dest: trip.trip_headsign,
                });
                // BoT's attribution wins when the route carries it — official
                // NJ/EN data labels partner trains with brand strings like
                // "EuroNight", not the operating companies.
                const botOperatorName =
                  tripRoute?.bot_agency_id && operatorComponents.length
                    ? operatorComponents.map((c) => c.name).join(" + ")
                    : null;
                const operatorName =
                  botOperatorName ||
                  nightjetTrain?.operator ||
                  crTrain?.operator ||
                  caucasusTrain?.operator ||
                  curatedTrain?.operator ||
                  naTrain?.operator ||
                  (operatorComponents.length > 1
                    ? operatorComponents.map((c) => c.name).join(" + ")
                    : agency?.agency_name) ||
                  "Operator";
                // Synthetic trips without a route row default agency_id="ÖBB",
                // but the actual operator can differ (partner EuroNight trains).
                // Suppress logos only in that misleading case; rows with a real
                // agency id always show their operators' logos.
                const suppressSyntheticObbLogo =
                  !tripRoute?.agency_id &&
                  trip.agency_id === "ÖBB" &&
                  !!nightjetTrain?.operator &&
                  nightjetTrain.operator !== agency?.agency_name;
                const logoComponents = suppressSyntheticObbLogo
                  ? []
                  : operatorComponents.filter((c) => c.logoUrl);
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
                // A synthetic row from any other registry source (Trafiklab,
                // CFR, …): its own trains file, by its own label.
                const sourceFeedId = sourceFeedIdForTrip(trip);
                const sourceSchedule = sourceFeedId
                  ? sourceFeedSchedule(sourceFeedData[sourceFeedId], trip)
                  : null;
                const sourceStops = sourceSchedule?.stops || [];
                const sourceOriginDeparture =
                  sourceStops[0]?.departure || sourceStops[0]?.arrival || null;
                const sourceDestinationArrival =
                  sourceStops[sourceStops.length - 1]?.arrival ||
                  sourceStops[sourceStops.length - 1]?.departure ||
                  null;
                // Same "8h 57m" shape as the corroborated row's own duration,
                // which this replaces on the same card.
                const sourceDuration = formatDurationShort(
                  durationMinutesBetween(
                    sourceOriginDeparture,
                    sourceDestinationArrival,
                  ),
                );
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
                  naSchedule ||
                  esSchedule ||
                  sourceSchedule ||
                  viaSchedule;
                // Nights in the next fortnight on which the train runs a
                // different timetable (engineering works, an extension), read
                // from the same source as the timetable they differ from.
                const upcomingChanges =
                  schedule === sourceSchedule ? sourceSchedule?.changes || [] : [];
                const upcomingChangeNights = upcomingChanges.reduce(
                  (n, c) => n + c.dates.length,
                  0,
                );
                // A search on the operator's own site for that night, when it
                // has a dated deep link (sj.se); otherwise nothing, since a
                // homepage cannot show a particular night's timetable.
                const changeSearchUrl = (change, night) => {
                  for (const id of splitAgencyIds(bookingAgencyId)) {
                    const url = buildBookingUrl({
                      agencyId: id,
                      origin: change.from,
                      dest: change.to,
                      isoDate: night.date,
                    });
                    if (url) return url;
                  }
                  return null;
                };
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

                // A Back-on-Track trip carries the route's stamped pricing; a
                // synthetic trip (built from the row in fallbackTrips) does
                // not, so read the row's. Then narrow it to THIS train: an
                // official source prices each direction and berth class
                // separately (fare_0/fare_1, see src/lib/fareClasses.mjs).
                const basePricing = getOperatorPricing(
                  trip.pricing || !tripRoute?.pricing
                    ? trip
                    : { ...trip, pricing: tripRoute.pricing },
                );
                const fareDir = fareDirectionForTrip(tripRoute, trip);
                const pricing =
                  fareDir == null
                    ? basePricing
                    : pricingForDirection(tripRoute, fareDir, basePricing);
                // Regular fares only: a promotional deal (European Sleeper's
                // last-minute pages) is sold elsewhere, so it is shown beside
                // the link that sells it, in BookingActions below.
                const dirFare =
                  fareDir == null ? null : directionFare(tripRoute, fareDir);
                // One row per kind of place (panelFareRows folds European
                // Sleeper's cabins by beds); deals are never among them.
                const fareRows = dirFare
                  ? panelFareRows(dirFare, {
                      from: pricing?.type === "dynamic",
                    })
                  : [];
                const { regular: regularFare, deal: dealFare } =
                  splitDealFare(dirFare);
                // Each chip carries its own night when the source keeps a
                // calendar; one shared line only for a single-date record.
                const rowDates = [
                  ...new Set(fareRows.map((f) => f.date).filter(Boolean)),
                ];
                const chipDates =
                  pricing?.type === "dynamic" && rowDates.length > 1;
                // One night for every class: say it once, under the chips.
                const sharedFareDate =
                  rowDates.length === 1 ? rowDates[0] : pricing?.travelDate;
                // The Fare line under the Book button quotes what that button
                // sells — the regular fare — when a deal is listed apart.
                const bookingPricing =
                  dealFare && pricing
                    ? {
                        ...pricing,
                        fromPrice: regularFare?.fromPrice ?? null,
                        seatClass: regularFare?.seatClass ?? null,
                        travelDate: regularFare?.travelDate ?? null,
                      }
                    : pricing;
                const dealForBooking = dealFare
                  ? {
                      ...dealFare,
                      date: formatTravelDateShort(dealFare.travelDate),
                      href: buildDealsLandingUrl(
                        bookingAgencyId,
                        dealFare.landing,
                      ),
                      // Cheaper than every regular berth on this train.
                      best:
                        !regularFare ||
                        dealFare.fromPrice < regularFare.fromPrice,
                    }
                  : null;
                const pricingLabel = formatPricingLabel(pricing);
                const pricingBadgeStyle = getPricingBadgeStyle(pricing);
                // Keyed to the SELLING agency, because a deals page is a
                // selling-side thing and BookingActions renders that link right
                // below — the two must not disagree about whether one exists.
                const pricingHelp = pricingAdvice(pricing, {
                  hasLastMinuteDeals: hasLastMinuteDeals(bookingAgencyId),
                });

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
                        {logoComponents.length > 0 && (
                          <div className="flex flex-wrap items-center gap-3">
                            {logoComponents.map((c) => {
                              // With multiple operators each logo gets at most
                              // half the row (minus its share of the gap) so
                              // they sit side by side instead of stacking.
                              const halfWidth =
                                logoComponents.length > 1
                                  ? "max-w-[calc(50%-0.375rem)]"
                                  : "";
                              const logoImg = (
                                <img
                                  src={c.logoUrl}
                                  alt={c.name}
                                  className={`h-9 max-w-full object-contain object-left ${
                                    c.linkUrl ? "" : halfWidth
                                  }`}
                                  loading="lazy"
                                  onError={(e) => {
                                    // Hide the link wrapper too, not just the img,
                                    // so no empty clickable box remains.
                                    const wrapper =
                                      e.target.closest("a") || e.target;
                                    wrapper.style.display = "none";
                                  }}
                                />
                              );
                              if (!c.linkUrl) {
                                return (
                                  <React.Fragment key={c.id}>
                                    {logoImg}
                                  </React.Fragment>
                                );
                              }
                              const label =
                                c.linkKind === "home"
                                  ? `Visit ${c.name}`
                                  : `Book with ${c.name}`;
                              return (
                                <a
                                  key={c.id}
                                  href={c.linkUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={label}
                                  aria-label={label}
                                  className={`inline-flex rounded-sm hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 transition-opacity ${halfWidth}`}
                                >
                                  {logoImg}
                                </a>
                              );
                            })}
                          </div>
                        )}
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {operatorName}
                        </div>
                      </div>
                      {trainLabel &&
                        (trainPageSlug ? (
                          <Link
                            href={`/connections/${trainPageSlug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold underline decoration-transparent underline-offset-2 transition hover:decoration-current hover:opacity-90"
                            style={{
                              backgroundColor: hexWithAlpha(operatorColor, 0.12),
                              color: operatorColor,
                            }}
                            title={`View ${trainLabel} timetable & route`}
                          >
                            {trainLabel}
                          </Link>
                        ) : (
                          <div
                            className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold"
                            style={{
                              backgroundColor: hexWithAlpha(operatorColor, 0.12),
                              color: operatorColor,
                            }}
                          >
                            {trainLabel}
                          </div>
                        ))}
                    </div>

                    {/* Pricing — the badge names the fare model; the circled
                        "?" opens what it means for booking (PricingExplainer). */}
                    {pricingLabel && pricingBadgeStyle && (
                      <div className="flex items-start gap-2">
                        <span className="text-xs text-gray-500 uppercase mt-0.5">
                          Price
                        </span>
                        <PricingExplainer
                          advice={pricingHelp}
                          label={pricingLabel}
                          tone="light"
                          labelClassName="rounded-md px-2 py-0.5 text-xs font-medium"
                          labelStyle={pricingBadgeStyle}
                          checkedAt={formatCheckedAt(pricing?.checkedAt)}
                        />
                      </div>
                    )}

                    {/* Official fare per berth class for this train, when its
                        source quotes them (12306 does). */}
                    {fareRows.length > 0 && (
                      <div className="space-y-1" data-testid="fare-classes">
                        <div className="text-xs text-gray-500 uppercase">
                          Fares
                        </div>
                        <ul className="space-y-0.5">
                          {fareRows.map((f) => (
                            <li
                              key={f.key}
                              className="text-xs text-gray-700"
                            >
                              {f.label}{" "}
                              <span className="font-semibold text-gray-900">
                                {f.price}
                              </span>
                              {chipDates && f.date && (
                                <span className="text-gray-500">
                                  {" "}
                                  · {formatTravelDateShort(f.date)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                        {/* A dynamic fare is one night's price: say which —
                            on each row when the nights differ, else once. */}
                        {!chipDates &&
                          pricing?.type === "dynamic" &&
                          formatTravelDate(sharedFareDate) && (
                          <div
                            className="text-xs text-gray-500"
                            data-testid="fare-travel-date"
                          >
                            Lowest fares{" "}
                            {formatTravelDate(sharedFareDate)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Route */}
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 uppercase">
                        Route
                      </div>
                      <div className="text-sm font-medium text-gray-900">
                        {abbreviateStationName(
                          esOrigin || officialRow?.origin || trip.trip_origin,
                        )}{" "}
                        {"->"}{" "}
                        {abbreviateStationName(
                          esDestination ||
                            officialRow?.destination ||
                            trip.trip_headsign,
                        )}
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
                      esOriginDeparture ||
                      esDestinationArrival ||
                      sourceOriginDeparture ||
                      sourceDestinationArrival ||
                      officialRow?.departure ||
                      officialRow?.arrival ||
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
                              esOriginDeparture ||
                              sourceOriginDeparture ||
                              officialRow?.departure ||
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
                              esDestinationArrival ||
                              sourceDestinationArrival ||
                              officialRow?.arrival ||
                              formatTime(
                                trip.destination_arrival_time ||
                                  nightjetDestinationArrival ||
                                  itDestinationArrival,
                              )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Back-on-Track's `duration` was computed from the times
                        the enrichment replaced, so on a corrected row it
                        contradicts the two numbers printed right above it —
                        IC Nuit 5789 reads 11h30 against its own 20:57 → 08:24. */}
                    {(esDuration ||
                      sourceDuration ||
                      officialRow?.durationText ||
                      trip.duration) && (
                      <div className="text-xs text-gray-600">
                        Duration:{" "}
                        {esDuration ||
                          sourceDuration ||
                          officialRow?.durationText ||
                          formatTime(trip.duration)}
                      </div>
                    )}

                    {/* Frequency — PKP GTFS run-days win; BoT/override fallback */}
                    {(pkpSchedule?.days ||
                      esSchedule?.days ||
                      officialRow?.serviceDays ||
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
                            // The feed's own service days, which carry the
                            // period they apply to; BoT's copy is undated.
                            return (
                              esSchedule?.days ||
                              officialRow?.serviceDays ||
                              trip.service_id
                            );
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

                    {/* Helper link, not a CTA: verify these times against the
                        operator's own timetable. Above the station accordions
                        rather than below, so it reads next to the times while
                        they are still collapsed. */}
                    {scheduleLink && (
                      <div className="text-xs text-gray-400">
                        <a
                          href={scheduleLink.url}
                          target="_blank"
                          rel={
                            scheduleLink.affiliate
                              ? "sponsored nofollow noopener noreferrer"
                              : "noopener noreferrer"
                          }
                          className="inline-flex items-center gap-1 hover:text-gray-600 hover:underline"
                        >
                          {scheduleLink.label}
                          <FiExternalLink
                            className="h-3 w-3 shrink-0"
                            aria-hidden
                          />
                        </a>
                      </div>
                    )}

                    {/* Dated timetable changes: the card above is the usual
                        timetable, these are the nights it is not. */}
                    {upcomingChanges.length > 0 && (
                      <details className="rounded-md bg-amber-50">
                        <summary className="cursor-pointer list-none px-2 py-1.5 flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-amber-900">
                            Timetable changes in the next 2 weeks (
                            {upcomingChangeNights}{" "}
                            {upcomingChangeNights === 1 ? "night" : "nights"})
                          </span>
                          <span
                            className="inline-flex items-center justify-center h-5 w-5 text-amber-700"
                            aria-hidden
                          >
                            <FiChevronDown className="h-4 w-4" />
                          </span>
                        </summary>
                        <div className="px-2 pb-2 space-y-1.5">
                          <div className="text-xs text-amber-800">
                            From the operator&apos;s timetable data, usually
                            engineering works. Check the night you travel.
                          </div>
                          {upcomingChanges.map((change) => (
                            <div
                              key={change.dates[0]}
                              className="rounded bg-white px-2 py-1.5 text-xs space-y-1"
                            >
                              <div className="text-gray-800">
                                <span className="font-medium">
                                  {change.dates.length > 1
                                    ? `${formatPlanDate(change.dates[0])} – ${formatPlanDate(change.dates[change.dates.length - 1])}`
                                    : formatPlanDate(change.dates[0])}
                                </span>
                                {" · "}
                                {change.from} → {change.to} · {change.stops}{" "}
                                stops
                              </div>
                              {change.skipped.length > 0 && (
                                <div className="text-gray-500">
                                  Not calling at: {change.skipped.join(", ")}
                                </div>
                              )}
                              {change.added.length > 0 && (
                                <div className="text-gray-500">
                                  Also calls at: {change.added.join(", ")}
                                </div>
                              )}
                              <div>
                                {change.nights.map((night) => {
                                  const url = changeSearchUrl(change, night);
                                  const label = formatPlanDate(night.date);
                                  return (
                                    <div
                                      key={night.date}
                                      className="grid grid-cols-[1fr_auto_auto] items-center gap-2 py-0.5"
                                    >
                                      <span className="text-gray-700">
                                        {label}
                                      </span>
                                      <span className="text-gray-600 tabular-nums whitespace-nowrap">
                                        {night.departure || "--"} →{" "}
                                        {night.arrival || "--"}
                                      </span>
                                      {url ? (
                                        <a
                                          href={url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          aria-label={`Check ${label} on the operator's site`}
                                          title="Check this night on the operator's site"
                                          className="text-gray-400 hover:text-gray-600"
                                        >
                                          <FiExternalLink
                                            className="h-3 w-3"
                                            aria-hidden
                                          />
                                        </a>
                                      ) : (
                                        <span />
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
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
                      agencyId={bookingAgencyId}
                      agencies={agencies}
                      agencyUrl={agencies[bookingAgencyId]?.agency_url}
                      origin={bookingOrigin}
                      dest={bookingDest}
                      pricing={bookingPricing}
                      deal={dealForBooking}
                      routeId={trip.route_id}
                      scheduleStops={schedule?.stops}
                    />

                    {/* How buying works where it has quirks the Book button
                        cannot explain (booking-guides.json) — closed by
                        default so the card does not grow a page of prose. */}
                    <BookingGuide
                      guide={guideProps(
                        getBookingGuide({
                          agencyIds: [bookingAgencyId, tripRoute?.bot_agency_id].filter(Boolean),
                        }),
                      )}
                      tone="light"
                      compact
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
