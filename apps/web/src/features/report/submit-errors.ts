import type { WriteError } from "../../api/types";

export type ReportField = "category" | "title" | "description" | "location" | "source_url" | "scheduled_start_at" | "scheduled_end_at";
export type FieldErrors = Partial<Record<ReportField | "form", string>>;

const FIELDS = new Set<string>(["category", "title", "description", "location", "source_url", "scheduled_start_at", "scheduled_end_at"]);

/** The service's message for a key its strict schema doesn't know (see parseInput in apps/api). */
const UNEXPECTED_FIELD = "Unexpected field";

export const KEPT = "Everything you entered is still here.";

export const SCHEDULE_NOT_ACCEPTED =
  "The Verity service doesn't accept scheduled times yet, so this report wasn't sent. Your schedule is still filled in: clear Starts and Ends to send the report without it, or try again later.";

/**
 * The two kinds of failed submit: the service (or the client, before sending)
 * definitely said no, or nobody can tell whether the report was stored.
 */
export type SubmitOutcome = "rejected" | "unknown";

export function submitOutcome(error: WriteError): SubmitOutcome {
  return error.outcomeUnknown ? "unknown" : "rejected";
}

export const UNKNOWN_HEADLINE = "We couldn't confirm whether your report was received.";

/** Why the outcome is unknown, in words; only for errors whose outcome is "unknown". */
export function unknownOutcomeReason(error: WriteError): string {
  return error.code === "network" ? "The connection failed before Verity answered." : "Verity didn't send a usable answer.";
}

/**
 * Field and form messages for a report that definitely wasn't accepted. Nothing
 * here changes what the user typed; the form keeps every value, including the
 * schedule, and the user decides whether to resubmit.
 *
 * A service that predates scheduled times rejects them with its strict schema
 * as an unknown top-level key, which its error body reports as
 * `fields: { "_": "Unexpected field" }`. The client sends no other key such a
 * service doesn't know, so that answer to a report carrying a schedule means
 * "schedules aren't supported yet".
 */
export function submitFailureErrors(error: WriteError, sentSchedule: boolean): FieldErrors {
  const out: FieldErrors = {};
  let unmatched = false;
  let scheduleRejected = false;
  for (const [key, message] of Object.entries(error.fields ?? {})) {
    const field = key.split(".")[0] ?? "";
    const unexpected = message === UNEXPECTED_FIELD;
    if (unexpected && sentSchedule && (field === "_" || field === "scheduled_start_at" || field === "scheduled_end_at")) {
      scheduleRejected = true;
    } else if (FIELDS.has(field) && !unexpected) {
      out[field as ReportField] ??= message;
    } else {
      unmatched = true;
    }
  }

  if (error.code === "validation_failed" && scheduleRejected) {
    out.scheduled_start_at ??= "Not accepted by the service yet";
    out.form = SCHEDULE_NOT_ACCEPTED;
    return out;
  }
  // Errors on fields the form shows speak for themselves.
  if (Object.keys(out).length > 0 && !unmatched) return out;
  out.form =
    error.code === "validation_failed"
      ? `The service didn't accept this report (${error.message.replace(/\.$/, "")}). ${KEPT}`
      : `${error.message.replace(/\.?$/, ".")} Your report wasn't accepted. ${KEPT}`;
  return out;
}
