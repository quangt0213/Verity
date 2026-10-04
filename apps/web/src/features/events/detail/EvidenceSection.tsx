import { isSafeHttpUrl, type Claim, type EventDetail, type Evidence, type EvidenceStance, type SourceClass } from "@verity/contracts";
import { Check, ChevronDown, CircleCheckBig, ExternalLink, Info, X, type IconNode } from "lucide";
import { useState, type ReactNode } from "react";
import { Icon } from "../../../components/ui/Icon";
import { cn } from "../../../lib/cn";
import { calendarDate, relativeTime } from "../../../lib/time";

/**
 * "Why Verity says this" and "Sources". Everything here is written for an
 * ordinary reader: no rule ids, lineage ids, retrieval methods or scores.
 * Copies of one underlying report are grouped under ONE source, so many web
 * pages never look like many independent confirmations.
 */

const STANCE: Record<EvidenceStance, { label: string; heading: string; icon: IconNode; className: string }> = {
  supports: { label: "Supports", heading: "Supporting", icon: Check, className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300" },
  contradicts: { label: "Contradicts", heading: "Contradicting", icon: X, className: "bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300" },
  ended: { label: "Says it ended", heading: "Says it has ended", icon: CircleCheckBig, className: "bg-zinc-100 text-zinc-700 dark:bg-zinc-400/10 dark:text-zinc-300" },
  context: { label: "Context", heading: "Background", icon: Info, className: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300" },
};

/** Plain-language source kinds. "Unknown" becomes "Website": unidentified, not suspicious. */
export const SOURCE_KIND: Record<SourceClass, string> = {
  OFFICIAL: "Official source",
  FIRST_PARTY: "First-party source",
  REPUTABLE_NEWS: "News outlet",
  LOCAL_NEWS: "Local news",
  SOCIAL: "Social media",
  COMMUNITY: "Community report",
  UNKNOWN: "Website",
};
const CLASS_ORDER: SourceClass[] = ["OFFICIAL", "FIRST_PARTY", "REPUTABLE_NEWS", "LOCAL_NEWS", "SOCIAL", "UNKNOWN", "COMMUNITY"];
const GROUP_ORDER: EvidenceStance[] = ["supports", "contradicts", "ended", "context"];

const CLAIM_STANCE: Record<Claim["stance"], { label: string; className: string }> = {
  supported: { label: "Supported", className: "text-emerald-700 dark:text-emerald-300" },
  contradicted: { label: "Disputed by sources", className: "text-violet-700 dark:text-violet-300" },
  ended: { label: "Ended", className: "text-zinc-600 dark:text-zinc-300" },
  unconfirmed: { label: "Unconfirmed", className: "text-slate-600 dark:text-slate-300" },
};

const nameOf = (e: Evidence) => e.publisher ?? e.source_name;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One independent source: the representative record and the pages that repeat the same underlying report. */
export interface SourceGroup {
  lead: Evidence;
  copies: Evidence[];
}

export function groupSources(evidence: Evidence[]): SourceGroup[] {
  const byLineage = new Map<string, Evidence[]>();
  for (const e of evidence) byLineage.set(e.lineage_id, [...(byLineage.get(e.lineage_id) ?? []), e]);
  const groups = [...byLineage.values()].map((records) => {
    const lead = records.find((r) => r.counts_as_independent) ?? records[0]!;
    return { lead, copies: records.filter((r) => r !== lead) };
  });
  const time = (e: Evidence) => (e.published_at ? Date.parse(e.published_at) : 0);
  return groups.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.lead.stance) - GROUP_ORDER.indexOf(b.lead.stance) ||
      CLASS_ORDER.indexOf(a.lead.source_class) - CLASS_ORDER.indexOf(b.lead.source_class) ||
      time(b.lead) - time(a.lead),
  );
}

/** "Published 18 min ago", or for a date-only time "Published Oct 4 (date only)": never a made-up clock time. */
export function publishedText(e: Evidence, now: number): string {
  const verb = e.source_type === "community_report" ? "Reported" : "Published";
  if (!e.published_at) return "Publication time not available";
  return e.published_at_precision === "day" ? `${verb} ${calendarDate(e.published_at, now)} (date only)` : `${verb} ${relativeTime(e.published_at, now)}`;
}

function SourceLink({ evidence, isDemo }: { evidence: Evidence; isDemo: boolean }) {
  if (!isSafeHttpUrl(evidence.source_url)) return null;
  const host = evidence.source_domain ?? new URL(evidence.source_url).hostname;
  if (isDemo) return <span className="text-xs text-muted">Demo source ({host}), not a real publication</span>;
  return (
    <a
      href={evidence.source_url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      referrerPolicy="no-referrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
    >
      {host}
      <Icon icon={ExternalLink} size={12} />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "strong" | "good" | "warn" }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-surface-2 text-muted",
        tone === "strong" && "bg-indigo-50 text-indigo-800 dark:bg-indigo-400/15 dark:text-indigo-200",
        tone === "good" && "bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300",
        tone === "warn" && "bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200",
      )}
    >
      {children}
    </span>
  );
}

export function EvidenceItem({ evidence, now, isDemo, copies = [] }: { evidence: Evidence; now: number; isDemo: boolean; copies?: Evidence[] }) {
  const [showCopies, setShowCopies] = useState(false);
  const stance = STANCE[evidence.stance];
  const isCommunity = evidence.source_type === "community_report";
  const identified = evidence.source_class === "OFFICIAL" || evidence.source_class === "FIRST_PARTY";
  const copiesId = `copies-${evidence.id}`;
  return (
    <li className="flex gap-3 py-3">
      <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", stance.className)}>
        <Icon icon={stance.icon} size={15} strokeWidth={2.5} label={stance.label} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold break-words">{nameOf(evidence)}</span>
          <Tag tone={identified ? "strong" : "neutral"}>{SOURCE_KIND[evidence.source_class]}</Tag>
          {!isCommunity && evidence.is_primary && <Tag tone="strong">Primary source</Tag>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>{publishedText(evidence, now)}</span>
          {evidence.freshness_state === "stale" ? (
            <Tag tone="warn">Out of date</Tag>
          ) : evidence.time_match === "outdated" ? (
            <Tag tone="warn">May describe an earlier incident</Tag>
          ) : (
            evidence.freshness_state === "fresh" && !isCommunity && evidence.stance !== "context" && <Tag tone="good">Current</Tag>
          )}
        </p>
        {evidence.quote && (
          <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm break-words text-fg">
            <span className="sr-only">{isCommunity ? "Reporter wrote: " : "Source text: "}</span>“{evidence.quote}”
          </blockquote>
        )}
        {evidence.agent_note && (
          <p className="mt-2 text-xs text-muted">
            <span className="font-medium">Verity's note (not a quote):</span> {evidence.agent_note}
          </p>
        )}
        {evidence.found_via === "extended_verification" && <p className="mt-1.5 text-xs text-muted">Source discovered during extended verification</p>}
        <div className="mt-1.5">
          <SourceLink evidence={evidence} isDemo={isDemo} />
        </div>
        {copies.length > 0 && (
          <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
            <p className="text-fg">
              Also reported by {plural(copies.length, "other page", "other pages")} using the same underlying report. They count as one
              source.
            </p>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 font-medium text-accent hover:underline"
              aria-expanded={showCopies}
              aria-controls={copiesId}
              onClick={() => setShowCopies((v) => !v)}
            >
              {showCopies ? "Hide them" : `Show ${copies.length === 1 ? "it" : "them"}`}
              <Icon icon={ChevronDown} size={12} className={cn("transition-transform motion-reduce:transition-none", showCopies && "rotate-180")} />
            </button>
            {showCopies && (
              <ul id={copiesId} className="mt-1.5 space-y-1.5">
                {copies.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{nameOf(c)}</span>
                    <span className="text-muted"> · Repeats reporting from {nameOf(evidence)} · {publishedText(c, now)}</span>
                    <div>
                      <SourceLink evidence={c} isDemo={isDemo} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** 2. Why Verity says this: the deterministic explanation, and what is being tracked. */
export function WhySection({ event }: { event: EventDetail }) {
  return (
    <section aria-labelledby="why-heading" id="why">
      <h2 id="why-heading" className="text-base font-semibold">
        Why Verity says this
      </h2>
      <p className="mt-2 text-sm text-fg">{event.evidence_summary ?? "Verity hasn't found sources for this yet."}</p>
      <p className="mt-1 text-xs text-muted">Based on the sources below. Community answers are shown separately and don't verify an event.</p>
      {event.current_claims.length > 0 && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">What's being tracked</p>
          <ul className="mt-1.5 space-y-1.5">
            {event.current_claims.map((claim) => (
              <li key={claim.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span>{claim.text}</span>
                <span className={cn("shrink-0 text-xs font-medium", CLAIM_STANCE[claim.stance].className)}>{CLAIM_STANCE[claim.stance].label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">Claims are written by Verity; the quotes below come from the sources.</p>
        </div>
      )}
    </section>
  );
}

const COLLAPSED_GROUPS = 4;

/** 3. Sources: one entry per independent source, grouped by what each says. */
export function SourcesSection({ event, now }: { event: EventDetail; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupSources(event.evidence);
  const visible = expanded ? groups : groups.slice(0, COLLAPSED_GROUPS);
  const pages = event.evidence.length;
  const byStance = GROUP_ORDER.map((stance) => ({ stance, groups: visible.filter((g) => g.lead.stance === stance) })).filter((s) => s.groups.length > 0);

  return (
    <section aria-labelledby="sources-heading" id="evidence">
      <h2 id="sources-heading" className="text-base font-semibold">
        Sources
      </h2>
      {groups.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No sources have been attached yet.</p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          {plural(groups.length, "independent source", "independent sources")}
          {pages > groups.length ? ` from ${pages} pages. Copies of the same report count once.` : "."}
        </p>
      )}
      {byStance.map(({ stance, groups: items }) => (
        <div key={stance} className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            {STANCE[stance].heading} ({groups.filter((g) => g.lead.stance === stance).length})
          </h3>
          <ul className="divide-y divide-line">
            {items.map((g) => (
              <EvidenceItem key={g.lead.id} evidence={g.lead} copies={g.copies} now={now} isDemo={event.is_demo} />
            ))}
          </ul>
        </div>
      ))}
      {groups.length > COLLAPSED_GROUPS && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-2 text-sm font-medium text-accent hover:underline" aria-expanded={expanded}>
          {expanded ? "Show fewer sources" : `Show all ${groups.length} sources`}
        </button>
      )}
    </section>
  );
}

/** Why + Sources, as two separate sections. */
export function EvidenceSection({ event, now }: { event: EventDetail; now: number }) {
  return (
    <>
      <WhySection event={event} />
      <SourcesSection event={event} now={now} />
    </>
  );
}
