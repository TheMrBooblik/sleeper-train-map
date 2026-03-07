import Head from "next/head";
import Header from "@components/Header";
import ThankYouModal from "@components/ThankYouModal";
import { useState, useCallback, startTransition } from "react";
import Container from "@components/Container";
import Map from "@components/Map";
import Section from "@components/Section";
import { useWindowSize } from "../../hooks/useWindowSize";

const DEFAULT_CENTER = [49.385541, 12.765493];

const Layout = ({ children }) => {
  const [isModalOpen, setModalIsOpen] = useState(false);
  const [layerType, setLayerType] = useState("thunderforest");
  const [isGrouped, setIsGrouped] = useState(true);
  const [showRoutes, setShowRoutes] = useState(false); // Toggle for showing route paths
  const [hideIntermediateStations, setHideIntermediateStations] =
    useState(false); // Filter to hide intermediate stations
  const { width, height } = useWindowSize();

  // Defer heavy "all routes" render so checkbox updates instantly (paths are precomputed)
  const setShowRoutesStable = useCallback((value) => {
    if (value === true) {
      startTransition(() => setShowRoutes(true));
    } else {
      setShowRoutes(false);
    }
  }, []);

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
