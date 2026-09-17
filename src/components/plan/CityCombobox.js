import { useEffect, useId, useMemo, useRef, useState } from "react";

import { getFlagEmoji } from "../../lib/countries";
import { MAX_RESULTS, rankCities } from "../../lib/plan/citySearch.mjs";

/**
 * City picker for the planner.
 *
 * Deliberately not a <datalist>: that renders 1 939 options with no ranking, no
 * keyboard semantics browsers agree on, and no way to show a country or how
 * many trains a city has — and on a phone it is a native sheet the page cannot
 * style. This is an ARIA combobox over the same list, ranked so typing "vien"
 * offers Vienna before Vienne, and matching station names too so "Meidling"
 * finds Vienna.
 */
export default function CityCombobox({
  label,
  value,
  cities,
  onSelect,
  placeholder = "City or station",
  disabled = false,
  autoFocus = false,
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // The input shows the committed city until the user starts typing over it.
  const display = open ? query : value?.name || "";
  const results = useMemo(
    () => (open ? rankCities(cities ?? [], query) : []),
    [open, cities, query],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  function commit(city) {
    if (!city) return;
    onSelect(city);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (results.length ? (i + delta + results.length) % results.length : 0));
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      commit(results[active]);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" ref={wrapRef}>
      <label htmlFor={id} className="text-sm font-medium text-white/70">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={disabled ? "Loading cities…" : placeholder}
          value={display}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="w-full min-w-0 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-base text-white placeholder:text-white/35 focus:border-primary-green/60 focus:outline-none focus:ring-1 focus:ring-primary-green/40 disabled:opacity-50"
        />
        {value && !open && (
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
            aria-label={`Clear ${label}`}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            ×
          </button>
        )}

        {open && (
          <ul
            id={`${id}-listbox`}
            role="listbox"
            className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-white/15 bg-zinc-900 py-1 shadow-2xl"
          >
            {results.length === 0 && (
              <li className="px-4 py-3 text-sm text-white/45">
                No night train calls at a city matching “{query}”.
              </li>
            )}
            {results.map((city, i) => (
              <li key={city.slug} role="none">
                <button
                  type="button"
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(city)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === active ? "bg-white/10 text-white" : "text-white/80"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true">{getFlagEmoji(city.country) || "🚂"}</span>
                    <span className="truncate">{city.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-white/35">
                    {city.legCount} {city.legCount === 1 ? "train" : "trains"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
