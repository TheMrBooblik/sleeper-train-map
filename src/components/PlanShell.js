import { useState } from "react";
import Header from "@components/Header";
import { HEADER_HEIGHT } from "../constants/header";

export default function PlanShell({ children }) {
  const [isGrouped, setIsGrouped] = useState(true);
  const [showRoutes, setShowRoutes] = useState(false);
  const [hideIntermediateStations, setHideIntermediateStations] = useState(false);
  const [showRailwayOverlay, setShowRailwayOverlay] = useState(false);

  return (
    <div className="plan-shell">
      <Header
        isGrouped={isGrouped}
        setIsGrouped={setIsGrouped}
        showRoutes={showRoutes}
        setShowRoutes={setShowRoutes}
        hideIntermediateStations={hideIntermediateStations}
        setHideIntermediateStations={setHideIntermediateStations}
        showRailwayOverlay={showRailwayOverlay}
        setShowRailwayOverlay={setShowRailwayOverlay}
        stops={[]}
        stopsLoading={false}
      />
      <main className="plan-shell-content">{children}</main>
      <style jsx>{`
        .plan-shell {
          min-height: 100dvh;
          height: 100dvh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: #000;
          color: #fff;
        }

        .plan-shell-content {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-y: contain;
        }

        @media (max-width: 640px) {
          .plan-shell-content {
            scroll-padding-top: ${HEADER_HEIGHT}px;
          }
        }
      `}</style>
    </div>
  );
}
