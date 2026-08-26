/**
 * Shared hook for the review queue: lists pending proposals, loads full
 * envelopes on demand, and submits approve/reject decisions through
 * /api/admin/proposals. Mirrors the useAdminOverrides state conventions.
 */
import { useCallback, useEffect, useState } from "react";

export default function useProposals() {
  const [proposals, setProposals] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/proposals");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `Failed to load queue (${res.status}).`);
        return;
      }
      setProposals(json.proposals || []);
      setTruncated(Boolean(json.truncated));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Fetch the full proposal envelope for one queue entry. */
  const loadOne = useCallback(async (id, filename) => {
    const res = await fetch(
      `/api/admin/proposals/${encodeURIComponent(id)}?filename=${encodeURIComponent(filename)}`,
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error || `Failed to load proposal (${res.status}).`);
      return null;
    }
    return json;
  }, []);

  /** Submit a decision; reloads the queue on success. */
  const decide = useCallback(
    async (id, filename, decision, { note, editedApply } = {}) => {
      setBusy(id);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/admin/proposals/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, note, editedApply, filename }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json.error || `Decision failed (${res.status}).`);
          return false;
        }
        setNotice({
          text: decision === "approve" ? `Approved ${id}.` : `Rejected ${id}.`,
          href: json.applyCommit || null,
        });
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

  return {
    proposals,
    truncated,
    loading,
    busy,
    error,
    notice,
    load,
    loadOne,
    decide,
  };
}
