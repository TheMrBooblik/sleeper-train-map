import { useEffect, useState } from "react";

/**
 * The URL is the saved plan, so copying it is the save button.
 *
 * No account, no stored itinerary, nothing about the person anywhere: the path
 * holds the cities and the date, and that is the whole record. Worth saying on
 * the page rather than only in a design doc — "we didn't ask who you are" is a
 * feature a traveller should be able to see.
 */
export default function SharePlan({ href }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    const url = typeof window === "undefined" ? href : new URL(href, window.location.origin).href;
    try {
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        await navigator.share({ title: "Night train plan", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A denied clipboard permission or a dismissed share sheet is not an
      // error worth a message — the URL is in the address bar either way.
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/80 transition-colors hover:border-primary-green/50 hover:text-white"
      >
        {copied ? "Link copied" : "Copy link to this plan"}
      </button>
      <p className="text-xs text-white/35">
        This link is your plan — no account, nothing saved about you.
      </p>
    </div>
  );
}
