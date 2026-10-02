import { useQueries } from "@tanstack/react-query";
import { toEventSummary, type EventDetail, type TimelineEntry } from "@verity/contracts";
import { Bookmark } from "lucide";
import { Link } from "react-router";
import { useApi } from "../../api/ApiProvider";
import { Card, PageLayout } from "../../app/PageLayout";
import { EmptyState, EventCardSkeleton } from "../../components/ui/States";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useNow } from "../../lib/hooks";
import { relativeTime } from "../../lib/time";
import { EventCard } from "../events/EventCard";
import { eventKeys } from "../events/queries";
import { useFollows } from "./follows";

const MEANINGFUL: TimelineEntry["kind"][] = ["status_changed", "contradiction_found", "verification_unavailable"];
const MAX_SHOWN = 50;

interface Change {
  event: EventDetail;
  entry: TimelineEntry;
}

/** Status changes and contradictions only; routine re-checks aren't "activity". */
export function meaningfulChanges(events: EventDetail[], limit = 10): Change[] {
  return events
    .flatMap((event) => event.timeline.filter((t) => MEANINGFUL.includes(t.kind)).map((entry) => ({ event, entry })))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at))
    .slice(0, limit);
}

export function FollowingPage() {
  const api = useApi();
  const now = useNow();
  const { follows } = useFollows();
  const ids = follows.slice(0, MAX_SHOWN);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: eventKeys.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.getEvent(id, signal),
      retry: false,
    })),
  });
  const loaded = results.flatMap((r) => (r.data ? [r.data] : []));
  const pending = results.some((r) => r.isPending);
  const missing = results.filter((r) => r.isError).length;
  const changes = meaningfulChanges(loaded);

  return (
    <PageLayout title="Following" description="Events you follow and how Verity's understanding of them changed.">
      {ids.length === 0 ? (
        <Card>
          <EmptyState icon={Bookmark} title="You're not following anything yet">
            Open an event and tap <span className="font-medium text-fg">Follow</span> to keep track of it here.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="activity-heading">
            <h2 id="activity-heading" className="text-base font-semibold">
              Recent changes
            </h2>
            {pending && loaded.length === 0 ? (
              <div className="mt-2">
                <EventCardSkeleton />
              </div>
            ) : changes.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No status changes yet for the events you follow.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line rounded-2xl bg-surface ring-1 ring-line">
                {changes.map(({ event, entry }) => (
                  <li key={entry.id}>
                    <Link to={`/events/${event.id}`} className="block px-4 py-3 hover:bg-surface-2">
                      <p className="text-sm font-medium">{event.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        {entry.to_status ? (
                          <>
                            {entry.from_status && <StatusBadge status={entry.from_status} className="opacity-70" />}
                            {entry.from_status && <span aria-hidden>→</span>}
                            <StatusBadge status={entry.to_status} />
                          </>
                        ) : (
                          <span className="text-fg">{entry.label}</span>
                        )}
                        <span>· {relativeTime(entry.at, now)}</span>
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="followed-heading">
            <h2 id="followed-heading" className="text-base font-semibold">
              Followed events ({ids.length})
            </h2>
            <ul className="mt-2 space-y-2.5">
              {pending && loaded.length === 0 && (
                <li>
                  <EventCardSkeleton />
                </li>
              )}
              {loaded.map((event) => (
                <li key={event.id}>
                  <EventCard event={toEventSummary(event)} now={now} />
                </li>
              ))}
            </ul>
            {missing > 0 && (
              <p className="mt-2 text-xs text-muted">
                {missing} followed event{missing === 1 ? "" : "s"} couldn't be loaded. {missing === 1 ? "It" : "They"} may have been removed.
              </p>
            )}
          </section>

          <p className="text-xs text-muted">
            Follows are saved on this device. Alerts for meaningful changes (for example Developing → Verified) will arrive once the Verity
            service is connected.
          </p>
        </div>
      )}
    </PageLayout>
  );
}
