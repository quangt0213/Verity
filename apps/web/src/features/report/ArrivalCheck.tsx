import type { Coordinates, EventSummary } from "@verity/contracts";
import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api/ApiProvider";
import { Button } from "../../components/ui/Button";
import { clockTime } from "../../lib/time";

/** What was sent in the attempt whose outcome is unknown. */
export interface SubmitAttempt {
  /** Client clock when the request started. */
  at: number;
  title: string;
  coordinates: Coordinates;
}

/** Search this far around the reported point: the service attaches reports to events within 300 m. */
const RADIUS_DEG_LAT = 0.005;
/** Look this far before the attempt, so a client clock that runs fast doesn't hide the event. */
const CLOCK_MARGIN_MS = 10 * 60_000;

const normalize = (title: string) => title.toLowerCase().replace(/\s+/g, " ").trim();

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "found"; event: EventSummary; checkedAt: number }
  | { kind: "nearby"; events: EventSummary[]; checkedAt: number }
  | { kind: "none" }
  | { kind: "failed" };

export const RESEND_NOTE =
  "If you send it again and the first one did arrive, Verity usually adds it to the same event instead of creating a new one, but it may count as a second report from you.";

/**
 * Checks, without leaving the form, whether a report whose outcome is unknown
 * reached Verity, using only the public event list: events near the reported
 * point that were created or updated since the attempt. A report either
 * creates an event with its exact title at that point or attaches to a nearby
 * event and updates it, so both cases show up here.
 */
export function ArrivalCheck({ attempt }: { attempt: SubmitAttempt }) {
  const api = useApi();
  const [state, setState] = useState<CheckState>({ kind: "idle" });

  const check = async () => {
    setState({ kind: "checking" });
    const { latitude, longitude } = attempt.coordinates;
    const dLng = RADIUS_DEG_LAT / Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
    const since = attempt.at - CLOCK_MARGIN_MS;
    try {
      const { events } = await api.listEvents({
        bbox: [longitude - dLng, latitude - RADIUS_DEG_LAT, longitude + dLng, latitude + RADIUS_DEG_LAT],
        updated_since: new Date(since).toISOString(),
      });
      const recent = events.filter((e) => Date.parse(e.last_updated_at) >= since);
      const match = recent.find((e) => normalize(e.title) === normalize(attempt.title));
      const checkedAt = Date.now();
      setState(
        match ? { kind: "found", event: match, checkedAt } : recent.length ? { kind: "nearby", events: recent.slice(0, 3), checkedAt } : { kind: "none" },
      );
    } catch {
      setState({ kind: "failed" });
    }
  };

  let result = null;
  switch (state.kind) {
    case "checking":
      result = "Checking…";
      break;
    case "found":
      result = (
        <>
          It arrived: “{state.event.title}” near this location was updated at {clockTime(state.event.last_updated_at, state.checkedAt)}. You don't need
          to send it again.{" "}
          <Link to={`/events/${state.event.id}`} className="font-medium underline">
            Open the event
          </Link>
        </>
      );
      break;
    case "nearby":
      result = (
        <>
          No event with your title, but{" "}
          {state.events.map((e, i) => (
            <span key={e.id}>
              {i > 0 && ", "}“{e.title}” ({clockTime(e.last_updated_at, state.checkedAt)})
            </span>
          ))}{" "}
          near this location changed since you tried. Your report may have been added to one of them. {RESEND_NOTE}
        </>
      );
      break;
    case "none":
      result = "Nothing near this location was reported or updated since you tried, so your report most likely didn't arrive. You can send it again.";
      break;
    case "failed":
      result = "Couldn't check right now. Try again in a moment.";
      break;
  }

  return (
    <div className="mt-2 space-y-2">
      <Button variant="secondary" size="sm" onClick={() => void check()} disabled={state.kind === "checking"}>
        {state.kind === "idle" ? "Check whether it arrived" : "Check again"}
      </Button>
      <p role="status" className="text-sm">
        {result}
      </p>
    </div>
  );
}
