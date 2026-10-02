import type { EventSummary } from "@verity/contracts";
import { ChevronRight, X } from "lucide";
import { Link } from "react-router";
import { Icon } from "../../components/ui/Icon";
import { DemoBadge } from "../../components/ui/StatusBadge";
import { communityReportNote } from "../../lib/freshness";
import { CategoryDot, FreshnessLine } from "./EventCard";

/** Compact card shown when a marker is tapped; opening it leads to the full detail. */
export function EventPreview({ event, now, onClose }: { event: EventSummary; now: number; onClose: () => void }) {
  const note = communityReportNote(event);
  return (
    <div className="pointer-events-auto w-full rounded-2xl bg-surface p-3.5 shadow-xl ring-1 ring-line" role="dialog" aria-label={`Preview: ${event.title}`}>
      <div className="flex gap-3">
        <CategoryDot event={event} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="line-clamp-2 flex-1 text-[15px] leading-snug font-semibold">{event.title}</p>
            {event.is_demo && <DemoBadge className="mt-0.5" />}
            <button type="button" onClick={onClose} className="-mt-1 -mr-1 rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Close preview">
              <Icon icon={X} size={16} />
            </button>
          </div>
          <FreshnessLine event={event} now={now} className="mt-1.5" />
          <p className="mt-1.5 truncate text-xs text-muted">{event.approximate_location}</p>
          {note && <p className="mt-1 text-xs font-medium text-orange-800 dark:text-orange-300">{note}</p>}
        </div>
      </div>
      <Link
        to={`/events/${event.id}`}
        className="mt-3 flex h-10 items-center justify-center gap-1 rounded-xl bg-surface-2 text-sm font-medium hover:brightness-95 dark:hover:brightness-110"
      >
        View evidence and details
        <Icon icon={ChevronRight} size={16} />
      </Link>
    </div>
  );
}
