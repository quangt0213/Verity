import { isSafeHttpUrl, type Claim, type EventDetail, type Evidence, type EvidenceStance } from "@verity/contracts";
import { Check, CircleCheckBig, ExternalLink, Info, X, type IconNode } from "lucide";
import { useState } from "react";
import { Icon } from "../../../components/ui/Icon";
import { cn } from "../../../lib/cn";
import { SOURCE_CLASS_LABEL } from "../../../lib/display";
import { calendarDate, relativeTime } from "../../../lib/time";

const STANCE: Record<EvidenceStance, { label: string; heading: string; icon: IconNode; className: string }> = {
  supports: {
    label: "Supports",
    heading: "Supporting",
    icon: Check,
    className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
  },
  contradicts: {
    label: "Contradicts",
    heading: "Contradicting",
    icon: X,
    className: "bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300",
  },
  ended: {
    label: "Says it ended",
    heading: "Says it has ended",
    icon: CircleCheckBig,
    className: "bg-zinc-100 text-zinc-700 dark:bg-zinc-400/10 dark:text-zinc-300",
  },
  context: {
    label: "Context",
    heading: "Context",
    icon: Info,
    className: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300",
  },
};

const CLAIM_STANCE: Record<Claim["stance"], { label: string; className: string }> = {
  supported: { label: "Supported", className: "text-emerald-700 dark:text-emerald-300" },
  contradicted: { label: "Disputed by sources", className: "text-violet-700 dark:text-violet-300" },
  ended: { label: "Ended", className: "text-zinc-600 dark:text-zinc-300" },
  unconfirmed: { label: "Unconfirmed", className: "text-slate-600 dark:text-slate-300" },
};

function SourceLink({ evidence, isDemo }: { evidence: Evidence; isDemo: boolean }) {
  if (!isSafeHttpUrl(evidence.source_url)) return null;
  const host = evidence.source_domain ?? new URL(evidence.source_url).hostname;
  if (isDemo) {
    return <span className="text-xs text-muted">Demo source ({host}), not a real publication</span>;
  }
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

export function EvidenceItem({ evidence, now, isDemo }: { evidence: Evidence; now: number; isDemo: boolean }) {
  const stance = STANCE[evidence.stance];
  const isCommunity = evidence.source_type === "community_report";
  return (
    <li className="flex gap-3 py-3">
      <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", stance.className)}>
        <Icon icon={stance.icon} size={15} strokeWidth={2.5} label={stance.label} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold">{evidence.source_name}</span>
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
            {SOURCE_CLASS_LABEL[evidence.source_class]}
          </span>
          {!isCommunity && (
            <span className="text-[11px] text-muted">{evidence.is_primary ? "Original source" : "Repeats another source"}</span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {evidence.published_at
            ? evidence.published_at_precision === "day"
              ? `${isCommunity ? "Reported" : "Published"} ${calendarDate(evidence.published_at, now)} (date only)`
              : `${isCommunity ? "Reported" : "Published"} ${relativeTime(evidence.published_at, now)}`
            : "Publication time not available"}
          {" · "}
          Retrieved {relativeTime(evidence.retrieved_at, now)}
          {evidence.freshness_state === "stale" && (
            <span className="ml-1 font-medium text-amber-700 dark:text-amber-300">· Out of date</span>
          )}
        </p>
        {evidence.quote && (
          <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm text-fg">
            <span className="sr-only">{isCommunity ? "Reporter wrote: " : "Source text: "}</span>“{evidence.quote}”
          </blockquote>
        )}
        {evidence.agent_note && (
          <p className="mt-2 text-xs text-muted">
            <span className="font-medium">Verity's research note (not a quote):</span> {evidence.agent_note}
          </p>
        )}
        {!evidence.counts_as_independent && (
          <p className="mt-1.5 text-xs text-muted">
            Not counted as an independent source. It traces back to the same origin as another source here.
          </p>
        )}
        <div className="mt-1.5">
          <SourceLink evidence={evidence} isDemo={isDemo} />
        </div>
      </div>
    </li>
  );
}

const GROUP_ORDER: EvidenceStance[] = ["supports", "contradicts", "ended", "context"];
const COLLAPSED_COUNT = 3;

export function EvidenceSection({ event, now }: { event: EventDetail; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const groups = GROUP_ORDER.map((stance) => ({ stance, items: event.evidence.filter((e) => e.stance === stance) })).filter(
    (g) => g.items.length > 0,
  );
  let shown = 0;

  return (
    <section aria-labelledby="why-heading" id="evidence">
      <h2 id="why-heading" className="text-base font-semibold">
        Why Verity says this
      </h2>

      {event.evidence_summary && (
        <p className="mt-2 text-sm text-fg">
          <span className="sr-only">Verity's summary of the evidence: </span>
          {event.evidence_summary}
        </p>
      )}

      {event.current_claims.length > 0 && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">What's being tracked</p>
          <ul className="mt-1.5 space-y-1.5">
            {event.current_claims.map((claim) => (
              <li key={claim.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span>{claim.text}</span>
                <span className={cn("shrink-0 text-xs font-medium", CLAIM_STANCE[claim.stance].className)}>
                  {CLAIM_STANCE[claim.stance].label}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">Claims are written by Verity; the quotes below come from the sources.</p>
        </div>
      )}

      {groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No sources have been attached yet.</p>
      ) : (
        groups.map((group) => {
          const remaining = expanded ? group.items.length : Math.max(0, COLLAPSED_COUNT - shown);
          const items = group.items.slice(0, remaining);
          shown += items.length;
          if (items.length === 0) return null;
          return (
            <div key={group.stance} className="mt-4">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                {STANCE[group.stance].heading} ({group.items.length})
              </h3>
              <ul className="divide-y divide-line">
                {items.map((e) => (
                  <EvidenceItem key={e.id} evidence={e} now={now} isDemo={event.is_demo} />
                ))}
              </ul>
            </div>
          );
        })
      )}

      {event.evidence.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-sm font-medium text-accent hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? "Show fewer sources" : `Show all ${event.evidence.length} sources`}
        </button>
      )}
    </section>
  );
}
