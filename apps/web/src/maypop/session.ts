import type { Maypop as MaypopSdk } from "@basilica-digital/maypop-sdk";
import { isSafeHttpUrl } from "@verity/contracts";

/**
 * What Verity uses from Maypop, based on SDK v1.3.0's typed contract
 * (see docs/MAYPOP.md):
 *
 *  - `user`: a PSEUDONYMOUS, app-scoped viewer (id, username, avatar, role
 *    hint). Display only. It is not a verifiable credential: Maypop exposes no
 *    signed assertion the Verity service could validate, so it is never sent
 *    to the service or used to authorize anything.
 *  - `signInRequired` / `signIn()`: the host-owned sign-in card.
 *  - `theme` + "themechange": the host's light/dark theme, used as "system".
 *  - `share({ path })` and `launchPath`: deep links to events.
 */

export type MaypopStatus = "connecting" | "connected" | "standalone";

export interface MaypopViewer {
  /** Pseudonymous and app-scoped. Never an authorization input. */
  id: string;
  username: string;
  avatarUrl: string | null;
  isAnonymous: boolean;
  /** Maypop calls this a hint for labels, never a permission check. */
  roleHint: string;
}

export interface MaypopSnapshot {
  status: MaypopStatus;
  viewer: MaypopViewer | null;
  mode: "read-write" | "read-only" | null;
  signInRequired: boolean;
  hostTheme: "light" | "dark" | null;
  launchPath: string | null;
  scopes: string[];
}

export const STANDALONE: MaypopSnapshot = {
  status: "standalone",
  viewer: null,
  mode: null,
  signInRequired: false,
  hostTheme: null,
  launchPath: null,
  scopes: [],
};

export const CONNECTING: MaypopSnapshot = { ...STANDALONE, status: "connecting" };

/** Maypop apps always run inside the host's sandboxed iframe. */
export function isEmbedded(win: Window = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    // Cross-origin parent: we are framed.
    return true;
  }
}

const LAUNCH_PATH = /^\/(map|report|following|settings|events\/[A-Za-z0-9_-]{1,64})$/;

/** Only allow deep links to screens this app actually has. */
export function safeLaunchPath(path: string | null | undefined): string | null {
  return path && LAUNCH_PATH.test(path) ? path : null;
}

export function snapshotFrom(sdk: MaypopSdk): MaypopSnapshot {
  const user = sdk.user;
  return {
    status: "connected",
    viewer: user
      ? {
          id: user.id,
          username: user.username,
          avatarUrl: isSafeHttpUrl(user.avatarUrl) ? user.avatarUrl : null,
          isAnonymous: user.isAnonymous,
          roleHint: user.role,
        }
      : null,
    mode: sdk.mode,
    signInRequired: sdk.signInRequired,
    hostTheme: sdk.theme === "dark" || sdk.theme === "light" ? sdk.theme : null,
    launchPath: safeLaunchPath(sdk.launchPath),
    scopes: [...sdk.permissions],
  };
}

export interface MaypopConnection {
  sdk: MaypopSdk | null;
  snapshot: MaypopSnapshot;
}

export interface ConnectOptions {
  timeoutMs?: number;
  embedded?: boolean;
  load?: () => Promise<MaypopSdk>;
}

const loadSdk = async (): Promise<MaypopSdk> => (await import("@basilica-digital/maypop-sdk")).maypop;

/**
 * Connect to the Maypop host if there is one. Outside an iframe the SDK is
 * never loaded. Inside one, `ready()` waits for the host handshake; if no host
 * answers in time we continue standalone rather than blocking the app.
 */
export async function connectMaypop(options: ConnectOptions = {}): Promise<MaypopConnection> {
  const embedded = options.embedded ?? isEmbedded();
  if (!embedded) return { sdk: null, snapshot: STANDALONE };

  let sdk: MaypopSdk;
  try {
    sdk = await (options.load ?? loadSdk)();
  } catch {
    return { sdk: null, snapshot: STANDALONE };
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    sdk.ready().then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!ready) return { sdk: null, snapshot: STANDALONE };
  return { sdk, snapshot: snapshotFrom(sdk) };
}

export type ShareResult = { ok: true; via: "maypop" | "native" | "clipboard" } | { ok: false; message: string };

function errorMessage(error: unknown): string | null {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message.slice(0, 200);
  }
  return null;
}

/** Share a deep link: Maypop's share card when hosted, otherwise Web Share or the clipboard. */
export async function shareLink(sdk: MaypopSdk | null, path: string, title: string): Promise<ShareResult> {
  if (sdk) {
    try {
      await sdk.share({ path, title });
      return { ok: true, via: "maypop" };
    } catch (error) {
      // Maypop documents its share errors as user-facing ("This app must be
      // published to a group before you can share.").
      return { ok: false, message: errorMessage(error) ?? "Sharing isn't available right now." };
    }
  }
  const url = `${window.location.origin}${window.location.pathname}#${path}`;
  try {
    if (navigator.share) {
      await navigator.share({ title, url });
      return { ok: true, via: "native" };
    }
    await navigator.clipboard.writeText(url);
    return { ok: true, via: "clipboard" };
  } catch {
    return { ok: false, message: "Couldn't share automatically. Copy the link from your address bar." };
  }
}
