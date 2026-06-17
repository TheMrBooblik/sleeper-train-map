import Link from "next/link";
import { getOperatorBaseColor } from "@components/Map/utils/operatorColors";

/**
 * A link card for a single train route, used in the hub-page lists.
 * @param {{ route: object }} props - a route summary from the SEO data layer
 */
export default function RouteCardLink({ route }) {
  const color = getOperatorBaseColor({ agency_id: route.operatorIds?.[0] });
  const operatorNames = route.operators.map((o) => o.name).join(", ");

  return (
    <Link
      href={`/trains/${route.slug}`}
      className="group block rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] transition-colors overflow-hidden"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white group-hover:text-primary-green transition-colors">
            {route.title}
          </h3>
          {route.trainNumbers?.length > 0 && (
            <span className="shrink-0 text-xs font-mono text-white/50">
              {route.trainNumbers.join(" / ")}
            </span>
          )}
        </div>
        {operatorNames && (
          <p className="mt-1 text-xs text-white/50">{operatorNames}</p>
        )}
      </div>
    </Link>
  );
}
