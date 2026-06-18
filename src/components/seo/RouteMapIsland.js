import dynamic from "next/dynamic";

// Leaflet needs the browser, so the map is a client-only island (ssr:false).
// All SEO text content is in the static HTML; the map is a visual enhancement.
const RouteMap = dynamic(() => import("./RouteMap"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full animate-pulse bg-white/[0.03]" />
  ),
});

/**
 * Wraps the client map in a sized container, and renders nothing when the route
 * has no usable geometry (so pages degrade gracefully).
 */
export default function RouteMapIsland({ map, agencyId }) {
  const hasGeometry =
    map &&
    (map.polyline0 || map.polyline1 || (map.stops && map.stops.length >= 2));
  if (!hasGeometry) return null;

  return (
    <div className="h-[360px] w-full overflow-hidden rounded-xl border border-white/10">
      <RouteMap
        polyline0={map.polyline0}
        polyline1={map.polyline1}
        stops={map.stops}
        agencyId={agencyId}
      />
    </div>
  );
}
