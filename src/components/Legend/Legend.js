import React from "react";

const Legend = () => {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-3 max-[768px]:gap-2 max-[480px]:gap-1.5">
        <div className="flex items-center gap-1.5 max-[768px]:gap-1">
          <div className="w-3 h-3 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] shrink-0 bg-gradient-to-br from-[#2196f3] to-[#1976d2] max-[768px]:w-2.5 max-[768px]:h-2.5"></div>
          <span className="text-xs text-white font-medium max-[768px]:text-[11px] max-[480px]:text-[10px]">Origin</span>
        </div>

        <div className="flex items-center gap-1.5 max-[768px]:gap-1">
          <div className="w-3 h-3 rounded-full border border-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] shrink-0 bg-gradient-to-br from-[#4caf50] to-[#388e3c] max-[768px]:w-2.5 max-[768px]:h-2.5"></div>
          <span className="text-xs text-white font-medium max-[768px]:text-[11px] max-[480px]:text-[10px]">Via</span>
        </div>
      </div>
    </div>
  );
};

export default Legend;
