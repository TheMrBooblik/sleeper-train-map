"use client";

import React, { useState, useEffect } from "react";

/**
 * Small corner badge that shows NightJet/EuroNight loading progress
 * while the map is already visible and usable.
 *
 * - Appears as soon as GTFS (dots) are loaded
 * - Shows progress as routes load in background
 * - Fades out 2 seconds after all routes are ready
 *
 * Progress is passed as 35–100 range (overall map load progress).
 * We normalize it to 0–100% for display so it starts at 0% visually.
 */
export default function BackgroundLoadingBadge({
  nightTrainsReady,
  loadingProgress,
  loadingMessage,
}) {
  // Controls fade-out animation
  const [fadeOut, setFadeOut] = useState(false);
  // Controls full removal from DOM after fade
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!nightTrainsReady) return;
    // Start fade 1.5s after routes finish loading
    const fadeTimer = setTimeout(() => setFadeOut(true), 1500);
    // Remove from DOM 0.6s later (after CSS transition)
    const hideTimer = setTimeout(() => setHidden(true), 2100);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [nightTrainsReady]);

  if (hidden) return null;

  // Normalize overall 35–100% to badge-local 0–100%
  // so the bar starts empty when badge first appears
  const badgeProgress = Math.min(
    100,
    Math.max(0, Math.round(((loadingProgress - 35) / 65) * 100)),
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: "28px",
        left: "10px",
        zIndex: 1000,
        backgroundColor: "rgba(255,255,255,0.96)",
        borderRadius: "10px",
        boxShadow: "0 2px 14px rgba(0,0,0,0.16)",
        padding: "10px 14px",
        minWidth: "220px",
        maxWidth: "260px",
        border: "1px solid rgba(0,0,0,0.08)",
        transition: "opacity 0.6s ease",
        opacity: fadeOut ? 0 : 1,
        pointerEvents: fadeOut ? "none" : "auto",
      }}
    >
      {/* Header row: icon + title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: nightTrainsReady ? "4px" : "8px",
        }}
      >
        {/* Spinning loader or checkmark */}
        {nightTrainsReady ? (
          <span style={{ fontSize: "15px" }}>✅</span>
        ) : (
          <span
            style={{
              display: "inline-block",
              width: "14px",
              height: "14px",
              border: "2px solid #dbeafe",
              borderTop: "2px solid #3b82f6",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: "12px",
            fontWeight: "600",
            color: nightTrainsReady ? "#15803d" : "#1d4ed8",
            letterSpacing: "0.01em",
          }}
        >
          {nightTrainsReady ? "Night trains ready" : "Loading night trains"}
        </span>
      </div>

      {/* Progress bar — only shown while loading */}
      {!nightTrainsReady && (
        <>
          <div
            style={{
              width: "100%",
              height: "3px",
              backgroundColor: "#e5e7eb",
              borderRadius: "2px",
              overflow: "hidden",
              marginBottom: "7px",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${badgeProgress}%`,
                backgroundColor: "#3b82f6",
                borderRadius: "2px",
                transition: "width 0.5s ease",
              }}
            />
          </div>

          {/* Status message */}
          <div
            style={{
              fontSize: "11px",
              color: "#6b7280",
              lineHeight: "1.4",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {loadingMessage || "Initializing…"}
          </div>
        </>
      )}

      {/* Success sub-label */}
      {nightTrainsReady && (
        <div style={{ fontSize: "11px", color: "#6b7280" }}>
          NightJet &amp; EuroNight routes on map
        </div>
      )}

      {/* Keyframe for spinner — injected inline */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
