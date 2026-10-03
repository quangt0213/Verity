import type { EventDetail } from "@verity/contracts";
import { Bookmark, BookmarkCheck, ChevronLeft, LoaderCircle, MapPin, Share2, TriangleAlert } from "lucide";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { DemoBadge, StatusBadge } from "../../../components/ui/StatusBadge";
import { useToast } from "../../../components/ui/Toast";
import { CATEGORY_DISPLAY, STATUS_DISPLAY } from "../../../lib/display";
import { checkedText, communityReportNote, sourcesText } from "../../../lib/freshness";
import { relativeTime, scheduleText } from "../../../lib/time";
import { useMaypop } from "../../../maypop/MaypopProvider";
import { useFollowingList, useFollowToggle } from "../../following/useFollowing";
import { CommunitySection } from "./CommunitySection";
import { EvidenceSection } from "./EvidenceSection";
import { TimelineSection } from "./TimelineSection";

function VerificationNotice({ event }: { event: EventDetail }) {
  switch (event.verification_state) {
    case "queued":
      return (
        <div className="flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-900 dark:bg-sky-400/10 dark:text-sky-100" role="status">
          <Icon icon={LoaderCircle} size={16} className="mt-0.5 shrink-0" />
          <span>Verification queued. Verity will check live sources shortly.</span>
        </div>
      );
    case "in_progress":
      return (
        <div className="flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-900 dark:bg-sky-400/10 dark:text-sky-100" role="status">
          <Icon icon={LoaderCircle} size={16} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" />
          <span>Verification in progress. Verity is checking live sources; this page updates automatically.</span>
        </div>
      );
    case "unavailable":
      return (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100" role="status">
          <Icon icon={TriangleAlert} size={16} className="mt-0.5 shrink-0" />
          <span>
            Verification temporarily unavailable. The evidence below is unchanged and nothing new has been inferred. Verity will try
            again.
          </span>
        </div>
      );
    case "idle":
      return null;
  }
}

export function EventDetailView({ event, now }: { event: EventDetail; now: number }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const followingList = useFollowingList();
  const toggleFollow = useFollowToggle();
  const { share } = useMaypop();
  const toast = useToast();
  const following = followingList.data?.some((e) => e.id === event.id) ?? false;
  const category = CATEGORY_DISPLAY[event.category];
  const schedule = scheduleText(event.scheduled_start_at, event.scheduled_end_at, now);
  const note = communityReportNote(event);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [event.id]);

  return (
    <article className="space-y-6 px-4 pt-3 pb-8">
      <header>
        <div className="flex items-center justify-between gap-2">
          <Link to="/map" className="-ml-2 inline-flex h-10 items-center gap-1 rounded-xl px-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg">
            <Icon icon={ChevronLeft} size={18} />
            All events
          </Link>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={following}
              onClick={() => void toggleFollow(event.id, !following)}
            >
              <Icon icon={following ? BookmarkCheck : Bookmark} size={16} />
              {following ? "Following" : "Follow"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await share(`/events/${event.id}`, event.title);
                if (result.ok) {
                  if (result.via === "clipboard") toast.show("Link copied", "success");
                } else {
                  toast.show(result.message, "warning");
                }
              }}
            >
              <Icon icon={Share2} size={16} />
              Share
            </Button>
          </div>
        </div>

        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-muted">
          <Icon icon={category.icon} size={14} />
          {category.label}
          {event.is_demo && <DemoBadge className="ml-1" />}
        </p>
        <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-xl leading-tight font-semibold focus:outline-none">
          {event.title}
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusBadge status={event.status} size="md" />
          <span className="text-sm text-fg">{STATUS_DISPLAY[event.status].description}</span>
        </div>
        <p className="mt-2 text-sm text-muted">
          {sourcesText(event)} · {checkedText(event, now)} · first reported {relativeTime(event.first_seen_at, now)}
        </p>
        {note && <p className="mt-1 text-sm font-medium text-orange-800 dark:text-orange-300">{note}</p>}
        <p className="mt-2 flex items-start gap-1.5 text-sm">
          <Icon icon={MapPin} size={16} className="mt-0.5 shrink-0 text-muted" />
          <span>
            {event.approximate_location}
            <span className="text-muted"> (approximate)</span>
          </span>
        </p>
        {schedule && <p className="mt-1 pl-[22px] text-sm text-muted">{schedule}</p>}
      </header>

      <VerificationNotice event={event} />

      {event.summary && (
        <section aria-label="Summary">
          <p className="text-[15px] leading-relaxed">{event.summary}</p>
        </section>
      )}

      <EvidenceSection event={event} now={now} />
      <CommunitySection event={event} />
      <TimelineSection entries={event.timeline} now={now} />
    </article>
  );
}
