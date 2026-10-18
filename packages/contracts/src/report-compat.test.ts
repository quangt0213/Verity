import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reportEventInputSchema } from "./api";
import { eventCategorySchema } from "./category";
import { coordinatesSchema } from "./geo";
import { LIMITS } from "./limits";
import { multilineText, singleLineText } from "./text";
import { isoDateTime } from "./time";
import { publicHttpUrlSchema } from "./url";

/**
 * Compatibility of report submission across releases. The running service
 * (cc44449) validates reports with the schema frozen below: the same strict
 * object, without the scheduled_* keys. Its parseInput maps every Zod issue to
 * `fields[path.join(".") || "_"]`, with "Unexpected field" for unknown keys
 * (apps/api/src/security/errors.ts, unchanged since then).
 */
const MAX_OBSERVED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const v1ReportSchema = z.strictObject({
  category: eventCategorySchema,
  title: singleLineText(LIMITS.titleMin, LIMITS.titleMax),
  description: multilineText(LIMITS.descriptionMax).optional(),
  location: z.strictObject({
    coordinates: coordinatesSchema,
    label: singleLineText(1, LIMITS.locationLabelMax).optional(),
  }),
  source_url: publicHttpUrlSchema.optional(),
  observed_at: isoDateTime
    .refine((v) => Date.parse(v) <= Date.now() + MAX_CLOCK_SKEW_MS, { message: "Can't be in the future" })
    .refine((v) => Date.parse(v) >= Date.now() - MAX_OBSERVED_AGE_MS, { message: "Must be within the last 7 days" })
    .optional(),
});

/** The service's error `fields` for a payload, as parseInput builds them. */
function serviceFields(schema: z.ZodType, payload: unknown): Record<string, string> | null {
  const result = schema.safeParse(payload);
  if (result.success) return null;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fields[issue.path.join(".") || "_"] ??= issue.code === "unrecognized_keys" ? "Unexpected field" : issue.message.slice(0, 200);
  }
  return fields;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const basic = {
  category: "concert",
  title: "Outdoor concert in the park",
  location: { coordinates: { latitude: 37.77, longitude: -122.42 } },
};
const withSchedule = { ...basic, scheduled_start_at: inDays(2), scheduled_end_at: inDays(2.1) };

describe("report compatibility: new frontend, running service (v1 schema)", () => {
  it("a report with a schedule is rejected as an unknown top-level key", () => {
    expect(serviceFields(v1ReportSchema, withSchedule)).toEqual({ _: "Unexpected field" });
    expect(serviceFields(v1ReportSchema, { ...basic, scheduled_start_at: inDays(2) })).toEqual({ _: "Unexpected field" });
  });

  it("a report without a schedule is accepted, as long as the keys are absent", () => {
    expect(serviceFields(v1ReportSchema, basic)).toBeNull();
    // A key that is present at all is rejected, even as null; undefined disappears in JSON.
    expect(serviceFields(v1ReportSchema, { ...basic, scheduled_start_at: null })).toEqual({ _: "Unexpected field" });
    expect(serviceFields(v1ReportSchema, JSON.parse(JSON.stringify({ ...basic, scheduled_start_at: undefined })))).toBeNull();
  });
});

describe("report compatibility: current schema", () => {
  it("accepts what the old frontend sends (it never sends a schedule)", () => {
    const oldFrontend = { ...basic, category: "road_closure", description: "Both lanes", source_url: "https://news.example.com/a", location: { ...basic.location, label: "Main St" } };
    expect(serviceFields(reportEventInputSchema, oldFrontend)).toBeNull();
  });

  it("accepts the new frontend's report with and without a schedule", () => {
    expect(serviceFields(reportEventInputSchema, basic)).toBeNull();
    expect(serviceFields(reportEventInputSchema, withSchedule)).toBeNull();
  });
});
