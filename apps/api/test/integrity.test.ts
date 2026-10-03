import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { communitySignals, eventStateTransitions, events, eventTimeline, sourceRecords } from "../src/db/schema";
import { checkTransition } from "../src/domain/state-machine";
import { TransitionError, transitionEvent } from "../src/domain/transitions";
import { createTestContext, INTERNAL_TOKEN, validReport, type TestContext } from "./helpers";

let ctx: TestContext;
let eventId: string;
let userId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  const token = await ctx.signIn("integrity@example.com");
  userId = await ctx.userIdFor(token);
  eventId = (await ctx.request({ method: "POST", url: "/api/v1/reports", token, payload: validReport })).json().event_id;
});
afterAll(async () => ctx.close());

describe("state machine (pure rules)", () => {
  it("allows evidence-driven edges and blocks invalid ones", () => {
    expect(checkTransition("UNVERIFIED", "DEVELOPING", "verifier")).toEqual({ ok: true });
    expect(checkTransition("STALE", "VERIFIED", "verifier")).toEqual({ ok: true });
    expect(checkTransition("RESOLVED", "VERIFIED", "admin").ok).toBe(false);
    expect(checkTransition("REJECTED", "VERIFIED", "admin").ok).toBe(false);
    expect(checkTransition("VERIFIED", "VERIFIED", "admin").ok).toBe(false);
  });

  it("never lets community input change status", () => {
    for (const to of ["DEVELOPING", "LIKELY", "VERIFIED", "RESOLVED", "REJECTED"] as const) {
      expect(checkTransition("UNVERIFIED", to, "community").ok, to).toBe(false);
    }
    expect(checkTransition("UNVERIFIED", "VERIFIED", "system").ok).toBe(false);
    expect(checkTransition("VERIFIED", "STALE", "system").ok).toBe(true);
  });
});

describe("transition service", () => {
  it("applies a valid transition and audits it with a timeline entry", async () => {
    const result = await ctx.db.transaction((tx) =>
      transitionEvent(tx, { eventId, to: "DEVELOPING", reason: "Test: independent source found", actor: { type: "admin", userId } }),
    );
    expect(result).toEqual({ from: "UNVERIFIED", to: "DEVELOPING" });

    const audit = await ctx.db.select().from(eventStateTransitions).where(eq(eventStateTransitions.eventId, eventId));
    expect(audit.map((a) => [a.fromStatus, a.toStatus, a.actorType])).toEqual([
      [null, "UNVERIFIED", "community"],
      ["UNVERIFIED", "DEVELOPING", "admin"],
    ]);
    const timeline = await ctx.db.select().from(eventTimeline).where(eq(eventTimeline.eventId, eventId));
    expect(timeline.at(-1)).toMatchObject({ kind: "status_changed", fromStatus: "UNVERIFIED", toStatus: "DEVELOPING" });
  });

  it("rejects invalid transitions and stale expectations", async () => {
    await expect(
      ctx.db.transaction((tx) => transitionEvent(tx, { eventId, to: "VERIFIED", reason: "crowd", actor: { type: "community" } })),
    ).rejects.toBeInstanceOf(TransitionError);
    await expect(
      ctx.db.transaction((tx) =>
        transitionEvent(tx, { eventId, to: "LIKELY", reason: "x", actor: { type: "admin" }, expectedFrom: "UNVERIFIED" }),
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    const [row] = await ctx.db.select({ status: events.status }).from(events).where(eq(events.id, eventId));
    expect(row!.status).toBe("DEVELOPING");
  });

  it("is exposed to operators only through the internal endpoint", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/internal/v1/events/${eventId}/transition`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { to: "REJECTED", reason: "Test: invalid report", expected_from: "DEVELOPING" },
    });
    expect(res.statusCode).toBe(200);
    const invalid = await ctx.app.inject({
      method: "POST",
      url: `/internal/v1/events/${eventId}/transition`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { to: "VERIFIED", reason: "Test: not allowed from REJECTED" },
    });
    expect(invalid.statusCode).toBe(409);
  });
});

describe("database constraints", () => {
  const baseEvent = {
    title: "Constraint probe",
    category: "crash",
    latitude: 37.7,
    longitude: -122.4,
    approximateLocation: "Somewhere",
    origin: "community_report",
  };

  it("enforce enums and ranges independently of application code", async () => {
    await expect(ctx.db.insert(events).values({ ...baseEvent, category: "ufo" })).rejects.toThrow();
    await expect(ctx.db.insert(events).values({ ...baseEvent, latitude: 91 })).rejects.toThrow();
    await expect(ctx.db.insert(events).values({ ...baseEvent, longitude: -181 })).rejects.toThrow();
    await expect(ctx.db.insert(events).values({ ...baseEvent, title: "" })).rejects.toThrow();
    await expect(ctx.db.insert(events).values({ ...baseEvent, verificationState: "done" })).rejects.toThrow();
  });

  it("only allow new events to start UNVERIFIED", async () => {
    await expect(ctx.db.insert(events).values({ ...baseEvent, status: "VERIFIED" })).rejects.toThrow();
    const [ok] = await ctx.db.insert(events).values(baseEvent).returning({ status: events.status });
    expect(ok!.status).toBe("UNVERIFIED");
  });

  it("block status changes that bypass the transition service", async () => {
    await expect(ctx.db.update(events).set({ status: "VERIFIED" }).where(eq(events.id, eventId))).rejects.toThrow();
  });

  it("make history append-only", async () => {
    await expect(ctx.db.update(eventTimeline).set({ label: "rewritten" }).where(eq(eventTimeline.eventId, eventId))).rejects.toThrow();
    await expect(ctx.db.delete(eventTimeline).where(eq(eventTimeline.eventId, eventId))).rejects.toThrow();
    await expect(ctx.db.delete(eventStateTransitions).where(eq(eventStateTransitions.eventId, eventId))).rejects.toThrow();
    await expect(ctx.db.delete(events).where(eq(events.id, eventId))).rejects.toThrow();
  });

  it("keep one active answer per person and question, with consistent groups", async () => {
    await ctx.db.insert(communitySignals).values({ eventId, userId, type: "CONFIRM", signalGroup: "validity" }).catch(() => undefined);
    await expect(
      ctx.db.insert(communitySignals).values({ eventId, userId, type: "DISPUTE", signalGroup: "validity" }),
    ).rejects.toThrow();
    await expect(
      ctx.db.insert(communitySignals).values({ eventId, userId, type: "CONFIRM", signalGroup: "current_state" }),
    ).rejects.toThrow();
  });

  it("allow only one independent record per evidence lineage", async () => {
    const record = {
      eventId,
      sourceType: "news_article",
      sourceName: "Probe",
      stance: "supports",
      sourceClass: "LOCAL_NEWS",
      isPrimary: false,
      lineageId: "probe-lineage",
    };
    await ctx.db.insert(sourceRecords).values({ ...record, countsAsIndependent: true });
    await expect(ctx.db.insert(sourceRecords).values({ ...record, countsAsIndependent: true })).rejects.toThrow();
    await ctx.db.insert(sourceRecords).values({ ...record, countsAsIndependent: false });
  });

  it("reject non-http source URLs at the database level", async () => {
    await expect(
      ctx.db.execute(
        sql`insert into source_records (event_id, source_type, source_name, stance, source_class, is_primary, lineage_id, counts_as_independent, source_url)
            values (${eventId}, 'web_page', 'x', 'supports', 'UNKNOWN', false, 'l2', false, 'javascript:alert(1)')`,
      ),
    ).rejects.toThrow();
  });
});
