/**
 * Sources tab: the registry (data/sources/registry.json) made editable —
 * enable/disable a source and edit its params JSON without touching code.
 * Writes go through the standard override commit path; the nightly scrape
 * picks changes up on its next run. The endpoint re-validates the whole
 * registry before committing, so a bad edit can't break the pipeline.
 */
import { useState } from "react";
import useAdminOverrides from "../../hooks/useAdminOverrides";

function SourceRow({ entry, busy, onToggle, onSaveParams }) {
  const [editing, setEditing] = useState(false);
  const [paramsText, setParamsText] = useState("");
  const [localError, setLocalError] = useState(null);

  function startEdit() {
    setParamsText(JSON.stringify(entry.params ?? {}, null, 2));
    setLocalError(null);
    setEditing(true);
  }

  async function saveParams() {
    let parsed;
    try {
      parsed = JSON.parse(paramsText);
    } catch {
      setLocalError("Params is not valid JSON.");
      return;
    }
    setLocalError(null);
    const ok = await onSaveParams(entry.id, parsed);
    if (ok) setEditing(false);
  }

  const isBusy = busy === `source-registry:${entry.id}`;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900">{entry.label}</span>
            <code className="text-[11px] text-gray-400">{entry.id}</code>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
              {entry.kind}
            </span>
            {entry.schedule && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                {entry.schedule}
              </span>
            )}
          </div>
          {entry.description && (
            <p className="text-xs text-gray-400 mt-0.5">{entry.description}</p>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={!!entry.enabled}
            disabled={isBusy}
            onChange={(e) => onToggle(entry.id, e.target.checked)}
          />
          enabled
        </label>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => (editing ? setEditing(false) : startEdit())}
          className="text-blue-600 hover:underline"
        >
          {editing ? "Cancel" : "Edit params"}
        </button>
        {entry.output && <span className="text-gray-400">→ {entry.output}</span>}
      </div>

      {editing && (
        <div className="space-y-2">
          <textarea
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            rows={8}
            spellCheck={false}
            className="w-full font-mono text-[11px] border border-gray-200 rounded-md p-2"
          />
          {localError && <p className="text-xs text-red-600">{localError}</p>}
          <button
            type="button"
            disabled={isBusy}
            onClick={saveParams}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-black text-white disabled:opacity-50"
          >
            {isBusy ? "Saving…" : "Save params"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function SourcesTab() {
  const { overrides, loading, busy, error, notice, mutate } =
    useAdminOverrides();

  const registry = Array.isArray(overrides?.["source-registry"])
    ? overrides["source-registry"]
    : null;

  const onToggle = (id, enabled) =>
    mutate(
      "source-registry",
      "setEnabled",
      { id, enabled },
      `chore(sources): ${enabled ? "enable" : "disable"} ${id}`,
      `source-registry:${id}`,
    );

  const onSaveParams = (id, params) =>
    mutate(
      "source-registry",
      "setParams",
      { id, params },
      `chore(sources): params ${id}`,
      `source-registry:${id}`,
    );

  return (
    <div className="h-full min-h-0 overflow-y-auto space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-gray-600">
          Data sources (registry)
        </h2>
        <span className="text-xs text-gray-400">
          Changes apply on the next nightly scrape
        </span>
      </div>

      {notice && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-2">
          {notice.text}{" "}
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noopener noreferrer" className="underline">
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
      {loading && <p className="text-sm text-gray-400">Loading registry…</p>}

      {(registry ?? []).map((entry) => (
        <SourceRow
          key={entry.id}
          entry={entry}
          busy={busy}
          onToggle={onToggle}
          onSaveParams={onSaveParams}
        />
      ))}

      {registry && (
        <p className="text-xs text-gray-400 pb-4">
          New sources: add a registry entry (and an adapter module if no
          existing kind fits) — see data/sources/registry.json.
        </p>
      )}
    </div>
  );
}
