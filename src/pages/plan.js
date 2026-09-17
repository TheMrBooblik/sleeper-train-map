import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Header from "@components/Header";
import { SITE_URL } from "../lib/seo/site";

const TITLE = "Plan a Sleeper Train Trip | Pingwi";
const DESCRIPTION =
  "Plan a flexible sleeper train journey by choosing where you start and when you want to travel.";

function today() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

export default function Plan() {
  const router = useRouter();
  const [stations, setStations] = useState([]);
  const [origin, setOrigin] = useState("");
  const [date, setDate] = useState("");
  const [loadingStations, setLoadingStations] = useState(true);
  const [stationError, setStationError] = useState("");
  const [destinations, setDestinations] = useState([]);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [destinationError, setDestinationError] = useState("");
  const [isGrouped, setIsGrouped] = useState(true);
  const [showRoutes, setShowRoutes] = useState(false);
  const [hideIntermediateStations, setHideIntermediateStations] = useState(false);
  const [showRailwayOverlay, setShowRailwayOverlay] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;

    const queryOrigin = typeof router.query.from === "string" ? router.query.from : "";
    const queryDate = typeof router.query.date === "string" ? router.query.date : "";
    setOrigin(queryOrigin);
    setDate(queryDate || today());
  }, [router.isReady, router.query.from, router.query.date]);

  useEffect(() => {
    let cancelled = false;

    async function loadStations() {
      try {
        const response = await fetch("/api/plan-stations");
        if (!response.ok) throw new Error("Station request failed");
        const data = await response.json();
        if (!cancelled) setStations(Array.isArray(data.stations) ? data.stations : []);
      } catch (error) {
        console.error("[plan] Station loading failed:", error);
        if (!cancelled) setStationError("Stations are temporarily unavailable.");
      } finally {
        if (!cancelled) setLoadingStations(false);
      }
    }

    loadStations();
    return () => { cancelled = true; };
  }, []);

  const stationNames = useMemo(() => stations.map((station) => station.name), [stations]);

  useEffect(() => {
    if (!origin || !date || !router.isReady) {
      setDestinations([]);
      return undefined;
    }

    let cancelled = false;
    setLoadingDestinations(true);
    setDestinationError("");

    async function loadDestinations() {
      try {
        const params = new URLSearchParams({ from: origin, date });
        const response = await fetch(`/api/plan-destinations?${params.toString()}`);
        if (!response.ok) throw new Error("Destination request failed");
        const data = await response.json();
        if (!cancelled) setDestinations(Array.isArray(data.destinations) ? data.destinations : []);
      } catch (error) {
        console.error("[plan] Destination loading failed:", error);
        if (!cancelled) {
          setDestinations([]);
          setDestinationError("We couldn’t find routes for this date.");
        }
      } finally {
        if (!cancelled) setLoadingDestinations(false);
      }
    }

    loadDestinations();
    return () => { cancelled = true; };
  }, [origin, date, router.isReady]);

  function updatePlan(nextOrigin, nextDate) {
    const query = {};
    if (nextOrigin.trim()) query.from = nextOrigin.trim();
    if (nextDate) query.date = nextDate;
    router.replace({ pathname: "/plan", query }, undefined, { shallow: true });
  }

  function handleOriginChange(event) {
    const value = event.target.value;
    setOrigin(value);
    updatePlan(value, date);
  }

  function handleDateChange(event) {
    const value = event.target.value;
    setDate(value);
    updatePlan(origin, value);
  }

  return (
    <div className="plan-shell">
      <Header
        isGrouped={isGrouped}
        setIsGrouped={setIsGrouped}
        showRoutes={showRoutes}
        setShowRoutes={setShowRoutes}
        hideIntermediateStations={hideIntermediateStations}
        setHideIntermediateStations={setHideIntermediateStations}
        showRailwayOverlay={showRailwayOverlay}
        setShowRailwayOverlay={setShowRailwayOverlay}
        stops={[]}
        stopsLoading={false}
      />

      <div className="plan-scroll">
        <Head>
          <title>{TITLE}</title>
          <meta name="description" content={DESCRIPTION} />
          <link rel="canonical" href={`${SITE_URL}/plan`} />
        </Head>

        <main className="plan-page">
          <section className="plan-hero" aria-labelledby="plan-title">
            <p className="plan-eyebrow">Sleeper train planner</p>
            <h1 id="plan-title">Where could you go tonight?</h1>
            <p className="plan-intro">
              Choose where you start and when you want to travel. We&apos;ll help you
              discover where a night train can take you.
            </p>

            <div className="plan-form" aria-label="Trip planning">
              <div className="plan-field">
                <label htmlFor="plan-origin">From</label>
                <input
                  id="plan-origin"
                  name="origin"
                  type="text"
                  list="plan-stations"
                  value={origin}
                  onChange={handleOriginChange}
                  placeholder={loadingStations ? "Loading stations..." : "Departure station"}
                  autoComplete="off"
                  disabled={loadingStations && stations.length === 0}
                />
                <datalist id="plan-stations">
                  {stationNames.map((name) => <option key={name} value={name} />)}
                </datalist>
                {stationError && <span className="plan-error">{stationError}</span>}
              </div>

              <div className="plan-field">
                <label htmlFor="plan-date">When</label>
                <input
                  id="plan-date"
                  name="date"
                  type="date"
                  min={today()}
                  value={date}
                  onChange={handleDateChange}
                />
              </div>
            </div>

            {origin && date && (
              <section className="plan-results" aria-live="polite" aria-labelledby="plan-results-title">
                <div className="plan-results-header">
                  <h2 id="plan-results-title">
                    {loadingDestinations ? "Looking for night trains..." : "You could go to"}
                  </h2>
                  {!loadingDestinations && destinations.length > 0 && (
                    <span>{destinations.length} destination{destinations.length === 1 ? "" : "s"}</span>
                  )}
                </div>

                {destinationError && <p className="plan-error">{destinationError}</p>}

                {!loadingDestinations && !destinationError && destinations.length === 0 && (
                  <p className="plan-empty">
                    No sleeper trains found from <strong>{origin}</strong> on this date.
                  </p>
                )}

                <div className="plan-results-list">
                  {destinations.map((item) => (
                    <article
                      className="plan-result"
                      key={`${item.destination}|${item.train}|${item.departure}`}
                    >
                      <div className="plan-result-main">
                        <p className="plan-result-destination">{item.destination}</p>
                        {item.via && <p className="plan-result-via">via {item.via}</p>}
                      </div>
                      <div className="plan-result-times">
                        {item.departure && <strong>{item.departure}</strong>}
                        <span>overnight</span>
                        {item.arrival && <strong>{item.arrival}</strong>}
                      </div>
                      {item.train && <p className="plan-result-train">{item.train}</p>}
                    </article>
                  ))}
                </div>
              </section>
            )}
          </section>
        </main>
      </div>

      <style jsx>{`
        .plan-shell {
          height: 100dvh;
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: #000;
        }

        .plan-scroll {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-y: contain;
        }

        .plan-page {
          min-height: 100%;
        }
      `}</style>
    </div>
  );
}

const styles = `
  .plan-page {
    color: #fff;
    display: flex;
    justify-content: center;
    padding: 64px 24px 96px;
  }

  .plan-hero {
    width: min(760px, 100%);
  }

  .plan-eyebrow {
    margin: 0 0 12px;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.65;
  }

  .plan-hero h1 {
    margin: 0;
    font-size: clamp(2.25rem, 6vw, 4rem);
    line-height: 1.05;
  }

  .plan-intro {
    max-width: 620px;
    margin: 20px 0 40px;
    font-size: 1.1rem;
    line-height: 1.6;
    opacity: 0.78;
  }

  .plan-form {
    display: grid;
    min-width: 0;
    grid-template-columns: 1fr 220px;
    gap: 16px;
  }

  .plan-field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }

  .plan-field label {
    font-size: 0.9rem;
    font-weight: 600;
  }

  .plan-field input {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    min-height: 52px;
    padding: 0 14px;
    border: 1px solid currentColor;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    color: #fff;
    font: inherit;
    outline: none;
  }

  .plan-field input::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }

  .plan-error {
    font-size: 0.85rem;
    opacity: 0.75;
  }

  .plan-results {
    margin-top: 56px;
  }

  .plan-results-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }

  .plan-results-header h2 {
    margin: 0;
    font-size: 1.5rem;
  }

  .plan-results-header span {
    font-size: 0.85rem;
    opacity: 0.6;
  }

  .plan-results-list {
    display: grid;
    gap: 12px;
  }

  .plan-result {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    padding: 18px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.04);
  }

  .plan-result-main p,
  .plan-result-train {
    margin: 0;
  }

  .plan-result-destination {
    font-size: 1.2rem;
    font-weight: 650;
  }

  .plan-result-via,
  .plan-result-train {
    margin-top: 5px !important;
    font-size: 0.85rem;
    opacity: 0.6;
  }

  .plan-result-times {
    display: grid;
    grid-template-columns: auto auto auto;
    align-items: center;
    gap: 7px;
    text-align: right;
  }

  .plan-result-times span {
    font-size: 0.72rem;
    opacity: 0.5;
  }

  .plan-empty {
    margin: 0;
    line-height: 1.5;
    opacity: 0.75;
  }

  @media (max-width: 640px) {
    .plan-page {
      padding: 40px 18px 72px;
    }

    .plan-form {
      grid-template-columns: 1fr;
    }

    .plan-results {
      margin-top: 44px;
    }

    .plan-result {
      grid-template-columns: 1fr;
    }

    .plan-result-times {
      grid-template-columns: auto 1fr auto;
      text-align: left;
    }
  }
`;

if (typeof document !== "undefined" && !document.getElementById("plan-page-styles")) {
  const style = document.createElement("style");
  style.id = "plan-page-styles";
  style.textContent = styles;
  document.head.appendChild(style);
}
