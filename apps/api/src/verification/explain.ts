import type { EventStatus } from "@verity/contracts";
import { STATUS_LABEL } from "../domain/labels";
import type { DecisionFacts, Decision, LineageFacts } from "./rules";
import type { VerificationPolicy } from "./policy";

/**
 * Deterministic explanations ("Why Verity says this"), written from facts by
 * fixed templates: no model text, no percentages or probabilities, no claims of
 * proof. Source names appear as names only; quotes are never generated here
 * (verbatim excerpts live on the evidence records and are shown separately).
 */

const MAX_LENGTH = 1000;
const MAX_NAME = 60;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const name = (l: LineageFacts) => {
  const clean = l.name.replace(/\s+/g, " ").trim();
  return clean.length > MAX_NAME ? `${clean.slice(0, MAX_NAME - 1)}…` : clean;
};
const names = (ls: LineageFacts[]) => {
  const list = ls.slice(0, 3).map(name);
  if (ls.length > 3) list.push(`${ls.length - 3} more`);
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
};

function durationText(minutes: number): string {
  if (minutes < 120) return plural(minutes, "minute", "minutes");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour", "hours");
  return plural(Math.round(minutes / (24 * 60)), "day", "days");
}

/** "3 independent sources (5 total)", counting lineages; community reports count once. */
export function sourceCountText(f: Pick<DecisionFacts, "totalLineages" | "totalRecords">): string {
  if (f.totalRecords === 0) return "No sources yet.";
  const lineages = plural(f.totalLineages, "independent source", "independent sources");
  return f.totalLineages === f.totalRecords ? `${lineages}.` : `${lineages} (${f.totalRecords} total).`;
}

function lead(d: Omit<Decision, "explanation">, current: EventStatus): string {
  const f = d.facts;
  const primary = (ls: LineageFacts[]) => ls.filter((l) => l.primaryOfficial);
  switch (d.ruleId) {
    case "resolved_primary_end":
      return `A primary official source (${names(primary(f.ended))}) reports that this has ended.`;
    case "resolved_independent_end":
      return `${plural(f.ended.length, "independent source reports", "independent sources report")} that this has ended (${names(f.ended)}).`;
    case "conflicting_sources":
      return `Sources disagree: ${plural(f.support.length, "independent source supports", "independent sources support")} this and ${plural(f.contradiction.length, "contradicts", "contradict")} it.`;
    case "rejected_primary_contradiction":
      return `A primary official source (${names(primary(f.contradiction))}) contradicts this report, and no source supports it.`;
    case "conflicting_primary_contradiction":
      return `A primary official source (${names(primary(f.contradiction))}) now contradicts this, and no current source supports it.`;
    case "verified_primary_source":
      return `Confirmed by a primary official source (${names(primary(f.support))}).`;
    case "verified_independent_sources":
      return `Supported by ${plural(f.support.length, "independent source", "independent sources")} reporting this location (${names(f.support)}).`;
    case "likely_multiple_lineages":
      return f.communitySupport
        ? `Supported by community reports and ${plural(f.support.length, "independent source", "independent sources")} (${names(f.support)}).`
        : `Supported by ${plural(f.support.length, "independent source", "independent sources")} (${names(f.support)}).`;
    case "developing_single_source":
      return `One independent source supports this so far (${names(f.support)}).`;
    case "resolved_schedule_ended":
      return "The scheduled end time has passed.";
    case "stale_support_aged_out":
      return "The most recent supporting evidence is older than Verity's freshness window for this kind of event.";
    case "no_qualifying_evidence":
      if (f.contradiction.length > 0) return `${plural(f.contradiction.length, "source contradicts", "sources contradict")} this, but not a primary official source.`;
      if (f.locationUnclear > 0) return "Sources mention a similar event, but it is not clear they describe this location.";
      return f.communitySupport ? "Community reports only so far; not yet confirmed by other sources." : `No current source confirms this yet. Status stays ${STATUS_LABEL[current]}.`;
  }
}

export function explainDecision(d: Omit<Decision, "explanation">, current: EventStatus, policy: VerificationPolicy): string {
  const f = d.facts;
  const parts = [lead(d, current), sourceCountText(f)];

  if (d.facts.communitySupport && d.ruleId !== "likely_multiple_lineages") parts.push("Community reports count as one source.");
  const settled = d.ruleTarget === "RESOLVED" || d.ruleTarget === "REJECTED";
  if (!settled && f.support.length > 0 && !f.support.some((l) => l.primaryOfficial)) parts.push("No primary official source found yet.");
  if (d.ruleId === "stale_support_aged_out") {
    parts.push(`For this kind of event, evidence older than ${durationText(policy.categories[f.category].staleMinutes)} no longer counts as current.`);
  }
  if (d.ruleId === "likely_multiple_lineages" && current !== "VERIFIED" && f.support.length >= policy.rules.verifiedMinIndependent && !f.support.some((l) => l.identifiedSupport)) {
    parts.push("Verified status also needs at least one identified source, such as an official agency or the organization involved.");
  }
  if (f.dateOnly > 0) {
    parts.push(`${plural(f.dateOnly, "more source gives", "more sources give")} only a date, not a time, which is too imprecise to count for this kind of event yet.`);
  }
  if (d.guard === "no_downgrade") parts.push(`Status stays ${STATUS_LABEL[current]} until the evidence changes or ages out.`);
  if (d.guard === "reopened") parts.push("New supporting evidence reopened this event for verification.");
  if (f.community.disputes > 0) parts.push(`${plural(f.community.disputes, "person disputes", "people dispute")} this; disputes prompt a re-check but don't change the status on their own.`);
  if (f.retrieval === "unavailable") parts.push("Live sources couldn't be checked this time; nothing new was inferred.");
  else if (f.retrieval === "no_results") parts.push("The latest search found no new sources.");

  const text = parts.filter(Boolean).join(" ");
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}
