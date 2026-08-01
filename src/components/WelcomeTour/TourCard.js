/**
 * One HUD card of the welcome tour: dark glass shell with an optional notch
 * pointing at the UI element it explains. Positioning comes from the parent
 * via `className`; the entrance stagger via `--tour-delay` in `style`.
 * The tour closes as a whole (outside click / Escape / "Start exploring"),
 * so cards carry no close button of their own.
 *
 * On mobile the cards are already stacked inside one dark bottom sheet, so the
 * per-card shell is dropped (`max-md:`) — nesting bordered boxes inside a
 * bordered sheet reads as clutter. There they become plain sections separated
 * by the parent's dividers; the glass shell returns at `md:` where each card
 * floats free over the map.
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
      className={`${className} ${notchClass} ${animate ? "tour-card-enter" : ""} relative rounded-xl border border-white/10 bg-black/85 backdrop-blur-md text-white shadow-xl p-3.5 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none max-md:backdrop-blur-none max-md:px-0 max-md:py-3.5`}
      style={style}
    >
      {children}
    </section>
  );
}
