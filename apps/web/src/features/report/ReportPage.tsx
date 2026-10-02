import {
  checkPublicHttpUrl,
  EVENT_CATEGORIES,
  LIMITS,
  reportEventInputSchema,
  type Coordinates,
  type EventCategory,
} from "@verity/contracts";
import { Info } from "lucide";
import { useState, type FormEvent } from "react";
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
import { LocationPicker } from "./LocationPicker";

type FieldErrors = Partial<Record<"category" | "title" | "description" | "location" | "source_url" | "form", string>>;

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
  const [coordinates, setCoordinates] = useState<Coordinates>(approximateCoordinates(startCenter));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const policy = api.writePolicy;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const payload = {
      category: category ?? undefined,
      title,
      ...(description.trim() ? { description } : {}),
      location: { coordinates: approximateCoordinates(coordinates), ...(label.trim() ? { label } : {}) },
      ...(sourceUrl.trim() ? { source_url: sourceUrl.trim() } : {}),
    };

    // Same schema the service uses; the service re-validates everything.
    const parsed = reportEventInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form") as keyof FieldErrors;
        next[key] ??= key === "category" ? "Choose a category" : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    const result = await api.reportEvent(payload as Parameters<typeof api.reportEvent>[0]);
    setSubmitting(false);

    if (!result.ok) {
      if (result.error.fields) {
        const next: FieldErrors = {};
        for (const [key, message] of Object.entries(result.error.fields)) {
          next[(key.split(".")[0] ?? "form") as keyof FieldErrors] ??= message;
        }
        setErrors(next);
      } else {
        setErrors({ form: result.error.message });
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
              : "Reporting isn't available yet: Verity can't verify accounts, so reports can't be accepted. You can preview the form, but nothing will be submitted."}
          </span>
        </div>
      )}
      {policy.enabled && policy.simulated && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" role="note">
          <Icon icon={Info} size={16} className="mt-0.5 shrink-0" />
          <span>Demo mode: your report stays in this browser tab and isn't sent anywhere.</span>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-4">
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

        {errors.form && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:bg-red-400/10 dark:text-red-200">
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
