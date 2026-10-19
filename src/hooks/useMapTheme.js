import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
} from "../lib/mapTheme.mjs";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The map page's theme: the visitor's choice (persisted), the OS preference
 * (live, so "system" follows a sunset switch without a reload), and the
 * resolved theme written to `<html data-theme>` — which is what the `dark:`
 * variant in globals.css keys on.
 *
 * The attribute is the map page's alone and is removed on unmount: the SEO
 * pages, /plan and /about are dark by design and must not inherit it.
 * Both states start as the server rendered them (light, "system") and are
 * read after mount, so hydration never sees a different tree; the map is
 * client-only, so the basemap itself never paints in the wrong theme.
 */
export function useMapTheme() {
  const [preference, setPreferenceState] = useState(DEFAULT_THEME_PREFERENCE);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    try {
      setPreferenceState(
        parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY)),
      );
    } catch {
      // Storage blocked (private mode etc.): keep following the system.
    }
    if (typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(DARK_QUERY);
    setSystemDark(mql.matches);
    const onChange = (e) => setSystemDark(e.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  const theme = resolveTheme(preference, systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    return () => {
      delete root.dataset.theme;
      root.style.colorScheme = "";
    };
  }, [theme]);

  const setPreference = useCallback((value) => {
    const next = parseThemePreference(value);
    setPreferenceState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors; the choice still applies for this visit.
    }
  }, []);

  return { preference, setPreference, theme, isDark: theme === "dark" };
}
