import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  communitySignals,
  eventStateTransitions,
  events,
  eventTimeline,
  geocodeCache,
  sourceRecords,
  verificationJobs,
  verificationRuns,
} from "../src/db/schema";
import { checkTransition } from "../src/domain/state-machine";
import { TransitionError, transitionEvent } from "../src/domain/transitions";
import { createTestContext, INTERNAL_TOKEN, validReport, type TestContext } from "./helpers";

/** The violated constraint's name, from the driver error anywhere in the cause chain. */
function violatedConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("constraint" in current && typeof current.constraint === "string") return current.constraint;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function expectViolation(query: PromiseLike<unknown>, constraint: string) {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${constraint} to be violated`).toBeDefined();
  expect(violatedConstraint(caught)).toBe(constraint);
}

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
    expect(result).toMatchObject({ from: "UNVERIFIED", to: "DEVELOPING" });
    expect(result.transitionId).toMatch(/^[0-9a-f-]{36}$/);

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
    // The HTTP response stays exactly { from, to }: internal ids never leak.
    expect(res.json()).toEqual({ from: "DEVELOPING", to: "REJECTED" });
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

  it("keep one record per canonical source URL per event", async () => {
    const record = {
      sourceType: "news_article",
      sourceName: "Canonical probe",
      stance: "supports",
      sourceClass: "LOCAL_NEWS",
      isPrimary: false,
      countsAsIndependent: false,
    };
    // source_url holds the canonical URL; tracking-parameter variants are
    // normalized to this before they reach the database.
    const canonical = "https://news.example/story";
    await ctx.db.insert(sourceRecords).values({ ...record, eventId, lineageId: "pub:news.example", sourceUrl: canonical });
    await expectViolation(
      ctx.db.insert(sourceRecords).values({ ...record, eventId, lineageId: "pub:other", sourceUrl: canonical }),
      "source_records_one_per_url",
    );

    // The same resource may be evidence for a different event.
    const [other] = await ctx.db
      .insert(events)
      .values({ title: "Other event", category: "crash", latitude: 37.71, longitude: -122.41, approximateLocation: "Elsewhere", origin: "community_report" })
      .returning({ id: events.id });
    await ctx.db.insert(sourceRecords).values({ ...record, eventId: other!.id, lineageId: "pub:news.example", sourceUrl: canonical });

    // Records without a URL (community reports) are unaffected.
    await ctx.db.insert(sourceRecords).values({ ...record, eventId, lineageId: "community", sourceType: "community_report", sourceClass: "COMMUNITY" });
    await ctx.db.insert(sourceRecords).values({ ...record, eventId, lineageId: "community", sourceType: "community_report", sourceClass: "COMMUNITY" });
  });

  it("accept RECHECK verification jobs and reject unknown reasons", async () => {
    const job = { kind: "VERIFY_EVENT", eventId, status: "succeeded" };
    await ctx.db.insert(verificationJobs).values({ ...job, reason: "RECHECK", idempotencyKey: "recheck:probe:1" });
    await expectViolation(
      ctx.db.insert(verificationJobs).values({ ...job, reason: "BOGUS", idempotencyKey: "recheck:probe:2" }),
      "verification_jobs_reason_valid",
    );
  });

  it("keep one verification run per job with a consistent lifecycle and agent claim", async () => {
    const newJob = async (key: string) => {
      const [job] = await ctx.db
        .insert(verificationJobs)
        .values({ kind: "VERIFY_EVENT", eventId, reason: "MANUAL", status: "succeeded", idempotencyKey: key })
        .returning({ id: verificationJobs.id });
      return job!.id;
    };

    const jobId = await newJob("run-probe:1");
    const [run] = await ctx.db.insert(verificationRuns).values({ jobId, eventId }).returning();
    expect(run).toMatchObject({ outcome: "running", searchCount: 0, agentRunCount: 0, agentRequestedAt: null, evidenceIds: [] });
    // One logical run per job: a retry resumes it, never starts another.
    await expectViolation(ctx.db.insert(verificationRuns).values({ jobId, eventId }), "verification_runs_one_per_job");

    const other = await newJob("run-probe:2");
    // Open outcomes have no completion time; final outcomes must have one.
    await expectViolation(ctx.db.insert(verificationRuns).values({ jobId: other, eventId, outcome: "no_change" }), "verification_runs_completion_consistent");
    await expectViolation(
      // Clearly after started_at (the database's now()), so ONLY the lifecycle rule is violated:
      // a JS timestamp a millisecond earlier would also trip completed_after_start, which Postgres reports first.
      ctx.db.insert(verificationRuns).values({ jobId: other, eventId, outcome: "running", completedAt: new Date(Date.now() + 60 * 60_000) }),
      "verification_runs_completion_consistent",
    );
    // An agent run id can only exist after the slot was claimed, and a run holds at most one agent.
    await expectViolation(ctx.db.insert(verificationRuns).values({ jobId: other, eventId, agentRunId: "task_run_x" }), "verification_runs_agent_id_requires_claim");
    await expectViolation(ctx.db.insert(verificationRuns).values({ jobId: other, eventId, agentRunCount: 1 }), "verification_runs_agent_claim_consistent");
    await expectViolation(
      ctx.db.insert(verificationRuns).values({ jobId: other, eventId, agentRunCount: 2 }),
      "verification_runs_agent_count_range",
    );

    // The agent slot is claimed with a conditional update that only one caller can win.
    const claim = () =>
      ctx.db
        .update(verificationRuns)
        .set({ agentRunCount: 1, agentRequestedAt: sql`now()` })
        .where(sql`${verificationRuns.id} = ${run!.id} and ${verificationRuns.agentRequestedAt} is null`)
        .returning({ id: verificationRuns.id });
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);

    // Evidence ids round-trip, and finishing requires a completion time.
    const evidenceId = "00000000-0000-4000-8000-0000000000aa";
    const [done] = await ctx.db
      .update(verificationRuns)
      .set({ outcome: "no_change", completedAt: new Date(), decisionRuleId: "no_change", evidenceIds: [evidenceId] })
      .where(eq(verificationRuns.id, run!.id))
      .returning();
    expect(done!.evidenceIds).toEqual([evidenceId]);
  });

  it("keep the geocode cache to derived place data with valid cells, statuses and lifetimes", async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 86_400_000);
    const row = { provider: "probe", cellKey: "37.760,-122.419", status: "ok", city: "San Francisco", retrievedAt: now, expiresAt: later };
    await ctx.db.insert(geocodeCache).values(row);
    await expectViolation(ctx.db.insert(geocodeCache).values({ ...row, status: "error", city: null, cellKey: "1.000,1.000" }), "geocode_cache_status_valid");
    await expectViolation(ctx.db.insert(geocodeCache).values({ ...row, status: "no_result", cellKey: "1.000,2.000" }), "geocode_cache_no_result_empty");
    await expectViolation(ctx.db.insert(geocodeCache).values({ ...row, cellKey: "37.76012,-122.41891" }), "geocode_cache_cell_key_format");
    await expectViolation(ctx.db.insert(geocodeCache).values({ ...row, cellKey: "2.000,2.000", countryCode: "usa" }), "geocode_cache_country_code_format");
    await expectViolation(ctx.db.insert(geocodeCache).values({ ...row, cellKey: "3.000,3.000", expiresAt: now }), "geocode_cache_expiry_after_retrieval");
    await expectViolation(ctx.db.insert(geocodeCache).values(row), "geocode_cache_provider_cell_key_pk");
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
