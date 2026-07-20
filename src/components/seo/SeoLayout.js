import Link from "next/link";
import { FaArrowRight } from "react-icons/fa";

/**
 * Shared chrome for the SEO content pages. Clones the dark-theme layout of the
 * about page (fixed nav + scroll container + footer) WITHOUT importing it, so the
 * existing about/homepage are never touched. Each page renders its own <Head>.
 */
export default function SeoLayout({ children }) {
  return (
    <div className="h-screen overflow-y-auto bg-black">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link
              href="/"
              className="text-white font-medium hover:text-primary-green transition-colors"
            >
              Pingwi{" "}
              <span className="italic text-primary-green">sleeper train</span> map
            </Link>
            <div className="flex items-center gap-4 sm:gap-6">
              <Link
                href="/trains"
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
              href="/trains"
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
