import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FaArrowRight, FaBars, FaMapMarkedAlt, FaRegCalendarAlt, FaRoute, FaInfoCircle } from "react-icons/fa";

/**
 * Shared chrome for the SEO content pages. Clones the dark-theme layout of the
 * about page (fixed nav + scroll container + footer) WITHOUT importing it, so the
 * existing about/homepage are never touched. Each page renders its own <Head>.
 */

/** The whole site, in the order a reader wants it. Mobile shows all of these. */
const MENU = [
  { href: "/", label: "Open the map", icon: FaMapMarkedAlt },
  { href: "/plan", label: "Plan a trip", icon: FaRegCalendarAlt },
  { href: "/connections", label: "All night train routes", icon: FaRoute },
  { href: "/about", label: "About", icon: FaInfoCircle },
];

export default function SeoLayout({ children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  // Same dismissal contract as the map header's popovers: anywhere outside, or
  // Escape. Capture phase so a link underneath cannot swallow the pointerdown.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event) => {
      if (
        panelRef.current?.contains(event.target) ||
        buttonRef.current?.contains(event.target)
      ) {
        return;
      }
      setMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen]);

  // h-dvh, not h-screen: on iOS Safari 100vh exceeds the visible area, so the
  // bottom of this scroll container (and the footer in it) stays under the
  // browser toolbar no matter how far you scroll.
  return (
    <div className="h-dvh overflow-y-auto bg-black">
      {/* Navigation */}
      {/* z-[1002] matches the homepage Header (see the z-index stack comment in
          globals.css) — Leaflet's own controls/panes reach z-index 1000, so a
          fixed nav below that draws underneath the corridor map on scroll. */}
      <nav className="fixed top-0 left-0 right-0 z-[1002] bg-black/80 backdrop-blur-md border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link
              href="/"
              className="min-w-0 truncate text-white font-medium hover:text-primary-green transition-colors"
            >
              Pingwi{" "}
              <span className="italic text-primary-green">sleeper train</span> map
            </Link>
            <div className="flex shrink-0 items-center gap-3 sm:gap-6">
              <Link
                href="/plan"
                className="hidden sm:inline shrink-0 text-sm text-white/70 hover:text-white transition-colors"
              >
                Plan a trip
              </Link>
              <Link
                href="/connections"
                className="hidden sm:inline text-sm text-white/70 hover:text-white transition-colors"
              >
                All routes
              </Link>
              {/* Desktop keeps the call to action; on a phone a green pill next
                  to the wordmark is the loudest thing on a page that is meant to
                  be read, so there the same destinations sit behind ≡. */}
              <Link
                href="/"
                className="hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-medium text-sm transition-colors"
              >
                Open Map
                <FaArrowRight className="w-3 h-3" />
              </Link>

              <div className="relative sm:hidden">
                <button
                  ref={buttonRef}
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  aria-controls="seo-menu"
                  aria-label="Menu"
                  className={`icon-toggle-button ${menuOpen ? "is-active" : ""}`}
                >
                  <FaBars size={16} />
                </button>
                {menuOpen && (
                  <div
                    ref={panelRef}
                    id="seo-menu"
                    role="dialog"
                    aria-label="Menu"
                    className="fixed right-2 top-[4.5rem] z-[1003] w-[min(calc(100vw-1rem),18rem)] rounded-xl border border-white/15 bg-zinc-900 p-2 shadow-2xl"
                  >
                    {MENU.map(({ href, label, icon: Icon }) => (
                      <Link
                        key={href}
                        href={href}
                        // Closing on click rather than on a route event: React
                        // keeps this component mounted across a navigation
                        // between two pages that share the layout, so the panel
                        // would otherwise still be open on arrival.
                        onClick={() => setMenuOpen(false)}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        <span className="text-primary-green">
                          <Icon size={14} />
                        </span>
                        {label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      <main>{children}</main>

      {/* Footer */}
      <footer className="py-8 px-4 sm:px-6 lg:px-8 border-t border-white/10">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-white/40">Pingwi Sleeper Train Map</p>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link
              href="/"
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              Map
            </Link>
            <Link
              href="/plan"
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              Plan a trip
            </Link>
            <Link
              href="/connections"
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              All routes
            </Link>
            <Link
              href="/about"
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              About
            </Link>
            <Link
              href="/privacy"
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
