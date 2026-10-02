import { useCallback, useSyncExternalStore } from "react";
import { readStored, STORAGE_KEYS, writeStored } from "../../lib/storage";

/**
 * Followed event ids, stored on this device only. Server-side follows and
 * notifications arrive with the Verity service; until then nothing about what
 * a person follows leaves their browser.
 */
const MAX_FOLLOWS = 200;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const parseFollows = (raw: unknown): string[] | null =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && SAFE_ID.test(v)).slice(0, MAX_FOLLOWS) : null;

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function current(): string[] {
  cache ??= readStored(STORAGE_KEYS.follows, parseFollows, []);
  return cache;
}

function set(next: string[]) {
  cache = next.slice(0, MAX_FOLLOWS);
  writeStored(STORAGE_KEYS.follows, cache);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEYS.follows) {
      cache = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const EMPTY: string[] = [];

export function useFollows() {
  const follows = useSyncExternalStore(subscribe, current, () => EMPTY);
  const isFollowing = useCallback((id: string) => follows.includes(id), [follows]);
  const toggle = useCallback((id: string) => {
    if (!SAFE_ID.test(id)) return;
    const list = current();
    set(list.includes(id) ? list.filter((f) => f !== id) : [id, ...list]);
  }, []);
  return { follows, isFollowing, toggle };
}

/** Test helper. */
export function resetFollowsCache() {
  cache = null;
}
