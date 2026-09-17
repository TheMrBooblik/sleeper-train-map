import { STATUS_LABEL } from "../../lib/plan/availability.mjs";

/**
 * The verdict, rendered so the three answers never look like two.
 *
 * "Runs" and "days unconfirmed" must not share a colour: a third of the legs in
 * the dataset have no operating days at all, and a planner that paints them the
 * same green as a confirmed service is telling a traveller something it does
 * not know.
 */
const STYLES = {
  runs: "bg-primary-green/15 text-primary-green border-primary-green/30",
  unknown: "bg-amber-400/10 text-amber-300 border-amber-400/25",
  no: "bg-white/5 text-white/45 border-white/10",
  "not-yet": "bg-sky-400/10 text-sky-300 border-sky-400/25",
  suspended: "bg-rose-500/10 text-rose-300 border-rose-500/25",
};

export default function AvailabilityBadge({ availability, className = "" }) {
  if (!availability) return null;
  const { status, reason } = availability;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        STYLES[status] || STYLES.unknown
      } ${className}`}
      title={reason || undefined}
    >
      <span aria-hidden="true" className="text-[0.6rem] leading-none">
        {status === "runs" ? "●" : status === "unknown" ? "◐" : "○"}
      </span>
      {STATUS_LABEL[status] || "Unknown"}
    </span>
  );
}
