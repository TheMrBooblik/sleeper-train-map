import React from "react";

/**
 * Chip shown when a station filter is active.
 * Truncates long names on narrow screens; close button is a 44px tap target.
 */
const Filter = ({ selected, filterName, onClose }) => {
  return (
    <div
      className={`flex items-center gap-1 text-sm absolute !z-999 left-14 top-3 max-w-[calc(100vw-5.5rem)] bg-white rounded shadow-sm ${
        selected ? "flex" : "hidden"
      } leaflet-bar`}
    >
      <button
        type="button"
        onClick={onClose}
        className="flex h-11 w-11 shrink-0 items-center justify-center cursor-pointer text-gray-600 hover:bg-gray-100 rounded-l"
        aria-label="Clear filter"
      >
        ✖
      </button>
      <span className="pr-3 py-2 min-w-0 truncate">
        Filter:&nbsp;<strong>{filterName}</strong>
      </span>
    </div>
  );
};

export default Filter;
