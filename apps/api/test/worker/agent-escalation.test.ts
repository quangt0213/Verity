import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceRecords } from "../../src/db/schema";
import { sweepAgentResources } from "../../src/worker/escalate";
import type { AgentPoll } from "../../src/worker/ports";
import { evidenceSchema } from "@verity/contracts";
import { processJob } from "../../src/worker/process";
import { createTestContext, type TestContext } from "../helpers";
import {
  agentFound,
  claimFor,
  deps,
  eventRow,
  FakeClock,
  fakeExtractor,
  fakeInvestigator,
  fakeRetriever,
  jobsFor,
  newEvent,
  newsAt,
  officialAt,
  pageRead,
  results,
  runsFor,
  testConfig,
  writtenTime,
} from "./harness";

/**
 * S5C on the real worker (PGlite): when the Agent runs, what it may change,
 * and what it costs. Search → Extract → decide → Agent only if still needed →
 * citations become evidence → decide again.
 */

let ctx: TestContext;
let tokens: string[];
let next = 0;
beforeAll(async () => {
  ctx = await createTestContext();
  tokens = await Promise.all([1, 2, 3].map((n) => ctx.signIn(`escalation-${n}@example.com`)));
});
afterAll(async () => ctx.close());
const reporter = () => tokens[next++ % tokens.length]!;

/** One supporting, located, dated source: DEVELOPING/LIKELY, and the engine asks for more. */
const oneSource = (clock: FakeClock) => fakeRetriever(() => results.found([newsAt(clock, { locationMatch: "near", excerpt: "Lanes are closed on Test St.", publishedAt: clock.ago(5) })]));
const caltrans = (clock: FakeClock) => `https://dot.ca.gov/alerts/esc-${clock.now().getTime()}`;
const stored = (eventId: string) => ctx.db.select().from(sourceRecords).where(and(eq(sourceRecords.eventId, eventId), isNotNull(sourceRecords.sourceUrl)));

describe("when the Agent runs", () => {
  it("does not escalate when Search evidence is already sufficient", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const investigator = fakeInvestigator();
    await processJob(deps(ctx, clock, { retriever: fakeRetriever(() => results.found([officialAt(clock)])), investigator }), await claimFor(ctx, clock, eventId));
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
    expect(investigator.starts).toBe(0);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ agentRunCount: 0, agentRequestedAt: null });
  });

  it("escalates insufficient evidence, and conflicting evidence with its own reason", async () => {
    const clock = new FakeClock();
    const insufficient = await newEvent(ctx, reporter());
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: fakeInvestigator() }), await claimFor(ctx, clock, insufficient));
    expect((await runsFor(ctx, insufficient))[0]).toMatchObject({ agentRunCount: 1, escalationReason: "insufficient_independent" });

    const conflicting = await newEvent(ctx, reporter());
    const both = fakeRetriever(() => results.found([newsAt(clock), newsAt(clock, { stance: "contradicts" })]));
    await processJob(deps(ctx, clock, { retriever: both, investigator: fakeInvestigator() }), await claimFor(ctx, clock, conflicting));
    expect((await runsFor(ctx, conflicting))[0]).toMatchObject({ agentRunCount: 1, escalationReason: "conflicting_sources" });
  });
});

describe("what the Agent may change: citations only, through the deterministic engine", () => {
  it("creates no evidence without citations, whatever the model proposed", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", citations: [], proposals: [{ url: caltrans(clock), publishedAt: clock.ago(5).toISOString(), eventTime: null }] }) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, eventId));
    expect((await stored(eventId)).map((r) => r.sourceUrl)).not.toContain(caltrans(clock));
    expect((await eventRow(ctx, eventId)).status).not.toBe("VERIFIED");
  });

  it("verifies on a cited official page whose excerpt states the time (citation-supported date accepted)", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    const investigator = fakeInvestigator({ poll: () => agentFound([{ url, excerpt: `As of ${writtenTime(clock.ago(5))}, all lanes of Test St are closed.`, published: clock.ago(5) }]) });
    const extractor = fakeExtractor({});
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator, extractor }), await claimFor(ctx, clock, eventId));
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
    const record = (await stored(eventId)).find((r) => r.sourceUrl === url)!;
    expect(record).toMatchObject({ sourceClass: "OFFICIAL", stance: "supports" });
    expect(record.extractionMetadata).toMatchObject({ retrieval_method: "agent", published_at_precision: "instant", classified_by: "rules" });
    // The citation established the date: no page read was needed for it.
    expect(extractor.urls).not.toContain(url);
  });

  it("rejects an unsupported Agent date: the cited page counts only with a time the evidence states", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    const investigator = fakeInvestigator({ poll: () => agentFound([{ url, excerpt: "All lanes of Test St are closed for emergency repairs.", published: clock.ago(5) }]) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, eventId));
    const record = (await stored(eventId)).find((r) => r.sourceUrl === url)!;
    expect(record.publishedAt).toBeNull();
    expect((await eventRow(ctx, eventId)).status).not.toBe("VERIFIED");
  });

  it("reads the cited page (conditional Extract) for a claim the citation doesn't establish, and uses the PAGE's own date", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    const investigator = fakeInvestigator({ poll: () => agentFound([{ url, excerpt: "All lanes of Test St are closed for emergency repairs.", published: clock.ago(5) }]) });
    // The page's own metadata says 7 minutes ago (not the model's "5 minutes ago").
    const extractor = fakeExtractor({ [url]: pageRead(url, "All lanes of Test St are closed for emergency repairs, Caltrans said.", clock.ago(7)) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator, extractor }), await claimFor(ctx, clock, eventId));
    expect(extractor.urls.filter((u) => u === url)).toHaveLength(1);
    const record = (await stored(eventId)).find((r) => r.sourceUrl === url)!;
    expect(record.publishedAt!.toISOString()).toBe(clock.ago(7).toISOString());
    expect(record.extractionMetadata).toMatchObject({ retrieval_steps: ["agent", "extract"] });
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
    expect((await runsFor(ctx, eventId))[0]!.extractCount).toBe(extractor.urls.length);
  });

  it("can't promote a source: a provider-labelled 'official, primary' unknown site stays UNKNOWN and can't verify", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = `https://totally-official-${clock.now().getTime()}.example/notice`;
    const investigator = fakeInvestigator({ poll: () => agentFound([{ url, excerpt: `OFFICIAL NOTICE ${writtenTime(clock.ago(5))}: all lanes of Test St are closed.`, published: clock.ago(5) }]) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, eventId));
    expect((await stored(eventId)).find((r) => r.sourceUrl === url)).toMatchObject({ sourceClass: "UNKNOWN", isPrimary: false });
    expect((await eventRow(ctx, eventId)).status).not.toBe("VERIFIED");
  });
});

describe("citations without verbatim text (as the live low-effort run returned)", () => {
  const textless = (url: string): AgentPoll => ({ status: "completed", citations: [{ url, title: "Test St closure", excerpts: [], providerCategory: "official", providerSourceType: "primary" }], proposals: [] });

  it("store nothing for a text-less citation unless the page itself is read", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: fakeInvestigator({ poll: () => textless(url) }) }), await claimFor(ctx, clock, eventId));
    expect((await stored(eventId)).map((r) => r.sourceUrl)).not.toContain(url);
  });

  it("reads the cited page within the extraction ceiling, and builds evidence only from the page's own words and metadata", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    const extractor = fakeExtractor({ [url]: pageRead(url, "All lanes of Test St are closed for emergency repairs.", clock.ago(8)) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: fakeInvestigator({ poll: () => textless(url) }), extractor }), await claimFor(ctx, clock, eventId));
    const record = (await stored(eventId)).find((r) => r.sourceUrl === url)!;
    expect(record).toMatchObject({ quote: "All lanes of Test St are closed for emergency repairs.", sourceClass: "OFFICIAL", stance: "supports" });
    expect(record.publishedAt!.toISOString()).toBe(clock.ago(8).toISOString());
    expect(record.extractionMetadata).toMatchObject({ retrieval_steps: ["agent", "extract"] });
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
  });

  it("exposes only the contract's evidence fields through the API, with provenance in plain terms", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    const extractor = fakeExtractor({ [url]: pageRead(url, "All lanes of Test St are closed for emergency repairs.", clock.ago(8)) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: fakeInvestigator({ poll: () => textless(url) }), extractor }), await claimFor(ctx, clock, eventId));
    const res = await ctx.request({ method: "GET", url: `/api/v1/events/${eventId}/evidence` });
    const { evidence } = res.json() as { evidence: Array<Record<string, unknown>> };
    const allowed = Object.keys(evidenceSchema.shape).sort();
    for (const e of evidence) expect(Object.keys(e).sort()).toEqual(allowed);
    const byVia = Object.fromEntries(evidence.map((e) => [e.source_url ?? "community", e.found_via]));
    expect(byVia[url]).toBe("extended_verification");
    expect(byVia.community).toBe("community_report");
    expect(Object.values(byVia)).toContain("web_search");
    // No provider identifiers, raw metadata, page bodies, model text or reporter identity.
    const body = JSON.stringify(evidence);
    expect(body).not.toMatch(/task_run|task_fake|agent_\d|extract_ref|extraction_metadata|final_url|retrieval_steps|provider|escalation-\d@example\.com|reporter_id|user_id/);
    expect(evidence.find((e) => e.source_url === url)).toMatchObject({ agent_note: null, published_at_precision: "instant", source_class: "OFFICIAL" });
  });

  it("never exceeds the job's extraction ceiling for cited pages", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const urls = [1, 2, 3, 4, 5, 6].map((n) => `https://cited-${n}-${clock.now().getTime()}.example/page`);
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", citations: urls.map((url) => ({ url, title: null, excerpts: [], providerCategory: null, providerSourceType: null })), proposals: [] }) });
    const extractor = fakeExtractor({});
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator, extractor }), await claimFor(ctx, clock, eventId));
    expect(extractor.urls.length).toBeLessThanOrEqual(4);
    expect((await runsFor(ctx, eventId))[0]!.extractCount).toBe(extractor.urls.length);
  });
});

describe("the Extract ceiling is shared with the Agent stage", () => {
  it("does not read URL-only Agent citations when pre-Agent extraction used all 4 slots, and records why", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const searchUrls = [1, 2, 3, 4, 5].map((n) => `https://paper-${n}-${clock.now().getTime()}.example/story`);
    const retriever = fakeRetriever(() =>
      results.found(searchUrls.map((url, i) => newsAt(clock, { canonicalUrl: url, publisherDomain: null, excerpt: null, stance: "context", locationMatch: "exact", publishedAt: null, publishedAtPrecision: null, title: `Story ${i}` }))),
    );
    const pages = Object.fromEntries(searchUrls.map((url, i) => [url, pageRead(url, `Report ${i}: lanes of Test St remain closed, witness ${i} said near block ${i * 17}.`, clock.ago(5 + i))]));
    const agentUrl = caltrans(clock);
    const extractor = fakeExtractor(pages);
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", citations: [{ url: agentUrl, title: "Test St", excerpts: [], providerCategory: "official", providerSourceType: "primary" }], proposals: [] }) });
    await processJob(deps(ctx, clock, { retriever, investigator, extractor }), await claimFor(ctx, clock, eventId));
    expect(investigator.starts).toBe(1);
    expect(extractor.urls).toHaveLength(4);
    expect(extractor.urls).not.toContain(agentUrl);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ extractCount: 4, agentRunCount: 1, errorCode: "agent_citations_unread_ceiling" });
    expect((await stored(eventId)).map((r) => r.sourceUrl)).not.toContain(agentUrl);
  });
});

describe("run lifecycle: reuse, fail closed, cleanup", () => {
  it("saves the run with its agent resource, and polls that same run on a retry", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const slow = fakeInvestigator({ poll: () => ({ status: "running" }) });
    expect(await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: slow }), await claimFor(ctx, clock, eventId))).toBe("retry_scheduled");
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ agentRunId: "task_run_1", agentId: "agent_1", agentCleanedUpAt: null });

    const [job] = await jobsFor(ctx, eventId);
    clock.advance(job!.availableAt.getTime() - clock.now().getTime() + 1000);
    const done = fakeInvestigator();
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: done }), await claimFor(ctx, clock, eventId));
    expect(done.starts).toBe(0);
    expect(done.refs[0]).toEqual({ runId: "task_run_1", agentId: "agent_1" });
  });

  it("cleans up the agent resource after the run, and a cleanup failure never changes the verdict", async () => {
    const clock = new FakeClock();
    const ok = await newEvent(ctx, reporter());
    const cleaned = fakeInvestigator();
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: cleaned }), await claimFor(ctx, clock, ok));
    expect(cleaned.cleanups).toBe(1);
    expect((await runsFor(ctx, ok))[0]!.agentCleanedUpAt).not.toBeNull();

    const broken = await newEvent(ctx, reporter());
    const failing = fakeInvestigator({ cleanup: () => "failed" });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: failing }), await claimFor(ctx, clock, broken));
    expect(failing.cleanups).toBe(1);
    expect((await eventRow(ctx, broken)).status).toBe((await eventRow(ctx, ok)).status);
    expect((await runsFor(ctx, broken))[0]).toMatchObject({ agentCleanedUpAt: null, agentId: "agent_1" });

    // The sweep retries leftover cleanups later (free calls), and only for finished runs.
    expect(await sweepAgentResources(ctx.db, fakeInvestigator(), clock.now)).toBeGreaterThanOrEqual(1);
    expect((await runsFor(ctx, broken))[0]!.agentCleanedUpAt).not.toBeNull();
  });

  it("attempts cleanup after a failed run too", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const investigator = fakeInvestigator({ poll: () => ({ status: "failed", errorCode: "agent_failed" }) });
    await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, eventId));
    expect(investigator.cleanups).toBe(1);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ errorCode: "agent_failed", agentRunCount: 1 });
  });

  it("keeps the agent budget from erasing the Search/Extract decision", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const investigator = fakeInvestigator();
    await processJob(deps(ctx, clock, { config: testConfig({ dailyAgentBudget: 0 }), retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, eventId));
    expect(investigator.starts).toBe(0);
    expect(["DEVELOPING", "LIKELY"]).toContain((await eventRow(ctx, eventId)).status);
  });
});

describe("cost counters", () => {
  it("counts searches, extractions and the single agent run accurately", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = caltrans(clock);
    const searchUrl = "https://outlet-cost.example/test-st";
    const retriever = fakeRetriever(() => results.found([newsAt(clock, { canonicalUrl: searchUrl, locationMatch: "near", excerpt: "Lanes closed on Test St.", publishedAt: null, publishedAtPrecision: null })]));
    const extractor = fakeExtractor({
      [searchUrl]: pageRead(searchUrl, "Lanes are closed on Test St near the bridge.", clock.ago(6)),
      [url]: pageRead(url, "All lanes of Test St are closed.", clock.ago(4)),
    });
    const investigator = fakeInvestigator({ poll: () => agentFound([{ url, excerpt: "All lanes of Test St are closed.", published: clock.ago(4) }]) });
    await processJob(deps(ctx, clock, { retriever, investigator, extractor }), await claimFor(ctx, clock, eventId));
    expect(extractor.urls).toEqual([searchUrl, url]);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ searchCount: 2, extractCount: 2, agentRunCount: 1 });
  });
});
