"use client";

import React from "react";

/**
 * Skeleton placeholder shown before map is initialized.
 */
export default function MapSkeleton() {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "#f0f0f0",
        backgroundImage: `
          linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%),
          linear-gradient(45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%),
          linear-gradient(-45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%)
        `,
        backgroundSize: "200% 100%, 20px 20px, 20px 20px",
        backgroundPosition: "-200% 0, 0 0, 0 0",
        animation: "shimmer 2s infinite",
        zIndex: 1,
      }}
    />
  );
}
