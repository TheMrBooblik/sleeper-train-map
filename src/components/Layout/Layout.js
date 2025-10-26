import Head from "next/head";
import Header from "@components/Header";
import styles from "./Layout.module.scss";
import ThankYouModal from "@components/ThankYouModal";
import { useState } from "react";
import Container from "@components/Container";
import Map from "@components/Map";
import Section from "@components/Section";
import { useWindowSize } from "../../hooks/useWindowSize";

const DEFAULT_CENTER = [49.385541, 12.765493];

const Layout = ({ children }) => {
  const [isModalOpen, setModalIsOpen] = useState(false);
  const [layerType, setLayerType] = useState("thunderforest");
  const [isGrouped, setIsGrouped] = useState(true);
  const { width, height } = useWindowSize();

  return (
    <div className={styles.layout}>
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
      />
      <main className={styles.main}>
        {children}
        <Container>
          <Map
            width={width}
            height={height}
            center={DEFAULT_CENTER}
            zoom={5}
            isGrouped={isGrouped}
            setIsGrouped={setIsGrouped}
          >
            {({ TileLayer }) => (
              <>
                <TileLayer
                  url={`https://tile.openstreetmap.org/{z}/{x}/{y}.png`}
                  attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
                />
              </>
            )}
          </Map>
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
