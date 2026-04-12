import Head from "next/head";
import Header from "@components/Header";
import ThankYouModal from "@components/ThankYouModal";
import { useState, useCallback, startTransition, useEffect } from "react";
import Container from "@components/Container";
import Map from "@components/Map";
import Section from "@components/Section";
import { useWindowSize } from "../../hooks/useWindowSize";

const DEFAULT_CENTER = [49.385541, 12.765493];
const STORAGE_KEY_IS_GROUPED = "train-map:isGrouped";
const STORAGE_KEY_SHOW_ROUTES = "train-map:showRoutes";
const STORAGE_KEY_HIDE_INTERMEDIATE = "train-map:hideIntermediateStations";

const Layout = ({ children }) => {
  const [isModalOpen, setModalIsOpen] = useState(false);
  const [layerType, setLayerType] = useState("thunderforest");
  const [isGrouped, setIsGrouped] = useState(true);
  const [showRoutes, setShowRoutes] = useState(false); // Toggle for showing route paths
  const [hideIntermediateStations, setHideIntermediateStations] =
    useState(false); // Filter to hide intermediate stations
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);
  const { width, height } = useWindowSize();

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
      <Head>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚂</text></svg>"
        />
      </Head>
      <Header
        setModalIsOpen={setModalIsOpen}
        setLayerType={setLayerType}
        layerType={layerType}
        isGrouped={isGrouped}
        setIsGrouped={setIsGrouped}
        showRoutes={showRoutes}
        setShowRoutes={setShowRoutesStable}
        hideIntermediateStations={hideIntermediateStations}
        setHideIntermediateStations={setHideIntermediateStations}
      />
      <main>
        {children}
        <Container>
          <Map
            width={width}
            height={height}
            center={DEFAULT_CENTER}
            zoom={5}
            isGrouped={isGrouped}
            setIsGrouped={setIsGrouped}
            showRoutes={showRoutes}
            hideIntermediateStations={hideIntermediateStations}
          />
        </Container>
      </main>
      <ThankYouModal
        isModalOpen={isModalOpen}
        setModalIsOpen={setModalIsOpen}
      />
    </div>
  );
};

export default Layout;
