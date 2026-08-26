/**
 * Review queue tab: lists pending proposals (scrape diffs, AI suggestions,
 * price probes, public submissions), shows the full envelope with a
 * before/after diff and evidence, and lets the admin Approve / Edit & Approve
 * / Reject. Approval commits the change to the live branch — nothing lands on
 * the map without passing through here.
 */
import { useEffect, useState } from "react";
import useProposals from "../../hooks/useProposals";
import { diffProposal } from "./proposalDiff";

const SOURCE_BADGES = {
  public: "bg-sky-50 text-sky-700 border-sky-200",
  scrape: "bg-violet-50 text-violet-700 border-violet-200",
  ai: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  probe: "bg-teal-50 text-teal-700 border-teal-200",
  admin: "bg-gray-100 text-gray-600 border-gray-200",
};

function ageLabel(createdAt) {
  const hours = Math.round((Date.now() - new Date(createdAt).getTime()) / 3.6e6);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Badge({ children, className }) {
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${className}`}
    >
      {children}
    </span>
  );
}

function DiffTable({ before, after }) {
  const rows = diffProposal(before, after);
  if (!rows.length) return null;
  return (
    <div className="rounded-md border border-gray-100 overflow-hidden text-xs">
      <div className="grid grid-cols-[1fr_1fr_1fr] bg-gray-50 px-2 py-1 font-medium text-gray-500">
        <span>Field</span>
        <span>Before</span>
        <span>After</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="grid grid-cols-[1fr_1fr_1fr] px-2 py-1 border-t border-gray-50"
        >
          <span className="font-mono text-gray-700 break-all">{row.key}</span>
          <span className="text-red-700/80 break-all">
            {row.before === undefined ? "—" : String(row.before)}
          </span>
          <span className="text-green-700/90 break-all">
            {row.after === undefined ? "—" : String(row.after)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProposalCard({ meta, loadOne, decide, busy }) {
  const [details, setDetails] = useState(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [applyText, setApplyText] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!details) {
      const loaded = await loadOne(meta.id, meta.filename);
      if (loaded) {
        setDetails(loaded);
        setApplyText(
          loaded.proposal.apply ? JSON.stringify(loaded.proposal.apply, null, 2) : "",
        );
      }
    }
  }

  async function submit(decision) {
    setLocalError(null);
    let editedApply;
    if (editing && applyText.trim()) {
      try {
        editedApply = JSON.parse(applyText);
      } catch {
        setLocalError("Edited apply is not valid JSON.");
        return;
      }
    }
    await decide(meta.id, meta.filename, decision, { note, editedApply });
  }

  const p = details?.proposal;
  const isBusy = busy === meta.id;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <button
        type="button"
        onClick={toggle}
        className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Badge className={SOURCE_BADGES[meta.source] ?? SOURCE_BADGES.admin}>
            {meta.source}
          </Badge>
          <span className="text-xs font-mono text-gray-500">{meta.kind}</span>
          <span className="text-sm font-medium text-gray-900 truncate">
            {p?.title ?? meta.id}
          </span>
        </div>
        <span className="text-xs text-gray-400 shrink-0">{ageLabel(meta.createdAt)}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
          {!details && <p className="text-xs text-gray-400">Loading…</p>}
          {p && (
            <>
              {p.summary && <p className="text-sm text-gray-700">{p.summary}</p>}

              <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                {p.target?.routeKey && <span>route: <code>{p.target.routeKey}</code></span>}
                {p.target?.agencyId && <span>operator: <code>{p.target.agencyId}</code></span>}
                {p.target?.stationName && <span>station: <code>{p.target.stationName}</code></span>}
                {p.submitter?.email && <span>contact: {p.submitter.email}</span>}
                {p.submitter?.ipHash && <span>ip#{p.submitter.ipHash}</span>}
              </div>

              <DiffTable before={p.before} after={p.after} />

              {p.evidence?.urls?.length > 0 && (
                <div className="text-xs space-x-3">
                  {p.evidence.urls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline break-all"
                    >
                      {url}
                    </a>
                  ))}
                </div>
              )}
              {p.evidence?.excerpt && (
                <pre className="text-[11px] bg-gray-50 rounded-md p-2 max-h-40 overflow-auto whitespace-pre-wrap">
                  {p.evidence.excerpt}
                </pre>
              )}

              {p.apply ? (
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500">
                      Change to apply
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditing((v) => !v)}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {editing ? "Cancel edit" : "Edit before approving"}
                    </button>
                  </div>
                  {editing ? (
                    <textarea
                      value={applyText}
                      onChange={(e) => setApplyText(e.target.value)}
                      rows={8}
                      spellCheck={false}
                      className="mt-1 w-full font-mono text-[11px] border border-gray-200 rounded-md p-2"
                    />
                  ) : (
                    <pre className="mt-1 text-[11px] bg-gray-50 rounded-md p-2 max-h-40 overflow-auto">
                      {applyText}
                    </pre>
                  )}
                </div>
              ) : (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                  No automatic change attached — apply manually in the other tabs,
                  then resolve this item.
                </p>
              )}

              {localError && <p className="text-xs text-red-600">{localError}</p>}

              <div className="flex items-center gap-2 flex-wrap">
                {p.apply && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => submit("approve")}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {isBusy ? "Working…" : editing ? "Approve edited" : "Approve"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => submit("reject")}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {p.apply ? "Reject" : "Resolve / dismiss"}
                </button>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note"
                  className="flex-1 min-w-[140px] text-xs border border-gray-200 rounded-md px-2 py-1.5"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ReviewTab({ onPendingCount }) {
  const { proposals, truncated, loading, busy, error, notice, loadOne, decide } =
    useProposals();

  useEffect(() => {
    if (typeof onPendingCount === "function" && proposals) {
      onPendingCount(proposals.length);
    }
  }, [proposals, onPendingCount]);

  return (
    <div className="h-full min-h-0 overflow-y-auto space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-gray-600">
          Pending changes{proposals ? ` (${proposals.length})` : ""}
        </h2>
        {truncated && (
          <span className="text-xs text-amber-600">Queue truncated at 1000</span>
        )}
      </div>

      {notice && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-2">
          {notice.text}{" "}
          {notice.href && (
            <a
              href={notice.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View commit
            </a>
          )}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2">
          {error}
        </p>
      )}

      {loading && <p className="text-sm text-gray-400">Loading queue…</p>}

      {proposals && proposals.length === 0 && !loading && (
        <p className="text-sm text-gray-500 bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">
          Nothing waiting for review. 🎉
        </p>
      )}

      {(proposals ?? []).map((meta) => (
        <ProposalCard
          key={meta.id}
          meta={meta}
          loadOne={loadOne}
          decide={decide}
          busy={busy}
        />
      ))}
    </div>
  );
}
