import { useState, useDeferredValue } from "react";
import useAdminOverrides from "../../hooks/useAdminOverrides";

const inputCls =
  "border border-gray-300 rounded px-2 py-1 text-sm min-w-0 focus:outline-none focus:ring-1 focus:ring-gray-400";
const primaryBtnCls =
  "text-xs px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
const dangerBtnCls =
  "text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";

// ─── Single alias row ────────────────────────────────────────────────────────

function AliasRow({ alias, canonical, mutate, busy }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-b-0">
      <span className="text-sm text-gray-500 flex-1 truncate min-w-0" title={alias}>
        {alias}
      </span>
      <span className="text-gray-300 shrink-0">→</span>
      <span className="text-sm text-gray-800 flex-1 truncate min-w-0" title={canonical}>
        {canonical}
      </span>
      <button
        type="button"
        className={dangerBtnCls}
        disabled={!!busy}
        onClick={() => {
          if (window.confirm(`Remove alias "${alias}" → "${canonical}"?`)) {
            mutate(
              "station-aliases",
              "remove",
              { alias },
              `chore(override): alias remove ${alias}`,
              `alias:remove:${alias}`,
            );
          }
        }}
      >
        Remove
      </button>
    </div>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export default function StationsTab() {
  const { overrides, target, loading, busy, error, notice, mutate } =
    useAdminOverrides();

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  // Add-alias form
  const [newAlias, setNewAlias] = useState("");
  const [newCanonical, setNewCanonical] = useState("");

  const aliases = overrides?.["station-aliases"] || {};
  const allEntries = Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b));

  const q = deferredQuery.toLowerCase().trim();
  const filtered = q
    ? allEntries.filter(
        ([alias, canonical]) =>
          alias.includes(q) || canonical.toLowerCase().includes(q),
      )
    : allEntries;

  // Paginate to keep the DOM responsive
  const PAGE_SIZE = 80;
  const shown = filtered.slice(0, PAGE_SIZE);

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 overflow-hidden">
      {notice && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700 flex items-center justify-between gap-2">
          <span>{notice.text}</span>
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noreferrer" className="underline shrink-0">
              View commit
            </a>
          )}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {loading && !overrides ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : (
        <>
          {/* Description */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-800">Station name aliases</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Map alternative station names (NightJet German, ASCII, GTFS variants) to canonical
              Back-on-Track names. Keys are lowercase; the resolver lowercases input before lookup.
            </p>
            {target?.repo && (
              <p className="text-xs text-gray-400 mt-1 font-mono">
                {target.repo}@{target.branch}
              </p>
            )}
          </div>

          {/* Search + list */}
          <input
            type="search"
            placeholder={`Filter ${allEntries.length} aliases…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
          />

          <div className="text-xs text-gray-400">
            {filtered.length} of {allEntries.length} aliases
          </div>

          <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm p-4 overflow-hidden">
            {/* Column headers */}
            <div className="shrink-0 flex items-center gap-2 text-[11px] text-gray-400 font-medium pb-1 border-b border-gray-100 mb-1">
              <span className="flex-1">Alias (lowercase)</span>
              <span className="w-4" />
              <span className="flex-1">Canonical name</span>
              <span className="w-16" />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {shown.length === 0 ? (
                <p className="text-xs text-gray-400 py-2">No matches.</p>
              ) : (
                shown.map(([alias, canonical]) => (
                  <AliasRow
                    key={alias}
                    alias={alias}
                    canonical={canonical}
                    mutate={mutate}
                    busy={busy}
                  />
                ))
              )}
              {filtered.length > PAGE_SIZE && (
                <p className="text-xs text-gray-400 pt-2">
                  +{filtered.length - PAGE_SIZE} more — refine the filter.
                </p>
              )}
            </div>
          </div>

          {/* Add new alias */}
          <div className="shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-2">Add alias</h3>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const a = newAlias.trim();
                const c = newCanonical.trim();
                if (!a || !c) return;
                mutate(
                  "station-aliases",
                  "set",
                  { alias: a, canonical: c },
                  `chore(override): alias ${a} → ${c}`,
                  "alias:add",
                ).then((ok) => {
                  if (ok) {
                    setNewAlias("");
                    setNewCanonical("");
                  }
                });
              }}
            >
              <input
                className={`${inputCls} flex-1 min-w-[8rem]`}
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder="Alias name (will be lowercased)"
              />
              <span className="text-gray-300">→</span>
              <input
                className={`${inputCls} flex-1 min-w-[8rem]`}
                value={newCanonical}
                onChange={(e) => setNewCanonical(e.target.value)}
                placeholder="Canonical name (exact case)"
              />
              <button
                type="submit"
                className={primaryBtnCls}
                disabled={busy === "alias:add" || !newAlias.trim() || !newCanonical.trim()}
              >
                Add
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
