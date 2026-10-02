import { resolve } from "node:path";

/**
 * Three different sites, like production:
 *   host page (stands in for maypop.ai)  → http://localhost:4190
 *   Verity frontend in a sandboxed iframe → http://127.0.0.1:4180
 *   Verity service (API)                  → http://127.0.0.2:8788 (another loopback address;
 *     CSP source expressions cannot contain IPv6 literals such as [::1])
 * so every API call is cross-site from a third-party iframe.
 */
export const HOST_URL = "http://localhost:4190";
export const APP_ORIGIN = "http://127.0.0.1:4180";
export const API_ORIGIN = "http://127.0.0.2:8788";
export const INTERNAL_TOKEN = "e2e-internal-token-0123456789abcdefghijklmnop";

const TMP = resolve(import.meta.dirname, "../../test-results/service-tmp");
export const DB_DIR = resolve(TMP, "pglite");
export const OUTBOX_DIR = resolve(TMP, "outbox");
export const TMP_DIR = TMP;
