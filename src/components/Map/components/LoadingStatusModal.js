"use client";

import React, { useState, useEffect } from "react";

/**
 * Single small loading modal used for the whole load sequence.
 * Shows real status for both phases so users (and Vercel cold starts) see what is happening.
 *
 * Phase 1: Initial data (Back-on-Track stations & routes)
 * Phase 2: Night trains (NightJet & EuroNight route list + drawing)
 * Then: "Night trains ready" and fade out.
 *
 * Progress bar: indeterminate during phase 1; real 0–100% during phase 2.
 */
export default function LoadingStatusModal({
  /** True while /api/initial-data (stations & routes) is loading */
  initialDataLoading,
  /** True when night train routes are loaded and drawn */
  nightTrainsReady,
  /** 0–100 progress during night train phase (35–100 from parent, normalized here) */
  loadingProgress,
  /** Current step message from useNightTrainData (e.g. "Fetching route list…") */
  loadingMessage,
}) {
  const [fadeOut, setFadeOut] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const done = !initialDataLoading && nightTrainsReady;
    if (!done) return;
    const fadeTimer = setTimeout(() => setFadeOut(true), 1500);
    const hideTimer = setTimeout(() => setHidden(true), 2100);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [initialDataLoading, nightTrainsReady]);

  if (hidden) return null;

  const isPhase1 = initialDataLoading;
  const isPhase2 = !initialDataLoading && !nightTrainsReady;
  // Only "done" when both phases complete — avoids showing green/checkmark while Phase 1 still loading
  const isDone = !initialDataLoading && nightTrainsReady;

  // During phase 2 use real progress (35–100 → 0–100%); phase 1 shows indeterminate
  const barProgress =
    isPhase2
      ? Math.min(100, Math.max(0, Math.round(((loadingProgress - 35) / 65) * 100)))
      : 0;

  const title = isPhase1
    ? "Loading…"
    : isDone
      ? "Night trains ready"
      : "Loading night trains";

  const message = isPhase1
    ? "Stations & routes from Back-on-Track…"
    : isPhase2
      ? (loadingMessage || "Fetching route data…")
      : "NightJet & EuroNight routes on map";

  return (
    <div
      style={{
        position: "absolute",
        bottom: "28px",
        left: "10px",
        zIndex: 1001,
        backgroundColor: "rgba(255,255,255,0.98)",
        borderRadius: "10px",
        boxShadow: "0 2px 14px rgba(0,0,0,0.16)",
        padding: "12px 16px",
        minWidth: "240px",
        maxWidth: "300px",
        border: "1px solid rgba(0,0,0,0.08)",
        transition: "opacity 0.6s ease",
        opacity: fadeOut ? 0 : 1,
        pointerEvents: fadeOut ? "none" : "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: isDone ? "4px" : "8px",
        }}
      >
        {!isDone && (
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
        {isDone && <span style={{ fontSize: "15px", flexShrink: 0 }}>✅</span>}
        <span
          style={{
            fontSize: "12px",
            fontWeight: "600",
            color: isDone ? "#15803d" : "#1d4ed8",
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </span>
      </div>

      {!isDone && (
        <>
          <div
            style={{
              width: "100%",
              height: "3px",
              backgroundColor: "#e5e7eb",
              borderRadius: "2px",
              overflow: "hidden",
              marginBottom: "7px",
              position: "relative",
            }}
          >
            {isPhase1 ? (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: "-40%",
                  width: "40%",
                  height: "100%",
                  backgroundColor: "#3b82f6",
                  borderRadius: "2px",
                  animation: "slideProgress 1.2s ease-in-out infinite",
                }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  width: `${barProgress}%`,
                  backgroundColor: "#3b82f6",
                  borderRadius: "2px",
                  transition: "width 0.4s ease",
                }}
              />
            )}
          </div>
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
            {message}
          </div>
        </>
      )}

      {isDone && (
        <div style={{ fontSize: "11px", color: "#6b7280" }}>{message}</div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes slideProgress {
          0%   { left: -40%; }
          100% { left: 110%; }
        }
      `}</style>
    </div>
  );
}
