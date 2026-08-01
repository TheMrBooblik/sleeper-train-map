"use client";

import { useEffect, useRef } from "react";
import StationSearchBar from "./StationSearchBar";

/**
 * Full-screen search overlay for mobile.
 * Reuses StationSearchBar so desktop and mobile share the same index/logic.
 */
export default function MobileSearchOverlay({
  open,
  onClose,
  stops,
  isLoading,
  onSelect,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the overlay is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[1200] flex flex-col bg-zinc-950/95 pt-[env(safe-area-inset-top,0px)]"
      role="dialog"
      aria-modal="true"
      aria-label="Search stations"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-3">
        <div className="min-w-0 flex-1">
          <StationSearchBar
            stops={stops}
            isLoading={isLoading}
            onSelect={(item) => {
              onSelect?.(item);
              onClose?.();
            }}
            autoFocus
            variant="mobile"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Close search"
        >
          Cancel
        </button>
      </div>
      <p className="px-4 pt-3 text-xs text-white/50">
        Type a city or station name to jump to it on the map.
      </p>
    </div>
  );
}
