import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMediaQuery } from "../lib/hooks";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import { useMaypop } from "../maypop/MaypopProvider";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const parsePreference = (raw: unknown): ThemePreference | null =>
  raw === "system" || raw === "light" || raw === "dark" ? raw : null;

function useSystemTheme(): ResolvedTheme {
  return useMediaQuery("(prefers-color-scheme: dark)") ? "dark" : "light";
}

/**
 * "system" follows the Maypop host's theme when running inside Maypop, and the
 * OS preference otherwise. An explicit Light/Dark choice is persisted on this
 * device. The SDK's own theme mirroring is disabled in index.html
 * (data-maypop-theme="manual") so the two never fight.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { hostTheme } = useMaypop();
  const systemTheme = useSystemTheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStored(STORAGE_KEYS.theme, parsePreference, "system"),
  );

  const resolved: ResolvedTheme = preference === "system" ? (hostTheme ?? systemTheme) : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStored(STORAGE_KEYS.theme, next);
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
