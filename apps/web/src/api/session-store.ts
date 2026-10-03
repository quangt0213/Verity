import { authSessionSchema, type AuthSession } from "@verity/contracts";

/**
 * Verity session on this device. The app runs in a third-party (Maypop)
 * iframe, where cookies to the Verity service's site are unreliable, so the
 * session is an opaque bearer token kept in localStorage and sent in the
 * Authorization header. It is never readable by other sites; the CSP and
 * plain-text rendering limit script injection, and the token is revocable.
 */
const KEY = "verity.session.v1";

export interface SessionStore {
  get(): AuthSession | null;
  set(session: AuthSession | null): void;
  subscribe(listener: () => void): () => void;
}

export function createSessionStore(storage: Storage | undefined = globalThis.localStorage): SessionStore {
  const listeners = new Set<() => void>();
  let cache: AuthSession | null | undefined;

  const read = (): AuthSession | null => {
    try {
      const raw = storage?.getItem(KEY);
      if (!raw) return null;
      const parsed = authSessionSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || Date.parse(parsed.data.expires_at) <= Date.now()) return null;
      return parsed.data;
    } catch {
      return null;
    }
  };

  return {
    get() {
      if (cache === undefined) cache = read();
      if (cache && Date.parse(cache.expires_at) <= Date.now()) cache = null;
      return cache;
    },
    set(session) {
      cache = session;
      try {
        if (session) storage?.setItem(KEY, JSON.stringify(session));
        else storage?.removeItem(KEY);
      } catch {
        // Session simply won't persist across visits.
      }
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
