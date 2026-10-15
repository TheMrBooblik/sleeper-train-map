import React from "react";

/**
 * Chip shown when a station/route filter is active.
 *
 * Sits to the right of the Leaflet zoom stack and shares its chrome
 * (`leaflet-bar`) so it reads as a native map control. Geometry is pinned to
 * Leaflet's own control metrics: controls get `margin: 10px`, and the zoom bar
 * is 48px wide (44px button + 2px border each side) — so `top-[10px]` aligns
 * the chip's top edge with the zoom bar's, and `left-[66px]` clears its right
 * edge (10 + 48) with an 8px gutter. Long route labels truncate rather than
 * running off screen.
 */
const Filter = ({ selected, filterName, onClose }) => {
  return (
    <div
      className={`absolute !z-999 left-[66px] top-[10px] h-11 max-w-[calc(100vw-76px)] items-center overflow-hidden rounded bg-white dark:bg-zinc-900 text-sm leaflet-bar ${
        selected ? "flex" : "hidden"
      }`}
    >
      <button
        type="button"
        onClick={onClose}
        className="flex h-full w-10 shrink-0 cursor-pointer items-center justify-center text-gray-500 dark:text-zinc-400 transition-colors hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-zinc-100"
        aria-label="Clear filter"
      >
        ✖
      </button>
      <span className="min-w-0 truncate pr-3 text-gray-900 dark:text-zinc-100">
        <span className="hidden text-gray-500 dark:text-zinc-400 md:inline">Filter:&nbsp;</span>
        <strong>{filterName}</strong>
      </span>
    </div>
  );
};

export default Filter;
