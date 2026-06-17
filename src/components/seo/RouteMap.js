import { useEffect } from "react";
import { MapContainer, TileLayer, Polyline, useMap } from "react-leaflet";
import polyline from "@mapbox/polyline";
import "leaflet/dist/leaflet.css";
import { getOperatorBaseColor } from "@components/Map/utils/operatorColors";

function FitBounds({ positions }) {
  const map = useMap();
  useEffect(() => {
    if (positions && positions.length) {
      try {
        map.fitBounds(positions, { padding: [30, 30] });
      } catch {
        /* noop */
      }
    }
  }, [map, positions]);
  return null;
}

/**
 * Client-only Leaflet map for a single route. Prefers the encoded polylines
 * (one per direction); falls back to a straight line through the resolved stops.
 * Renders nothing when no geometry is available.
 */
export default function RouteMap({ polyline0, polyline1, stops, agencyId }) {
  const color = getOperatorBaseColor({ agency_id: agencyId });

  const lines = [];
  if (polyline0) lines.push(polyline.decode(polyline0));
  if (polyline1) lines.push(polyline.decode(polyline1));
  if (lines.length === 0 && stops && stops.length >= 2) {
    lines.push(stops.map((s) => [s.lat, s.lon]));
  }
  if (lines.length === 0) return null;

  const all = lines.flat();
  const center = all[Math.floor(all.length / 2)] || [50, 10];

  return (
    <MapContainer
      center={center}
      zoom={5}
      scrollWheelZoom={false}
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {lines.map((positions, i) => (
        <Polyline
          key={i}
          positions={positions}
          pathOptions={{ color, weight: 3, opacity: 0.9 }}
        />
      ))}
      <FitBounds positions={all} />
    </MapContainer>
  );
}
