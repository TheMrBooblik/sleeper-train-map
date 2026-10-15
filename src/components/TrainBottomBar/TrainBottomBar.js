"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  buildRouteColorMap,
  NEUTRAL_FALLBACK_COLOR,
} from "../Map/utils/operatorColors";
import {
  normalizeStationNameForDisplay,
  abbreviateStationName,
} from "../Map/utils/stationNameUtils";
import {
  hasUnknownStart,
  routeHasNotStartedYet,
  shouldHideRouteDueToFutureDate,
} from "../Map/utils/routeStyleUtils";
import { splitViaString } from "../../lib/viaSplit.mjs";
import { normalizeStationNameForLookup } from "../../lib/stationKey.mjs";
import { orderByPromotion } from "../../lib/operatorPromotion.mjs";
import { liftForDarkMap } from "../../lib/mapTheme.mjs";
import {
  disambiguateLabels,
  selectedCityMatcher,
  stationFirstEndpoints,
} from "../../lib/stationFirst.mjs";

/**
 * Bottom bar showing routes (Back-on-Track + NightJet/EuroNight) for the selected station.
 * Hidden when TrainDetailPanel is open.
 */
const TrainBottomBar = ({
  isOpen,
  sidebarDisabled,
  stopId,
  stopRouteIds,
  selectedNormalizedName,
  isDetailPanelOpen = false,
  onRouteClick,
  onRouteHover,
  onRouteLeave,
  viewMapData,
  trips,
  cities,
  stationCoords,
  isDarkMap = false,
}) => {
  // The "more to the right" fade. It sits on a wrapper that does not scroll:
  // as a ::after of the scroll container it scrolled WITH the chips, and once
  // the bar was scrolled it landed in the middle of one ("Bruxelles ▯idi").
  // Shown only while there is more to scroll, so the last chip is not faded.
  const scrollRef = useRef(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    // A new station starts at the beginning of its list, where the first
    // (promoted, running) trains are.
    if (el) el.scrollLeft = 0;
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [stopId, stopRouteIds, isOpen, isDetailPanelOpen, updateFade]);

  const hideRoute = useCallback(
    (routeId) =>
      shouldHideRouteDueToFutureDate(routeId, trips, viewMapData?.[routeId]),
    [trips, viewMapData],
  );

  // "Is this a station?" for splitting a via string. `cities` is keyed by the
  // same normalizer and already holds whole names rather than fragments, so it
  // is the map's own answer and cannot disagree with what got a marker.
  const isKnownStation = useCallback(
    (name) => !!cities?.[normalizeStationNameForLookup(String(name ?? ""))],
    [cities],
  );

  // A train that does not run yet: never opened ("Postponed to 2027"), or the
  // next timetable's preview row, drawn faded on the map for the same reason.
  const isNotRunning = useCallback(
    (row) =>
      hasUnknownStart(row?.route_id, trips) ||
      (row?.draw_as_active === true && routeHasNotStartedYet(row)),
    [trips],
  );

  // Guard against undefined viewMapData; hide future "From …" and outside service_id seasons.
  // Running trains first, promoted operators' first among them
  // (data/overrides/operator-promotion.json); trains not running yet last.
  // Ordered before the dedup below, so on a shared corridor the promoted
  // operator's route is the one the bar keeps.
  const filteredViewMapData = viewMapData
    ? orderByPromotion(
        Object.values(viewMapData).filter((el) => {
          const routeId = el?.route_id?.toString();
          return stopRouteIds?.includes(routeId) && !hideRoute(routeId);
        }),
        undefined,
        { isNotRunning },
      )
    : [];

  // Is this station in the city the user picked? The same test the via hint
  // below has always used, so the two cannot disagree about "here".
  const inSelectedCity = selectedCityMatcher(
    selectedNormalizedName,
    normalizeStationNameForDisplay,
  );
  const coordsOf = (name) =>
    stationCoords?.get?.(normalizeStationNameForLookup(String(name ?? ""))) ||
    stationCoords?.get?.(name) ||
    null;

  if (sidebarDisabled) return null;
  if (isDetailPanelOpen) return null;
  if (!isOpen) return null;

  const hasBackOnTrackRoutes =
    !!stopRouteIds?.length && filteredViewMapData?.length > 0;

  // Build operator-based color map for these routes (brand colors with shade variation)
  const routeIds = filteredViewMapData
    .map((el) => el?.route_id?.toString())
    .filter(Boolean);
  const routeDataMap = new Map();
  filteredViewMapData.forEach((el) => {
    if (el?.route_id) routeDataMap.set(el.route_id.toString(), el);
  });
  const routeColorMap = buildRouteColorMap(routeIds, routeDataMap);

  // Group routes by origin-destination to avoid duplicates
  // Store route_id to determine color
  const routeMap = new Map();

  filteredViewMapData?.forEach((el) => {
    let stationArr = [el?.origin_trip_0, el?.destination_trip_0];
    stationArr.sort();

    const routeKey = `${stationArr[0]}-${stationArr[1]}`;

    if (!routeMap.has(routeKey)) {
      // From the selected city's own station to where the train takes you
      // (src/lib/stationFirst.mjs): a click on Milan reads "Milano – Bruxelles".
      const ends = stationFirstEndpoints(el, {
        inSelectedCity,
        splitVia: (via) => splitViaString(via, isKnownStation),
        coordsOf,
      });

      // Get the via stations
      const viaStationsRaw = stationArr[1] === stopId ? el?.via_1 : el?.via_0;

      // Filter via stations to only show stations in the selected city.
      // normalizeStationNameForDisplay handles local↔English equivalences (Wien→Vienna, etc.),
      // with a substring fallback for cities not in the known list.
      // Only needed when the label could not start at the selected station.
      let viaText = "";
      if (!ends.fromIsSelected && viaStationsRaw && selectedNormalizedName) {
        // A station whose own name holds " - " must not be shown as two
        // places ("Rocamadour" + "Padirac" for one SNCF stop).
        const viaList = splitViaString(viaStationsRaw, isKnownStation);
        const filteredVia = viaList.filter((station) => {
          const normalizedVia = normalizeStationNameForDisplay(station.trim());
          return (
            normalizedVia === selectedNormalizedName ||
            station.toLowerCase().includes(selectedNormalizedName.toLowerCase())
          );
        });

        if (filteredVia.length > 0) {
          viaText = filteredVia.join(" - ");
        }
      }

      routeMap.set(routeKey, {
        origin: ends.from,
        destination: ends.to,
        trainNumber: (
          el?.[`trip_short_name_${ends.direction}`] ||
          el?.trip_short_name_0 ||
          ""
        ).trim(),
        viaText: viaText,
        notRunning: isNotRunning(el),
        routeId: el?.route_id?.toString(), // Store route_id for color determination
        routeData: el, // Keep source route data for special color rules (e.g. RegioJet)
      });
    }
  });

  const chips = Array.from(routeMap.values());
  const suffixes = disambiguateLabels(
    chips.map((c) => ({
      from: abbreviateStationName(c.origin),
      to: abbreviateStationName(c.destination),
      trainNumber: c.trainNumber,
    })),
  );

  return (
    <div className="absolute bottom-0 w-full pb-[env(safe-area-inset-bottom,0px)] md:pb-0 bg-white dark:bg-zinc-900 dark:text-zinc-100 shadow-[-2px_0_8px_rgba(0,0,0,0.1)] z-[1000]">
      <div
        ref={scrollRef}
        onScroll={updateFade}
        data-testid="bottom-bar-scroll"
        className="min-h-12 md:min-h-0 md:h-auto md:max-h-7 overflow-y-hidden overflow-x-scroll p-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
      >
        <div className="flex min-w-max p-1">
          {!hasBackOnTrackRoutes ? (
            <div className="flex items-center h-10 px-4 text-sm text-gray-500 dark:text-zinc-400 italic">
              No night train routes found for this station.
            </div>
          ) : (
            chips.map((route, index) => {
              // Operator brand color (with shade variation for same-operator routes)
              // Lifted on the dark theme to match the line it names.
              const baseColor =
                routeColorMap.get(route.routeId) || NEUTRAL_FALLBACK_COLOR;
              const routeColor = isDarkMap ? liftForDarkMap(baseColor) : baseColor;

              return (
                <div
                  className="relative flex items-center h-10 md:h-auto max-w-[calc(100vw-1rem)] pl-2 pr-3 whitespace-nowrap text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-800 active:bg-gray-100 dark:active:bg-zinc-800 md:active:bg-transparent transition-colors"
                  key={`route-info-${index}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onRouteClick?.(route.routeId)}
                  onMouseEnter={() => onRouteHover?.(route.routeId)}
                  onMouseLeave={() => onRouteLeave?.()}
                  onFocus={() => {
                    // Focus preview only on fine pointers (desktop keyboard).
                    if (
                      typeof window !== "undefined" &&
                      window.matchMedia("(hover: hover) and (pointer: fine)")
                        .matches
                    ) {
                      onRouteHover?.(route.routeId);
                    }
                  }}
                  onBlur={() => onRouteLeave?.()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRouteClick?.(route.routeId);
                    }
                  }}
                >
                  {/* Color indicator line */}
                  <div
                    className="absolute left-0 top-0.5 bottom-0.5 w-1 rounded shrink-0"
                    style={{ backgroundColor: routeColor }}
                  />
                  {/* Never wider than the screen: a long name is cut with an
                  ellipsis rather than pushing the chip off a phone. */}
                  <div
                    className={`flex min-w-0 items-center ${route.notRunning ? "text-gray-500 dark:text-zinc-400" : ""}`}
                  >
                    <strong className="shrink-0">
                      {abbreviateStationName(route.origin)}
                    </strong>
                    &nbsp;-&nbsp;
                    {route.viaText ? (
                      <span className="truncate">
                        ({abbreviateStationName(route.viaText)})
                      </span>
                    ) : null}
                    {route.viaText && <>&nbsp;-&nbsp;</>}
                    <strong className="truncate">
                      {abbreviateStationName(route.destination)}
                    </strong>
                    {suffixes[index] && (
                      <span className="ml-1.5 shrink-0 text-xs font-normal text-gray-500 dark:text-zinc-400">
                        {suffixes[index]}
                      </span>
                    )}
                    {route.notRunning && (
                      <span className="ml-1.5 shrink-0 text-xs font-normal text-gray-400 dark:text-zinc-500">
                        not running yet
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {canScrollRight && (
        <div
          aria-hidden
          data-testid="bottom-bar-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-white from-40% to-transparent dark:from-zinc-900"
        />
      )}
    </div>
  );
};

export default TrainBottomBar;
