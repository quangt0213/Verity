import { eq, sql } from "drizzle-orm";
import { events, verificationJobs, verificationRuns } from "../../src/db/schema";
import type { NormalizedEvidence } from "../../src/verification/evidence";
import { loadWorkerConfig, type WorkerConfig } from "../../src/worker/config";
import { claimJobs, type Lease } from "../../src/worker/jobs";
import { unconfiguredExtractor, type AgentInvestigator, type AgentPoll, type AgentStart, type EvidenceRetriever, type RetrievalResult } from "../../src/worker/ports";
import type { WorkerDeps, WorkerLog } from "../../src/worker/process";
import type { TestContext } from "../helpers";

export class FakeClock {
  private t: number;
  constructor(start = Date.now() + 5_000) {
    this.t = start;
  }
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  minutes(m: number) {
    this.advance(m * 60_000);
  }
  ago(minutes: number) {
    return new Date(this.t - minutes * 60_000);
  }
}

export const silentLog: WorkerLog = { info: () => {}, warn: () => {}, error: () => {} };

export function testConfig(nimble: Partial<WorkerConfig["nimble"]> = {}, rest: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = loadWorkerConfig({ NODE_ENV: "test", NIMBLE_API_KEY: "fake-key-for-tests" });
  return { ...base, ...rest, nimble: { ...base.nimble, ...nimble } };
}

export type RetrieverScript = (call: number) => RetrievalResult | Promise<RetrievalResult>;

export function fakeRetriever(script: RetrieverScript): EvidenceRetriever & { calls: number } {
  const retriever = {
    name: "fake",
    configured: true,
    calls: 0,
    search: async () => script(++retriever.calls),
  };
  return retriever;
}

export const results = {
  found: (evidence: NormalizedEvidence[]): RetrievalResult => ({ status: "ok", evidence, searchCount: 2, errorCode: null, retryAfterSeconds: null }),
  none: (): RetrievalResult => ({ status: "no_results", evidence: [], searchCount: 3, errorCode: null, retryAfterSeconds: null }),
  unavailable: (errorCode = "provider_5xx"): RetrievalResult => ({ status: "unavailable", evidence: [], searchCount: 1, errorCode, retryAfterSeconds: null }),
  permanent: (errorCode = "provider_rejected"): RetrievalResult => ({ status: "permanent_error", evidence: [], searchCount: 0, errorCode, retryAfterSeconds: null }),
};

export function fakeInvestigator(options: {
  start?: () => AgentStart | Promise<AgentStart>;
  poll?: (call: number) => AgentPoll | Promise<AgentPoll>;
} = {}): AgentInvestigator & { starts: number; polls: number; efforts: string[] } {
  const investigator = {
    name: "fake-agent",
    configured: true,
    starts: 0,
    polls: 0,
    efforts: [] as string[],
    start: async (request: { effort: string }) => {
      investigator.starts += 1;
      investigator.efforts.push(request.effort);
      return options.start ? options.start() : ({ status: "started", runId: `task_run_${investigator.starts}` } as const);
    },
    poll: async () => {
      investigator.polls += 1;
      return options.poll ? options.poll(investigator.polls) : ({ status: "completed", evidence: [] } as const);
    },
  };
  return investigator as AgentInvestigator & typeof investigator;
}

export function deps(ctx: TestContext, clock: FakeClock, over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: ctx.db,
    config: testConfig(),
    retriever: fakeRetriever(() => results.none()),
    extractor: unconfiguredExtractor,
    investigator: fakeInvestigator(),
    geocoder: null,
    now: clock.now,
    random: () => 0.5,
    // Agent polling "sleeps" by advancing the fake clock.
    sleep: async (ms) => clock.advance(ms),
    log: silentLog,
    ...over,
  };
}

let place = 0;
/** File a community report at a fresh location (so tests never dedupe into each other's events). */
export async function newEvent(ctx: TestContext, token: string, over: { title?: string; category?: string; label?: string } = {}): Promise<string> {
  place += 1;
  const res = await ctx.request({
    method: "POST",
    url: "/api/v1/reports",
    token,
    remoteAddress: `10.200.${(place >> 8) & 255}.${place & 255}`,
    payload: {
      category: over.category ?? "road_closure",
      title: over.title ?? `Road blocked near test site ${place}`,
      description: "Two lanes closed, police directing traffic.",
      location: { coordinates: { latitude: 30 + place * 0.05, longitude: -100 - place * 0.05 }, label: over.label ?? `Test St & ${place}th Ave` },
    },
  });
  if (res.statusCode !== 201) throw new Error(`report failed: ${res.statusCode} ${res.body}`);
  return res.json().event_id as string;
}

/** Claim the (only) ready job for an event. */
export async function claimFor(ctx: TestContext, clock: FakeClock, eventId: string, workerId = "w_test"): Promise<Lease> {
  // Make only this event's job ready, so concurrently created jobs don't interfere.
  await ctx.db.execute(sql`update verification_jobs set available_at = ${clock.now()} where event_id = ${eventId} and status = 'pending' and available_at <= ${clock.now()}`);
  const leases = await claimJobs(ctx.db, { workerId, limit: 50, now: clock.now() });
  const lease = leases.find((l) => l.eventId === eventId);
  // Release unrelated claims back to pending.
  for (const other of leases.filter((l) => l.eventId !== eventId)) {
    await ctx.db.update(verificationJobs).set({ status: "pending", attempts: other.attempt - 1, lockedBy: null, lockedAt: null }).where(eq(verificationJobs.id, other.jobId));
  }
  if (!lease) throw new Error("no claimable job for event");
  return lease;
}

export async function eventRow(ctx: TestContext, eventId: string) {
  const [row] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  return row!;
}

export async function jobsFor(ctx: TestContext, eventId: string) {
  return ctx.db.select().from(verificationJobs).where(eq(verificationJobs.eventId, eventId)).orderBy(verificationJobs.createdAt);
}

export async function runsFor(ctx: TestContext, eventId: string) {
  return ctx.db.select().from(verificationRuns).where(eq(verificationRuns.eventId, eventId)).orderBy(verificationRuns.startedAt);
}

let sourceCounter = 0;
/** A supporting, exactly located news record published a few minutes before `clock`. */
export function newsAt(clock: FakeClock, over: Partial<NormalizedEvidence> = {}): NormalizedEvidence {
  sourceCounter += 1;
  return {
    id: null,
    canonicalUrl: `https://outlet-${sourceCounter}.example/story-${sourceCounter}`,
    originalUrl: null,
    publisherDomain: `outlet-${sourceCounter}.example`,
    publisher: `Outlet ${sourceCounter}`,
    sourceName: `Outlet ${sourceCounter}`,
    sourceType: "news_article",
    sourceClass: "LOCAL_NEWS",
    title: null,
    eventTimeAsReported: null,
    eventTimePrecision: null,
    publishedAt: clock.ago(5),
    publishedAtPrecision: "instant",
    retrievedAt: clock.now(),
    excerpt: null,
    note: null,
    stance: "supports",
    locationMatch: "exact",
    isPrimary: false,
    attributions: [],
    originRef: null,
    retrievalMethod: "search",
    retrievalSteps: ["search"],
    finalUrl: null,
    extractRef: null,
    classifiedBy: "rules",
    query: null,
    providerRequestId: null,
    ...over,
  };
}

export function officialAt(clock: FakeClock, over: Partial<NormalizedEvidence> = {}): NormalizedEvidence {
  return newsAt(clock, {
    canonicalUrl: `https://dot.ca.gov/alerts/${++sourceCounter}`,
    publisher: "Caltrans",
    sourceName: "Caltrans",
    sourceType: "official_feed",
    sourceClass: "OFFICIAL",
    isPrimary: true,
    ...over,
  });
}
