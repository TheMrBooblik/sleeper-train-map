import { FaTimes } from "react-icons/fa";

/**
 * One HUD card of the welcome tour: dark glass shell with a ✕ and an optional
 * notch pointing at the UI element it explains. Positioning comes from the
 * parent via `className`; the entrance stagger via `--tour-delay` in `style`.
 */
export default function TourCard({
  className = "",
  notch = "none",
  animate = false,
  style,
  onClose,
  children,
}) {
  const notchClass =
    notch === "up" ? "tour-notch-up" : notch === "down" ? "tour-notch-down" : "";
  return (
    <section
      className={`${className} ${notchClass} ${animate ? "tour-card-enter" : ""} relative rounded-xl border border-white/10 bg-black/85 backdrop-blur-md text-white shadow-xl p-3.5`}
      style={style}
    >
      <button
        type="button"
        aria-label="Dismiss this tip"
        onClick={onClose}
        className="absolute right-2.5 top-2.5 text-white/40 hover:text-white transition-colors"
      >
        <FaTimes className="h-3 w-3" />
      </button>
      {children}
    </section>
  );
}
