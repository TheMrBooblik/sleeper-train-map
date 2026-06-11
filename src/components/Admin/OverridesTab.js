import { useState } from "react";
import useAdminOverrides from "../../hooks/useAdminOverrides";

// "Overrides" tab on /data: edits the data/overrides/* store and saves each
// change via /api/admin/override. The page is already gated by the admin
// session (middleware) and the same admin_session cookie rides along with
// these same-origin requests, so there is no separate login here. Each save is
// a real git commit, so removes are confirmed.

const inputCls =
  "border border-gray-300 rounded px-2 py-1 text-sm min-w-0 focus:outline-none focus:ring-1 focus:ring-gray-400";
const primaryBtnCls =
  "text-xs px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
const dangerBtnCls =
  "text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";

function Section({ title, description, children }) {
  return (
    <div className="border-t border-gray-100 pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0">
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {description && <p className="text-xs text-gray-400 mt-0.5">{description}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

// ─── String-array resources (stations-to-skip, always-show-stations) ──────────

function ListResourceEditor({ title, description, resource, items, mutate, busy }) {
  const [name, setName] = useState("");
  const list = Array.isArray(items) ? items : [];
  const addKey = `${resource}:add`;

  return (
    <Section title={title} description={description}>
      {list.length === 0 ? (
        <p className="text-xs text-gray-400">None.</p>
      ) : (
        <ul className="space-y-1 max-h-56 overflow-y-auto">
          {list.map((n) => (
            <li key={n} className="flex items-center justify-between gap-2">
              <span className="text-sm text-gray-700 truncate">{n}</span>
              <button
                type="button"
                className={dangerBtnCls}
                disabled={!!busy}
                onClick={() => {
                  if (window.confirm(`Remove "${n}" from ${title}?`)) {
                    mutate(
                      resource,
                      "remove",
                      { name: n },
                      `chore(override): ${resource} remove ${n}`,
                      `${resource}:remove:${n}`,
                    );
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = name.trim();
          if (!v) return;
          mutate(
            resource,
            "add",
            { name: v },
            `chore(override): ${resource} add ${v}`,
            addKey,
          ).then((ok) => ok && setName(""));
        }}
      >
        <input
          className={`${inputCls} flex-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Station name (exact)"
        />
        <button type="submit" className={primaryBtnCls} disabled={busy === addKey || !name.trim()}>
          Add
        </button>
      </form>
    </Section>
  );
}

// ─── Station coordinates ────────────────────────────────────────────────────

function CoordRow({ name, value, mutate, busy }) {
  const [lat, setLat] = useState(value.lat ?? "");
  const [lon, setLon] = useState(value.lon ?? "");
  const key = `coords:${name}`;
  const valid = lat !== "" && lon !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));

  return (
    <div className="flex items-center gap-2 py-1 border-b border-gray-50 last:border-b-0">
      <span className="text-sm text-gray-700 flex-1 truncate" title={name}>
        {name}
      </span>
      <input
        className={`${inputCls} w-24`}
        value={lat}
        onChange={(e) => setLat(e.target.value)}
        placeholder="lat"
        inputMode="decimal"
      />
      <input
        className={`${inputCls} w-24`}
        value={lon}
        onChange={(e) => setLon(e.target.value)}
        placeholder="lon"
        inputMode="decimal"
      />
      <button
        type="button"
        className={primaryBtnCls}
        disabled={busy === key || !valid}
        onClick={() =>
          mutate(
            "station-coordinates",
            "set",
            { name, lat: Number(lat), lon: Number(lon) },
            `chore(override): coords ${name}`,
            key,
          )
        }
      >
        Save
      </button>
      <button
        type="button"
        className={dangerBtnCls}
        disabled={!!busy}
        onClick={() => {
          if (window.confirm(`Remove coordinate override for "${name}"?`)) {
            mutate(
              "station-coordinates",
              "remove",
              { name },
              `chore(override): coords remove ${name}`,
              `coords:remove:${name}`,
            );
          }
        }}
      >
        Remove
      </button>
    </div>
  );
}

function CoordsEditor({ coords, mutate, busy }) {
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const all = Object.entries(coords || {}).sort(([a], [b]) => a.localeCompare(b));
  const q = query.trim().toLowerCase();
  const filtered = q ? all.filter(([n]) => n.toLowerCase().includes(q)) : all;
  const shown = filtered.slice(0, 50);
  const addValid =
    name.trim() && lat !== "" && lon !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));

  return (
    <Section
      title="Station coordinates"
      description="Manual lat/lon overrides merged on top of the geocoded coordinates."
    >
      <input
        className={`${inputCls} w-full`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Filter ${all.length} overrides…`}
      />
      <div className="mt-2 max-h-72 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="text-xs text-gray-400">No matches.</p>
        ) : (
          shown.map(([n, v]) => (
            <CoordRow key={`${n}:${v?.lat},${v?.lon}`} name={n} value={v || {}} mutate={mutate} busy={busy} />
          ))
        )}
        {filtered.length > shown.length && (
          <p className="text-xs text-gray-400 pt-1">
            +{filtered.length - shown.length} more — refine the filter.
          </p>
        )}
      </div>
      <form
        className="flex flex-wrap items-center gap-2 mt-3 pt-2 border-t border-gray-100"
        onSubmit={(e) => {
          e.preventDefault();
          if (!addValid) return;
          mutate(
            "station-coordinates",
            "set",
            { name: name.trim(), lat: Number(lat), lon: Number(lon) },
            `chore(override): coords ${name.trim()}`,
            "coords:add",
          ).then((ok) => {
            if (ok) {
              setName("");
              setLat("");
              setLon("");
            }
          });
        }}
      >
        <input
          className={`${inputCls} flex-1 min-w-[8rem]`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Station name (exact)"
        />
        <input
          className={`${inputCls} w-24`}
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          placeholder="lat"
          inputMode="decimal"
        />
        <input
          className={`${inputCls} w-24`}
          value={lon}
          onChange={(e) => setLon(e.target.value)}
          placeholder="lon"
          inputMode="decimal"
        />
        <button type="submit" className={primaryBtnCls} disabled={busy === "coords:add" || !addValid}>
          Add
        </button>
      </form>
    </Section>
  );
}

// ─── Station name replacements ────────────────────────────────────────────────

function NameReplacementsEditor({ value, mutate, busy }) {
  const stops = (value && value.stopReplacements) || {};
  const routes = (value && value.routeReplacements) || {};
  const [stopOld, setStopOld] = useState("");
  const [stopNew, setStopNew] = useState("");
  const [routeOld, setRouteOld] = useState("");
  const [routeNew, setRouteNew] = useState("");
  const [routeIds, setRouteIds] = useState("");

  const parseIds = (csv) =>
    csv
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));

  return (
    <Section
      title="Station name replacements"
      description="Rename stop labels everywhere (stop) or only on specific route ids (route)."
    >
      <p className="text-xs font-medium text-gray-500 mb-1">Stop-wide</p>
      {Object.keys(stops).length === 0 ? (
        <p className="text-xs text-gray-400">None.</p>
      ) : (
        <ul className="space-y-1">
          {Object.entries(stops).map(([oldName, newName]) => (
            <li key={oldName} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-gray-700 truncate">
                {oldName} <span className="text-gray-400">→</span> {newName}
              </span>
              <button
                type="button"
                className={dangerBtnCls}
                disabled={!!busy}
                onClick={() => {
                  if (window.confirm(`Remove stop replacement "${oldName}"?`)) {
                    mutate(
                      "station-name-replacements",
                      "removeStop",
                      { oldName },
                      `chore(override): name removeStop ${oldName}`,
                      `name:removeStop:${oldName}`,
                    );
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const o = stopOld.trim();
          const n = stopNew.trim();
          if (!o || !n) return;
          mutate(
            "station-name-replacements",
            "setStop",
            { oldName: o, newName: n },
            `chore(override): name setStop ${o}`,
            "name:setStop",
          ).then((ok) => {
            if (ok) {
              setStopOld("");
              setStopNew("");
            }
          });
        }}
      >
        <input
          className={`${inputCls} flex-1 min-w-[7rem]`}
          value={stopOld}
          onChange={(e) => setStopOld(e.target.value)}
          placeholder="old name"
        />
        <input
          className={`${inputCls} flex-1 min-w-[7rem]`}
          value={stopNew}
          onChange={(e) => setStopNew(e.target.value)}
          placeholder="new name"
        />
        <button type="submit" className={primaryBtnCls} disabled={busy === "name:setStop" || !stopOld.trim() || !stopNew.trim()}>
          Add
        </button>
      </form>

      <p className="text-xs font-medium text-gray-500 mb-1 mt-4">Route-specific</p>
      {Object.keys(routes).length === 0 ? (
        <p className="text-xs text-gray-400">None.</p>
      ) : (
        <ul className="space-y-1">
          {Object.entries(routes).map(([oldName, entry]) => {
            const newName = typeof entry === "string" ? entry : entry?.newName;
            const ids = typeof entry === "object" && Array.isArray(entry?.routeIds) ? entry.routeIds : null;
            return (
              <li key={oldName} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-700 truncate">
                  {oldName} <span className="text-gray-400">→</span> {newName}
                  {ids && <span className="text-gray-400"> [{ids.join(", ")}]</span>}
                </span>
                <button
                  type="button"
                  className={dangerBtnCls}
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm(`Remove route replacement "${oldName}"?`)) {
                      mutate(
                        "station-name-replacements",
                        "removeRoute",
                        { oldName },
                        `chore(override): name removeRoute ${oldName}`,
                        `name:removeRoute:${oldName}`,
                      );
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const o = routeOld.trim();
          const n = routeNew.trim();
          if (!o || !n) return;
          const ids = parseIds(routeIds);
          mutate(
            "station-name-replacements",
            "setRoute",
            { oldName: o, newName: n, routeIds: ids },
            `chore(override): name setRoute ${o}`,
            "name:setRoute",
          ).then((ok) => {
            if (ok) {
              setRouteOld("");
              setRouteNew("");
              setRouteIds("");
            }
          });
        }}
      >
        <input
          className={`${inputCls} flex-1 min-w-[6rem]`}
          value={routeOld}
          onChange={(e) => setRouteOld(e.target.value)}
          placeholder="old name"
        />
        <input
          className={`${inputCls} flex-1 min-w-[6rem]`}
          value={routeNew}
          onChange={(e) => setRouteNew(e.target.value)}
          placeholder="new name"
        />
        <input
          className={`${inputCls} w-28`}
          value={routeIds}
          onChange={(e) => setRouteIds(e.target.value)}
          placeholder="route ids 1,2"
        />
        <button type="submit" className={primaryBtnCls} disabled={busy === "name:setRoute" || !routeOld.trim() || !routeNew.trim()}>
          Add
        </button>
      </form>
    </Section>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export default function OverridesTab() {
  const { overrides, target, loading, busy, error, notice, expired, mutate } =
    useAdminOverrides();

  if (expired) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-sm text-gray-700">
        Your session expired.{" "}
        <a href="/login" className="underline">
          Log in again
        </a>
        .
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-600">Data overrides</h2>
        {target?.repo && (
          <span className="text-xs text-gray-400 font-mono truncate">
            {target.repo}@{target.branch}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-0.5">
        Each save commits directly to the deploy branch; changes go live on the next deploy.
      </p>

      {notice && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700 mt-3 flex items-center justify-between gap-2">
          <span>{notice.text}</span>
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noreferrer" className="underline shrink-0">
              View commit
            </a>
          )}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 mt-3">
          {error}
        </div>
      )}

      {loading && !overrides ? (
        <p className="text-sm text-gray-400 mt-3">Loading…</p>
      ) : (
        <>
          <CoordsEditor coords={overrides?.["station-coordinates"]} mutate={mutate} busy={busy} />
          <ListResourceEditor
            title="Stations to skip"
            description="Hidden from the map and route stop lists."
            resource="stations-to-skip"
            items={overrides?.["stations-to-skip"]}
            mutate={mutate}
            busy={busy}
          />
          <ListResourceEditor
            title="Always-show stations"
            description="Kept visible even when intermediate stations are hidden."
            resource="always-show-stations"
            items={overrides?.["always-show-stations"]}
            mutate={mutate}
            busy={busy}
          />
          <NameReplacementsEditor
            value={overrides?.["station-name-replacements"]}
            mutate={mutate}
            busy={busy}
          />
        </>
      )}
    </div>
  );
}
