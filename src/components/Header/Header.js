import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FaEyeSlash, FaInfo, FaLayerGroup, FaRoute } from "react-icons/fa";

import Container from "@components/Container";
import Legend from "@components/Legend";

import { HEADER_HEIGHT } from "../../constants/header";

// label: shown next to icon on desktop (1280px+). ariaLabel: full phrase for a11y / mobile tooltip.
const IconToggleButton = ({
  isActive,
  label,
  ariaLabel,
  onClick,
  icon,
  showMobileTooltip = false,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`icon-toggle-button icon-toggle-button--labeled whitespace-nowrap ${
      showMobileTooltip ? "icon-toggle-button--show-tooltip-mobile" : ""
    } ${isActive ? "is-active" : ""}`}
    aria-label={ariaLabel || label}
    data-tooltip={ariaLabel || label}
  >
    {icon}
    <span className="hidden min-[1280px]:inline text-xs font-medium leading-none whitespace-nowrap">
      {label}
    </span>
  </button>
);

const Header = ({
  setLayerType,
  layerType,
  isGrouped,
  setIsGrouped,
  showRoutes,
  setShowRoutes,
  hideIntermediateStations,
  setHideIntermediateStations,
}) => {
  const [mobileTooltipId, setMobileTooltipId] = useState(null);
  const [mobileTooltipSession, setMobileTooltipSession] = useState(0);
  const [mapLegendOpen, setMapLegendOpen] = useState(false);
  const legendPanelRef = useRef(null);
  const legendButtonRef = useRef(null);

  const showMobileTooltip = useCallback((id) => {
    setMobileTooltipId(id);
    // Ensure repeated taps on the same button reset the 2s timer.
    setMobileTooltipSession((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!mobileTooltipId) return undefined;
    const timerId = setTimeout(() => {
      setMobileTooltipId(null);
    }, 2000);
    return () => clearTimeout(timerId);
  }, [mobileTooltipId, mobileTooltipSession]);

  // Close map legend popover on outside click or Escape (same panel on all breakpoints).
  useEffect(() => {
    if (!mapLegendOpen) return undefined;

    const onPointerDown = (event) => {
      const panel = legendPanelRef.current;
      const btn = legendButtonRef.current;
      const t = event.target;
      if (panel?.contains(t) || btn?.contains(t)) return;
      setMapLegendOpen(false);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") setMapLegendOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [mapLegendOpen]);

  return (
    <header
      className={`h-[${HEADER_HEIGHT}px] bg-black px-2 py-2 min-[640px]:px-4 text-white`}
      style={{ position: "relative", zIndex: 1002 }}
    >
      <Container className="flex flex-wrap justify-between items-center gap-y-2 gap-x-2">
        <p className="text-sm leading-none whitespace-nowrap min-[640px]:text-base">
          <Link href="/">
            Pingwi <i>night trains</i> map
          </Link>
        </p>
        <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end list-none gap-2 min-[640px]:gap-3">
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 min-[640px]:gap-2">
            <IconToggleButton
              isActive={showRoutes}
              label="All routes"
              ariaLabel="Show all routes"
              onClick={() => {
                setShowRoutes(!showRoutes);
                showMobileTooltip("showRoutes");
              }}
              showMobileTooltip={mobileTooltipId === "showRoutes"}
              icon={<FaRoute size={14} />}
            />
            <IconToggleButton
              isActive={hideIntermediateStations}
              label="Hide via stations"
              ariaLabel="Hide intermediate stations"
              onClick={() => {
                setHideIntermediateStations(!hideIntermediateStations);
                showMobileTooltip("hideIntermediateStations");
              }}
              showMobileTooltip={mobileTooltipId === "hideIntermediateStations"}
              icon={<FaEyeSlash size={14} />}
            />
            <IconToggleButton
              isActive={isGrouped}
              label="Group stations"
              ariaLabel="Group stations"
              onClick={() => {
                setIsGrouped(!isGrouped);
                showMobileTooltip("groupStations");
              }}
              showMobileTooltip={mobileTooltipId === "groupStations"}
              icon={<FaLayerGroup size={14} />}
            />
          </div>

          <div className="relative shrink-0">
            <button
              ref={legendButtonRef}
              type="button"
              onClick={() => {
                setMapLegendOpen((v) => !v);
                showMobileTooltip("mapLegend");
              }}
              className={`icon-toggle-button shrink-0 ${
                mobileTooltipId === "mapLegend"
                  ? "icon-toggle-button--show-tooltip-mobile"
                  : ""
              } ${mapLegendOpen ? "is-active" : ""}`}
              aria-expanded={mapLegendOpen}
              aria-controls="map-legend-popover"
              aria-label="Map legend"
              data-tooltip="Map legend"
            >
              <FaInfo size={14} />
            </button>
            {mapLegendOpen ? (
              <div
                ref={legendPanelRef}
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
        </div>
      </Container>
    </header>
  );
};

export default Header;
