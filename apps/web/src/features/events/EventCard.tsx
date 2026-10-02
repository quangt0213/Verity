import type { EventSummary } from "@verity/contracts";
import { Link } from "react-router";
import { Icon } from "../../components/ui/Icon";
import { DemoBadge, StatusBadge } from "../../components/ui/StatusBadge";
import { cn } from "../../lib/cn";
import { CATEGORY_DISPLAY, MARKER_GROUPS, markerGroup } from "../../lib/display";
import { checkedText, communityReportNote, sourcesText } from "../../lib/freshness";
import { scheduleText } from "../../lib/time";

export function CategoryDot({ event, size = 36 }: { event: Pick<EventSummary, "status" | "category">; size?: number }) {
  const group = MARKER_GROUPS[markerGroup(event)];
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full", group.hollow && "border-2 border-dashed")}
      style={
        group.hollow
          ? { width: size, height: size, borderColor: group.color, color: group.color }
          : { width: size, height: size, backgroundColor: group.color, color: "#fff" }
      }
      aria-hidden
    >
      <Icon icon={CATEGORY_DISPLAY[event.category].icon} size={Math.round(size * 0.5)} strokeWidth={2.25} />
    </span>
  );
}

/**
 * Status, independent sources and last-checked time, in that order:
 * "Verified · 3 independent sources · checked 4 min ago".
 */
export function FreshnessLine({ event, now, className }: { event: EventSummary; now: number; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted", className)}>
      <StatusBadge status={event.status} />
      <span aria-hidden>·</span>
      <span>{sourcesText(event)}</span>
      <span aria-hidden>·</span>
      <span className={cn(event.verification_state === "unavailable" && "text-amber-700 dark:text-amber-300")}>
        {checkedText(event, now)}
      </span>
    </p>
  );
}

interface EventCardProps {
  event: EventSummary;
  now: number;
  selected?: boolean;
  onHover?: (id: string | null) => void;
  onOpen?: (event: EventSummary) => void;
}

export function EventCard({ event, now, selected, onHover, onOpen }: EventCardProps) {
  const note = communityReportNote(event);
  const schedule = scheduleText(event.scheduled_start_at, event.scheduled_end_at, now);
  const category = CATEGORY_DISPLAY[event.category];
  return (
    <Link
      to={`/events/${event.id}`}
      onClick={() => onOpen?.(event)}
      onMouseEnter={() => onHover?.(event.id)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(event.id)}
      onBlur={() => onHover?.(null)}
      className={cn(
        "group block rounded-2xl bg-surface p-3.5 ring-1 ring-line transition-shadow hover:shadow-md",
        selected && "ring-2 ring-accent",
      )}
    >
      <div className="flex gap-3">
        <CategoryDot event={event} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="line-clamp-2 flex-1 text-[15px] leading-snug font-semibold text-fg">{event.title}</h3>
            {event.is_demo && <DemoBadge className="mt-0.5" />}
          </div>
          <FreshnessLine event={event} now={now} className="mt-1.5" />
          <p className="mt-1.5 truncate text-xs text-muted">
            <span className="sr-only">Category: </span>
            {category.label} · {event.approximate_location}
          </p>
          {schedule && <p className="mt-0.5 text-xs text-muted">{schedule}</p>}
          {note && <p className="mt-1.5 text-xs font-medium text-orange-800 dark:text-orange-300">{note}</p>}
        </div>
      </div>
    </Link>
  );
}
