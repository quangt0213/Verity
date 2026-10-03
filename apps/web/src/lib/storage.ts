/**
 * Per-device preferences only (theme, onboarding, followed event ids).
 * Never location history. Storage can be unavailable (private mode, sandbox
 * policies), so every access degrades to defaults instead of throwing.
 */
export function readStored<T>(key: string, parse: (raw: unknown) => T | null, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Preference simply isn't persisted.
  }
}

export const STORAGE_KEYS = {
  theme: "verity.theme",
  onboarded: "verity.onboarded",
  follows: "verity.follows",
  notificationPrefs: "verity.notificationPrefs",
} as const;
