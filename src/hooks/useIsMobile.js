import { useEffect, useState } from "react";

/**
 * Shared mobile/desktop breakpoint for the map UI.
 * Matches Tailwind `md:` (768px) so header, panels, and JS agree.
 */
export const MOBILE_BREAKPOINT_PX = 768;
export const MOBILE_MQ = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

/**
 * True when the viewport is below the shared mobile breakpoint (767px and under).
 * Starts false so SSR and the first client render match; updates after mount.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const update = () => setIsMobile(mq.matches);
    update();
    // Modern browsers: addEventListener; older Safari used addListener.
    if (mq.addEventListener) {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  return isMobile;
}
