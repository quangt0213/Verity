import { MapPin, ZoomIn } from "lucide";
import { userMessageFor } from "../../api/errors";
import { EmptyState, ErrorState, EventCardSkeleton } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { useShell } from "../map/shell-context";
import { EventCard } from "./EventCard";
import type { EventFilters, KindFilter } from "./filters";

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "disruption", label: "Disruptions" },
  { value: "planned", label: "Planned events" },
];

export function FilterChips({
  filters,
  setFilters,
}: {
  filters: EventFilters;
  setFilters: (update: (f: EventFilters) => EventFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter events">
      {KIND_OPTIONS.map((option) => {
        const active = filters.kind === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setFilters((f) => ({ ...f, kind: option.value }))}
            className={cn(
              "h-9 rounded-full px-3.5 text-sm font-medium transition-colors",
              active ? "bg-fg text-bg" : "bg-surface-2 text-fg hover:brightness-95 dark:hover:brightness-110",
            )}
          >
            {option.label}
          </button>
        );
      })}
      <label className="ml-auto inline-flex h-9 cursor-pointer items-center gap-2 text-sm text-muted select-none">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--app-accent)]"
          checked={filters.showEnded}
          onChange={(e) => setFilters((f) => ({ ...f, showEnded: e.target.checked }))}
        />
        Show ended
      </label>
    </div>
  );
}

export function feedHeading(count: number, zoomedOut: boolean, pending: boolean): string {
  if (zoomedOut) return "Zoom in to see events";
  if (pending) return "Loading events…";
  return count === 1 ? "1 event in this area" : `${count} events in this area`;
}

/** The list of events in the current map viewport. */
export function FeedPanel() {
  const { events, list, zoomedOut, now, highlightedId, setHighlightedId, filters, setFilters } = useShell();

  let body;
  if (zoomedOut) {
    body = (
      <EmptyState icon={ZoomIn} title="Zoom in to see events">
        Verity loads events for the area you're looking at.
      </EmptyState>
    );
  } else if (list.isPending) {
    body = (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading events">
        {[0, 1, 2, 3].map((i) => (
          <EventCardSkeleton key={i} />
        ))}
      </div>
    );
  } else if (list.error) {
    body = <ErrorState message={userMessageFor(list.error)} onRetry={list.refetch} />;
  } else if (events.length === 0) {
    body = (
      <EmptyState icon={MapPin} title={filters.q ? "No matching events here" : "No events in this area right now"}>
        {filters.q ? (
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => setFilters((f) => ({ ...f, q: "" }))}>
            Clear search
          </button>
        ) : (
          "Move or zoom out the map to look elsewhere."
        )}
      </EmptyState>
    );
  } else {
    body = (
      <ul className="space-y-2.5">
        {events.map((event) => (
          <li key={event.id}>
            <EventCard event={event} now={now} selected={event.id === highlightedId} onHover={setHighlightedId} />
          </li>
        ))}
        {list.truncated && <li className="py-2 text-center text-xs text-muted">More events match. Zoom in to see them all.</li>}
      </ul>
    );
  }

  return (
    <div className="space-y-3 px-4 pt-3 pb-24 lg:pb-6">
      <div className="hidden lg:block">
        <h1 className="text-base font-semibold" aria-live="polite">
          {feedHeading(events.length, zoomedOut, list.isPending)}
        </h1>
      </div>
      <div className="hidden lg:block">
        <FilterChips filters={filters} setFilters={setFilters} />
      </div>
      {body}
    </div>
  );
}
