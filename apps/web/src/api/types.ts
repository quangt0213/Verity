import type {
  ApiErrorCode,
  CommunityResponseInput,
  EventDetail,
  Evidence,
  ListEventsQuery,
  ListEventsResponse,
  ReportEventInput,
  ReportEventResult,
} from "@verity/contracts";

/**
 * Whether this client may record writes.
 *  - "auth_unavailable": the Verity service has no verifiable identity for this
 *    viewer yet, so nothing is sent. Controls render but explain why.
 *  - simulated: demo adapter accepts writes in memory only, clearly labeled.
 */
export type WritePolicy =
  | { enabled: false; reason: "auth_unavailable" | "service_unconfigured" }
  | { enabled: true; simulated: boolean };

export type WriteErrorCode = ApiErrorCode | "auth_unavailable" | "network";

export interface WriteError {
  code: WriteErrorCode;
  message: string;
  fields?: Record<string, string>;
}

export type WriteResult<T> = { ok: true; data: T; simulated: boolean } | { ok: false; error: WriteError };

export interface CommunityResponseAck {
  accepted: true;
}

export type ApiMode = "mock" | "api" | "unconfigured";

/**
 * The only way UI code talks to Verity. Implementations: the HTTP client for
 * the external service, the demo adapter, and an "unconfigured" stub.
 */
export interface VerityApi {
  readonly mode: ApiMode;
  readonly writePolicy: WritePolicy;
  /** Human-readable description of the data source, for Settings. */
  readonly sourceLabel: string;
  listEvents(query: ListEventsQuery, signal?: AbortSignal): Promise<ListEventsResponse>;
  getEvent(id: string, signal?: AbortSignal): Promise<EventDetail>;
  getEvidence(id: string, signal?: AbortSignal): Promise<Evidence[]>;
  reportEvent(input: ReportEventInput): Promise<WriteResult<ReportEventResult>>;
  respond(eventId: string, input: CommunityResponseInput): Promise<WriteResult<CommunityResponseAck>>;
}

export const AUTH_UNAVAILABLE_MESSAGE =
  "Not recorded. Verity can't verify accounts yet, so reports and responses aren't saved.";
