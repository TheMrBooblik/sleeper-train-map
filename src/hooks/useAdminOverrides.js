/**
 * Shared hook for loading and mutating data/overrides/*.json resources
 * through the /api/admin/override endpoint. Used by OverridesTab,
 * OperatorsTab, and StationsTab to avoid duplicating the fetch/commit logic.
 */
import { useCallback, useEffect, useState } from "react";

export default function useAdminOverrides() {
  const [overrides, setOverrides] = useState(null);
  const [seenState, setSeenState] = useState(null);
  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [expired, setExpired] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/override");
      if (res.status === 401) {
        setExpired(true);
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `Failed to load (${res.status}).`);
        return;
      }
      setOverrides(json.overrides || {});
      setSeenState(json.seenState || null);
      setTarget({ repo: json.repo, branch: json.branch });
      if (json.errors) {
        setError(
          `Could not read ${Object.keys(json.errors).join(", ")} from GitHub — check ADMIN_GITHUB_TOKEN.`,
        );
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Apply a single mutation and reload all overrides on success. */
  const mutate = useCallback(
    async (resource, action, payload, message, busyKey) => {
      setBusy(busyKey || `${resource}:${action}`);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/admin/override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource, action, payload, message }),
        });
        if (res.status === 401) {
          setExpired(true);
          return false;
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json.error || `Save failed (${res.status}).`);
          return false;
        }
        setNotice({ text: `Saved: ${resource} ${action}.`, href: json.commit || null });
        await load();
        return true;
      } catch (e) {
        setError(e.message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return { overrides, seenState, target, loading, busy, error, notice, expired, mutate };
}
