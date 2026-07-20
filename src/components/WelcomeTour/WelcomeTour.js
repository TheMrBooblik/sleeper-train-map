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
  const sheetRef = useRef(null);
  // Tracks a downward drag on the sheet header to dismiss (mobile only).
  const dragRef = useRef({ active: false, startY: 0, pointerId: null });

  const onSheetDragStart = (e) => {
    if (window.matchMedia("(min-width: 640px)").matches) return;
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
        phase === "waiting" ? "opacity-0" : ""
      }`}
    >
      {/* Mobile (<640px): compact scrollable bottom sheet — hero + close visible
          by default; SEO cards (browse hubs, legend) stay in DOM below the fold.
          Desktop: the wrapper dissolves and cards break out to absolute anchors. */}
      <div
        ref={sheetRef}
        className="tour-mobile-sheet pointer-events-auto absolute inset-x-0 bottom-0 max-h-[42vh] overflow-y-auto overscroll-y-contain rounded-t-2xl border-t border-white/10 bg-black/90 shadow-2xl min-[640px]:pointer-events-none min-[640px]:static min-[640px]:max-h-none min-[640px]:overflow-visible min-[640px]:rounded-none min-[640px]:border-t-0 min-[640px]:bg-transparent min-[640px]:shadow-none"
      >
        {/* Mobile-only sticky header: drag down to close + X button. */}
        <div
          className="tour-sheet-drag sticky top-0 z-10 flex touch-none cursor-grab active:cursor-grabbing items-center justify-center border-b border-white/10 bg-black/90 px-4 py-3 min-[640px]:hidden"
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

        <div className="space-y-2 px-3 pb-3 min-[640px]:space-y-0 min-[640px]:p-0">
          {/* ① Hero: the crawlable h1 + primary dismiss */}
          <TourCard
            className="min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:top-4 min-[640px]:left-16 min-[640px]:w-80"
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
            className="min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:left-[calc(50%-61px)] min-[640px]:top-[calc(50%+62px)] min-[640px]:w-64"
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
            className="hidden min-[640px]:block min-[640px]:pointer-events-auto min-[640px]:absolute min-[640px]:top-2 min-[640px]:right-35 min-[640px]:w-60 tour-notch-right-side"
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
            <div className="mt-2 min-[640px]:max-h-[40vh] min-[640px]:overflow-y-auto min-[640px]:pr-1">
              {countries.length > 0 && (
                <div>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    By country
                  </h3>
                  {/* Mobile: swipeable row; desktop: wrapped chip grid. */}
                  <div className="tour-country-carousel mt-1.5 flex gap-1.5 max-[639px]:-mx-3 max-[639px]:flex-nowrap max-[639px]:overflow-x-auto max-[639px]:px-3 max-[639px]:pb-0.5 min-[640px]:flex-wrap">
                    {countries.map((c) => (
                      <Link
                        key={c.slug}
                        href={`/night-trains/${c.slug}`}
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
                <div className="mt-2.5 hidden min-[640px]:block">
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
                <div className="mt-2.5 hidden min-[640px]:block">
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
            <div className="mt-2 min-[640px]:max-h-[45vh] min-[640px]:overflow-y-auto min-[640px]:pr-1">
              <Legend variant="panel" />
            </div>
            <button
              type="button"
              onClick={onDismiss}
              className="mt-3 w-full cursor-pointer rounded-lg bg-primary-green px-3 py-2 text-sm font-semibold text-black hover:bg-primary-green-light transition-colors"
            >
              Start exploring →
            </button>
          </TourCard>
        </div>
      </div>
    </div>
  );
}
