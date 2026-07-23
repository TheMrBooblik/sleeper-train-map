import Header from "@components/Header";
import WelcomeTour from "@components/WelcomeTour";
import NearbyStationsSheet from "@components/NearbyStations/NearbyStationsSheet";
import { useState, useCallback, startTransition, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import Container from "@components/Container";
import Map from "@components/Map";
import Section from "@components/Section";
import { useWindowSize } from "../../hooks/useWindowSize";
import { getCountryByCode } from "../../lib/countries";
import { useInitialData } from "../../hooks/requests/useInitialData";

const DEFAULT_CENTER = [49.385541, 12.765493];
const DEFAULT_ZOOM = 5;
const STORAGE_KEY_IS_GROUPED = "train-map:isGrouped";
const STORAGE_KEY_SHOW_ROUTES = "train-map:showRoutes";
const STORAGE_KEY_HIDE_INTERMEDIATE = "train-map:hideIntermediateStations";
const STORAGE_KEY_RAILWAY_OVERLAY = "train-map:showRailwayOverlay";
const STORAGE_KEY_TOUR_SEEN = "train-map:tourSeen";
// Dismiss flag of the old HomeSeoPanel chip — returning visitors who closed
// that are treated as having seen the tour.
const LEGACY_SEO_DISMISS_KEY = "train-map:homeSeoDismissed";

const Layout = ({ children, tourSeo }) => {
  const router = useRouter();
  const { stops, cities, isLoading: stopsLoading } = useInitialData();
  const [searchTarget, setSearchTarget] = useState(null);
  const [showRailwayOverlay, setShowRailwayOverlay] = useState(false); // OpenRailwayMap tile overlay
  const [isGrouped, setIsGrouped] = useState(true);
  const [showRoutes, setShowRoutes] = useState(false); // Toggle for showing route paths
  const [hideIntermediateStations, setHideIntermediateStations] =
    useState(false); // Filter to hide intermediate stations
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);
  // Welcome tour: starts open so the SSG HTML always carries its (SEO) content;
  // hidden after mount for visitors who already saw it (see preferences effect).
  const [tourOpen, setTourOpen] = useState(true);
  const [legendPulse, setLegendPulse] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const tourOpenRef = useRef(true);
  const pulseShownRef = useRef(false);
  const { width, height } = useWindowSize();

  useEffect(() => {
    tourOpenRef.current = tourOpen;
  }, [tourOpen]);

  const dismissTour = useCallback(() => {
    // Ref guard: station clicks keep calling this after the tour is gone.
    if (!tourOpenRef.current) return;
    setTourOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY_TOUR_SEEN, "true");
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    }
    // Blink the header "i" button once per page load so the user learns where
    // to reopen the tour.
    if (!pulseShownRef.current) {
      pulseShownRef.current = true;
      setLegendPulse(true);
      setTimeout(() => setLegendPulse(false), 3200);
    }
  }, []);

  // Header "i" button: instant open/close. Closing this way also counts as
  // "seen" (dismissTour), so the tour still shows only once for new visitors.
  const toggleTour = useCallback(() => {
    if (tourOpenRef.current) {
      // Closing from the "i" button itself — no need to pulse it afterwards.
      pulseShownRef.current = true;
      dismissTour();
    } else {
      setTourOpen(true);
    }
  }, [dismissTour]);

  // Handle country zoom from URL params
  const { country, lat, lng, zoom: zoomParam } = router.query;
  
  const initialCenter = (() => {
    // First check for explicit lat/lng params
    if (lat && lng) {
      const parsedLat = parseFloat(lat);
      const parsedLng = parseFloat(lng);
      if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
        return [parsedLat, parsedLng];
      }
    }
    // Then check for country code
    if (country) {
      const countryData = getCountryByCode(country);
      if (countryData) {
        return countryData.center;
      }
    }
    return DEFAULT_CENTER;
  })();

  const initialZoom = (() => {
    // First check for explicit zoom param
    if (zoomParam) {
      const parsedZoom = parseInt(zoomParam, 10);
      if (!isNaN(parsedZoom) && parsedZoom >= 1 && parsedZoom <= 18) {
        return parsedZoom;
      }
    }
    // Then check for country code (use country's default zoom)
    if (country) {
      const countryData = getCountryByCode(country);
      if (countryData) {
        return countryData.zoom;
      }
    }
    return DEFAULT_ZOOM;
  })();

  // Defer heavy "all routes" render so checkbox updates instantly (paths are precomputed)
  const setShowRoutesStable = useCallback((value) => {
    if (value === true) {
      startTransition(() => setShowRoutes(true));
    } else {
      setShowRoutes(false);
    }
  }, []);

  useEffect(() => {
    try {
      const storedIsGrouped = localStorage.getItem(STORAGE_KEY_IS_GROUPED);
      const storedShowRoutes = localStorage.getItem(STORAGE_KEY_SHOW_ROUTES);
      const storedHideIntermediate = localStorage.getItem(
        STORAGE_KEY_HIDE_INTERMEDIATE,
      );
      const storedRailwayOverlay = localStorage.getItem(
        STORAGE_KEY_RAILWAY_OVERLAY,
      );

      if (storedIsGrouped !== null) {
        setIsGrouped(storedIsGrouped === "true");
      }
      if (storedShowRoutes !== null) {
        setShowRoutes(storedShowRoutes === "true");
      }
      if (storedHideIntermediate !== null) {
        setHideIntermediateStations(storedHideIntermediate === "true");
      }
      if (storedRailwayOverlay !== null) {
        setShowRailwayOverlay(storedRailwayOverlay === "true");
      }
      if (
        localStorage.getItem(STORAGE_KEY_TOUR_SEEN) === "true" ||
        localStorage.getItem(LEGACY_SEO_DISMISS_KEY) === "true"
      ) {
        setTourOpen(false);
      }
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    } finally {
      setHasLoadedPreferences(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedPreferences) return;
    try {
      localStorage.setItem(STORAGE_KEY_IS_GROUPED, String(isGrouped));
      localStorage.setItem(STORAGE_KEY_SHOW_ROUTES, String(showRoutes));
      localStorage.setItem(
        STORAGE_KEY_HIDE_INTERMEDIATE,
        String(hideIntermediateStations),
      );
      localStorage.setItem(
        STORAGE_KEY_RAILWAY_OVERLAY,
        String(showRailwayOverlay),
      );
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    }
  }, [
    hasLoadedPreferences,
    isGrouped,
    showRoutes,
    hideIntermediateStations,
    showRailwayOverlay,
  ]);

  return (
    <div className="grid grid-rows-[auto_1fr_auto] overflow-hidden min-h-screen">
      <Header
        isGrouped={isGrouped}
        setIsGrouped={setIsGrouped}
        showRoutes={showRoutes}
        setShowRoutes={setShowRoutesStable}
        hideIntermediateStations={hideIntermediateStations}
        setHideIntermediateStations={setHideIntermediateStations}
        showRailwayOverlay={showRailwayOverlay}
        setShowRailwayOverlay={setShowRailwayOverlay}
        stops={stops}
        stopsLoading={stopsLoading}
        onSearchSelect={setSearchTarget}
        onToggleTour={tourSeo ? toggleTour : undefined}
        tourOpen={tourOpen}
        legendPulse={legendPulse}
        onNearbyOpen={() => {
          dismissTour();
          setNearbyOpen(true);
        }}
      />
      <main className="relative">
        {children}
        {tourSeo && tourOpen && (
          <WelcomeTour
            {...tourSeo}
            loading={stopsLoading}
            onDismiss={dismissTour}
          />
        )}
        <NearbyStationsSheet
          open={nearbyOpen}
          onClose={() => setNearbyOpen(false)}
          stops={stops}
          cities={cities}
          onSelect={setSearchTarget}
        />
        <Container>
          <Map
            width={width}
            height={height}
            center={initialCenter}
            zoom={initialZoom}
            isGrouped={isGrouped}
            setIsGrouped={setIsGrouped}
            showRoutes={showRoutes}
            hideIntermediateStations={hideIntermediateStations}
            showRailwayOverlay={showRailwayOverlay}
            searchTarget={searchTarget}
            onSearchProcessed={() => setSearchTarget(null)}
            onStationSelect={dismissTour}
          />
        </Container>
      </main>
    </div>
  );
};

export default Layout;
