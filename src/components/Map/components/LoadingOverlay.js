"use client";

import React from "react";

/**
 * Full-screen loading overlay shown only during the fast GTFS phase
 * (loading station dots and base route data from Back-on-Track).
 *
 * This overlay disappears as soon as stations are ready (~1-2s),
 * revealing the map. NightJet/EuroNight routes then load from their
 * dedicated APIs in the background via BackgroundLoadingBadge.
 */
export default function LoadingOverlay({ stopsLoading, citiesLoading }) {
  return (
    <div
      style={{
        position: "absolute",
        zIndex: 1001,
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        backgroundColor: "rgba(255,255,255,0.96)",
        padding: "30px 40px",
        borderRadius: "12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
        textAlign: "center",
        minWidth: "280px",
        border: "1px solid rgba(0,0,0,0.07)",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontSize: "44px", marginBottom: "10px" }}>🚂</div>
        <h3 style={{ margin: "0 0 8px 0", color: "#1e293b", fontSize: "17px", fontWeight: "700" }}>
          Loading European Trains
        </h3>
        <p style={{ margin: 0, color: "#64748b", fontSize: "13px" }}>
          Fetching stations across Europe…
        </p>
      </div>

      {/* Animated progress bar (indeterminate shimmer) */}
      <div
        style={{
          width: "100%",
          height: "6px",
          backgroundColor: "#e2e8f0",
          borderRadius: "3px",
          overflow: "hidden",
          marginBottom: "14px",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "-60%",
            width: "60%",
            height: "100%",
            backgroundColor: "#3b82f6",
            borderRadius: "3px",
            animation: "slideProgress 1.4s ease-in-out infinite",
          }}
        />
      </div>

      {/* Status checklist */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          fontSize: "12px",
          color: "#64748b",
        }}
      >
        <StatusRow
          done={!stopsLoading}
          label={stopsLoading ? "Loading stations…" : "Stations loaded"}
        />
        <StatusRow
          done={!citiesLoading}
          label={citiesLoading ? "Processing routes…" : "Routes processed"}
        />
      </div>

      {/* Keyframe animation for progress shimmer */}
      <style>{`
        @keyframes slideProgress {
          0%   { left: -60%; }
          100% { left: 110%; }
        }
      `}</style>
    </div>
  );
}

/** Single status row with tick or spinner. */
function StatusRow({ done, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
      {done ? (
        <span style={{ color: "#22c55e", fontWeight: "700", fontSize: "13px" }}>✓</span>
      ) : (
        <span
          style={{
            display: "inline-block",
            width: "11px",
            height: "11px",
            border: "1.5px solid #cbd5e1",
            borderTop: "1.5px solid #3b82f6",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ color: done ? "#334155" : "#64748b" }}>{label}</span>
      {/* Keyframe for row spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
