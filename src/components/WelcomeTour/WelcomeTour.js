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
 * reveal so the cards don't compete with the initial-data loading overlay.
 * The region is invisible by default (opacity-0) and only reveals on "enter",
 * so there's no flash of the tour before data has loaded:
 *   "static"  — SSR + first client render: hidden (in DOM for SEO), no animation
 *   "waiting" — client, data still loading: hidden
 *   "enter"   — data ready: region reveals and cards pop in with a small stagger
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
  const sheetRef = useRef(null);
  // Tracks a downward drag on the sheet header to dismiss (mobile only).
  const dragRef = useRef({ active: false, startY: 0, pointerId: null });

  const onSheetDragStart = (e) => {
    if (window.matchMedia("(min-width: 768px)").matches) return;
    if ((sheetRef.current?.scrollTop ?? 0) > 0) return;
    dragRef.current = {
      active: true,
      startY: e.clientY,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onSheetDragMove = (e) => {
    if (!dragRef.current.active || !sheetRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    if (dy <= 0 || sheetRef.current.scrollTop > 0) {
      sheetRef.current.style.transform = "";
      return;
    }
    sheetRef.current.style.transition = "none";
    sheetRef.current.style.transform = `translateY(${dy}px)`;
  };

  const onSheetDragEnd = (e) => {
    if (!dragRef.current.active || !sheetRef.current) return;
    const dy = e.clientY - dragRef.current.startY;
    dragRef.current.active = false;
    sheetRef.current.style.transition = "";
    sheetRef.current.style.transform = "";
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (dy > 72) onDismiss?.();
  };

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
        // Hidden by default (SSR + "static" + "waiting"): the content stays in
        // the DOM for SEO/crawlers, but is invisible until data is ready. This
        // avoids the flash where the tour showed briefly then hid while loading.
        phase === "enter" ? "" : "opacity-0"
      }`}
    >
      {/* Mobile (<768px): scrollable bottom sheet — drag handle and the primary
          CTA stay pinned (sticky top/bottom) so they are reachable at any scroll
          offset; SEO cards (browse hubs, legend) stay in DOM below the fold.
          Desktop: the wrapper dissolves and cards break out to absolute anchors. */}
      <div
        ref={sheetRef}
        className="tour-mobile-sheet pointer-events-auto absolute inset-x-0 bottom-0 max-h-[65vh] overflow-y-auto overscroll-y-contain rounded-t-2xl border-t border-white/10 bg-black/95 backdrop-blur-lg shadow-2xl md:pointer-events-none md:static md:max-h-none md:overflow-visible md:rounded-none md:border-t-0 md:bg-transparent md:backdrop-blur-none md:shadow-none"
      >
        {/* Mobile-only sticky header: drag down to close + X button. */}
        <div
          className="tour-sheet-drag sticky top-0 z-10 flex touch-none cursor-grab active:cursor-grabbing items-center justify-center border-b border-white/10 bg-black/95 px-4 py-3 md:hidden"
          onPointerDown={onSheetDragStart}
          onPointerMove={onSheetDragMove}
          onPointerUp={onSheetDragEnd}
          onPointerCancel={onSheetDragEnd}
        >
          <div className="h-1 w-10 rounded-full bg-white/30" aria-hidden />
          <button
            type="button"
            onClick={onDismiss}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close tour"
            className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-5 w-5"
              aria-hidden
            >
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="px-4 max-md:divide-y max-md:divide-white/10 md:space-y-0 md:p-0">
          {/* ① Hero: the crawlable h1 + primary dismiss */}
          <TourCard
            className="md:pointer-events-auto md:absolute md:top-4 md:left-16 md:w-80"
            animate={animate}
            style={delay(0)}
          >
            <h1 className="text-base font-bold tracking-tight">
              Night Train Map
            </h1>
            <p className="mt-1.5 text-xs leading-relaxed text-white/70">
              {routeCount} night and sleeper train routes across {countryCount}{" "}
              countries, with timetables, stops and booking links. The map is
              live — go poke it.
            </p>
          </TourCard>

          {/* ② Station dots explainer — sits just BELOW a big endpoint dot
            (≈München at the default view) so the up-notch on top points at it.
            The initial centre is fixed, so the calc() offsets hold. */}
          <TourCard
            className="md:pointer-events-auto md:absolute md:left-[calc(50%-61px)] md:top-[calc(50%+62px)] md:w-64"
            notch="up"
            animate={animate}
            style={delay(1)}
          >
            <h2 className="text-sm font-semibold">Click any glowing dot</h2>
            <ul className="mt-1.5 space-y-1.5 text-xs leading-relaxed text-white/70">
              <li className="flex items-start gap-1.5">
                <div
                  className="mt-0.5 h-3 w-3 shrink-0 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] bg-gradient-to-br from-[#2196f3] to-[#1976d2] min-[1280px]:mt-1 min-[1280px]:h-3.5 min-[1280px]:w-3.5"
                  aria-hidden
                />
                <span>
                  Big <span className="text-sky-400">blue dots</span> are route
                  endpoints — cities where night trains start or end.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <div
                  className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] bg-gradient-to-br from-[#4caf50] to-[#388e3c] min-[1280px]:mt-1 min-[1280px]:h-3 min-[1280px]:w-3"
                  aria-hidden
                />
                <span>
                  Small <span className="text-green-400">green dots</span> are
                  intermediate stops along the way.
                </span>
              </li>
              <li>
                An <span className="text-orange-400">orange badge</span> bundles
                nearby stations, possible to split them in the settings.
              </li>
            </ul>
          </TourCard>

          {/* ③ Search hint — on mobile the search icon is in the header */}
          <TourCard
            className="md:pointer-events-auto md:absolute md:top-2 md:left-[25rem] md:w-56"
            notch="up"
            animate={animate}
            style={delay(2)}
          >
            <h2 className="text-sm font-semibold">Find your station</h2>
            <p className="mt-1 text-xs leading-relaxed text-white/70">
              Tap the search icon in the header (or type in the bar on desktop)
              to jump straight to any city or station.
            </p>
          </TourCard>

          {/* ④ Settings hint (desktop only: the gear is hidden on mobile) */}
          <TourCard
            className="hidden md:block md:pointer-events-auto md:absolute md:top-2 md:right-35 md:w-60 tour-notch-right-side"
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
            className="md:pointer-events-auto md:absolute md:bottom-4 md:left-4 md:w-[min(92vw,26rem)]"
            animate={animate}
            style={delay(4)}
          >
            <h2 className="text-sm font-semibold">
              Prefer a list? Browse every route
            </h2>
            <div className="mt-1.5">
              <Link
                href="/trains"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold text-primary-green hover:text-primary-green-light"
              >
                All night train routes →
              </Link>
            </div>
            <div className="mt-2 md:max-h-[40vh] md:overflow-y-auto md:pr-1">
              {countries.length > 0 && (
                <div>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    By country
                  </h3>
                  {/* Mobile: swipeable row; desktop: wrapped chip grid. */}
                  <div className="tour-country-carousel mt-1.5 flex gap-1.5 max-md:-mx-3 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-3 max-md:pb-0.5 md:flex-wrap">
                    {countries.map((c) => (
                      <Link
                        key={c.slug}
                        href={`/night-trains/${c.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${chipClass} shrink-0`}
                      >
                        <span className="mr-1">{getFlagEmoji(c.code)}</span>
                        {c.name}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {operators.length > 0 && (
                <div className="mt-2.5 hidden md:block">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    By operator
                  </h3>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {operators.map((o) => (
                      <Link
                        key={o.slug}
                        href={`/operators/${o.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={chipClass}
                      >
                        {o.name}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {connections.length > 0 && (
                <div className="mt-2.5 hidden md:block">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    Popular connections
                  </h3>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {connections.map((p) => (
                      <Link
                        key={p.key || p.slug}
                        href={p.href || `/connections/${p.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
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
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-white/50 hover:text-white transition-colors"
              >
                About this map
              </Link>
            </div>
          </TourCard>

          {/* ⑥ Map legend — lives here since the "i" button now opens the tour */}
          <TourCard
            className="md:pointer-events-auto md:absolute md:bottom-4 md:right-4 md:w-72"
            animate={animate}
            style={delay(5)}
          >
            <h2 className="text-sm font-semibold">Map legend</h2>
            <div className="mt-2 md:max-h-[45vh] md:overflow-y-auto md:pr-1">
              <Legend variant="panel" />
            </div>
            {/* Mobile gets this CTA pinned to the sheet instead (see below), so
                it is reachable without scrolling past every card. */}
            <button
              type="button"
              onClick={onDismiss}
              className="mt-3 hidden w-full cursor-pointer rounded-lg bg-primary-green px-3 py-2 text-sm font-semibold text-black hover:bg-primary-green-light transition-colors md:block"
            >
              Start exploring →
            </button>
          </TourCard>
        </div>

        {/* Mobile-only pinned CTA: the tour is a tall scroll, so the primary
            dismiss must not depend on reaching the last card. */}
        <div className="sticky bottom-0 z-10 border-t border-white/10 bg-black/95 px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={onDismiss}
            className="w-full cursor-pointer rounded-lg bg-primary-green px-3 py-2.5 text-sm font-semibold text-black hover:bg-primary-green-light transition-colors"
          >
            Start exploring →
          </button>
        </div>
      </div>
    </div>
  );
}
