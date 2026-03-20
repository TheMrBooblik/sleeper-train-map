import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
    } ${
      isActive ? "is-active" : ""
    }`}
    aria-label={ariaLabel || label}
    data-tooltip={ariaLabel || label}
    title={ariaLabel || label}
  >
    {icon}
    <span className="hidden min-[1280px]:inline text-xs font-medium leading-none whitespace-nowrap">
      {label}
    </span>
  </button>
);

const Header = ({
  setModalIsOpen,
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

  return (
    <header
      className={`h-[${HEADER_HEIGHT}px] bg-black px-2 py-2 min-[640px]:px-4 text-white`}
      style={{ position: "relative", zIndex: 1002 }}
    >
      <Container className="flex justify-between items-center gap-2">
        <p className="text-sm leading-none whitespace-nowrap min-[640px]:text-base">
          <Link href="/">
            Pingwi <i>night trains</i> map
          </Link>
        </p>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end list-none gap-2 min-[640px]:gap-3 min-[1280px]:gap-3">
          <div className="flex min-w-0 shrink items-center gap-1.5 min-[640px]:gap-2">
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
                setHideIntermediateStations(!hideIntermediateStations)
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

          <div className="hidden min-[1280px]:flex min-w-0 shrink-0 items-center">
            <Legend />
          </div>
          <button
            type="button"
            onClick={() => {
              setModalIsOpen(true);
              showMobileTooltip("info");
            }}
            className={`icon-toggle-button shrink-0 ${
              mobileTooltipId === "info"
                ? "icon-toggle-button--show-tooltip-mobile"
                : ""
            }`}
            aria-label="Open info"
            data-tooltip="Open info"
            title="Open info"
          >
            <FaInfo size={14} />
          </button>
        </div>
      </Container>
    </header>
  );
};

export default Header;
