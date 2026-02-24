"use client";

import React from "react";

/**
 * Full-screen loading overlay with progress bar and status messages.
 * Shown while stations, routes, and night train data are loading.
 */
export default function LoadingOverlay({
  loadingProgress,
  loadingMessage,
  stopsLoading,
  citiesLoading,
  njLoadingProgress = {},
}) {
  return (
    <div
      style={{
        position: "absolute",
        zIndex: 1001,
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        backgroundColor: "rgba(255,255,255,0.95)",
        padding: "30px 40px",
        borderRadius: "12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        textAlign: "center",
        minWidth: "300px",
        border: "1px solid rgba(255,255,255,0.2)",
      }}
    >
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontSize: "48px", marginBottom: "10px" }}>🚂</div>
        <h3 style={{ margin: "0 0 10px 0", color: "#333", fontSize: "18px" }}>
          Loading European Trains
        </h3>
        <p style={{ margin: "0 0 20px 0", color: "#666", fontSize: "14px" }}>
          Discovering stations and routes across Europe...
        </p>
      </div>

      <div style={{ marginBottom: "20px" }}>
        <div
          style={{
            width: "100%",
            height: "8px",
            backgroundColor: "#e0e0e0",
            borderRadius: "4px",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              width: `${Math.min(loadingProgress, 100)}%`,
              height: "100%",
              backgroundColor: "#4CAF50",
              borderRadius: "4px",
              transition: "width 0.3s ease",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
                animation: "shimmer 1.5s infinite",
              }}
            />
          </div>
        </div>
        <div
          style={{
            marginTop: "12px",
            fontSize: "14px",
            color: "#333",
            fontWeight: "500",
          }}
        >
          {Math.round(loadingProgress)}% Complete
        </div>
        <div
          style={{
            marginTop: "8px",
            fontSize: "12px",
            color: "#888",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>
              {stopsLoading ? "Loading stations..." : "✓ Stations loaded"}
            </span>
            <span>
              {citiesLoading
                ? "Processing routes..."
                : "✓ Routes processed"}
            </span>
          </div>
          {njLoadingProgress.progress > 0 && (
            <div
              style={{
                marginTop: "8px",
                padding: "8px",
                backgroundColor: "#f0f9ff",
                borderRadius: "4px",
                border: "1px solid #bae6fd",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: "600",
                  color: "#0369a1",
                  marginBottom: "4px",
                }}
              >
                NightJet Stations
              </div>
              <div style={{ fontSize: "11px", color: "#075985" }}>
                {njLoadingProgress.message ||
                  `Progress: ${njLoadingProgress.progress}%`}
              </div>
              {njLoadingProgress.step === "discovering" &&
                njLoadingProgress.trainsFound !== undefined && (
                  <div
                    style={{
                      fontSize: "10px",
                      color: "#64748b",
                      marginTop: "2px",
                    }}
                  >
                    Found {njLoadingProgress.trainsFound} trains
                  </div>
                )}
              {njLoadingProgress.step === "fetching" &&
                njLoadingProgress.stationsFound !== undefined && (
                  <div
                    style={{
                      fontSize: "10px",
                      color: "#64748b",
                      marginTop: "2px",
                    }}
                  >
                    {njLoadingProgress.stationsFound} stations discovered
                  </div>
                )}
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: "12px", color: "#999" }}>
        {loadingMessage}
      </div>
    </div>
  );
}
