import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Layout from "@components/Layout";
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
    <Layout>
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
            <p className="plan-selection" aria-live="polite">
              Planning a sleeper train journey from <strong>{origin}</strong> on{" "}
              <strong>{date}</strong>.
            </p>
          )}
        </section>
      </main>
    </Layout>
  );
}

const styles = `
  .plan-page {
    min-height: calc(100vh - 64px);
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
    grid-template-columns: 1fr 220px;
    gap: 16px;
  }

  .plan-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .plan-field label {
    font-size: 0.9rem;
    font-weight: 600;
  }

  .plan-field input {
    width: 100%;
    box-sizing: border-box;
    min-height: 52px;
    padding: 0 14px;
    border: 1px solid currentColor;
    border-radius: 10px;
    background: transparent;
    font: inherit;
  }

  .plan-error {
    font-size: 0.85rem;
    opacity: 0.75;
  }

  .plan-selection {
    margin: 28px 0 0;
    line-height: 1.5;
  }

  @media (max-width: 640px) {
    .plan-page {
      padding: 40px 18px 72px;
    }

    .plan-form {
      grid-template-columns: 1fr;
    }
  }
`;

if (typeof document !== "undefined" && !document.getElementById("plan-page-styles")) {
  const style = document.createElement("style");
  style.id = "plan-page-styles";
  style.textContent = styles;
  document.head.appendChild(style);
}
