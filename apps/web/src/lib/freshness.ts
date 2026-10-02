import type { CommunitySummary, EventSummary } from "@verity/contracts";
import { STATUS_DISPLAY } from "./display";
import { relativeTime, windowText } from "./time";

type SourceCounts = Pick<EventSummary, "source_count" | "independent_source_count">;

/** "No sources yet", "1 source", "3 independent sources", "2 independent sources (5 total)". */
export function sourcesText({ source_count, independent_source_count }: SourceCounts): string {
  if (source_count === 0) return "No sources yet";
  if (source_count === 1) return "1 source";
  if (independent_source_count === source_count) return `${source_count} independent sources`;
  const independent =
    independent_source_count === 1 ? "1 independent source" : `${independent_source_count} independent sources`;
  return `${independent} (${source_count} total)`;
}

/**
 * When Verity last checked, which is distinct from when the event was posted.
 * Verification state takes priority so "in progress" and "unavailable" are
 * never hidden behind an old timestamp.
 */
export function checkedText(
  event: Pick<EventSummary, "verification_state" | "last_checked_at">,
  now: number,
): string {
  switch (event.verification_state) {
    case "in_progress":
      return "verifying now";
    case "queued":
      return event.last_checked_at
        ? `re-check queued · last checked ${relativeTime(event.last_checked_at, now)}`
        : "verification queued";
    case "unavailable":
      return event.last_checked_at
        ? `verification unavailable · tried ${relativeTime(event.last_checked_at, now)}`
        : "verification unavailable";
    case "idle":
      return event.last_checked_at ? `checked ${relativeTime(event.last_checked_at, now)}` : "not yet checked";
  }
}

/** The pieces of "Verified · 3 independent sources · checked 4 min ago". */
export function freshnessParts(event: EventSummary, now: number): [status: string, sources: string, checked: string] {
  return [STATUS_DISPLAY[event.status].label, sourcesText(event), checkedText(event, now)];
}

export function freshnessLine(event: EventSummary, now: number): string {
  return freshnessParts(event, now).join(" · ");
}

/** Extra label for community-originated events that haven't been verified. */
export function communityReportNote(event: Pick<EventSummary, "origin" | "status" | "verification_state">): string | null {
  if (event.origin !== "community_report" || event.status !== "UNVERIFIED") return null;
  if (event.verification_state === "queued" || event.verification_state === "in_progress") {
    return "Community report — verification in progress";
  }
  if (event.verification_state === "unavailable") return "Community report — verification temporarily unavailable";
  return "Community report — needs confirmation";
}

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** Aggregate-only, privacy-preserving phrasing: counts, never who or where. */
export function stillHappeningText(c: CommunitySummary): string | null {
  const { yes, no, not_sure } = c.still_happening;
  const when = windowText(c.window_minutes);
  if (yes === 0 && no === 0 && not_sure === 0) return null;
  if (yes > 0 && no === 0) return `${people(yes)} confirmed this is still happening ${when}.`;
  if (no > 0 && yes === 0) return `${people(no)} said this is no longer happening ${when}.`;
  if (yes > 0 && no > 0) {
    return `Mixed answers ${when}: ${people(yes)} said yes, ${people(no)} said no.`;
  }
  return `${people(not_sure)} ${not_sure === 1 ? "wasn't" : "weren't"} sure ${when}.`;
}

/**
 * One-line community summary: "still happening" answers when there are any,
 * otherwise recent confirmations or disputes. Counts only, never identities.
 */
export function communitySummaryText(c: CommunitySummary): string | null {
  const happening = stillHappeningText(c);
  if (happening) return happening;
  const when = windowText(c.window_minutes);
  if (c.recent_confirmations > 0 && c.recent_disputes === 0) return `${people(c.recent_confirmations)} confirmed this ${when}.`;
  if (c.recent_disputes > 0 && c.recent_confirmations === 0) return `${people(c.recent_disputes)} disputed this ${when}.`;
  if (c.recent_confirmations > 0 && c.recent_disputes > 0) {
    return `Mixed answers ${when}: ${people(c.recent_confirmations)} confirmed, ${people(c.recent_disputes)} disputed.`;
  }
  return null;
}
