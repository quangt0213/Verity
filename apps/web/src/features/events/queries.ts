import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { EventDetail, EventSummary, ListEventsQuery } from "@verity/contracts";
import { useApi } from "../../api/ApiProvider";
import { VerityApiError } from "../../api/errors";

export const eventKeys = {
  all: ["events"] as const,
  list: (query: ListEventsQuery | null) => ["events", "list", query] as const,
  detail: (id: string) => ["events", "detail", id] as const,
};

const NON_RETRYABLE = new Set(["unconfigured", "validation_failed", "not_found", "invalid_response"]);

function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof VerityApiError && NON_RETRYABLE.has(error.code)) return false;
  return failureCount < 2;
}

/**
 * Poll quickly only while verification is actively running; queued work may
 * wait for a worker, so it gets a moderate interval instead of hammering.
 */
const FAST_POLL_MS = 5_000;
const QUEUED_POLL_MS = 30_000;
const SLOW_POLL_MS = 60_000;

function pollInterval(items: Array<Pick<EventSummary, "verification_state">>): number {
  if (items.some((e) => e.verification_state === "in_progress")) return FAST_POLL_MS;
  if (items.some((e) => e.verification_state === "queued")) return QUEUED_POLL_MS;
  return SLOW_POLL_MS;
}

export function useEventList(query: ListEventsQuery | null) {
  const api = useApi();
  return useQuery({
    queryKey: eventKeys.list(query),
    queryFn: ({ signal }) => api.listEvents(query ?? {}, signal),
    enabled: query !== null,
    placeholderData: keepPreviousData,
    retry,
    refetchInterval: (q) => pollInterval(q.state.data?.events ?? []),
  });
}

export function useEventDetail(id: string | null) {
  const api = useApi();
  return useQuery<EventDetail>({
    queryKey: eventKeys.detail(id ?? ""),
    queryFn: ({ signal }) => api.getEvent(id ?? "", signal),
    enabled: id !== null,
    retry,
    refetchInterval: (q) => pollInterval(q.state.data ? [q.state.data] : []),
  });
}
