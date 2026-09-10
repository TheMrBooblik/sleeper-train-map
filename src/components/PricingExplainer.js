/**
 * A fare-model badge whose explanation is one click away.
 *
 * The badge names what the fare IS — "Dynamic fare", "Fixed fare" — because a
 * badge reading "Book early" is an instruction with its reasoning missing, and
 * sitting next to a price it is not even obviously about the price. The advice
 * ("Book early", and WHY) lives behind the circled "?" instead, where there is
 * room for the reason and for the last-minute caveat.
 *
 * Built on <details>/<summary> rather than a button plus popover state: it is
 * keyboard-operable and screen-reader-labelled for free, it works before (or
 * without) hydration, and it cannot be clipped by an overflow container the way
 * an absolutely-positioned panel can — which matters because this renders both
 * in a static page's facts grid and inside the map panel's scrolling trip card.
 *
 * `tone` picks the palette: "dark" for the SEO pages, "light" for the map panel.
 * `labelStyle` carries the map panel's per-model badge colour, which is an
 * inline style (getPricingBadgeStyle) rather than a class.
 */

const TONES = {
  dark: {
    summary: "text-white",
    marker: "border-white/30 text-white/60 group-hover:border-primary-green group-hover:text-primary-green",
    panel: "text-white/60",
    guidance: "text-white/90",
  },
  light: {
    summary: "text-gray-900",
    marker: "border-gray-300 text-gray-400 group-hover:border-gray-500 group-hover:text-gray-600",
    panel: "text-gray-600",
    guidance: "text-gray-900",
  },
};

export default function PricingExplainer({
  advice,
  label,
  tone = "dark",
  className = "",
  labelClassName = "",
  labelStyle = undefined,
}) {
  // No recognised pricing model: render the label alone rather than a "?" that
  // opens an empty box.
  if (!advice) {
    return label ? (
      <span className={labelClassName} style={labelStyle}>
        {label}
      </span>
    ) : null;
  }

  const t = TONES[tone] ?? TONES.dark;
  const text = label || advice.headline;

  return (
    <details className={`group ${className}`}>
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 ${t.summary} [&::-webkit-details-marker]:hidden`}
      >
        <span className={labelClassName} style={labelStyle}>
          {text}
        </span>
        {/* aria-hidden: <summary> is already the accessible control, so the
            marker would otherwise be announced as a second, nameless one. */}
        <span
          aria-hidden
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold leading-none transition-colors ${t.marker}`}
        >
          ?
        </span>
        <span className="sr-only">— what does this mean?</span>
      </summary>
      <div className={`mt-2 space-y-1 text-xs leading-relaxed text-pretty ${t.panel}`}>
        <p>
          <span className={`font-semibold ${t.guidance}`}>{advice.guidance}.</span>{" "}
          {advice.short.charAt(0).toUpperCase()}
          {advice.short.slice(1)}.
        </p>
        {advice.caveat && (
          <p>
            {advice.caveat.charAt(0).toUpperCase()}
            {advice.caveat.slice(1)}.
          </p>
        )}
      </div>
    </details>
  );
}
