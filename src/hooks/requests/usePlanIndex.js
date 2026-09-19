import { useEffect, useState } from "react";

import { hydratePlanIndex } from "../../lib/plan/index-codec.mjs";
import { createPlanner } from "../../lib/plan/search.mjs";

/**
 * The planner's dataset: one static asset, fetched once per session.
 *
 * Module-level cache holding the in-flight PROMISE, not only its result — the
 * same guard useInitialData needs, for the same reason: React 18 strict mode
 * mounts every component twice, and "have I got it yet" never catches a request
 * still on the wire.
 *
 * The file is under /data/, so next.config.js already gives it a real cache
 * lifetime and public/sw.js already serves it stale-while-revalidate: a repeat
 * visit pays nothing for it.
 */
const SOURCE = "/data/published/plan-index.json";
const cache = { planner: null, inFlight: null };

function loadPlanner() {
  if (cache.planner) return Promise.resolve(cache.planner);
  if (!cache.inFlight) {
    cache.inFlight = fetch(SOURCE)
      .then((response) => {
        if (!response.ok) throw new Error(`plan index ${response.status}`);
        return response.json();
      })
      .then((raw) => {
        cache.planner = createPlanner(hydratePlanIndex(raw));
        return cache.planner;
      })
      .finally(() => {
        cache.inFlight = null;
      });
  }
  return cache.inFlight;
}

/** @returns {{planner: object|null, error: string, isLoading: boolean}} */
export function usePlanIndex() {
  const [state, setState] = useState(() => ({
    planner: cache.planner,
    error: "",
    isLoading: !cache.planner,
  }));

  useEffect(() => {
    if (cache.planner) return undefined;
    let cancelled = false;
    loadPlanner()
      .then((planner) => {
        if (!cancelled) setState({ planner, error: "", isLoading: false });
      })
      .catch((error) => {
        console.error("[plan] index load failed:", error);
        if (!cancelled) {
          setState({
            planner: null,
            error: "We couldn't load the night train network just now.",
            isLoading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
