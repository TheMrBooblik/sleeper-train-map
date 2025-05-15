import Head from 'next/head';
import Layout from '@components/Layout';

export default function Home() {
  return (
    <Layout>
      <Head>
        <title>Pingwi Sleeper Train Map</title>
        <meta name="description" content="The Sleeper Train Map is a web application that visualizes direct night sleeper train routes across Europe. By selecting a station, users can easily see all reachable destinations via sleeper trains."/>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚂</text></svg>"
        />
      </Head>
    </Layout>
  )
}
