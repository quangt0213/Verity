import type { TimelineEntry } from "@verity/contracts";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { cn } from "../../../lib/cn";
import { clockTime } from "../../../lib/time";

/** How Verity's understanding changed over time, oldest first. */
export function TimelineSection({ entries, now }: { entries: TimelineEntry[]; now: number }) {
  const ordered = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="text-base font-semibold">
        Timeline
      </h2>
      {ordered.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No history yet.</p>
      ) : (
        <ol className="relative mt-3 space-y-3 border-l border-line pl-5">
          {ordered.map((entry) => {
            const isStatus = entry.kind === "status_changed" && entry.to_status;
            const isProblem = entry.kind === "verification_unavailable" || entry.kind === "contradiction_found";
            return (
              <li key={entry.id} className="relative">
                <span
                  className={cn(
                    "absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full ring-4 ring-surface",
                    isStatus ? "bg-accent" : isProblem ? "bg-amber-500" : "bg-zinc-400 dark:bg-zinc-500",
                  )}
                  aria-hidden
                />
                <p className="text-xs text-muted">
                  <time dateTime={entry.at}>{clockTime(entry.at, now)}</time>
                </p>
                {isStatus ? (
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="sr-only">{entry.label}: </span>
                    {entry.from_status && <StatusBadge status={entry.from_status} className="opacity-70" />}
                    {entry.from_status && <span aria-hidden>→</span>}
                    <StatusBadge status={entry.to_status!} />
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm">{entry.label}</p>
                )}
                {entry.detail && <p className="mt-0.5 text-xs text-muted">{entry.detail}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
