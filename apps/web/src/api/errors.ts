export type ReadErrorCode =
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "timeout"
  | "invalid_response"
  | "validation_failed"
  | "unconfigured"
  | "internal";

/** Errors surfaced to UI code. Messages are safe to show; provider details never reach them. */
export class VerityApiError extends Error {
  readonly code: ReadErrorCode;
  readonly status: number | null;

  constructor(code: ReadErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "VerityApiError";
    this.code = code;
    this.status = status;
  }
}

export function userMessageFor(error: unknown): string {
  if (error instanceof VerityApiError) {
    switch (error.code) {
      case "not_found":
        return "This event couldn't be found. It may have been removed.";
      case "rate_limited":
        return "Too many requests. Please wait a moment and try again.";
      case "network":
      case "timeout":
        return "Couldn't reach Verity. Check your connection and try again.";
      case "unavailable":
        return "Verity is temporarily unavailable. Please try again shortly.";
      case "unconfigured":
        return "This build isn't connected to a Verity service.";
      default:
        return "Something went wrong loading this. Please try again.";
    }
  }
  return "Something went wrong loading this. Please try again.";
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Event ids are opaque, but must be safe to place in a URL path segment. */
export function assertSafeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new VerityApiError("not_found", "Invalid event id");
  return id;
}
