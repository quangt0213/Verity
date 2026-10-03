import { useQueries } from "@tanstack/react-query";
import type { EventDetail, TimelineEntry } from "@verity/contracts";
import { Bookmark, LogIn } from "lucide";
import { Link } from "react-router";
import { useApi } from "../../api/ApiProvider";
import { userMessageFor } from "../../api/errors";
import { Card, PageLayout } from "../../app/PageLayout";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { EmptyState, ErrorState, EventCardSkeleton } from "../../components/ui/States";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useNow } from "../../lib/hooks";
import { relativeTime } from "../../lib/time";
import { useAuth } from "../auth/AuthProvider";
import { EventCard } from "../events/EventCard";
import { eventKeys } from "../events/queries";
import { useFollowingList } from "./useFollowing";

const MEANINGFUL: TimelineEntry["kind"][] = ["status_changed", "contradiction_found", "verification_unavailable"];
const MAX_DETAILS = 50;

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
  const { available, session, requestSignIn } = useAuth();
  const list = useFollowingList();
  const followed = list.data ?? [];
  const details = useQueries({
    queries: followed.slice(0, MAX_DETAILS).map((e) => ({
      queryKey: eventKeys.detail(e.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.getEvent(e.id, signal),
      retry: false,
    })),
  });
  const loaded = details.flatMap((r) => (r.data ? [r.data] : []));
  const changes = meaningfulChanges(loaded);
  const where = available ? "Follows are saved to your Verity account." : "Follows are saved on this device.";

  let body;
  if (available && !session) {
    body = (
      <Card>
        <EmptyState icon={Bookmark} title="Sign in to see events you follow">
          <p>Following keeps track of how Verity's understanding of an event changes.</p>
          <Button className="mt-4" onClick={() => void requestSignIn("Sign in to follow events")}>
            <Icon icon={LogIn} size={16} />
            Sign in
          </Button>
        </EmptyState>
      </Card>
    );
  } else if (list.isPending) {
    body = <EventCardSkeleton />;
  } else if (list.isError) {
    body = <ErrorState message={userMessageFor(list.error)} onRetry={() => void list.refetch()} />;
  } else if (followed.length === 0) {
    body = (
      <Card>
        <EmptyState icon={Bookmark} title="You're not following anything yet">
          Open an event and tap <span className="font-medium text-fg">Follow</span> to keep track of it here.
        </EmptyState>
      </Card>
    );
  } else {
    body = (
      <div className="space-y-6">
        <section aria-labelledby="activity-heading">
          <h2 id="activity-heading" className="text-base font-semibold">
            Recent changes
          </h2>
          {changes.length === 0 ? (
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
            Followed events ({followed.length})
          </h2>
          <ul className="mt-2 space-y-2.5">
            {followed.map((event) => (
              <li key={event.id}>
                <EventCard event={event} now={now} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  return (
    <PageLayout title="Following" description="Events you follow and how Verity's understanding of them changed.">
      {body}
      <p className="mt-6 text-xs text-muted">
        {where} Alerts for meaningful changes (for example Developing → Verified) will arrive in a later release.
      </p>
    </PageLayout>
  );
}
