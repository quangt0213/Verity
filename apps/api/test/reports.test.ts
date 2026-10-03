import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, eventStateTransitions, reports, sourceRecords, verificationJobs } from "../src/db/schema";
import { createReport } from "../src/domain/reports";
import { createTestContext, validReport, type TestContext } from "./helpers";

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("reporter@example.com");
});
afterAll(async () => ctx.close());

const post = (payload: unknown, t: string = token) => ctx.request({ method: "POST", url: "/api/v1/reports", token: t, payload: payload as object });

describe("creating a report", () => {
  it("persists the report and creates an UNVERIFIED canonical event with history and a verification job", async () => {
    const res = await post({ ...validReport, source_url: "https://www.sfchronicle.com/bayarea/article/x.php" });
    expect(res.statusCode).toBe(201);
    const { event_id, report_id, outcome } = res.json();
    expect(outcome).toBe("created");

    const [report] = await ctx.db.select().from(reports).where(eq(reports.id, report_id));
    expect(report).toMatchObject({ eventId: event_id, title: validReport.title, sourceUrl: "https://www.sfchronicle.com/bayarea/article/x.php" });

    const detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${event_id}` })).json();
    expect(detail).toMatchObject({
      status: "UNVERIFIED",
      origin: "community_report",
      verification_state: "queued",
      source_count: 1,
      independent_source_count: 1,
      is_demo: false,
    });
    expect(detail.timeline.map((t: { kind: string }) => t.kind)).toEqual(["report_received"]);
    expect(detail.evidence[0]).toMatchObject({ source_type: "community_report", source_url: null, source_class: "COMMUNITY" });

    const jobs = await ctx.db.select().from(verificationJobs).where(eq(verificationJobs.eventId, event_id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "VERIFY_EVENT", reason: "NEW_REPORT", status: "pending" });

    const audit = await ctx.db.select().from(eventStateTransitions).where(eq(eventStateTransitions.eventId, event_id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ fromStatus: null, toStatus: "UNVERIFIED", actorType: "community" });
  });

  it("never exposes the reporter's identity, email or submitted link publicly", async () => {
    const res = await post({ ...validReport, title: "Fallen tree blocking Folsom St", source_url: "https://example.org/private-link", location: { coordinates: { latitude: 37.771, longitude: -122.41 } } });
    const body = (await ctx.request({ method: "GET", url: `/api/v1/events/${res.json().event_id}` })).body;
    const userId = await ctx.userIdFor(token);
    expect(body).not.toContain(userId);
    expect(body).not.toContain("reporter@example.com");
    expect(body).not.toContain("private-link");
    expect(body).not.toMatch(/created_by|reporter|user_id|email|ip_address/);
  });

  it("attaches a near-identical nearby report to the existing event instead of duplicating it", async () => {
    const other = await ctx.signIn("second-reporter@example.com");
    const first = await post({
      ...validReport,
      title: "Water main break flooding Valencia St",
      category: "flooding",
      description: "Water gushing from the street at Valencia and 18th",
      location: { coordinates: { latitude: 37.7615, longitude: -122.4215 } },
    });
    const second = await post(
      {
        ...validReport,
        title: "Valencia St flooding from water main",
        category: "flooding",
        description: "Street flooded near 18th and Valencia",
        location: { coordinates: { latitude: 37.7617, longitude: -122.4213 } },
      },
      other,
    );
    expect(second.json()).toMatchObject({ outcome: "attached_to_existing", event_id: first.json().event_id });

    const detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${first.json().event_id}` })).json();
    // Many community reports are one independent lineage.
    expect(detail.source_count).toBe(2);
    expect(detail.independent_source_count).toBe(1);
    expect(detail.timeline.map((t: { kind: string }) => t.kind)).toEqual(["report_received", "report_merged"]);
    // Still at most one open verification job for the event.
    const open = await ctx.db
      .select()
      .from(verificationJobs)
      .where(and(eq(verificationJobs.eventId, first.json().event_id), eq(verificationJobs.status, "pending")));
    expect(open).toHaveLength(1);
  });

  it("keeps different situations separate", async () => {
    const a = await post({ ...validReport, title: "Car crash on Geary Blvd", category: "crash", location: { coordinates: { latitude: 37.781, longitude: -122.444 } } });
    const farAway = await post({ ...validReport, title: "Car crash on Geary Blvd", category: "crash", location: { coordinates: { latitude: 37.79, longitude: -122.444 } } });
    const differentKind = await post({ ...validReport, title: "Concert crowd on Geary Blvd", category: "concert", location: { coordinates: { latitude: 37.781, longitude: -122.444 } } });
    expect(farAway.json().event_id).not.toBe(a.json().event_id);
    expect(differentKind.json().event_id).not.toBe(a.json().event_id);
  });
});

describe("report validation", () => {
  it.each([
    ["latitude out of range", { ...validReport, location: { coordinates: { latitude: 91, longitude: 0 } } }],
    ["longitude out of range", { ...validReport, location: { coordinates: { latitude: 0, longitude: -190 } } }],
    ["string coordinates", { ...validReport, location: { coordinates: { latitude: "37", longitude: "-122" } } }],
    ["oversized description", { ...validReport, description: "x".repeat(1001) }],
    ["malformed URL", { ...validReport, source_url: "not a url" }],
    ["javascript URL", { ...validReport, source_url: "javascript:alert(1)" }],
    ["private network URL", { ...validReport, source_url: "http://169.254.169.254/latest/meta-data" }],
    ["unknown category", { ...validReport, category: "ufo" }],
    ["client-chosen status", { ...validReport, status: "VERIFIED" }],
    ["future observation time", { ...validReport, observed_at: new Date(Date.now() + 3600_000).toISOString() }],
    ["missing title", { ...validReport, title: undefined }],
  ])("rejects %s", async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("rejects oversized bodies and non-JSON content", async () => {
    const huge = await ctx.request({
      method: "POST",
      url: "/api/v1/reports",
      token,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...validReport, description: "x".repeat(20_000) }),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error.code).toBe("payload_too_large");

    const form = await ctx.request({
      method: "POST",
      url: "/api/v1/reports",
      token,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "title=hello",
    });
    expect(form.statusCode).toBe(415);
  });

  it("rate-limits report creation per account", async () => {
    const busy = await ctx.signIn("busy-reporter@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await post(
        { ...validReport, title: `Distinct report number ${i}`, location: { coordinates: { latitude: 37.70 + i * 0.01, longitude: -122.5 } } },
        busy,
      );
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("transactions", () => {
  it("rolls back every write when any step of report creation fails", async () => {
    const before = {
      events: (await ctx.db.select().from(events)).length,
      reports: (await ctx.db.select().from(reports)).length,
      jobs: (await ctx.db.select().from(verificationJobs)).length,
      sources: (await ctx.db.select().from(sourceRecords)).length,
    };
    const userId = await ctx.userIdFor(token);
    // Passes the event's constraints but violates the report's label length
    // constraint, so the failure happens after the event row is written.
    await expect(
      createReport(ctx.db, userId, {
        category: "crash",
        title: "Rollback probe crash",
        location: { coordinates: { latitude: 37.73, longitude: -122.47 }, label: "y".repeat(150) },
      }),
    ).rejects.toThrow();
    expect((await ctx.db.select().from(events)).length).toBe(before.events);
    expect((await ctx.db.select().from(reports)).length).toBe(before.reports);
    expect((await ctx.db.select().from(verificationJobs)).length).toBe(before.jobs);
    expect((await ctx.db.select().from(sourceRecords)).length).toBe(before.sources);
  });
});
