import { useEffect } from "react";
import Head from "next/head";
import "@styles/globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

function MyApp({ Component, pageProps }) {
  // Register the lightweight PWA service worker once on the client.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Skip SW on localhost during active development to avoid stale caches.
    const isLocal =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "[::1]";
    if (isLocal) {
      // Unregister leftover SW from a previous `next start`. An old worker
      // could still replay a cached /data → /login redirect.
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability still works via the manifest even if SW registration fails.
    });
  }, []);

  return (
    <>
      {/* Viewport must live in _app (not _document) so Next can merge it. */}
      <Head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
      </Head>
      <Component {...pageProps} />
      <Analytics />
      <SpeedInsights />
    </>
  );
}

export default MyApp;
