import Link from "next/link";
import { FaArrowRight } from "react-icons/fa";

/**
 * Shared chrome for the SEO content pages. Clones the dark-theme layout of the
 * about page (fixed nav + scroll container + footer) WITHOUT importing it, so the
 * existing about/homepage are never touched. Each page renders its own <Head>.
 */
export default function SeoLayout({ children }) {
  // h-dvh, not h-screen: on iOS Safari 100vh exceeds the visible area, so the
  // bottom of this scroll container (and the footer in it) stays under the
  // browser toolbar no matter how far you scroll.
  return (
    <div className="h-dvh overflow-y-auto bg-black">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b border-white/10">
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
                className="shrink-0 text-sm text-white/70 hover:text-white transition-colors"
              >
                {/* "Plan a trip" pushed the wordmark onto two lines at 375px.
                    The link has to stay on mobile — it is the only nav entry to
                    the planner from an SEO page — so it shortens instead. */}
                <span className="sm:hidden">Plan</span>
                <span className="hidden sm:inline">Plan a trip</span>
              </Link>
              <Link
                href="/connections"
                className="hidden sm:inline text-sm text-white/70 hover:text-white transition-colors"
              >
                All routes
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-medium text-sm transition-colors"
              >
                Open Map
                <FaArrowRight className="w-3 h-3" />
              </Link>
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
