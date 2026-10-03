import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isActiveStatus,
  LIMITS,
  type CommunityResponseInput,
  type EventDetail,
  type SignalType,
  type StillHappeningAnswer,
} from "@verity/contracts";
import { Check, CircleCheckBig, Info, MessageSquarePlus, ThumbsDown, ThumbsUp, Users, type IconNode } from "lucide";
import { useId, useState, type ReactNode } from "react";
import { useApi } from "../../../api/ApiProvider";
import { signalTypeFor } from "../../../api/types";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { useToast } from "../../../components/ui/Toast";
import { cn } from "../../../lib/cn";
import { communitySummaryText } from "../../../lib/freshness";
import { windowText } from "../../../lib/time";
import { useAuth, useGuardedWrite } from "../../auth/AuthProvider";
import { accountKeys } from "../../following/useFollowing";
import { eventKeys } from "../queries";

const ANSWERS: { value: StillHappeningAnswer; label: string; type: SignalType }[] = [
  { value: "yes", label: "Yes", type: "STILL_HAPPENING" },
  { value: "no", label: "No", type: "NO_LONGER_HAPPENING" },
  { value: "not_sure", label: "Not sure", type: "NOT_SURE" },
];

function AnswerButton({
  icon,
  label,
  activeLabel,
  active,
  sending,
  onClick,
  className,
}: {
  icon?: IconNode;
  label: string;
  activeLabel?: string;
  active: boolean;
  sending: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant={active ? "subtle" : "secondary"}
      className={cn(active && "ring-2 ring-accent", className)}
      aria-pressed={active}
      disabled={sending}
      aria-describedby="write-policy-note"
      onClick={onClick}
    >
      {(active || icon) && <Icon icon={active ? Check : icon!} size={16} />}
      <span>{sending ? "Sending…" : active ? (activeLabel ?? label) : label}</span>
    </Button>
  );
}

/**
 * Community answers. Each person has one current answer per question
 * ("is this real?" and "is it still happening?"); pressing a different answer
 * replaces theirs. Answers adjust counts only, never the event's status.
 * Optimism is limited to the viewer's own pending answer.
 */
export function CommunitySection({ event }: { event: EventDetail }) {
  const api = useApi();
  const { session, available } = useAuth();
  const guarded = useGuardedWrite();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<SignalType | "update" | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateText, setUpdateText] = useState("");
  const updateId = useId();
  const token = session?.token ?? null;

  const mine = useQuery({
    queryKey: accountKeys.mySignals(event.id, token),
    queryFn: ({ signal }) => api.getMySignals(event.id, signal),
    enabled: !available || session !== null,
  });
  const activeAnswers = new Set<SignalType>(mine.data ?? []);
  const active = isActiveStatus(event.status);
  const summary = communitySummaryText(event.community);
  const c = event.community;
  const policy = api.writePolicy;

  async function answer(input: CommunityResponseInput, success: string): Promise<boolean> {
    setPending(signalTypeFor(input) ?? "update");
    const result = await guarded(() => api.respond(event.id, input), "Sign in to answer");
    setPending(null);
    if (!result) return false; // sign-in dismissed: nothing happened, nothing to report
    if (!result.ok) {
      toast.show(result.error.message, "warning");
      return false;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["account", "signals", event.id] }),
    ]);
    if (result.data.changed === false) toast.show("That's already your answer.", "info");
    else toast.show(result.simulated ? `${success} (demo only, not sent to Verity)` : success, "success");
    return true;
  }

  let policyNote: ReactNode;
  if (!policy.enabled) {
    policyNote =
      policy.reason === "service_unconfigured"
        ? "Answers aren't available because this build isn't connected to a Verity service."
        : "Preview only: answers aren't recorded in this demo. Nothing you press here is saved or changes this event's status.";
  } else if (policy.simulated) {
    policyNote = "Demo mode: answers stay in this browser tab and aren't sent anywhere. They never change an event's status.";
  } else if (!session) {
    policyNote = "You'll be asked to sign in with your email. Each answer is one signal; it never changes the status on its own.";
  } else {
    policyNote = "Your answer is one signal. It never changes the event's status on its own; Verity re-checks the evidence.";
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
              {ANSWERS.map((a) => (
                <AnswerButton
                  key={a.value}
                  label={a.label}
                  active={activeAnswers.has(a.type)}
                  sending={pending === a.type}
                  className="flex-1"
                  onClick={() => void answer({ kind: "still_happening", answer: a.value }, "Thanks for answering")}
                />
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex flex-wrap gap-2">
            <AnswerButton
              icon={ThumbsUp}
              label="Confirm"
              activeLabel="Confirmed"
              active={activeAnswers.has("CONFIRM")}
              sending={pending === "CONFIRM"}
              className="flex-1 basis-[calc(50%-0.25rem)] sm:basis-0"
              onClick={() => void answer({ kind: "confirm" }, "Confirmation received")}
            />
            <AnswerButton
              icon={ThumbsDown}
              label="Dispute"
              activeLabel="Disputed"
              active={activeAnswers.has("DISPUTE")}
              sending={pending === "DISPUTE"}
              className="flex-1 basis-[calc(50%-0.25rem)] sm:basis-0"
              onClick={() => void answer({ kind: "dispute" }, "Dispute received")}
            />
            <AnswerButton
              icon={CircleCheckBig}
              label="It's over"
              activeLabel="Marked as over"
              active={activeAnswers.has("NO_LONGER_HAPPENING")}
              sending={pending === "NO_LONGER_HAPPENING"}
              className="flex-1 basis-[calc(50%-0.25rem)] sm:basis-0"
              onClick={() => void answer({ kind: "resolved" }, "Thanks, Verity will re-check")}
            />
            {api.supportsUpdates && (
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
            )}
          </div>

          {api.supportsUpdates && updateOpen && (
            <form
              id={updateId}
              className="mt-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const text = updateText.trim();
                if (!text) return;
                if (await answer({ kind: "update", text }, "Update received")) {
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
                <Button type="submit" size="sm" disabled={!updateText.trim() || pending === "update"}>
                  {pending === "update" ? "Sending…" : "Send update"}
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
          policy.enabled ? "bg-surface-2 text-muted" : "bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200",
        )}
      >
        <Icon icon={Info} size={14} className="mt-0.5 shrink-0" />
        <span>{policyNote}</span>
      </p>
    </section>
  );
}
