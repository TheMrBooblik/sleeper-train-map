import Head from 'next/head';
import Header from '@components/Header';
import styles from './Layout.module.scss';
import ThankYouModal from "@components/ThankYouModal";
import { useState } from "react";
import Container from "@components/Container";
import Map from "@components/Map";
import Section from "@components/Section";
import { useWindowSize } from "../../hooks/useWindowSize";

const DEFAULT_CENTER = [49.385541, 12.765493]

const Layout = ({children}) => {
  const [isModalOpen, setModalIsOpen] = useState(false);
  const [layerType, setLayerType] = useState("thunderforest");
  const {width, height} = useWindowSize();

  return (
    <div className={styles.layout}>
      <Head>
        <link rel="icon" href="/favicon.ico"/>
      </Head>
      <Header setModalIsOpen={setModalIsOpen} setLayerType={setLayerType} layerType={layerType}/>
      <main className={styles.main}>
        {children}
        <Container>
          <Map width={width} height={height} center={DEFAULT_CENTER} zoom={5}>
            {({TileLayer}) => (
              <>
                <TileLayer
                  url={`https://tile.openstreetmap.org/{z}/{x}/{y}.png`}
                  attribution="&copy; <a href=&quot;http://osm.org/copyright&quot;>OpenStreetMap</a> contributors"
                />
              </>
            )}
          </Map>
        </Container>
      </main>
      <ThankYouModal isModalOpen={isModalOpen} setModalIsOpen={setModalIsOpen}/>
    </div>
  );
};

export default Layout;