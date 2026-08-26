/**
 * Integrations — which of Pingwi's routes still come from Back-on-Track, what
 * official source could replace it, and what to build next.
 *
 * One fetch of /api/admin/integrations; all arithmetic already happened in
 * src/lib/integrations/model.mjs. Edits to the research catalogue go through
 * the ordinary admin commit path (useAdminOverrides → /api/admin/override).
 */
import { Fragment, useMemo, useState } from "react";
import useAdminOverrides from "../../hooks/useAdminOverrides";
import {
  AUTH_LABELS,
  Badge,
  DIFFICULTY_LABELS,
  ErrorBanner,
  FreshnessCell,
  INTEGRATION_STATUS_LABELS,
  Metric,
  NoticeBanner,
  PRIORITY_BANDS,
  PriorityBadge,
  SOURCE_STATUS,
  SourceLink,
  formatDate,
  formatUtc,
  inputCls,
  linkCls,
  primaryBtnCls,
  dangerBtnCls,
  useIntegrations,
} from "./integrationsUi";

const INTEGRATION_STATUS_OPTIONS = Object.keys(INTEGRATION_STATUS_LABELS);
const DIFFICULTY_OPTIONS = Object.keys(DIFFICULTY_LABELS);
const SOURCE_STATUS_OPTIONS = ["integrated", "working", "discovered", "broken"];
const AUTH_OPTIONS = Object.keys(AUTH_LABELS);

const COLUMNS = [
  {
    key: "name",
    label: "Operator",
    sort: (a, b) => a.name.localeCompare(b.name),
  },
  {
    key: "routes",
    label: "Routes",
    numeric: true,
    sort: (a, b) => b.routeCount - a.routeCount,
  },
  { key: "current", label: "Current source" },
  { key: "official", label: "Official source" },
  {
    key: "updated",
    label: "Last update",
    sort: (a, b) =>
      String(b.lastSuccessAt ?? "").localeCompare(
        String(a.lastSuccessAt ?? ""),
      ),
  },
  { key: "freshness", label: "Freshness" },
  {
    key: "coverage",
    label: "Coverage",
    numeric: true,
    sort: (a, b) => a.routeCoveragePct - b.routeCoveragePct,
  },
  {
    key: "priority",
    label: "Priority",
    sort: (a, b) => b.priority.score - a.priority.score,
  },
];

// ─── Current source cell ─────────────────────────────────────────────────────

/** Never a category — the actual feed, or "Back-on-Track", with route counts. */
function CurrentSources({ sources, compact = false }) {
  if (!sources?.length)
    return <span className="text-gray-400 text-xs">Unknown</span>;
  const shown = compact ? sources.slice(0, 2) : sources;
  return (
    <div className="space-y-0.5">
      {shown.map((s) => {
        const meta =
          s.id === "backontrack"
            ? SOURCE_STATUS.backontrack
            : s.official
              ? SOURCE_STATUS.integrated
              : null;
        return (
          <div key={s.id} className="leading-tight">
            <span className="text-xs text-gray-800">
              {meta && <span title={meta.hint}>{meta.icon} </span>}
              {s.label}
              {sources.length > 1 && (
                <span className="text-gray-400"> ({s.routeCount})</span>
              )}
            </span>
            <div>
              <SourceLink url={s.endpoint} />
            </div>
          </div>
        );
      })}
      {compact && sources.length > shown.length && (
        <div className="text-[11px] text-gray-400">
          +{sources.length - shown.length} more
        </div>
      )}
    </div>
  );
}

function OfficialSourceCell({ operator }) {
  const sources = operator.officialSources ?? [];
  if (!sources.length) {
    return (
      <Badge className={SOURCE_STATUS.none.cls} title={SOURCE_STATUS.none.hint}>
        {SOURCE_STATUS.none.icon} None found
      </Badge>
    );
  }
  const primary = sources[0];
  const meta = SOURCE_STATUS[primary.status] ?? SOURCE_STATUS.discovered;
  return (
    <div className="leading-tight space-y-0.5">
      <div className="text-xs text-gray-800">
        <span title={meta.hint}>{meta.icon} </span>
        {primary.format ?? "Source"}
      </div>
      <SourceLink url={primary.url} />
      {sources.length > 1 && (
        <div className="text-[11px] text-gray-400">
          +{sources.length - 1} more
        </div>
      )}
    </div>
  );
}

// ─── "What should I integrate next?" ─────────────────────────────────────────

function NextCard({ operator }) {
  const band = PRIORITY_BANDS[operator.priority.band] ?? PRIORITY_BANDS.low;
  const source = operator.officialSources?.[0] ?? null;
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-3 py-2.5 space-y-1.5 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900 truncate">
          {operator.name}
        </span>
        <Badge className={band.cls}>
          {band.dot} {band.label}
        </Badge>
      </div>
      <div className="text-xs text-gray-600">
        <span className="font-mono">{operator.manualRouteCount}</span> route
        {operator.manualRouteCount === 1 ? "" : "s"} on Back-on-Track ·{" "}
        <span className="font-mono">{operator.manualStationCount}</span>{" "}
        stations
      </div>
      <div className="text-[11px] text-gray-500">
        Current: {operator.currentSources.map((s) => s.label).join(", ")}
      </div>
      <div>
        <div className="text-[11px] text-gray-500">
          Official: {source ? (source.format ?? "source") : "none found"}
        </div>
        {source && <SourceLink url={source.url} />}
      </div>
      <div className="flex flex-wrap gap-1 pt-0.5">
        <Badge className="bg-gray-100 text-gray-600 border-gray-200">
          Coverage {operator.automatedRouteCount} → {operator.routeCount} /{" "}
          {operator.routeCount} routes
        </Badge>
        <Badge className="bg-gray-100 text-gray-600 border-gray-200">
          {DIFFICULTY_LABELS[operator.difficulty]} to build
        </Badge>
        <Badge className="bg-gray-100 text-gray-600 border-gray-200">
          {INTEGRATION_STATUS_LABELS[operator.integrationStatus]}
        </Badge>
      </div>
    </div>
  );
}

// ─── Catalogue editors ───────────────────────────────────────────────────────

function SourceEditor({ agencyId, index, source, mutate, busy, onDone }) {
  const [draft, setDraft] = useState(
    source ?? {
      name: "",
      url: "",
      docsUrl: "",
      format: "",
      provides: [],
      auth: "unknown",
      status: "discovered",
      lastChecked: "",
      notes: "",
    },
  );
  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });
  const busyKey = `official-sources:${agencyId}`;

  async function save() {
    const ok = await mutate(
      "official-sources",
      "setSource",
      {
        agencyId,
        ...(index >= 0 ? { index } : {}),
        source: {
          ...draft,
          provides:
            typeof draft.provides === "string"
              ? draft.provides
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : draft.provides,
          lastChecked: draft.lastChecked || null,
        },
      },
      `chore(sources): ${index >= 0 ? "update" : "add"} official source for ${agencyId}`,
      busyKey,
    );
    if (ok) onDone();
  }

  return (
    <div className="border border-gray-200 rounded-lg p-2 space-y-1.5 bg-gray-50">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        <input
          className={inputCls}
          placeholder="Name"
          value={draft.name}
          onChange={set("name")}
        />
        <input
          className={inputCls}
          placeholder="URL (exact endpoint / feed)"
          value={draft.url}
          onChange={set("url")}
        />
        <input
          className={inputCls}
          placeholder="Docs URL"
          value={draft.docsUrl ?? ""}
          onChange={set("docsUrl")}
        />
        <input
          className={inputCls}
          placeholder="Format (GTFS, JSON API, XML…)"
          value={draft.format ?? ""}
          onChange={set("format")}
        />
        <input
          className={inputCls}
          placeholder="Provides (comma separated)"
          value={
            Array.isArray(draft.provides)
              ? draft.provides.join(", ")
              : draft.provides
          }
          onChange={set("provides")}
        />
        <input
          className={inputCls}
          placeholder="Last checked (YYYY-MM-DD)"
          value={draft.lastChecked ?? ""}
          onChange={set("lastChecked")}
        />
        <select
          className={inputCls}
          value={draft.auth ?? "unknown"}
          onChange={set("auth")}
        >
          {AUTH_OPTIONS.map((a) => (
            <option key={a} value={a}>
              Auth: {AUTH_LABELS[a]}
            </option>
          ))}
        </select>
        <select
          className={inputCls}
          value={draft.status ?? "discovered"}
          onChange={set("status")}
        >
          {SOURCE_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {SOURCE_STATUS[s].label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className={`${inputCls} w-full`}
        rows={2}
        placeholder="Notes"
        value={draft.notes ?? ""}
        onChange={set("notes")}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className={primaryBtnCls}
          disabled={busy === busyKey}
          onClick={save}
        >
          {busy === busyKey ? "Saving…" : "Save source"}
        </button>
        <button
          type="button"
          className="text-xs text-gray-500 hover:underline"
          onClick={onDone}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function OfficialSourceRow({ agencyId, index, source, mutate, busy }) {
  const [editing, setEditing] = useState(false);
  const meta = SOURCE_STATUS[source.status] ?? SOURCE_STATUS.discovered;
  const busyKey = `official-sources:${agencyId}`;

  if (editing) {
    return (
      <SourceEditor
        agencyId={agencyId}
        index={index}
        source={source}
        mutate={mutate}
        busy={busy}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="border-t border-gray-100 pt-2 first:border-t-0 first:pt-0 space-y-0.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-900">{source.name}</span>
        <Badge className={meta.cls} title={meta.hint}>
          {meta.icon} {meta.label}
        </Badge>
        {source.probeWorkflow && (
          <Badge
            className="bg-gray-100 text-gray-600 border-gray-200"
            title="A probe workflow exists in .github/workflows/"
          >
            probe: {source.probeWorkflow}
          </Badge>
        )}
      </div>
      <SourceLink url={source.url} />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 text-[11px] text-gray-500">
        <dt>Format</dt>
        <dd className="text-gray-700">{source.format ?? "—"}</dd>
        <dt>Provides</dt>
        <dd className="text-gray-700">
          {source.provides?.length ? source.provides.join(", ") : "—"}
        </dd>
        <dt>Auth</dt>
        <dd className="text-gray-700">
          {AUTH_LABELS[source.auth] ?? source.auth}
        </dd>
        <dt>Last checked</dt>
        <dd className="text-gray-700">
          {source.lastChecked
            ? formatDate(source.lastChecked)
            : "never verified"}
        </dd>
        {source.docsUrl && (
          <>
            <dt>Docs</dt>
            <dd>
              <SourceLink url={source.docsUrl} />
            </dd>
          </>
        )}
      </dl>
      {source.notes && (
        <p className="text-[11px] text-gray-500">{source.notes}</p>
      )}
      <div className="flex gap-3 pt-0.5">
        <button
          type="button"
          className="text-[11px] text-blue-600 hover:underline"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          className="text-[11px] text-red-600 hover:underline"
          disabled={busy === busyKey}
          onClick={() => {
            if (!window.confirm(`Remove "${source.name}" from ${agencyId}?`))
              return;
            mutate(
              "official-sources",
              "removeSource",
              { agencyId, index },
              `chore(sources): remove official source for ${agencyId}`,
              busyKey,
            );
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function OperatorMetaEditor({ operator, mutate, busy }) {
  const [status, setStatus] = useState(operator.integrationStatus);
  const [difficulty, setDifficulty] = useState(operator.difficulty);
  const [notes, setNotes] = useState(operator.notes ?? "");
  const [website, setWebsite] = useState(operator.website ?? "");
  const busyKey = `official-sources:${operator.id}`;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5 items-center">
        <select
          className={inputCls}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {INTEGRATION_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {INTEGRATION_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          className={inputCls}
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
        >
          {DIFFICULTY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {DIFFICULTY_LABELS[d]} to build
            </option>
          ))}
        </select>
        <input
          className={`${inputCls} flex-1`}
          placeholder="Website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      <textarea
        className={`${inputCls} w-full`}
        rows={2}
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button
        type="button"
        className={primaryBtnCls}
        disabled={busy === busyKey}
        onClick={() =>
          mutate(
            "official-sources",
            "setOperator",
            {
              agencyId: operator.id,
              operator: {
                integrationStatus: status,
                difficulty,
                notes,
                website,
              },
            },
            `chore(sources): update research notes for ${operator.id}`,
            busyKey,
          )
        }
      >
        {busy === busyKey ? "Saving…" : "Save"}
      </button>
      {operator.statusOrigin === "derived" && (
        <p className="text-[11px] text-gray-400">
          Integration status shown in the table is derived from the registry and
          tonight&apos;s payload, so it overrides whatever is set here — this
          value only applies once no official source feeds this operator.
        </p>
      )}
    </div>
  );
}

// ─── Operator detail ─────────────────────────────────────────────────────────

function OperatorDetail({ operator, routes, mutate, busy }) {
  const [adding, setAdding] = useState(false);
  const opRoutes = useMemo(
    () => routes.filter((r) => r.operatorIds.includes(operator.id)),
    [routes, operator.id],
  );

  return (
    <div className="bg-gray-50 border-t border-gray-200 px-3 py-3 space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Basics + current source */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            Operator
          </h4>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-2 text-[11px] text-gray-500">
            <dt>Website</dt>
            <dd>
              <SourceLink url={operator.website} />
            </dd>
            <dt>Countries</dt>
            <dd className="text-gray-700">
              {operator.countries?.join(", ") || "—"}
            </dd>
            <dt>Routes</dt>
            <dd className="text-gray-700 font-mono">{operator.routeCount}</dd>
            <dt>Stations</dt>
            <dd className="text-gray-700 font-mono">{operator.stationCount}</dd>
            <dt>agency_id</dt>
            <dd className="text-gray-700 font-mono">{operator.id}</dd>
          </dl>

          <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide pt-1">
            Pingwi&apos;s current source
          </h4>
          <CurrentSources sources={operator.currentSources} />
          <dl className="grid grid-cols-[max-content_1fr] gap-x-2 text-[11px] text-gray-500">
            <dt>Last success</dt>
            <dd className="text-gray-700">
              {formatUtc(operator.lastSuccessAt)}
            </dd>
            <dt>Last failure</dt>
            <dd className="text-gray-700">
              {formatUtc(operator.lastFailureAt)}
            </dd>
            <dt>Routes covered</dt>
            <dd className="text-gray-700 font-mono">
              {operator.automatedRouteCount} / {operator.routeCount} (
              {operator.routeCoveragePct}%)
            </dd>
            <dt>Stations covered</dt>
            <dd className="text-gray-700 font-mono">
              {operator.automatedStationCount} / {operator.stationCount} (
              {operator.stationCoveragePct}%)
            </dd>
          </dl>
          {operator.lastError && (
            <p className="text-[11px] text-red-600 break-all">
              Last error: {operator.lastError}
            </p>
          )}
        </div>

        {/* Official sources found */}
        <div className="space-y-2 lg:col-span-2">
          <div className="flex items-baseline justify-between">
            <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Official sources found ({operator.officialSources.length})
            </h4>
            <button
              type="button"
              className="text-[11px] text-blue-600 hover:underline"
              onClick={() => setAdding((v) => !v)}
            >
              {adding ? "Cancel" : "+ Add source"}
            </button>
          </div>
          {adding && (
            <SourceEditor
              agencyId={operator.id}
              index={-1}
              source={null}
              mutate={mutate}
              busy={busy}
              onDone={() => setAdding(false)}
            />
          )}
          {operator.officialSources.length === 0 && !adding && (
            <p className="text-xs text-gray-500">
              {SOURCE_STATUS.none.icon} No official machine-readable source
              found yet.
              {operator.notes ? ` ${operator.notes}` : ""}
            </p>
          )}
          <div className="space-y-2">
            {operator.officialSources.map((source, i) => (
              <OfficialSourceRow
                key={`${source.name}-${i}`}
                agencyId={operator.id}
                index={i}
                source={source}
                mutate={mutate}
                busy={busy}
              />
            ))}
          </div>

          <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide pt-1">
            Integration status
          </h4>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-white text-gray-700 border-gray-300">
              {INTEGRATION_STATUS_LABELS[operator.integrationStatus]}
            </Badge>
            <span className="text-[11px] text-gray-400">
              {operator.statusOrigin === "derived"
                ? "derived from the registry + tonight's payload"
                : "from the research catalogue"}
            </span>
          </div>
          <p className="text-[11px] text-gray-500">
            {operator.priority.reason}
          </p>
          {operator.notes && (
            <p className="text-[11px] text-gray-500">{operator.notes}</p>
          )}
          <OperatorMetaEditor operator={operator} mutate={mutate} busy={busy} />
        </div>
      </div>

      {/* Routes */}
      <div>
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
          Routes ({opRoutes.length}) —{" "}
          <span className="font-normal normal-case text-gray-500">
            {operator.manualRouteCount} still on Back-on-Track
          </span>
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-1 pr-2 font-medium">Train</th>
                <th className="py-1 pr-2 font-medium">Origin</th>
                <th className="py-1 pr-2 font-medium">Destination</th>
                <th className="py-1 pr-2 font-medium">Current source</th>
                <th className="py-1 pr-2 font-medium">Automated</th>
                <th className="py-1 pr-2 font-medium">Last update</th>
                <th className="py-1 pr-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {opRoutes.map((r) => (
                <tr
                  key={r.routeKey}
                  className={`border-b border-gray-100 ${r.automated ? "" : "bg-orange-50/40"}`}
                >
                  <td className="py-1 pr-2 font-mono text-gray-800">
                    {r.trainNumbers[0] ?? r.routeKey}
                  </td>
                  <td className="py-1 pr-2 text-gray-600">{r.origin ?? "—"}</td>
                  <td className="py-1 pr-2 text-gray-600">
                    {r.destination ?? "—"}
                  </td>
                  <td className="py-1 pr-2 text-gray-600">{r.sourceLabel}</td>
                  <td className="py-1 pr-2">
                    {r.automated ? "✅ auto" : "⚠️ manual"}
                  </td>
                  <td className="py-1 pr-2 text-gray-500">
                    {r.lastChanged
                      ? `changed ${formatDate(r.lastChanged)}`
                      : "—"}
                  </td>
                  <td className="py-1 pr-2 text-gray-500">
                    {r.automated
                      ? `${SOURCE_STATUS.integrated.icon} ${r.sourceLabel}`
                      : `${SOURCE_STATUS.backontrack.icon} Back-on-Track`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────────────────

export default function IntegrationsTab() {
  const { data, loading, error } = useIntegrations();
  const { busy, error: saveError, notice, mutate } = useAdminOverrides();
  const [openId, setOpenId] = useState(null);
  const [sortKey, setSortKey] = useState("priority");

  const operators = useMemo(() => {
    const rows = [...(data?.operators ?? [])];
    const column = COLUMNS.find((c) => c.key === sortKey);
    return column?.sort ? rows.sort(column.sort) : rows;
  }, [data, sortKey]);

  const nextUp = useMemo(
    () =>
      (data?.next ?? [])
        .map((id) => data.operators.find((o) => o.id === id))
        .filter(Boolean),
    [data],
  );
  const blocked = useMemo(
    () =>
      (data?.blocked ?? [])
        .map((id) => data.operators.find((o) => o.id === id))
        .filter(Boolean),
    [data],
  );
  const totals = data?.totals ?? null;

  return (
    <div className="h-full min-h-0 overflow-y-auto space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-medium text-gray-600">
          Integration coverage — first-party vs Back-on-Track
        </h2>
        {data?.dataGeneratedAt && (
          <span className="text-[11px] text-gray-400">
            dataset {formatUtc(data.dataGeneratedAt)}
          </span>
        )}
      </div>

      {loading && (
        <p className="text-sm text-gray-400">Loading integration status…</p>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {/* Reading the dashboard needs no GitHub token; only editing the
          catalogue does. Don't open with a red banner over something that
          isn't broken. */}
      {saveError &&
        (/not configured/i.test(saveError) ? (
          <p className="text-[11px] text-gray-400">
            Read-only: {saveError}. Catalogue edits are disabled.
          </p>
        ) : (
          <ErrorBanner>{saveError}</ErrorBanner>
        ))}
      <NoticeBanner notice={notice} />

      {totals && (
        <>
          {/* Headline numbers — one dense row, no cards. */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap gap-x-8 gap-y-3 items-start">
            <Metric
              emphasis
              value={`${totals.automatedPct}%`}
              label="of routes on a first-party automated source"
              sub={`${totals.automatedRoutes} of ${totals.totalRoutes}`}
            />
            <Metric value={totals.totalRoutes} label="Total routes" />
            <Metric value={totals.automatedRoutes} label="Official automated" />
            <Metric
              value={totals.backontrackRoutes + totals.otherManualRoutes}
              label="Back-on-Track / manual"
              sub={`${totals.operatorsOnBackontrack} operators`}
            />
            <Metric
              value={totals.staleRoutes}
              label="Stale"
              sub={`feed >50h or unchanged ≥180d · oldest ${totals.oldestContentDays}d`}
            />
            <Metric
              value={totals.highPriority}
              label="High-priority integrations"
            />
          </div>

          {/* What should I integrate next? */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-600">
              What should I integrate next?
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-2">
              {nextUp.map((operator) => (
                <NextCard key={operator.id} operator={operator} />
              ))}
            </div>
            {blocked.length > 0 && (
              <p className="text-[11px] text-gray-500">
                Not actionable yet —{" "}
                {blocked
                  .map(
                    (o) =>
                      `${o.name} (${o.manualRouteCount} route${o.manualRouteCount === 1 ? "" : "s"})`,
                  )
                  .join(", ")}
                : no official machine-readable source found. Research first.
              </p>
            )}
          </div>

          {/* Operator table */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={`px-2 py-1.5 font-medium whitespace-nowrap ${c.sort ? "cursor-pointer hover:text-gray-800" : ""}`}
                      onClick={c.sort ? () => setSortKey(c.key) : undefined}
                    >
                      {c.label}
                      {sortKey === c.key && " ↓"}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {operators.map((operator) => {
                  const open = openId === operator.id;
                  return (
                    <Fragment key={operator.id}>
                      <tr
                        className={`border-b border-gray-100 align-top cursor-pointer hover:bg-gray-50 ${open ? "bg-gray-50" : ""}`}
                        onClick={() => setOpenId(open ? null : operator.id)}
                      >
                        <td className="px-2 py-1.5">
                          <div className="font-medium text-gray-900 whitespace-nowrap">
                            <span
                              className={`inline-block transition-transform duration-150 mr-1 ${open ? "rotate-90" : ""}`}
                            >
                              ▶
                            </span>
                            {operator.name}
                          </div>
                          <div className="text-[11px] text-gray-400 font-mono">
                            {operator.id}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-gray-700 whitespace-nowrap">
                          {operator.routeCount}
                          {operator.manualRouteCount > 0 && (
                            <span className="text-orange-600">
                              {" "}
                              ({operator.manualRouteCount} BoT)
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 max-w-[16rem]">
                          <CurrentSources
                            sources={operator.currentSources}
                            compact
                          />
                        </td>
                        <td className="px-2 py-1.5 max-w-[16rem]">
                          <OfficialSourceCell operator={operator} />
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-gray-600">
                          {formatUtc(operator.lastSuccessAt)}
                        </td>
                        <td className="px-2 py-1.5">
                          <FreshnessCell
                            status={operator.feedFreshness}
                            lastSuccessAt={operator.lastSuccessAt}
                            daysSinceChange={operator.medianDaysSinceChange}
                          />
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <div className="font-mono text-gray-700">
                            {operator.automatedRouteCount} /{" "}
                            {operator.routeCount} routes
                          </div>
                          <div className="font-mono text-[11px] text-gray-400">
                            {operator.automatedStationCount} /{" "}
                            {operator.stationCount} stations
                          </div>
                          <div className="text-[11px] text-gray-500">
                            {operator.routeCoveragePct}% coverage
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <PriorityBadge priority={operator.priority} />
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={COLUMNS.length} className="p-0">
                            <OperatorDetail
                              operator={operator}
                              routes={data.routes}
                              mutate={mutate}
                              busy={busy}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-gray-400 pb-4">
            Priority = (Back-on-Track routes + 0.1 × stations) × readiness
            (found &amp; tested 1.0 / found 0.6 / none 0.15) × ease (easy 1.5 /
            medium 1.0 / hard 0.5) × staleness. Sources and difficulty are
            curated in <code>data/sources/official-sources.json</code>;
            everything else is measured from the published payload and{" "}
            <code>data/sources/registry.json</code>.
          </p>
        </>
      )}
    </div>
  );
}
