import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, reports, reportSchedules } from "../src/db/schema";
import { createNimbleRetriever } from "../src/providers/nimble/retriever";
import { sweepAging } from "../src/worker/sweep";
import { processJob } from "../src/worker/process";
import { createTestContext, type TestContext } from "./helpers";
import { json, mockFetch, nimbleResult } from "./providers/mock-fetch";
import { claimFor, deps, eventRow, FakeClock, fakeInvestigator } from "./worker/harness";

/**
 * A3: a reporter may give the schedule of a planned event. It is a CLAIM on
 * the report (report_schedules, migration 0006), never the event's
 * established schedule (events.scheduled_*), so it can't move the event's
 * status; the worker uses it only to search for and recognize the event.
 */

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("schedule-reporter@example.com");
});
afterAll(async () => ctx.close());

const HOUR = 3600_000;
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR).toISOString();
let spot = 0;
const festival = (over: Record<string, unknown> = {}) => {
  spot += 1;
  return {
    category: "festival",
    title: `Harvest Lantern Fair ${spot}`,
    description: "Lanterns and music in the square.",
    location: { coordinates: { latitude: 36 + spot * 0.05, longitude: -119 - spot * 0.05 }, label: "Courthouse Square, Fresno, CA" },
    scheduled_start_at: at(24),
    scheduled_end_at: at(30),
    ...over,
  };
};
const post = (payload: unknown, t = token) => ctx.request({ method: "POST", url: "/api/v1/reports", token: t, payload: payload as object });

describe("reporting a schedule", () => {
  it("stores the claim on the report and leaves the event's established schedule empty", async () => {
    const payload = festival();
    const res = await post(payload);
    expect(res.statusCode).toBe(201);
    const { event_id, report_id } = res.json();
    const [claim] = await ctx.db.select().from(reportSchedules).where(eq(reportSchedules.reportId, report_id));
    expect(claim!.scheduledStartAt.toISOString()).toBe(payload.scheduled_start_at);
    expect(claim!.scheduledEndAt!.toISOString()).toBe(payload.scheduled_end_at);
    const event = await eventRow(ctx, event_id);
    expect(event).toMatchObject({ scheduledStartAt: null, scheduledEndAt: null, status: "UNVERIFIED" });
    const detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${event_id}` })).json();
    expect(detail).toMatchObject({ scheduled_start_at: null, scheduled_end_at: null });
  });

  it("an attached report never overwrites anything on the event", async () => {
    const first = festival();
    const created = (await post(first)).json();
    const other = await ctx.signIn("schedule-second@example.com");
    const attached = await post({ ...first, scheduled_start_at: at(2), scheduled_end_at: at(3) }, other);
    expect(attached.json()).toMatchObject({ outcome: "attached_to_existing", event_id: created.event_id });
    expect(await eventRow(ctx, created.event_id)).toMatchObject({ scheduledStartAt: null, scheduledEndAt: null });
    const claims = await ctx.db
      .select({ start: reportSchedules.scheduledStartAt })
      .from(reportSchedules)
      .innerJoin(reports, eq(reports.id, reportSchedules.reportId))
      .where(eq(reports.eventId, created.event_id));
    expect(claims).toHaveLength(2);
  });

  it("is optional, and accepted only for planned categories, in order and within limits", async () => {
    const { scheduled_start_at: _s, scheduled_end_at: _e, ...noSchedule } = festival();
    const plain = await post(noSchedule);
    expect(plain.statusCode).toBe(201);
    expect(await ctx.db.select().from(reportSchedules).where(eq(reportSchedules.reportId, plain.json().report_id))).toEqual([]);
    const fields = async (payload: unknown) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      return res.json().error.fields as Record<string, string>;
    };
    expect(await fields({ ...festival(), category: "road_closure" })).toMatchObject({ scheduled_start_at: "Only for planned events" });
    expect(await fields(festival({ scheduled_end_at: at(20) }))).toMatchObject({ scheduled_end_at: "Must be after the start" });
    expect(await fields(festival({ scheduled_start_at: undefined }))).toMatchObject({ scheduled_start_at: "Add a start time first" });
    expect(await fields(festival({ scheduled_start_at: at(24 * 400), scheduled_end_at: undefined }))).toHaveProperty("scheduled_start_at");
    expect(await fields(festival({ scheduled_start_at: "next Saturday" }))).toHaveProperty("scheduled_start_at");
  });

  it("is backed by database constraints", async () => {
    const res = (await post(festival())).json();
    const reject = (statement: ReturnType<typeof sql>) => expect(ctx.db.execute(statement)).rejects.toThrow();
    await reject(sql`update report_schedules set scheduled_end_at = scheduled_start_at - interval '1 hour' where report_id = ${res.report_id}`);
    await reject(sql`update report_schedules set scheduled_start_at = null where report_id = ${res.report_id}`);
    await reject(sql`insert into report_schedules (report_id, scheduled_start_at) values (${res.report_id}, now())`); // one claim per report
  });
});

describe("the worker treats a claimed schedule as a hint only", () => {
  it("searches around the claimed month, and the claim never ends the event", async () => {
    const clock = new FakeClock();
    const payload = festival({ scheduled_start_at: at(1), scheduled_end_at: at(2) });
    const eventId = (await post(payload)).json().event_id as string;
    const mock = mockFetch(() => json({ results: [] }));
    const retriever = createNimbleRetriever({ apiKey: "fake-nimble-key-0123", baseUrl: "https://sdk.nimbleway.com", now: clock.now, fetch: mock.fetch });
    await processJob(deps(ctx, clock, { retriever, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));

    const start = new Date(payload.scheduled_start_at as string);
    const month = start.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    expect(mock.calls[0]!.body).toMatchObject({ query: `"Harvest Lantern" Courthouse Square Fresno ${month} ${start.getUTCFullYear()}` });
    expect(mock.calls[0]!.body!.start_date).toBe(new Date(start.getTime() - 14 * 24 * HOUR).toISOString().slice(0, 10));
    expect(JSON.stringify(mock.calls.map((c) => c.body))).not.toMatch(/schedule-reporter|@example/);

    // Long after the claimed end, the aging sweep still has no established end: no "schedule ended" resolution.
    const swept = await sweepAging(ctx.db, { now: new Date(Date.now() + 48 * HOUR) });
    expect(swept.find((s) => s.eventId === eventId)).toBeUndefined();
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");
  });

  it("an explicit date outside every claimed window marks a source as another occurrence", async () => {
    const clock = new FakeClock();
    const payload = festival({ title: "Harvest Lantern Fair", scheduled_start_at: at(24), scheduled_end_at: at(30) });
    const eventId = (await post(payload)).json().event_id as string;
    const other = new Date(Date.now() + 90 * 24 * HOUR);
    const written = other.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const mock = mockFetch(() =>
      json({
        results: [
          nimbleResult({
            url: "https://fresno-events.example/lantern",
            title: "Harvest Lantern Fair",
            content: `The Harvest Lantern Fair fills Courthouse Square in Fresno on ${written}.`,
            additional_data: { publish_date: clock.ago(20).toISOString() },
          }),
        ],
      }),
    );
    const retriever = createNimbleRetriever({ apiKey: "fake-nimble-key-0123", baseUrl: "https://sdk.nimbleway.com", now: clock.now, fetch: mock.fetch });
    await processJob(deps(ctx, clock, { retriever, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    const rows = await ctx.db.execute(sql`select stance, extraction_metadata->>'identity' as identity from source_records where event_id = ${eventId} and source_url is not null`);
    const [row] = (Array.isArray(rows) ? rows : (rows as unknown as { rows: unknown[] }).rows) as Array<{ stance: string; identity: string }>;
    expect(row).toMatchObject({ stance: "context", identity: "mismatch" });
    expect((await ctx.db.select().from(events).where(eq(events.id, eventId)))[0]!.status).toBe("UNVERIFIED");
  });
});
