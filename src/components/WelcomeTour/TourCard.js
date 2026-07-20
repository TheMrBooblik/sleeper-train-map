/**
 * One HUD card of the welcome tour: dark glass shell with an optional notch
 * pointing at the UI element it explains. Positioning comes from the parent
 * via `className`; the entrance stagger via `--tour-delay` in `style`.
 * The tour closes as a whole (outside click / Escape / "Start exploring"),
 * so cards carry no close button of their own.
 */
export default function TourCard({
  className = "",
  notch = "none",
  animate = false,
  style,
  children,
}) {
  const notchClass =
    notch === "up" ? "tour-notch-up" : notch === "down" ? "tour-notch-down" : "";
  return (
    <section
      className={`${className} ${notchClass} ${animate ? "tour-card-enter" : ""} relative rounded-xl border border-white/10 bg-black/85 backdrop-blur-md text-white shadow-xl p-3.5`}
      style={style}
    >
      {children}
    </section>
  );
}
