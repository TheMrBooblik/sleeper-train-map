/**
 * Shared chrome for the Integrations and Route sources tabs, so the two read
 * as one surface. Presentation only — every number comes from
 * src/lib/integrations/model.mjs via /api/admin/integrations.
 */
import { useEffect, useState } from "react";

export const inputCls =
  "border border-gray-300 rounded px-2 py-1 text-sm min-w-0 focus:outline-none focus:ring-1 focus:ring-gray-400";
export const primaryBtnCls =
  "text-xs px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
export const dangerBtnCls =
  "text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
export const linkCls = "text-blue-600 hover:underline break-all";

// ─── Formatters ──────────────────────────────────────────────────────────────

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "26 Aug 2026, 06:15 UTC" — absolute, unambiguous, no locale surprises. */
export function formatUtc(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "2h ago" / "3d ago" — the relative half, shown next to the absolute one. */
export function agoLabel(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const hours = Math.floor((Date.now() - t) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ─── Badges ──────────────────────────────────────────────────────────────────

export const FEED_FRESHNESS = {
  fresh: { dot: "🟢", label: "Fresh", cls: "text-green-600" },
  aging: { dot: "🟡", label: "Aging", cls: "text-amber-600" },
  stale: { dot: "🔴", label: "Stale", cls: "text-red-600" },
  never: { dot: "⚫", label: "Never automated", cls: "text-gray-400" },
  // First-party, but the source leaves no dated artifact of its own.
  unknown: { dot: "⚪", label: "Automated, undated", cls: "text-gray-400" },
};

export const PRIORITY_BANDS = {
  high: {
    dot: "🔴",
    label: "High",
    cls: "bg-red-50 text-red-700 border-red-200",
  },
  medium: {
    dot: "🟡",
    label: "Medium",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
  },
  low: {
    dot: "🟢",
    label: "Low",
    cls: "bg-green-50 text-green-700 border-green-200",
  },
};

// The five states the source vocabulary distinguishes. The point of keeping
// them apart: "we found an official API" and "Pingwi fetches from it" are not
// the same claim, and only the second one makes the data trustworthy.
export const SOURCE_STATUS = {
  integrated: {
    icon: "✅",
    label: "Integrated",
    cls: "bg-green-50 text-green-700 border-green-200",
    hint: "Pingwi fetches from this automatically.",
  },
  working: {
    icon: "🟢",
    label: "Working source",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    hint: "Official source found and checked — not integrated yet.",
  },
  discovered: {
    icon: "🟡",
    label: "Source discovered",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
    hint: "Found, not yet checked.",
  },
  broken: {
    icon: "🔴",
    label: "Broken",
    cls: "bg-red-50 text-red-700 border-red-200",
    hint: "Was working, now failing.",
  },
  none: {
    icon: "🔴",
    label: "No known official source",
    cls: "bg-red-50 text-red-700 border-red-200",
    hint: "No official machine-readable source found yet.",
  },
  backontrack: {
    icon: "⚠️",
    label: "Back-on-Track",
    cls: "bg-orange-50 text-orange-700 border-orange-200",
    hint: "Third-party community dataset — no freshness guarantee.",
  },
};

export const INTEGRATION_STATUS_LABELS = {
  "not-investigated": "Not investigated",
  "source-discovered": "Source discovered",
  "source-tested": "Source tested",
  "in-progress": "Integration in progress",
  integrated: "Integrated",
  "needs-maintenance": "Needs maintenance",
};

export const DIFFICULTY_LABELS = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  unknown: "Unknown",
};
export const AUTH_LABELS = {
  none: "No",
  "api-key": "API key",
  oauth: "OAuth",
  account: "Account / registration",
  unknown: "Unknown",
};

export function Badge({ children, className = "", title }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap ${className}`}
    >
      {children}
    </span>
  );
}

export function PriorityBadge({ priority }) {
  const band = PRIORITY_BANDS[priority?.band] ?? PRIORITY_BANDS.low;
  return (
    <Badge className={band.cls} title={priority?.reason}>
      {band.dot} {band.label}
      <span className="font-mono opacity-60">{priority?.score}</span>
    </Badge>
  );
}

export function FreshnessCell({ status, lastSuccessAt, daysSinceChange }) {
  const meta = FEED_FRESHNESS[status] ?? FEED_FRESHNESS.never;
  const ago = agoLabel(lastSuccessAt);
  return (
    <div className="leading-tight">
      <div className={`text-xs ${meta.cls}`}>
        {meta.dot} {meta.label}
      </div>
      {status !== "never" && status !== "unknown" && (
        <div className="text-[11px] text-gray-400">
          {formatUtc(lastSuccessAt)}
          {ago ? ` · ${ago}` : ""}
        </div>
      )}
      {Number.isFinite(daysSinceChange) && (
        <div className="text-[11px] text-gray-400">
          unchanged {daysSinceChange}d
        </div>
      )}
    </div>
  );
}

/**
 * The concrete thing a source is — never "official API". Renders a real link
 * when we have a URL, plain text (an internal path, say) when we do not.
 */
export function SourceLink({ url, label, className = "" }) {
  if (!url)
    return <span className={`text-gray-400 ${className}`}>Unknown</span>;
  const isHttp = /^https?:\/\//.test(url);
  if (!isHttp) {
    return (
      <code className={`text-[11px] text-gray-500 break-all ${className}`}>
        {url}
      </code>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${linkCls} text-[11px] ${className}`}
      title={url}
    >
      {label ?? url}
    </a>
  );
}

/** The one number the whole tool exists to move. */
export function Metric({ label, value, sub, emphasis = false }) {
  return (
    <div className="min-w-0">
      <div
        className={
          emphasis
            ? "text-2xl font-semibold text-gray-900 leading-none"
            : "text-lg font-semibold text-gray-800 leading-none"
        }
      >
        {value}
      </div>
      <div className="text-[11px] text-gray-500 mt-1">{label}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
}

export function ErrorBanner({ children }) {
  return (
    <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2">
      {children}
    </p>
  );
}

export function NoticeBanner({ notice }) {
  if (!notice) return null;
  return (
    <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-2">
      {notice.text}{" "}
      {notice.href && (
        <a
          href={notice.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          View commit
        </a>
      )}
    </p>
  );
}

/**
 * Shared fetch for both tabs. One endpoint, one shape — all the arithmetic
 * already happened server-side in src/lib/integrations/model.mjs.
 */
export function useIntegrations() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/integrations")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(json?.error ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}
