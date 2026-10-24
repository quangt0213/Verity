import {
  CATEGORY_KIND,
  checkPublicHttpUrl,
  EVENT_CATEGORIES,
  LIMITS,
  reportEventInputSchema,
  type Coordinates,
  type EventCategory,
} from "@verity/contracts";
import { CircleHelp, Info } from "lucide";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { useApi } from "../../api/ApiProvider";
import { Card, PageLayout } from "../../app/PageLayout";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useToast } from "../../components/ui/Toast";
import { appConfig } from "../../config/env";
import { cn } from "../../lib/cn";
import { CATEGORY_DISPLAY } from "../../lib/display";
import { approximateCoordinates } from "../../lib/geo";
import { useTheme } from "../../theme/ThemeProvider";
import { useAuth, useGuardedWrite } from "../auth/AuthProvider";
import { LocationPicker } from "./LocationPicker";
import { ArrivalCheck, type SubmitAttempt } from "./ArrivalCheck";
import { KEPT, submitFailureErrors, submitOutcome, UNKNOWN_HEADLINE, unknownOutcomeReason, type FieldErrors } from "./submit-errors";

/** A `datetime-local` value is the reporter's local wall-clock time; send it as an exact instant. */
function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

/** The reporter's time zone in words ("Pacific Daylight Time"), since the schedule fields are local times. */
function localTimeZoneName(): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

const inputClass =
  "mt-1 w-full rounded-xl bg-surface px-3 text-sm ring-1 ring-line placeholder:text-muted focus:ring-2 focus:ring-accent focus:outline-none aria-invalid:ring-red-500";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">
      {message}
    </p>
  );
}

export function ReportPage() {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { resolved: theme } = useTheme();
  const startCenter = (location.state as { center?: Coordinates } | null)?.center ?? appConfig.defaultView.center;

  const [category, setCategory] = useState<EventCategory | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [label, setLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [coordinates, setCoordinates] = useState<Coordinates>(approximateCoordinates(startCenter));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const unknownRef = useRef<HTMLDivElement>(null);
  const focusFirstError = useRef(false);
  // A second submit while one is in flight is ignored (a fast double click lands before the button disables).
  const inFlight = useRef(false);
  // Remounts the alert per failed attempt, so the same message is announced again.
  const [attempt, setAttempt] = useState(0);
  // Set when the service may or may not have stored the last attempt.
  const [unknownOutcome, setUnknownOutcome] = useState<{ attempt: SubmitAttempt; reason: string } | null>(null);
  const [timeZone] = useState(localTimeZoneName);

  // After a failed submit, move focus to the first field that needs attention.
  useEffect(() => {
    if (!focusFirstError.current) return;
    focusFirstError.current = false;
    const form = formRef.current;
    const target = errors.category
      ? form?.querySelector<HTMLElement>('input[name="category"]')
      : (form?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? alertRef.current ?? unknownRef.current);
    target?.focus();
  }, [errors]);

  const policy = api.writePolicy;
  const { session } = useAuth();
  const guarded = useGuardedWrite();

  // Only planned events have a schedule; the fields keep their values if the category changes back.
  const planned = category !== null && CATEGORY_KIND[category] === "planned";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const scheduledStart = planned ? localToIso(startsAt) : undefined;
    const scheduledEnd = planned ? localToIso(endsAt) : undefined;
    const payload = {
      category: category ?? undefined,
      title,
      ...(description.trim() ? { description } : {}),
      location: { coordinates: approximateCoordinates(coordinates), ...(label.trim() ? { label } : {}) },
      ...(sourceUrl.trim() ? { source_url: sourceUrl.trim() } : {}),
      ...(scheduledStart ? { scheduled_start_at: scheduledStart } : {}),
      ...(scheduledEnd ? { scheduled_end_at: scheduledEnd } : {}),
    };

    // Same schema the service uses; the service re-validates everything.
    const parsed = reportEventInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form") as keyof FieldErrors;
        next[key] ??= key === "category" ? "Choose a category" : issue.message;
      }
      focusFirstError.current = true;
      setErrors(next);
      return;
    }
    setErrors({});
    setUnknownOutcome(null);
    setSubmitting(true);
    inFlight.current = true;
    const startedAt = Date.now();
    // If sign-in is needed, the dialog opens and the same report is submitted
    // right after; the form keeps everything that was typed.
    let result;
    try {
      result = await guarded(() => api.reportEvent(payload as Parameters<typeof api.reportEvent>[0]), "Sign in to submit your report");
    } catch {
      result = { ok: false as const, error: { code: "network" as const, message: "", outcomeUnknown: true as const } };
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
    if (!result) return;

    if (!result.ok) {
      // Every field keeps its value, the schedule included; nothing is resent automatically.
      focusFirstError.current = true;
      setAttempt((n) => n + 1);
      if (submitOutcome(result.error) === "unknown") {
        // The service may have stored it: say so, and offer a check before the user decides to resend.
        setUnknownOutcome({
          attempt: { at: startedAt, title: payload.title, coordinates: payload.location.coordinates },
          reason: unknownOutcomeReason(result.error),
        });
        setErrors({});
      } else {
        setErrors(submitFailureErrors(result.error, Boolean(scheduledStart || scheduledEnd)));
      }
      return;
    }
    const merged = result.data.outcome === "attached_to_existing";
    const base = merged ? "Added to an existing report of the same event" : "Report added as a community report, verification in progress";
    toast.show(result.simulated ? `${base}. Demo only, not sent to Verity.` : `${base}.`, "success");
    navigate(`/events/${result.data.event_id}`);
  };

  return (
    <PageLayout title="Report an event" description="Tell your community what's happening. Approximate is fine.">
      {!policy.enabled && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100" role="note">
          <Icon icon={Info} size={16} className="mt-0.5 shrink-0" />
          <span>
            {policy.reason === "service_unconfigured"
              ? "Reporting isn't available because this build isn't connected to a Verity service."
              : "Reporting is off in this demo. You can preview the form, but nothing will be submitted."}
          </span>
        </div>
      )}
      {policy.enabled && policy.requiresSignIn && !session && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" role="note">
          <Icon icon={Info} size={16} className="mt-0.5 shrink-0" />
          <span>You'll be asked to sign in with your email when you submit. Browsing never needs an account.</span>
        </div>
      )}
      {policy.enabled && policy.simulated && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" role="note">
          <Icon icon={Info} size={16} className="mt-0.5 shrink-0" />
          <span>Demo mode: your report stays in this browser tab and isn't sent anywhere.</span>
        </div>
      )}

      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
        <Card>
          <fieldset aria-describedby={errors.category ? "category-error" : undefined}>
            <legend className="text-sm font-semibold">What's happening?</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Category">
              {EVENT_CATEGORIES.map((c) => {
                const display = CATEGORY_DISPLAY[c];
                const checked = category === c;
                return (
                  <label
                    key={c}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition-colors has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[var(--app-focus)]",
                      checked ? "bg-accent/10 font-medium text-fg ring-2 ring-accent" : "ring-line hover:bg-surface-2",
                    )}
                  >
                    <input
                      type="radio"
                      name="category"
                      value={c}
                      checked={checked}
                      onChange={() => setCategory(c)}
                      className="sr-only"
                    />
                    <Icon icon={display.icon} size={16} className="shrink-0 text-muted" />
                    {display.label}
                  </label>
                );
              })}
            </div>
            <FieldError id="category-error" message={errors.category} />
          </fieldset>
        </Card>

        <Card className="space-y-4">
          <div>
            <label htmlFor="report-title" className="text-sm font-semibold">
              Short title
            </label>
            <input
              id="report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={LIMITS.titleMax}
              placeholder="e.g. Road blocked near Mission St & 24th"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? "title-error" : undefined}
              className={cn(inputClass, "h-11")}
            />
            <div className="flex justify-between">
              <FieldError id="title-error" message={errors.title} />
              <span className="mt-1 ml-auto text-xs text-muted">
                {title.length}/{LIMITS.titleMax}
              </span>
            </div>
          </div>
          <div>
            <label htmlFor="report-description" className="text-sm font-semibold">
              Details <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id="report-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={LIMITS.descriptionMax}
              rows={4}
              placeholder="What did you see? Which lanes, how long, anything people should know."
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? "description-error" : undefined}
              className={cn(inputClass, "py-2")}
            />
            <div className="flex justify-between">
              <FieldError id="description-error" message={errors.description} />
              <span className="mt-1 ml-auto text-xs text-muted">
                {description.length}/{LIMITS.descriptionMax}
              </span>
            </div>
          </div>
        </Card>

        {planned && (
          <Card>
            <fieldset aria-describedby="schedule-help">
              <legend className="text-sm font-semibold">
                When is it scheduled? <span className="font-normal text-muted">(optional)</span>
              </legend>
              <p id="schedule-help" className="mt-1 text-xs text-muted">
                If you know the schedule, Verity uses it to find this event. A schedule shows it's planned, not that it's happening.
                {timeZone && ` Times are in your time zone (${timeZone}).`}
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="report-starts" className="text-sm font-medium">
                    Starts
                  </label>
                  <input
                    id="report-starts"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    aria-invalid={Boolean(errors.scheduled_start_at)}
                    aria-describedby={errors.scheduled_start_at ? "starts-error" : undefined}
                    className={cn(inputClass, "h-11")}
                  />
                  <FieldError id="starts-error" message={errors.scheduled_start_at} />
                </div>
                <div>
                  <label htmlFor="report-ends" className="text-sm font-medium">
                    Ends
                  </label>
                  <input
                    id="report-ends"
                    type="datetime-local"
                    value={endsAt}
                    min={startsAt || undefined}
                    onChange={(e) => setEndsAt(e.target.value)}
                    aria-invalid={Boolean(errors.scheduled_end_at)}
                    aria-describedby={errors.scheduled_end_at ? "ends-error" : undefined}
                    className={cn(inputClass, "h-11")}
                  />
                  <FieldError id="ends-error" message={errors.scheduled_end_at} />
                </div>
              </div>
            </fieldset>
          </Card>
        )}

        <Card className="space-y-3">
          <p className="text-sm font-semibold">Where?</p>
          <LocationPicker
            value={coordinates}
            onChange={setCoordinates}
            styleUrl={theme === "dark" ? appConfig.map.styleDark : appConfig.map.styleLight}
            error={errors.location}
          />
          <div>
            <label htmlFor="report-label" className="text-sm font-medium">
              Nearby landmark or cross street <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="report-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={LIMITS.locationLabelMax}
              placeholder="e.g. Mission St & 24th St"
              className={cn(inputClass, "h-11")}
            />
          </div>
        </Card>

        <Card>
          <label htmlFor="report-source" className="text-sm font-semibold">
            Source link <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="report-source"
            type="url"
            inputMode="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            onBlur={() => {
              const v = sourceUrl.trim();
              if (!v) return setErrors((er) => ({ ...er, source_url: undefined }));
              const check = checkPublicHttpUrl(v);
              setErrors((er) => ({ ...er, source_url: check.ok ? undefined : check.reason }));
            }}
            maxLength={LIMITS.sourceUrlMax}
            placeholder="https://"
            aria-invalid={Boolean(errors.source_url)}
            aria-describedby="source-help"
            className={cn(inputClass, "h-11")}
          />
          <FieldError id="source-error" message={errors.source_url} />
          <p id="source-help" className="mt-1 text-xs text-muted">
            A public news article, official page or post. Verity checks it through its verification service, never directly from your
            device.
          </p>
        </Card>

        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
          Your report appears as <span className="font-medium text-fg">"Community report — verification in progress"</span>. It won't be
          shown as verified until independent evidence supports it.
        </div>

        {unknownOutcome && (
          <div
            key={attempt}
            ref={unknownRef}
            role="alert"
            tabIndex={-1}
            className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-950 focus:outline-none dark:bg-amber-400/10 dark:text-amber-100"
          >
            <p className="flex items-start gap-2 font-semibold">
              <Icon icon={CircleHelp} size={16} className="mt-0.5 shrink-0" />
              {UNKNOWN_HEADLINE}
            </p>
            <p className="mt-1">
              {unknownOutcome.reason} {KEPT} Before sending it again, check whether it arrived.
            </p>
            <ArrivalCheck attempt={unknownOutcome.attempt} />
          </div>
        )}

        {errors.form && (
          <p
            key={attempt}
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-800 focus:outline-none dark:bg-red-400/10 dark:text-red-200"
          >
            {errors.form}
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit report"}
        </Button>
      </form>
    </PageLayout>
  );
}
