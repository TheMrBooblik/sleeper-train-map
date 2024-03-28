import Head from 'next/head';

import Layout from '@components/Layout';
import Section from '@components/Section';
import Container from '@components/Container';
import Map from '@components/Map';

import { useWindowSize } from "../hooks/useWindowSize";

const DEFAULT_CENTER = [49.385541, 12.765493]

export default function Home() {
  const { width, height } = useWindowSize();

  return (
    <Layout>
      <Head>
        <title>Pingwi Sleeper Train Map</title>
        <meta name="description" content="Pingwi Sleeper Train Ma" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <Section>
        <Container>
          <Map width={width} height={height} center={DEFAULT_CENTER} zoom={5}>
            {({ TileLayer, Marker, Popup }) => (
              <>
                <TileLayer
                  url={`https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${process.env.NEXT_PUBLIC_THUNDER_FOREST}`}
                  attribution="&copy; <a href=&quot;http://osm.org/copyright&quot;>OpenStreetMap</a> contributors"
                />
              </>
            )}
          </Map>
        </Container>
      </Section>
    </Layout>
  )
}
