import { VerityApiError } from "./errors";
import type { VerityApi } from "./types";

/** Used by production builds without a service URL: shows an honest empty state, never demo data. */
export function createUnconfiguredApi(reason: string): VerityApi {
  const fail = () => Promise.reject(new VerityApiError("unconfigured", reason));
  return {
    mode: "unconfigured",
    writePolicy: { enabled: false, reason: "service_unconfigured" },
    sourceLabel: "Not connected to a Verity service",
    supportsUpdates: false,
    auth: null,
    getMySignals: async () => [],
    setFollowing: async () => ({
      ok: false,
      error: { code: "unavailable", message: "This build isn't connected to a Verity service." },
    }),
    listFollowing: fail,
    listEvents: fail,
    getEvent: fail,
    getEvidence: fail,
    reportEvent: async () => ({
      ok: false,
      error: { code: "unavailable", message: "This build isn't connected to a Verity service." },
    }),
    respond: async () => ({
      ok: false,
      error: { code: "unavailable", message: "This build isn't connected to a Verity service." },
    }),
  };
}
