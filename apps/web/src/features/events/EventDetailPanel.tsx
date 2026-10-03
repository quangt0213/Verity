import { useEffect } from "react";
import { useParams } from "react-router";
import { userMessageFor } from "../../api/errors";
import { ErrorState, Skeleton } from "../../components/ui/States";
import { useShell } from "../map/shell-context";
import { EventDetailView } from "./detail/EventDetailView";
import { useEventDetail } from "./queries";

export function EventDetailPanel() {
  const { eventId = null } = useParams();
  const shell = useShell();
  const detail = useEventDetail(eventId);
  const { focusOn, setSheet, isDesktop } = shell;
  const loadedId = detail.data?.id;
  const coordinates = detail.data?.coordinates;

  // Center the map on the event once per event, leaving the map visible above the sheet on mobile.
  useEffect(() => {
    if (!loadedId || !coordinates) return;
    focusOn(coordinates, 15);
    if (!isDesktop) setSheet("half");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);

  if (detail.isPending) {
    return (
      <div className="space-y-4 p-4" aria-busy="true" aria-label="Loading event">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (detail.isError) {
    return <ErrorState message={userMessageFor(detail.error)} onRetry={() => void detail.refetch()} />;
  }
  return <EventDetailView event={detail.data} now={shell.now} />;
}
