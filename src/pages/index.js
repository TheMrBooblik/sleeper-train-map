import Head from "next/head";
import Layout from "@components/Layout";

export default function Home() {
  return (
    <Layout>
      <Head>
        <title>Pingwi Train Map</title>
        <meta
          name="description"
          content="Interactive train map of Europe showing all train routes and stations. Filter by night trains or explore all routes. Click on any station to see departures and connections."
        />
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚂</text></svg>"
        />
      </Head>
    </Layout>
  );
}
