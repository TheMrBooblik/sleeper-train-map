import Link from "../Link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FaBars,
  FaEyeSlash,
  FaInfo,
  FaLayerGroup,
  FaRoute,
  FaExternalLinkAlt,
  FaCog,
  FaTrain,
  FaSearch,
  FaMapMarkerAlt,
  FaRegCalendarAlt,
  FaMoon,
  FaSun,
  FaAdjust,
} from "react-icons/fa";

import Container from "@components/Container";
import Legend from "@components/Legend";
import StationSearchBar from "../Map/components/StationSearchBar";
import MobileSearchOverlay from "../Map/components/MobileSearchOverlay";

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
    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
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

const THEME_OPTIONS = [
  { value: "system", label: "Auto", icon: <FaAdjust size={12} /> },
  { value: "light", label: "Light", icon: <FaSun size={12} /> },
  { value: "dark", label: "Dark", icon: <FaMoon size={12} /> },
];

// Map theme picker: a three-way radio group under the toggles. "Auto" follows
// the OS setting, so it is the default and the honest label for it.
// `idSuffix` keeps the label id unique — both menus may be in the DOM.
const ThemeRow = ({ value, onChange, idSuffix }) => (
  <div className="mt-1 border-t border-white/15 px-3 pt-3 pb-1">
    <div id={`map-theme-label-${idSuffix}`} className="mb-2 text-xs text-white/60">
      Map theme
    </div>
    <div
      role="radiogroup"
      aria-labelledby={`map-theme-label-${idSuffix}`}
      className="grid grid-cols-3 gap-1 rounded-lg bg-white/10 p-1"
    >
      {THEME_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm transition-colors ${
              active
                ? "bg-white/25 text-white"
                : "text-white/60 hover:bg-white/10 hover:text-white"
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  </div>
);

function usePopover() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (
        panelRef.current?.contains(e.target) ||
        buttonRef.current?.contains(e.target)
      )
        return;
      setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
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
  themePreference,
  setThemePreference,
  stops,
  stopsLoading,
  onSearchSelect,
  onToggleTour,
  tourOpen,
  legendPulse,
  onNearbyOpen,
}) => {
  const [mobileTooltipId, setMobileTooltipId] = useState(null);
  const [mobileTooltipSession, setMobileTooltipSession] = useState(0);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const legend = usePopover();
  const mobileMenu = usePopover();
  const settings = usePopover();

  const props = {
    isGrouped,
    setIsGrouped,
    showRoutes,
    setShowRoutes,
    hideIntermediateStations,
    setHideIntermediateStations,
    showRailwayOverlay,
    setShowRailwayOverlay,
  };

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
      className={`h-[${HEADER_HEIGHT}px] bg-black px-2 py-2 md:px-4 text-white`}
      style={{ position: "relative", zIndex: 1002 }}
    >
      <Container className="flex flex-wrap justify-between items-center gap-y-2 gap-x-2">
        <h2 className="text-sm leading-none whitespace-nowrap md:text-base shrink-0">
          {/* Negative margin keeps the header height while giving the link a
              taller hit area than its 16px text box. */}
          <Link href="/" className="-my-2.5 inline-block py-2.5">
            Pingwi <i>sleeper train</i> map
          </Link>
        </h2>
        {onSearchSelect && (
          <div className="flex-1 min-w-0 max-w-xs mx-2 hidden md:block">
            <StationSearchBar
              stops={stops}
              isLoading={stopsLoading}
              onSelect={onSearchSelect}
            />
          </div>
        )}
        <div className="ml-auto flex min-w-0 shrink-0 flex-wrap items-center justify-end list-none gap-2 md:gap-3">
          {/* Mobile search — opens a full-screen overlay (desktop keeps the header bar).
              `md:hidden` must sit on this wrapper, NOT on the button: the
              unlayered `.icon-toggle-button { display: inline-flex }` rule in
              globals.css beats Tailwind's layered utilities, so `md:hidden` on
              the button itself does nothing. Same pattern as the ≡ menu below. */}
          {onSearchSelect && (
            <div className="md:hidden shrink-0">
              <button
                type="button"
                onClick={() => setMobileSearchOpen(true)}
                className={`icon-toggle-button ${
                  mobileSearchOpen ? "is-active" : ""
                }`}
                aria-label="Search stations"
                data-tooltip="Search stations"
              >
                <FaSearch size={14} />
              </button>
            </div>
          )}

          {/* Mobile: single ≡ button opening controls + about — hidden on md+ */}
          <div className="relative shrink-0 md:hidden">
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
                {setThemePreference && (
                  <ThemeRow
                    idSuffix="mobile"
                    value={themePreference}
                    onChange={setThemePreference}
                  />
                )}
                {/* Same 44px full-width row geometry as the toggles above —
                    these were 16px-tall inline links, too small to tap. */}
                <div className="mt-2 flex flex-col gap-0.5 border-t border-white/15 pt-2">
                  {onNearbyOpen && (
                    <button
                      type="button"
                      onClick={() => {
                        mobileMenu.setOpen(false);
                        onNearbyOpen();
                      }}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium text-sky-400 transition-colors hover:bg-white/10 hover:text-sky-300"
                    >
                      <span className="text-sky-400/70">
                        <FaMapMarkerAlt size={14} />
                      </span>
                      Trains near me
                    </button>
                  )}
                  <Link
                    href="/plan"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-sky-400 transition-colors hover:bg-white/10 hover:text-sky-300"
                  >
                    <span className="text-sky-400/70">
                      <FaRegCalendarAlt size={14} />
                    </span>
                    Plan a trip
                  </Link>
                  <Link
                    href="/connections"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-sky-400 transition-colors hover:bg-white/10 hover:text-sky-300"
                  >
                    <span className="text-sky-400/70">
                      <FaRoute size={14} />
                    </span>
                    Browse all night train routes
                  </Link>
                  <Link
                    href="/about"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-sky-400 transition-colors hover:bg-white/10 hover:text-sky-300"
                  >
                    <span className="text-sky-400/70">
                      <FaExternalLinkAlt size={14} />
                    </span>
                    About this map
                  </Link>
                </div>
              </div>
            ) : null}
          </div>

          {/* Desktop: settings gear opening a popover with all toggles — hidden on mobile */}
          <div className="relative hidden md:block shrink-0">
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
                className="fixed right-2 md:right-4 z-[1003] w-[min(calc(100vw-1rem),20rem)] rounded-lg border border-white/15 bg-zinc-900 p-3 shadow-xl"
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
                {setThemePreference && (
                  <ThemeRow
                    idSuffix="desktop"
                    value={themePreference}
                    onChange={setThemePreference}
                  />
                )}
              </div>
            ) : null}
          </div>

          {/* Info button: toggles the welcome tour (which includes the legend
              card). Falls back to the legend popover on pages without a tour. */}
          <div className="relative shrink-0">
            <button
              ref={legend.buttonRef}
              type="button"
              onClick={() => {
                if (onToggleTour) {
                  onToggleTour();
                } else {
                  legend.setOpen((v) => !v);
                }
                showMobileTooltip("mapLegend");
              }}
              className={`icon-toggle-button shrink-0 ${
                mobileTooltipId === "mapLegend"
                  ? "icon-toggle-button--show-tooltip-mobile"
                  : ""
              } ${(onToggleTour ? tourOpen : legend.open) ? "is-active" : ""} ${
                legendPulse ? "icon-toggle-button--attention" : ""
              }`}
              aria-expanded={onToggleTour ? !!tourOpen : legend.open}
              aria-controls={onToggleTour ? undefined : "map-legend-popover"}
              aria-label="Map legend"
              data-tooltip="Map legend"
            >
              <FaInfo size={14} />
            </button>
            {!onToggleTour && legend.open ? (
              <div
                ref={legend.panelRef}
                id="map-legend-popover"
                className="fixed bottom-2 right-2 md:bottom-4 md:right-4 z-[1003] w-[min(calc(100vw-1rem),22rem)] overflow-y-auto overscroll-contain rounded-lg border border-white/15 bg-zinc-900 p-4 shadow-xl"
                style={{ top: HEADER_HEIGHT + 16 }}
                role="dialog"
                aria-label="Map legend"
              >
                <Legend variant="panel" />
              </div>
            ) : null}
          </div>

          {/* Browse routes + About — hidden on mobile (surfaced in mobile controls menu instead) */}
          <div className="hidden md:flex shrink-0 items-center gap-1.5 md:gap-2">
            <Link
              href="/connections"
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

      {onSearchSelect && (
        <MobileSearchOverlay
          open={mobileSearchOpen}
          onClose={() => setMobileSearchOpen(false)}
          stops={stops}
          isLoading={stopsLoading}
          onSelect={onSearchSelect}
        />
      )}
    </header>
  );
};

export default Header;
