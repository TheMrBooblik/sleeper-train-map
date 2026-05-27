import { useState, useEffect, useDeferredValue } from "react";
import useAdminOverrides from "../../hooks/useAdminOverrides";
import { OPERATOR_BRAND_COLORS, NEUTRAL_FALLBACK_COLOR } from "../Map/utils/operatorColors";

const inputCls =
  "border border-gray-300 rounded px-2 py-1 text-sm min-w-0 focus:outline-none focus:ring-1 focus:ring-gray-400";
const primaryBtnCls =
  "text-xs px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
const dangerBtnCls =
  "text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";

// ─── Color swatch ────────────────────────────────────────────────────────────

function ColorSwatch({ hex }) {
  return (
    <span
      className="inline-block w-4 h-4 rounded-sm border border-gray-200 shrink-0"
      style={{ backgroundColor: hex }}
      title={hex}
    />
  );
}

// ─── Editable pricing row (per operator) ──────────────────────────────────────

function PricingFields({ agencyId, value, mutate, busy }) {
  const [type, setType] = useState(value?.type || "");
  const [currency, setCurrency] = useState(value?.currency || "");
  const [fromPrice, setFromPrice] = useState(value?.fromPrice ?? "");
  const [note, setNote] = useState(value?.note || "");
  const key = `pricing:${agencyId}`;

  // Re-sync local state when the override value changes (e.g. after reload).
  // The parent uses a key that includes the serialized value, so this component
  // re-mounts on external changes — but this covers edge-case reloads too.
  const serialized = JSON.stringify(value);
  useEffect(() => {
    setType(value?.type || "");
    setCurrency(value?.currency || "");
    setFromPrice(value?.fromPrice ?? "");
    setNote(value?.note || "");
  }, [serialized]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      <select className={`${inputCls} w-24`} value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">—</option>
        <option value="dynamic">dynamic</option>
        <option value="fixed">fixed</option>
      </select>
      <input
        className={`${inputCls} w-16`}
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
        placeholder="EUR"
      />
      <input
        className={`${inputCls} w-20`}
        value={fromPrice}
        onChange={(e) => setFromPrice(e.target.value)}
        placeholder="from"
        inputMode="decimal"
      />
      <input
        className={`${inputCls} flex-1 min-w-[6rem]`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="note"
      />
      <button
        type="button"
        className={primaryBtnCls}
        disabled={busy === key || !type}
        onClick={() =>
          mutate(
            "operator-pricing",
            "set",
            {
              agencyId,
              type,
              currency: currency.trim() || null,
              fromPrice: fromPrice === "" ? null : Number(fromPrice),
              note: note.trim() || undefined,
            },
            `chore(override): pricing ${agencyId}`,
            key,
          )
        }
      >
        Save
      </button>
      {value && (
        <button
          type="button"
          className={dangerBtnCls}
          disabled={!!busy}
          onClick={() => {
            if (window.confirm(`Remove pricing for "${agencyId}"?`)) {
              mutate(
                "operator-pricing",
                "remove",
                { agencyId },
                `chore(override): pricing remove ${agencyId}`,
                `pricing:remove:${agencyId}`,
              );
            }
          }}
        >
          Remove
        </button>
      )}
    </div>
  );
}

// ─── Single operator card ───────────────────────────────────────────────────

function OperatorCard({ agencyId, color, routeCount, pricing, mutate, busy }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-gray-100 last:border-b-0 py-2.5">
      <div className="flex items-center gap-3">
        <ColorSwatch hex={color} />
        <span className="font-mono text-sm font-medium text-gray-800 w-14 shrink-0">
          {agencyId}
        </span>
        <span className="text-xs text-gray-500">
          {routeCount} {routeCount === 1 ? "route" : "routes"}
        </span>
        {pricing?.type && (
          <span className="text-xs text-gray-400 ml-auto hidden min-[480px]:inline">
            {pricing.type}{pricing.currency ? ` · ${pricing.currency}` : ""}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-gray-400 hover:text-gray-700 ml-auto min-[480px]:ml-0"
        >
          {open ? "Hide pricing" : "Edit pricing"}
        </button>
      </div>
      {open && (
        <PricingFields
          agencyId={agencyId}
          value={pricing}
          mutate={mutate}
          busy={busy}
        />
      )}
    </div>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export default function OperatorsTab() {
  const { overrides, target, loading, busy, error, notice, expired, mutate } =
    useAdminOverrides();

  // Route data for operator counts
  const [routeData, setRouteData] = useState(null);
  const [routeLoading, setRouteLoading] = useState(true);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    fetch("/api/initial-data")
      .then((r) => r.json())
      .then((data) => {
        // Count routes per agency_id
        const counts = {};
        Object.values(data.viewMap || {}).forEach((route) => {
          const id = (route.agency_id || "").trim();
          if (id) counts[id] = (counts[id] || 0) + 1;
        });
        setRouteData(counts);
      })
      .catch(() => setRouteData({}))
      .finally(() => setRouteLoading(false));
  }, []);

  // Build a merged list: all operators that have routes OR have pricing OR have brand colors
  const pricing = overrides?.["operator-pricing"] || {};
  const allIds = new Set([
    ...Object.keys(OPERATOR_BRAND_COLORS),
    ...Object.keys(routeData || {}),
    ...Object.keys(pricing),
  ]);
  const operators = [...allIds]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      color: OPERATOR_BRAND_COLORS[id] || NEUTRAL_FALLBACK_COLOR,
      routeCount: routeData?.[id] || 0,
      pricing: pricing[id] || null,
    }));

  const q = deferredQuery.toLowerCase().trim();
  const filtered = q
    ? operators.filter((op) => op.id.toLowerCase().includes(q))
    : operators;

  // New operator pricing form
  const [newId, setNewId] = useState("");
  const [newType, setNewType] = useState("dynamic");
  const [newCurrency, setNewCurrency] = useState("");

  if (expired) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-sm text-gray-700">
        Your session expired.{" "}
        <a href="/login" className="underline">Log in again</a>.
      </div>
    );
  }

  return (
    <div className="space-y-4">
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

      <input
        type="search"
        placeholder={`Filter ${operators.length} operators…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
      />

      {(loading || routeLoading) && (
        <div className="text-sm text-gray-400">Loading…</div>
      )}

      {!loading && !routeLoading && (
        <>
          <div className="text-xs text-gray-400">
            {filtered.length} of {operators.length} operators
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400">No matches.</p>
            ) : (
              filtered.map((op) => (
                <OperatorCard
                  key={op.id}
                  agencyId={op.id}
                  color={op.color}
                  routeCount={op.routeCount}
                  pricing={op.pricing}
                  mutate={mutate}
                  busy={busy}
                />
              ))
            )}
          </div>

          {/* Add new operator pricing */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-2">Add operator pricing</h3>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newId.trim();
                if (!v) return;
                mutate(
                  "operator-pricing",
                  "set",
                  { agencyId: v, type: newType, currency: newCurrency.trim() || null },
                  `chore(override): pricing ${v}`,
                  "pricing:add",
                ).then((ok) => {
                  if (ok) {
                    setNewId("");
                    setNewCurrency("");
                  }
                });
              }}
            >
              <input
                className={`${inputCls} w-20`}
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="agency id"
              />
              <select className={inputCls} value={newType} onChange={(e) => setNewType(e.target.value)}>
                <option value="dynamic">dynamic</option>
                <option value="fixed">fixed</option>
              </select>
              <input
                className={`${inputCls} w-16`}
                value={newCurrency}
                onChange={(e) => setNewCurrency(e.target.value)}
                placeholder="EUR"
              />
              <button
                type="submit"
                className={primaryBtnCls}
                disabled={busy === "pricing:add" || !newId.trim()}
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
