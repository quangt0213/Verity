import type { Coordinates } from "@verity/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { approximateCoordinates } from "./geo";

/** Current time, refreshed on an interval so "checked 4 min ago" stays accurate. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = globalThis.matchMedia?.(query);
      if (!mql) return () => undefined;
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

export type LocateResult = { ok: true; coordinates: Coordinates } | { ok: false; message: string };

/**
 * One-shot, low-accuracy location for centering the map. Only called after a
 * user action, rounded to ~110 m, kept in memory, never stored or sent.
 */
export function locateOnce(): Promise<LocateResult> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ ok: false, message: "Location isn't available in this browser. You can still browse the map." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          coordinates: approximateCoordinates({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }, 3),
        }),
      (err) =>
        resolve({
          ok: false,
          message:
            err.code === err.PERMISSION_DENIED
              ? "Location permission wasn't granted. You can still browse the map."
              : "Couldn't get your location. You can still browse the map.",
        }),
      { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 10_000 },
    );
  });
}
