import Header from "@components/Header";
import { useState, useCallback, startTransition, useEffect } from "react";
import { useRouter } from "next/router";
import Container from "@components/Container";
import Map from "@components/Map";
import Section from "@components/Section";
import { useWindowSize } from "../../hooks/useWindowSize";
import { getCountryByCode } from "../../lib/countries";
import {
  isNorthAmericaClient,
  NORTH_AMERICA_CENTER,
  NORTH_AMERICA_ZOOM,
} from "../../lib/detectRegion";
import { useInitialData } from "../../hooks/requests/useInitialData";

const DEFAULT_CENTER = [49.385541, 12.765493];
const DEFAULT_ZOOM = 5;
const STORAGE_KEY_IS_GROUPED = "train-map:isGrouped";
const STORAGE_KEY_SHOW_ROUTES = "train-map:showRoutes";
const STORAGE_KEY_HIDE_INTERMEDIATE = "train-map:hideIntermediateStations";

const Layout = ({ children }) => {
  const router = useRouter();
  const { stops, isLoading: stopsLoading } = useInitialData();
  const [searchTarget, setSearchTarget] = useState(null);
  const [layerType, setLayerType] = useState("thunderforest");
  const [isGrouped, setIsGrouped] = useState(true);
  const [showRoutes, setShowRoutes] = useState(false); // Toggle for showing route paths
  const [hideIntermediateStations, setHideIntermediateStations] =
    useState(false); // Filter to hide intermediate stations
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);
  const { width, height } = useWindowSize();

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
    // No explicit target: open on North America for NA visitors, else Europe.
    if (isNorthAmericaClient()) {
      return NORTH_AMERICA_CENTER;
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
    if (isNorthAmericaClient()) {
      return NORTH_AMERICA_ZOOM;
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

      if (storedIsGrouped !== null) {
        setIsGrouped(storedIsGrouped === "true");
      }
      if (storedShowRoutes !== null) {
        setShowRoutes(storedShowRoutes === "true");
      }
      if (storedHideIntermediate !== null) {
        setHideIntermediateStations(storedHideIntermediate === "true");
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
    } catch {
      // Ignore storage errors (private mode, blocked storage, etc.)
    }
  }, [hasLoadedPreferences, isGrouped, showRoutes, hideIntermediateStations]);

  return (
    <div className="grid grid-rows-[auto_1fr_auto] overflow-hidden min-h-screen">
      <Header
        setLayerType={setLayerType}
        layerType={layerType}
        isGrouped={isGrouped}
        setIsGrouped={setIsGrouped}
        showRoutes={showRoutes}
        setShowRoutes={setShowRoutesStable}
        hideIntermediateStations={hideIntermediateStations}
        setHideIntermediateStations={setHideIntermediateStations}
        stops={stops}
        stopsLoading={stopsLoading}
        onSearchSelect={setSearchTarget}
      />
      <main className="relative">
        {children}
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
            searchTarget={searchTarget}
            onSearchProcessed={() => setSearchTarget(null)}
          />
        </Container>
      </main>
    </div>
  );
};

export default Layout;
