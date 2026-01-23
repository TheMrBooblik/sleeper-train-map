import React, { memo, useEffect } from "react";
import { Tooltip } from "react-leaflet";

// Memoize the tooltip to prevent unnecessary re-renders
const MarkerTooltip = memo(({ stationName, stationId, groupedStations }) => {
  // Skip rendering if essential props are missing
  if (!stationName || !stationId) return null;

  return (
    <div className="px-2.5 py-1.5 bg-black/80 text-white rounded-md text-sm font-medium text-center shadow-[0_4px_12px_rgba(0,0,0,0.3)] border border-white/10 backdrop-blur max-w-[200px] break-words">
      <abbr title={`Station ID: ${stationId}`}>
        <span className="font-semibold text-white text-[0.9rem] block text-center text-shadow-[0_1px_2px_rgba(0,0,0,0.5)] hover:text-[#ffd54f] hover:cursor-help">{stationName}</span>
      </abbr>

      {/* Show grouped stations if this is a grouped marker */}
      {groupedStations && groupedStations.length > 1 && (
        <div className="mt-2 pt-2 border-t border-white/20 text-left">
          <div className="text-xs text-[#ffd54f] font-semibold mb-1">
            {groupedStations.length} stations in {stationName}:
          </div>
          <div className="max-h-[120px] overflow-y-auto">
            {groupedStations.map((station, index) => (
              <div key={index} className="text-[11px] text-[#e0e0e0] my-0.5 py-[1px]">
                • {station.originalName}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default MarkerTooltip;
