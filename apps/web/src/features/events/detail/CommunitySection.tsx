import { isActiveStatus, LIMITS, type EventDetail, type StillHappeningAnswer } from "@verity/contracts";
import { Check, CircleCheckBig, Info, MessageSquarePlus, ThumbsDown, ThumbsUp, Users } from "lucide";
import { useId, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { useToast } from "../../../components/ui/Toast";
import { cn } from "../../../lib/cn";
import { stillHappeningText } from "../../../lib/freshness";
import { windowText } from "../../../lib/time";
import { useCommunityResponse, type ResponseState } from "./useCommunityResponse";

const ANSWERS: { value: StillHappeningAnswer; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

function stateLabel(state: ResponseState | undefined): string | null {
  if (state === "sending") return "Sending…";
  if (state === "recorded") return "Recorded";
  if (state === "simulated") return "Demo only, not sent";
  return null;
}

function ResponseButton({
  icon,
  label,
  state,
  onClick,
}: {
  icon: typeof Check;
  label: string;
  state: ResponseState | undefined;
  onClick: () => void;
}) {
  const status = stateLabel(state);
  const done = state === "recorded" || state === "simulated";
  return (
    <Button
      variant={done ? "subtle" : "secondary"}
      size="md"
      className="flex-1 basis-[calc(50%-0.25rem)] sm:basis-0"
      onClick={onClick}
      disabled={state === "sending" || done}
      aria-describedby="write-policy-note"
    >
      <Icon icon={done ? Check : icon} size={16} />
      <span>{status ?? label}</span>
    </Button>
  );
}

export function CommunitySection({ event }: { event: EventDetail }) {
  const { respond, states, writePolicy } = useCommunityResponse(event.id);
  const toast = useToast();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateText, setUpdateText] = useState("");
  const updateId = useId();
  const active = isActiveStatus(event.status);
  const summary = stillHappeningText(event.community);
  const c = event.community;

  const handle = async (input: Parameters<typeof respond>[0], success: string): Promise<boolean> => {
    const outcome = await respond(input);
    if (outcome.ok) {
      toast.show(outcome.simulated ? `${success} (demo only, not sent to Verity)` : success, "success");
      return true;
    }
    // Includes the expected "auth_unavailable" refusal; the message is user-safe.
    toast.show(outcome.error.message, "warning");
    return false;
  };

  let policyNote: ReactNode;
  if (!writePolicy.enabled) {
    policyNote =
      writePolicy.reason === "service_unconfigured"
        ? "Responses aren't available because this build isn't connected to a Verity service."
        : "Preview only: Verity can't verify accounts yet, so responses aren't recorded. Nothing you press here is saved or changes this event's status.";
  } else if (writePolicy.simulated) {
    policyNote = "Demo mode: responses stay in this browser tab and aren't sent anywhere. They never change an event's status.";
  } else {
    policyNote = "Your response is one signal. It never changes the status on its own; Verity re-checks the evidence.";
  }

  return (
    <section aria-labelledby="community-heading">
      <h2 id="community-heading" className="text-base font-semibold">
        Community
      </h2>

      <div className="mt-2 flex items-start gap-2 text-sm">
        <Icon icon={Users} size={16} className="mt-0.5 shrink-0 text-muted" />
        <div>
          {summary ? <p>{summary}</p> : <p className="text-muted">No recent answers from the community yet.</p>}
          <p className="mt-0.5 text-xs text-muted">
            {c.recent_confirmations} confirmation{c.recent_confirmations === 1 ? "" : "s"} · {c.recent_disputes} dispute
            {c.recent_disputes === 1 ? "" : "s"}
            {c.resolved_reports > 0 && ` · ${c.resolved_reports} said it ended`} {windowText(c.window_minutes)}. Counts only;
            Verity never shows who answered or where they were.
          </p>
        </div>
      </div>

      {active && (
        <>
          <fieldset className="mt-4">
            <legend className="text-sm font-semibold">Is this still happening?</legend>
            <div className="mt-2 flex gap-2">
              {ANSWERS.map((a) => {
                const state = states.still_happening;
                return (
                  <Button
                    key={a.value}
                    variant="secondary"
                    className="flex-1"
                    disabled={state === "sending" || state === "recorded" || state === "simulated"}
                    aria-describedby="write-policy-note"
                    onClick={() => void handle({ kind: "still_happening", answer: a.value }, "Thanks for answering")}
                  >
                    {a.label}
                  </Button>
                );
              })}
            </div>
            {stateLabel(states.still_happening) && (
              <p className="mt-1.5 text-xs text-muted" aria-live="polite">
                {stateLabel(states.still_happening)}
              </p>
            )}
          </fieldset>

          <div className="mt-4 flex flex-wrap gap-2">
            <ResponseButton
              icon={ThumbsUp}
              label="Confirm"
              state={states.confirm}
              onClick={() => void handle({ kind: "confirm" }, "Confirmation received")}
            />
            <ResponseButton
              icon={ThumbsDown}
              label="Dispute"
              state={states.dispute}
              onClick={() => void handle({ kind: "dispute" }, "Dispute received")}
            />
            <ResponseButton
              icon={CircleCheckBig}
              label="It's over"
              state={states.resolved}
              onClick={() => void handle({ kind: "resolved" }, "Thanks, Verity will re-check")}
            />
            <Button
              variant="secondary"
              className="flex-1 basis-[calc(50%-0.25rem)] sm:basis-0"
              aria-expanded={updateOpen}
              aria-controls={updateId}
              onClick={() => setUpdateOpen((v) => !v)}
            >
              <Icon icon={MessageSquarePlus} size={16} />
              Add update
            </Button>
          </div>

          {updateOpen && (
            <form
              id={updateId}
              className="mt-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const text = updateText.trim();
                if (!text) return;
                const ok = await handle({ kind: "update", text }, "Update received");
                if (ok) {
                  setUpdateText("");
                  setUpdateOpen(false);
                }
              }}
            >
              <label htmlFor={`${updateId}-text`} className="text-sm font-medium">
                What has changed?
              </label>
              <textarea
                id={`${updateId}-text`}
                value={updateText}
                maxLength={LIMITS.updateTextMax}
                onChange={(e) => setUpdateText(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-xl bg-surface px-3 py-2 text-sm ring-1 ring-line focus:ring-2 focus:ring-accent focus:outline-none"
                placeholder="e.g. Only one lane is closed now"
              />
              <div className="mt-1 flex items-center justify-between">
                <span className="text-xs text-muted">
                  {updateText.length}/{LIMITS.updateTextMax}
                </span>
                <Button type="submit" size="sm" disabled={!updateText.trim() || states.update === "sending"}>
                  {states.update === "sending" ? "Sending…" : "Send update"}
                </Button>
              </div>
            </form>
          )}
        </>
      )}

      <p
        id="write-policy-note"
        className={cn(
          "mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs",
          writePolicy.enabled ? "bg-surface-2 text-muted" : "bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200",
        )}
      >
        <Icon icon={Info} size={14} className="mt-0.5 shrink-0" />
        <span>{policyNote}</span>
      </p>
    </section>
  );
}
