import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Legend from "@components/Legend";
import { getFlagEmoji } from "../../lib/countries";
import TourCard from "./TourCard";

/**
 * First-visit welcome tour: a non-blocking HUD of small cards over the map,
 * each anchored near the control it explains. The map stays fully interactive
 * between the cards (pointer-events pass through everywhere but the cards).
 * The whole tour closes at once: clicking anywhere outside a card, pressing
 * Escape, selecting a station, or "Start exploring". The header "i" button
 * toggles it back open.
 *
 * This is also the homepage's crawlable SEO content (h1, intro copy, links to
 * every country/operator/connection hub), so it must always be present in the
 * server-rendered HTML. Visibility for returning visitors is decided by the
 * parent (Layout) after mount; this component only stages the client-side
 * reveal so the cards don't compete with the initial-data loading overlay:
 *   "static"  — SSR + first client render: fully visible, no animation
 *   "waiting" — client, data still loading: hidden (client-only, so the
 *               static HTML never carries opacity-0)
 *   "enter"   — data ready: cards pop in with a small stagger
 */
export default function WelcomeTour({
  countries = [],
  operators = [],
  connections = [],
  routeCount = 0,
  countryCount = 0,
  loading = false,
  onDismiss,
}) {
  const [phase, setPhase] = useState("static");
  const regionRef = useRef(null);

  useEffect(() => {
    setPhase(loading ? "waiting" : "enter");
  }, [loading]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onDismiss?.();
    };
    // Close on any interaction outside the cards. The event is not consumed,
    // so whatever was clicked (map, header controls) still reacts normally.
    // The header "i" button is excluded — it toggles the tour itself.
    const onPointerDown = (e) => {
      if (regionRef.current?.contains(e.target)) return;
      if (e.target.closest?.("button[aria-label='Map legend']")) return;
      onDismiss?.();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onDismiss]);

  const animate = phase === "enter";
  const delay = (i) => ({ "--tour-delay": `${i * 90}ms` });

  const chipClass =
    "rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/70 hover:text-white hover:border-primary-green/50 transition-colors";

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label="Welcome tour"
      className={`pointer-events-none absolute inset-0 z-[1001] overflow-hidden ${
        phase === "waiting" ? "opacity-0" : ""
      }`}
    >
      {/* Mobile (<640px): cards stack in a scrollable bottom sheet.
          Desktop: the wrapper dissolves and cards break out to absolute anchors. */}
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 max-h-[45vh] overflow-y-auto p-2 space-y-2 min-[640px]:pointer-events-none min-[640px]:static min-[640px]:max-h-none min-[640px]:overflow-visible min-[640px]:p-0 min-[640px]:space-y-0">
        {/* ① Hero: the crawlable h1 + primary dismiss */}
        <TourCard
          className="min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:top-4 min-[640px]:left-16 min-[640px]:w-80"
          animate={animate}
          style={delay(0)}
        >
          <h1 className="text-base font-bold tracking-tight">
            Sleeper Train Map — European Night Train Routes
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-white/70">
            {routeCount} night and sleeper train routes across {countryCount}{" "}
            countries, with timetables, stops and booking links. The map is
            live — go poke it.
          </p>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-3 w-full rounded-lg bg-primary-green px-3 py-2 text-sm font-semibold text-black hover:bg-primary-green-light transition-colors"
          >
            Start exploring →
          </button>
        </TourCard>

        {/* ② Station dots explainer, pointing at the map */}
        <TourCard
          className="min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:left-1/2 min-[640px]:top-[38%] min-[640px]:-translate-x-1/2 min-[640px]:w-64"
          notch="down"
          animate={animate}
          style={delay(1)}
        >
          <h2 className="text-sm font-semibold">Click any glowing dot</h2>
          <p className="mt-1 text-xs leading-relaxed text-white/70">
            Every <span className="text-sky-400">blue dot</span> is a station
            served by a night train — click one to see its overnight
            connections. An{" "}
            <span className="text-orange-400">orange badge</span> groups
            several nearby stations; zoom in to split them.
          </p>
        </TourCard>

        {/* ③ Search hint (desktop only: the search bar is hidden on mobile) */}
        <TourCard
          className="hidden min-[640px]:block min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:top-2 min-[640px]:left-[25rem] min-[640px]:w-56"
          notch="up"
          animate={animate}
          style={delay(2)}
        >
          <h2 className="text-sm font-semibold">Find your station</h2>
          <p className="mt-1 text-xs leading-relaxed text-white/70">
            Type any city or station up here to jump straight to it.
          </p>
        </TourCard>

        {/* ④ Settings hint (desktop only: the gear is hidden on mobile) */}
        <TourCard
          className="hidden min-[640px]:block min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:top-2 min-[640px]:right-32 min-[640px]:w-60 tour-notch-right-side"
          notch="up"
          animate={animate}
          style={delay(3)}
        >
          <h2 className="text-sm font-semibold">Make it yours</h2>
          <p className="mt-1 text-xs leading-relaxed text-white/70">
            The ⚙ up there toggles all routes at once, station grouping and a
            railway-track overlay.
          </p>
        </TourCard>

        {/* ⑤ Browse hubs: the SEO link block (country/operator/connection pages) */}
        <TourCard
          className="min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:bottom-4 min-[640px]:left-4 min-[640px]:w-[min(92vw,26rem)]"
          animate={animate}
          style={delay(4)}
        >
          <h2 className="text-sm font-semibold">
            Prefer a list? Browse every route
          </h2>
          <div className="mt-1.5">
            <Link
              href="/trains"
              className="text-xs font-semibold text-primary-green hover:text-primary-green-light"
            >
              All night train routes →
            </Link>
          </div>
          <div className="mt-2 max-h-40 min-[640px]:max-h-[40vh] overflow-y-auto pr-1">
            {countries.length > 0 && (
              <div>
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                  By country
                </h3>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {countries.map((c) => (
                    <Link
                      key={c.slug}
                      href={`/night-trains/${c.slug}`}
                      className={chipClass}
                    >
                      <span className="mr-1">{getFlagEmoji(c.code)}</span>
                      {c.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {operators.length > 0 && (
              <div className="mt-2.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                  By operator
                </h3>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {operators.map((o) => (
                    <Link
                      key={o.slug}
                      href={`/operators/${o.slug}`}
                      className={chipClass}
                    >
                      {o.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {connections.length > 0 && (
              <div className="mt-2.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                  Popular connections
                </h3>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {connections.map((p) => (
                    <Link
                      key={p.slug}
                      href={`/connections/${p.slug}`}
                      className={chipClass}
                    >
                      {p.label}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 border-t border-white/10 pt-2">
            <Link
              href="/about"
              className="text-xs text-white/50 hover:text-white transition-colors"
            >
              About this map
            </Link>
          </div>
        </TourCard>

        {/* ⑥ Map legend — lives here since the "i" button now opens the tour */}
        <TourCard
          className="min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:bottom-4 min-[640px]:right-4 min-[640px]:w-72"
          animate={animate}
          style={delay(5)}
        >
          <h2 className="text-sm font-semibold">Map legend</h2>
          <div className="mt-2 max-h-40 min-[640px]:max-h-[45vh] overflow-y-auto pr-1">
            <Legend variant="panel" />
          </div>
        </TourCard>
      </div>
    </div>
  );
}
