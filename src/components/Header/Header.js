import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FaBars, FaEyeSlash, FaInfo, FaLayerGroup, FaRoute, FaExternalLinkAlt, FaCog, FaTrain } from "react-icons/fa";

import Container from "@components/Container";
import Legend from "@components/Legend";
import StationSearchBar from "../Map/components/StationSearchBar";

import { HEADER_HEIGHT } from "../../constants/header";

// Shared toggle config rendered both in the desktop Settings popover and the mobile ≡ menu.
const SETTINGS_CONTROLS = [
  {
    id: "showRoutes",
    label: "Show all routes",
    icon: <FaRoute size={14} />,
    getValue: (p) => p.showRoutes,
    toggle: (p) => p.setShowRoutes(!p.showRoutes),
  },
  {
    id: "hideVia",
    label: "Hide intermediate stations",
    icon: <FaEyeSlash size={14} />,
    getValue: (p) => p.hideIntermediateStations,
    toggle: (p) => p.setHideIntermediateStations(!p.hideIntermediateStations),
  },
  {
    id: "group",
    label: "Group stations",
    icon: <FaLayerGroup size={14} />,
    getValue: (p) => p.isGrouped,
    toggle: (p) => p.setIsGrouped(!p.isGrouped),
  },
  {
    id: "railwayOverlay",
    label: "OpenRailwayMap overlay",
    icon: <FaTrain size={14} />,
    getValue: (p) => p.showRailwayOverlay,
    toggle: (p) => p.setShowRailwayOverlay(!p.showRailwayOverlay),
  },
];

// Full-width switch row used inside the Settings popover and the mobile menu.
const ControlRow = ({ label, icon, isActive, onClick }) => (
  <button
    type="button"
    role="switch"
    aria-checked={isActive}
    aria-label={label}
    onClick={onClick}
    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
  >
    <span className="text-white/60">{icon}</span>
    <span className="flex-1">{label}</span>
    <span
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        isActive ? "bg-emerald-500" : "bg-white/25"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          isActive ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </span>
  </button>
);

function usePopover() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (panelRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return { open, setOpen, panelRef, buttonRef };
}

const Header = ({
  isGrouped,
  setIsGrouped,
  showRoutes,
  setShowRoutes,
  hideIntermediateStations,
  setHideIntermediateStations,
  showRailwayOverlay,
  setShowRailwayOverlay,
  stops,
  stopsLoading,
  onSearchSelect,
}) => {
  const [mobileTooltipId, setMobileTooltipId] = useState(null);
  const [mobileTooltipSession, setMobileTooltipSession] = useState(0);
  const legend = usePopover();
  const mobileMenu = usePopover();
  const settings = usePopover();

  const props = { isGrouped, setIsGrouped, showRoutes, setShowRoutes, hideIntermediateStations, setHideIntermediateStations, showRailwayOverlay, setShowRailwayOverlay };

  const showMobileTooltip = useCallback((id) => {
    setMobileTooltipId(id);
    setMobileTooltipSession((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!mobileTooltipId) return undefined;
    const timerId = setTimeout(() => setMobileTooltipId(null), 2000);
    return () => clearTimeout(timerId);
  }, [mobileTooltipId, mobileTooltipSession]);

  return (
    <header
      className={`h-[${HEADER_HEIGHT}px] bg-black px-2 py-2 min-[640px]:px-4 text-white`}
      style={{ position: "relative", zIndex: 1002 }}
    >
      <Container className="flex flex-wrap justify-between items-center gap-y-2 gap-x-2">
        <p className="text-sm leading-none whitespace-nowrap min-[640px]:text-base shrink-0">
          <Link href="/">
            Pingwi <i>sleeper train</i> map
          </Link>
        </p>
        {onSearchSelect && (
          <div className="flex-1 min-w-0 max-w-xs mx-2 hidden sm:block">
            <StationSearchBar
              stops={stops}
              isLoading={stopsLoading}
              onSelect={onSearchSelect}
            />
          </div>
        )}
        <div className="ml-auto flex min-w-0 shrink-0 flex-wrap items-center justify-end list-none gap-2 min-[640px]:gap-3">

          {/* Mobile: single ≡ button opening controls + about — hidden on sm+ */}
          <div className="relative shrink-0 min-[640px]:hidden">
            <button
              ref={mobileMenu.buttonRef}
              type="button"
              onClick={() => mobileMenu.setOpen((v) => !v)}
              className={`icon-toggle-button ${mobileMenu.open ? "is-active" : ""}`}
              aria-expanded={mobileMenu.open}
              aria-controls="mobile-controls-menu"
              aria-label="Map controls"
            >
              <FaBars size={14} />
            </button>
            {mobileMenu.open ? (
              <div
                ref={mobileMenu.panelRef}
                id="mobile-controls-menu"
                className="fixed right-2 z-[1003] w-[min(calc(100vw-1rem),22rem)] rounded-lg border border-white/15 bg-zinc-900 p-4 shadow-xl"
                style={{ top: HEADER_HEIGHT + 8 }}
                role="dialog"
                aria-label="Map controls"
              >
                <div className="flex flex-col gap-1">
                  {SETTINGS_CONTROLS.map((c) => (
                    <ControlRow
                      key={c.id}
                      label={c.label}
                      icon={c.icon}
                      isActive={c.getValue(props)}
                      onClick={() => c.toggle(props)}
                    />
                  ))}
                </div>
                <div className="mt-3 flex flex-col gap-2 border-t border-white/15 pt-3">
                  <Link
                    href="/trains"
                    className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-sky-400 underline decoration-sky-400 underline-offset-2 hover:text-sky-300"
                  >
                    <FaRoute size={10} />
                    Browse all night train routes
                  </Link>
                  <Link
                    href="/about"
                    className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-sky-400 underline decoration-sky-400 underline-offset-2 hover:text-sky-300"
                  >
                    <FaExternalLinkAlt size={10} />
                    About this map
                  </Link>
                </div>
              </div>
            ) : null}
          </div>

          {/* Desktop: settings gear opening a popover with all toggles — hidden on mobile */}
          <div className="relative hidden min-[640px]:block shrink-0">
            <button
              ref={settings.buttonRef}
              type="button"
              onClick={() => settings.setOpen((v) => !v)}
              className={`icon-toggle-button shrink-0 ${settings.open ? "is-active" : ""}`}
              aria-expanded={settings.open}
              aria-controls="map-settings-popover"
              aria-label="Map settings"
              data-tooltip="Map settings"
            >
              <FaCog size={14} />
            </button>
            {settings.open ? (
              <div
                ref={settings.panelRef}
                id="map-settings-popover"
                className="fixed right-2 min-[640px]:right-4 z-[1003] w-[min(calc(100vw-1rem),20rem)] rounded-lg border border-white/15 bg-zinc-900 p-3 shadow-xl"
                style={{ top: HEADER_HEIGHT + 8 }}
                role="dialog"
                aria-label="Map settings"
              >
                <div className="flex flex-col gap-1">
                  {SETTINGS_CONTROLS.map((c) => (
                    <ControlRow
                      key={c.id}
                      label={c.label}
                      icon={c.icon}
                      isActive={c.getValue(props)}
                      onClick={() => c.toggle(props)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Legend button */}
          <div className="relative shrink-0">
            <button
              ref={legend.buttonRef}
              type="button"
              onClick={() => { legend.setOpen((v) => !v); showMobileTooltip("mapLegend"); }}
              className={`icon-toggle-button shrink-0 ${
                mobileTooltipId === "mapLegend" ? "icon-toggle-button--show-tooltip-mobile" : ""
              } ${legend.open ? "is-active" : ""}`}
              aria-expanded={legend.open}
              aria-controls="map-legend-popover"
              aria-label="Map legend"
              data-tooltip="Map legend"
            >
              <FaInfo size={14} />
            </button>
            {legend.open ? (
              <div
                ref={legend.panelRef}
                id="map-legend-popover"
                className="fixed bottom-2 right-2 min-[640px]:bottom-4 min-[640px]:right-4 z-[1003] w-[min(calc(100vw-1rem),22rem)] overflow-y-auto overscroll-contain rounded-lg border border-white/15 bg-zinc-900 p-4 shadow-xl"
                style={{ top: HEADER_HEIGHT + 16 }}
                role="dialog"
                aria-label="Map legend"
              >
                <Legend variant="panel" />
              </div>
            ) : null}
          </div>

          {/* Browse routes + About — hidden on mobile (surfaced in mobile controls menu instead) */}
          <div className="hidden min-[640px]:flex shrink-0 items-center gap-1.5 min-[640px]:gap-2">
            <Link
              href="/trains"
              className="icon-toggle-button"
              aria-label="Browse all night train routes"
              data-tooltip="All night train routes"
            >
              <FaRoute size={14} />
            </Link>
            <Link
              href="/about"
              className="icon-toggle-button"
              aria-label="About this map"
              data-tooltip="About this map"
            >
              <FaExternalLinkAlt size={12} />
            </Link>
          </div>
        </div>
      </Container>
    </header>
  );
};

export default Header;
