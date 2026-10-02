import type {
  ApiErrorCode,
  AuthSession,
  CommunityResponseInput,
  EventDetail,
  EventSummary,
  Evidence,
  ListEventsQuery,
  ListEventsResponse,
  ReportEventInput,
  ReportEventResult,
  SignalType,
  VerityUser,
} from "@verity/contracts";

/**
 * Whether this client may record writes.
 *  - "auth_unavailable": demo mode with writes switched off; nothing is sent.
 *  - "service_unconfigured": no Verity service in this build.
 *  - enabled + simulated: demo adapter, in memory only, clearly labeled.
 *  - enabled + requiresSignIn: the real service; writes need a Verity session.
 */
export type WritePolicy =
  | { enabled: false; reason: "auth_unavailable" | "service_unconfigured" }
  | { enabled: true; simulated: boolean; requiresSignIn: boolean };

export type WriteErrorCode = ApiErrorCode | "auth_unavailable" | "network";

export interface WriteError {
  code: WriteErrorCode;
  message: string;
  fields?: Record<string, string>;
}

export type WriteResult<T> = { ok: true; data: T; simulated: boolean } | { ok: false; error: WriteError };

export interface CommunityResponseAck {
  accepted: true;
  /** False when the same answer was already recorded. */
  changed?: boolean;
}

export type ApiMode = "mock" | "api" | "unconfigured";

/**
 * Verity's own passwordless sign-in. Maypop's display identity is never sent
 * here; the service can't verify it and doesn't trust it.
 */
export interface VerityAuthApi {
  /** Current session (persisted on this device), or null. */
  getSession(): AuthSession | null;
  subscribe(listener: () => void): () => void;
  startEmailSignIn(email: string): Promise<WriteResult<{ sent: true }>>;
  verifyEmailSignIn(email: string, code: string): Promise<WriteResult<AuthSession>>;
  signOut(): Promise<void>;
  me(): Promise<VerityUser | null>;
}

/**
 * The only way UI code talks to Verity. Implementations: the HTTP client for
 * the external service, the demo adapter, and an "unconfigured" stub.
 */
export interface VerityApi {
  readonly mode: ApiMode;
  readonly writePolicy: WritePolicy;
  /** Human-readable description of the data source, for Settings. */
  readonly sourceLabel: string;
  /** Free-text community updates (demo only for now). */
  readonly supportsUpdates: boolean;
  /** Verity accounts; null when the data source has none (demo, unconfigured). */
  readonly auth: VerityAuthApi | null;
  listEvents(query: ListEventsQuery, signal?: AbortSignal): Promise<ListEventsResponse>;
  getEvent(id: string, signal?: AbortSignal): Promise<EventDetail>;
  getEvidence(id: string, signal?: AbortSignal): Promise<Evidence[]>;
  reportEvent(input: ReportEventInput): Promise<WriteResult<ReportEventResult>>;
  respond(eventId: string, input: CommunityResponseInput): Promise<WriteResult<CommunityResponseAck>>;
  /** The viewer's own active answers for an event (empty when signed out). */
  getMySignals(eventId: string, signal?: AbortSignal): Promise<SignalType[]>;
  setFollowing(eventId: string, following: boolean): Promise<WriteResult<{ following: boolean }>>;
  /** Followed events; rejects with auth_required when the service needs sign-in. */
  listFollowing(signal?: AbortSignal): Promise<EventSummary[]>;
}

export const AUTH_UNAVAILABLE_MESSAGE =
  "Not recorded. Verity can't verify accounts yet, so reports and responses aren't saved.";

export const SIGN_IN_PROMPT = "Sign in to contribute.";

/** Map the UI's response kinds onto the service's signal types. */
export function signalTypeFor(input: CommunityResponseInput): SignalType | null {
  switch (input.kind) {
    case "confirm":
      return "CONFIRM";
    case "dispute":
      return "DISPUTE";
    case "resolved":
      return "NO_LONGER_HAPPENING";
    case "still_happening":
      return input.answer === "yes" ? "STILL_HAPPENING" : input.answer === "no" ? "NO_LONGER_HAPPENING" : "NOT_SURE";
    case "update":
      return null;
  }
}
