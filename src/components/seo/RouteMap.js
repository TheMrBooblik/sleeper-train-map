import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Tooltip,
  useMap,
} from "react-leaflet";
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
 * Client-only Leaflet map for a single route. Draws the encoded polylines (one per
 * direction, else a straight line through the stops) plus a marker at every station.
 * Renders nothing when no geometry is available.
 */
export default function RouteMap({ polyline0, polyline1, stops, agencyId }) {
  const color = getOperatorBaseColor({ agency_id: agencyId });

  const stations = (stops || []).filter(
    (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon),
  );

  const lines = [];
  if (polyline0) lines.push(polyline.decode(polyline0));
  if (polyline1) lines.push(polyline.decode(polyline1));
  if (lines.length === 0 && stations.length >= 2) {
    lines.push(stations.map((s) => [s.lat, s.lon]));
  }
  if (lines.length === 0 && stations.length === 0) return null;

  const all = [...lines.flat(), ...stations.map((s) => [s.lat, s.lon])];
  const center = all[Math.floor(all.length / 2)] || [50, 10];
  const lastStation = stations.length - 1;

  return (
    <MapContainer
      center={center}
      zoom={5}
      scrollWheelZoom={false}
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        // Single origin — see the note on the interactive map's TileLayer.
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        updateWhenZooming={false}
        keepBuffer={1}
      />
      {lines.map((positions, i) => (
        <Polyline
          key={i}
          positions={positions}
          pathOptions={{ color, weight: 3, opacity: 0.9 }}
        />
      ))}
      {stations.map((s, i) => {
        const isEnd = i === 0 || i === lastStation;
        return (
          <CircleMarker
            key={`${s.name}-${i}`}
            center={[s.lat, s.lon]}
            radius={isEnd ? 6 : 4}
            pathOptions={{
              color: "#0a0d10",
              weight: 2,
              fillColor: isEnd ? "#ffffff" : color,
              fillOpacity: 1,
            }}
          >
            <Tooltip direction="top" offset={[0, -2]}>
              {s.name}
            </Tooltip>
          </CircleMarker>
        );
      })}
      <FitBounds positions={all} />
    </MapContainer>
  );
}
