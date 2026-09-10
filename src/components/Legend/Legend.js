import React from "react";

import { getOperatorName } from "../../lib/seo/operators";
import { OPERATOR_BRAND_COLORS } from "../Map/utils/operatorColors";
import {
  MAP_LEGEND_LINE_BASE_STYLES,
  PKP_COLOR,
  REGIOJET_COLOR,
} from "../Map/utils/routeStyleUtils";
import { FUTURE_STATION_OPACITY } from "../Map/utils/mapIcons";

/** Short badge labels + colors shown in the map legend (sample of operators). */
const OPERATOR_SAMPLES = [
  { id: "ES", label: "ES", color: OPERATOR_BRAND_COLORS.ES },
  { id: "ČD", label: "ČD", color: OPERATOR_BRAND_COLORS.ČD },
  { id: "FS", label: "FS", color: OPERATOR_BRAND_COLORS.FS },
  { id: "PKP", label: "PKP", color: PKP_COLOR },
  { id: "RJ", label: "RJ", color: REGIOJET_COLOR },
  { id: "ÖBB", label: "ÖBB", color: OPERATOR_BRAND_COLORS.ÖBB },
];

/** Official Back-on-Track night train map (overview + database context). */
const BACK_ON_TRACK_NIGHT_TRAIN_MAP =
  "https://back-on-track.eu/night-train-map/";

/** Buy Me a Coffee — Pingwi supporter page */
const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/pingwi";

/**
 * Mini polyline for legend — stroke matches map weights/dash from MAP_LEGEND_LINE_BASE_STYLES.
 */
function FrequencyLineSample({ weight, dashArray, opacity = 1 }) {
  const w = 44;
  const h = 12;
  const y = h / 2;
  const dash = dashArray ? dashArray.replace(/,/g, " ") : undefined;
  const strokeW = Math.min(Math.max(weight, 1.2), 4.2);
  return (
    <svg width={w} height={h} className="shrink-0 overflow-visible" aria-hidden>
      <line
        x1={2}
        y1={y}
        x2={w - 2}
        y2={y}
        stroke="white"
        strokeOpacity={opacity}
        strokeWidth={strokeW}
        strokeLinecap="round"
        {...(dash ? { strokeDasharray: dash } : {})}
      />
    </svg>
  );
}

/**
 * Map legend: intro, operator colours, line frequency, station markers, credits and external links.
 * @param {{ variant?: "inline" | "panel" }} props
 * - inline: horizontal wrap inside tight spaces (same intro block as panel).
 * - panel: stacked sections for the header popover.
 */
const Legend = ({ variant = "inline" }) => {
  const isPanel = variant === "panel";

  const sectionClass = isPanel
    ? "flex flex-col gap-2 border-b border-white/15 pb-3 last:border-0 last:pb-0"
    : "flex flex-wrap items-center gap-x-3 gap-y-1.5 max-[1200px]:max-w-[min(100%,22rem)]";

  // Match the welcome-tour card body copy so the legend reads the same as the
  // other tour cards (size / leading / muted colour).
  const labelClass = "text-xs leading-relaxed text-white/70";

  const linkClass =
    "rounded-sm font-medium text-sky-300 underline decoration-sky-300 decoration-2 underline-offset-2 outline-offset-2 hover:text-sky-200 hover:decoration-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/70";

  // Standalone footer link: reads clearly as a hyperlink (weight, underline, external-tab cue).
  const nightTrainMapLinkClass =
    "inline-flex w-fit max-w-full items-center gap-1 rounded-sm py-0.5 text-xs font-semibold text-sky-400 underline decoration-2 underline-offset-[3px] decoration-sky-400/90 outline-offset-2 hover:bg-sky-400/10 hover:text-sky-300 hover:decoration-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/70";

  /** Buy Me a Coffee — full-width yellow pill (use !text-black: global `a{color:inherit}` is unlayered and wins over layered utilities). */
  const buyMeACoffeeLinkClass =
    "flex w-full min-w-0 max-w-full items-center justify-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold !text-black no-underline bg-[#ffdd00] shadow-sm outline-offset-2 transition-colors hover:bg-[#ffcc33] focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-400/90";

  return (
    <div className={"flex flex-col gap-4 text-left"}>
      {/* How to use this map */}
      <div
        className={
          isPanel
            ? "flex flex-col gap-2 border-b border-white/15 pb-3"
            : "flex max-w-[min(100%,24rem)] flex-col gap-2 border-b border-white/15 pb-3"
        }
      >
        <p className={`${labelClass} ${isPanel ? "max-w-none" : ""}`}>
          This interactive map visualizes the{" "}
          <span className="text-white">night train routes</span> connecting
          major European cities, helping travelers plan sustainable
          long-distance journeys without flying. <br />
          <br />
          <span className="text-white">Click on any station</span> to see direct
          sleeper trains from that station!
        </p>
      </div>

      {/* Route colors = train operator; shades = several routes same company */}
      <div className={sectionClass}>
        <p
          className={`${labelClass} ${isPanel ? "max-w-none" : "max-w-[14rem] min-[1280px]:max-w-[16rem]"}`}
        >
          Each line color is a{" "}
          <span className="text-white">train operator</span>. Several routes
          from the same company use{" "}
          <span className="text-white">lighter or darker shades</span> of that
          brand.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {OPERATOR_SAMPLES.map(({ id, label, color }) => {
            const fullName = getOperatorName(id);
            return (
              <span
                key={id}
                className="legend-operator-badge inline-flex items-center gap-1.5 rounded border border-white/20 bg-white/5 px-1.5 py-0.5"
                data-tooltip={fullName}
                aria-label={fullName}
                tabIndex={0}
              >
                <span
                  className="h-2 w-6 shrink-0 rounded-sm"
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
                <span className="text-[11px] font-medium text-white/80">
                  {label}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* Dashed vs solid = inferred frequency from Back-on-Track */}
      <div className={sectionClass}>
        <p className={`${labelClass} ${isPanel ? "" : "max-w-[13rem]"}`}>
          <span className="text-white">Solid vs dashed</span> shows how often
          trains run, inferred from Back-on-Track schedule text (not an exact
          weekly count per line).
        </p>
        <div
          className={
            isPanel
              ? "flex flex-col gap-2"
              : "flex flex-wrap items-center gap-x-3 gap-y-1"
          }
        >
          <span className="flex items-center gap-1.5">
            <FrequencyLineSample {...MAP_LEGEND_LINE_BASE_STYLES.rank0} />
            <span className="text-[11px] font-medium text-white/85 whitespace-nowrap">
              Daily
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <FrequencyLineSample {...MAP_LEGEND_LINE_BASE_STYLES.rank1} />
            <span className="text-[11px] font-medium text-white/85 whitespace-nowrap">
              Less than daily
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <FrequencyLineSample {...MAP_LEGEND_LINE_BASE_STYLES.rank2} />
            <span className="text-[11px] font-medium text-white/85 whitespace-nowrap">
              Infrequent
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <FrequencyLineSample {...MAP_LEGEND_LINE_BASE_STYLES.futureGhost} />
            <span className="text-[11px] font-medium text-white/85 whitespace-nowrap">
              Not yet running
            </span>
          </span>
        </div>
      </div>

      {/* Station dots — match mapIcons.js gradients */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div
            className="h-3 w-3 shrink-0 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] bg-gradient-to-br from-[#2196f3] to-[#1976d2] min-[1280px]:h-3.5 min-[1280px]:w-3.5"
            aria-hidden
          />
          <span className="text-xs font-medium text-white min-[1280px]:text-xs">
            Route endpoint
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] bg-gradient-to-br from-[#4caf50] to-[#388e3c] min-[1280px]:h-3 min-[1280px]:w-3"
            aria-hidden
          />
          <span className="text-xs font-medium text-white min-[1280px]:text-xs">
            Intermediate stop
          </span>
        </div>
        {/* A stop only the next timetable period calls at — the faded dot
            futureIcon draws. The opacity comes from mapIcons.js rather than a
            copy here, so the swatch cannot drift from the marker. */}
        <div className="flex items-center gap-1.5">
          <div
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] bg-gradient-to-br from-[#4caf50] to-[#388e3c] min-[1280px]:h-3 min-[1280px]:w-3"
            style={{ opacity: FUTURE_STATION_OPACITY }}
            aria-hidden
          />
          <span className="text-xs font-medium text-white min-[1280px]:text-xs">
            Stop from a future timetable
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-white/15 pt-3">
        <p className="text-[11px] leading-snug text-white/65">
          Huge thanks to{" "}
          <a
            href="https://back-on-track.eu"
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            Back-on-Track.eu
          </a>{" "}
          for providing the data for this visualization!
        </p>
        <div className="flex w-full min-w-0 flex-col gap-2">
          <a
            href={BUY_ME_A_COFFEE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buyMeACoffeeLinkClass}
          >
            {/* Buy Me a Coffee mark from public/coffee.svg (served from site root) */}
            <img
              src="/coffee.svg"
              alt=""
              width={20}
              height={29}
              decoding="async"
              className="h-5 w-auto max-h-5 shrink-0 object-contain object-left"
              aria-hidden
            />
            <span>Buy me a coffee</span>
            <span
              className="select-none text-[0.65rem] font-normal leading-none text-black"
              aria-hidden
            >
              ↗
            </span>
          </a>
        </div>
      </div>
    </div>
  );
};

export default Legend;
