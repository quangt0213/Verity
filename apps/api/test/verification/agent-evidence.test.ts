import { describe, expect, it } from "vitest";
import { agentEvidence, establishTime, findExplicitDates, type AgentCitationInput, type AgentProposalInput } from "../../src/verification/agent-evidence";
import { buildSearchContext, type SearchPlace } from "../../src/verification/geocoding";
import { agentGate } from "../../src/worker/escalate";
import { NOW, communityReport, run } from "./factories";

/**
 * S5C: the Agent investigates, citations become evidence, the deterministic
 * engine decides. Agent output alone is never authoritative for dates, source
 * class, stance or state.
 */

const PLACE: SearchPlace = { street: "Mission Street", neighborhood: "Mission District", city: "San Francisco", region: "California", countryCode: "US", provider: "test", retrievedAt: NOW };
const context = buildSearchContext({ category: "power_outage", title: "Power out on Mission St", approximateLocation: "Mission St & 22nd St", reportLocationLabels: [] }, PLACE);
const URL_ = "https://news.example/outage";

const cite = (excerpt: string | string[], over: Partial<AgentCitationInput> = {}): AgentCitationInput => ({ url: URL_, title: "Outage update", excerpts: Array.isArray(excerpt) ? excerpt : [excerpt], ...over });
const propose = (over: Partial<AgentProposalInput> = {}): AgentProposalInput => ({ url: URL_, publishedAt: null, eventTime: null, ...over });
const evidence = (citations: AgentCitationInput[], proposals: AgentProposalInput[] = []) => agentEvidence({ citations, proposals, category: "power_outage", context, now: NOW, runId: "task_run_1" });

describe("evidence comes only from citations", () => {
  it("no citation, no evidence: a proposal alone (the model's own answer) creates nothing", () => {
    const out = evidence([], [propose({ publishedAt: "2026-10-03T09:00:00Z" })]);
    expect(out.evidence).toEqual([]);
  });

  it("a citation without verbatim text supports nothing; its page is only offered for reading", () => {
    expect(evidence([cite([])]).evidence).toEqual([]);
    const out = evidence([cite([" "])]);
    expect(out.stats.withoutExcerpt).toBe(1);
    expect(out.excerptless).toEqual([{ url: URL_, title: "Outage update" }]);
  });

  it("rejects unsafe or invalid citation URLs", () => {
    const out = evidence([cite("Power is out on Mission St at 22nd St.", { url: "http://localhost/x" }), cite("Power is out.", { url: "javascript:alert(1)" })]);
    expect(out.evidence).toEqual([]);
    expect(out.stats.rejectedUrls).toBe(2);
  });

  it("groups citations of one page into ONE record with the verbatim excerpt and rules-based stance", () => {
    const out = evidence([cite("Thousands are without power on Mission St near 22nd St."), cite("Crews are working on the outage.", { url: `${URL_}?utm_source=agent` })]);
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]).toMatchObject({
      canonicalUrl: URL_,
      excerpt: "Thousands are without power on Mission St near 22nd St.",
      stance: "supports",
      locationMatch: "exact",
      sourceClass: "UNKNOWN",
      retrievalMethod: "agent",
      retrievalSteps: ["agent"],
      classifiedBy: "rules",
      providerRequestId: "task_run_1",
      note: null,
    });
  });

  it("the Agent can't promote a source: class and 'primary' come only from the registry", () => {
    // The provider called it "official" and "primary"; Verity doesn't care.
    const unknown = evidence([cite("OFFICIAL: power is out on Mission St at 22nd St.", { url: "https://totally-official-utility.example/notice" })]).evidence[0]!;
    expect(unknown).toMatchObject({ sourceClass: "UNKNOWN", isPrimary: false, sourceType: "web_page" });
    const pge = evidence([cite("Power is out on Mission St at 22nd St.", { url: "https://www.pge.com/outages/123" })]).evidence[0]!;
    expect(pge).toMatchObject({ sourceClass: "FIRST_PARTY", isPrimary: true, publisher: "PG&E" });
  });

  it("stance is the conservative classifier's, on the excerpt: hedged or rumored text is context", () => {
    expect(evidence([cite("Rumors that power may be out on Mission St could not be confirmed.")]).evidence[0]!.stance).toBe("context");
    expect(evidence([cite("Power was restored on Mission St at 22nd St.")]).evidence[0]!.stance).toBe("ended");
  });
});

describe("Agent date policy: model dates are never evidence by themselves", () => {
  it("rejects a proposed date the cited excerpt doesn't contain, and reports it for a possible page read", () => {
    const out = evidence([cite("Thousands are without power on Mission St near 22nd St.")], [propose({ publishedAt: "2026-10-03T09:00:00Z", eventTime: "2026-10-03T08:42:00Z" })]);
    expect(out.evidence[0]).toMatchObject({ publishedAt: null, publishedAtPrecision: null, eventTimeAsReported: null, eventTimePrecision: null });
    expect(out.unsupported).toEqual([
      { url: URL_, field: "published", proposed: "2026-10-03T09:00:00Z" },
      { url: URL_, field: "event_time", proposed: "2026-10-03T08:42:00Z" },
    ]);
    expect(out.stats).toMatchObject({ proposedTimes: 2, acceptedTimes: 0 });
  });

  it("accepts a date the excerpt states, with the EXCERPT's precision (a written date alone is a day)", () => {
    const out = evidence([cite("Published October 3, 2026: thousands are without power on Mission St.")], [propose({ publishedAt: "2026-10-03T09:00:00Z" })]);
    expect(out.evidence[0]).toMatchObject({ publishedAt: new Date("2026-10-03T00:00:00Z"), publishedAtPrecision: "day" });
    expect(out.unsupported).toEqual([]);
  });

  it("accepts an exact time only when the excerpt states date, time AND zone", () => {
    const out = evidence([cite("At 3:42 a.m. PDT on Oct. 3, 2026, power failed across Mission St near 22nd St.")], [propose({ eventTime: "2026-10-03T10:42:00Z" })]);
    expect(out.evidence[0]).toMatchObject({ eventTimeAsReported: new Date("2026-10-03T10:42:00Z"), eventTimePrecision: "instant" });
  });

  it("a clock time with no date in the excerpt establishes no absolute time", () => {
    const out = evidence([cite("At 3:42 p.m., power failed across Mission St near 22nd St.")], [propose({ eventTime: "2026-10-02T22:42:00Z" })]);
    expect(out.evidence[0]!.eventTimeAsReported).toBeNull();
    expect(out.unsupported).toEqual([{ url: URL_, field: "event_time", proposed: "2026-10-02T22:42:00Z" }]);
  });

  it("rejects a proposal that contradicts the excerpt's date, and unparseable proposals", () => {
    const text = "Published September 12, 2026: power out on Mission St.";
    expect(evidence([cite(text)], [propose({ publishedAt: "2026-10-03" })]).evidence[0]!.publishedAt).toBeNull();
    expect(evidence([cite(text)], [propose({ publishedAt: "yesterday afternoon" })]).evidence[0]!.publishedAt).toBeNull();
  });

  it("never turns a schema-valid but unsupported date into evidence, even when the excerpt has OTHER dates", () => {
    const out = evidence([cite("Crews said on October 1, 2026 that repairs on Mission St would take a week.")], [propose({ eventTime: "2026-10-03T08:00:00Z" })]);
    expect(out.evidence[0]!.eventTimeAsReported).toBeNull();
  });
});

describe("explicit dates in text", () => {
  it.each([
    ["Oct. 3, 2026", "2026-10-03T00:00:00.000Z", "day"],
    ["October 3rd, 2026", "2026-10-03T00:00:00.000Z", "day"],
    ["3 October 2026", "2026-10-03T00:00:00.000Z", "day"],
    ["2026-10-03", "2026-10-03T00:00:00.000Z", "day"],
    ["Oct. 3, 2026 at 7:15 a.m. EDT", "2026-10-03T11:15:00.000Z", "instant"],
    ["2026-10-03T09:15:00Z", "2026-10-03T09:15:00.000Z", "instant"],
  ])("%s", (text, iso, precision) => {
    expect(findExplicitDates(`Updated ${text}.`, NOW)).toEqual([{ at: new Date(iso), precision }]);
  });

  it("ignores ambiguous numeric dates, relative phrases, bare years and future dates", () => {
    for (const text of ["10/03/2026", "3/10/2026", "two hours ago", "in 2026", "Oct. 9, 2026", "February 30, 2026"]) expect(findExplicitDates(text, NOW)).toEqual([]);
  });

  it("establishTime returns the text's value, never the proposal's", () => {
    expect(establishTime("2026-10-03T08:00:00Z", ["Posted Oct. 3, 2026."], NOW)).toEqual({ at: new Date("2026-10-03T00:00:00Z"), precision: "day" });
    expect(establishTime("2026-10-03T09:00:00Z", ["No date here."], NOW)).toBeNull();
  });
});

describe("the Agent can't set state, and cheap options come first", () => {
  it("many agent-cited UNKNOWN sources still can't reach VERIFIED", () => {
    const citations = [1, 2, 3, 4].map((n) => cite(`Published October 3, 2026: power is out on Mission St at 22nd St, resident ${n} said.`, { url: `https://site-${n}.example/outage` }));
    const proposals = citations.map((c) => propose({ url: c.url, publishedAt: "2026-10-03" }));
    const out = evidence(citations, proposals);
    const d = run("UNVERIFIED", [communityReport(), ...out.evidence], { event: { category: "construction", firstSeenAt: new Date("2026-10-02T12:00:00Z") } });
    expect(d.target).not.toBe("VERIFIED");
  });

  it("starts an investigation only when the decision asks for one and cheaper options are used up", () => {
    const base = { escalation: "insufficient_independent" as const, searchable: true, enabled: true };
    expect(agentGate({ ...base, enrichmentStop: "exhausted" })).toEqual({ start: true, heldCode: null });
    expect(agentGate({ ...base, enrichmentStop: "ceiling" })).toEqual({ start: true, heldCode: null });
    expect(agentGate({ ...base, enrichmentStop: "disabled" })).toEqual({ start: true, heldCode: null });
    expect(agentGate({ ...base, enrichmentStop: "blocked" })).toEqual({ start: false, heldCode: "agent_held_extract_blocked" });
    expect(agentGate({ ...base, escalation: null, enrichmentStop: "decided" })).toEqual({ start: false, heldCode: null });
    expect(agentGate({ ...base, enabled: false, enrichmentStop: "exhausted" }).start).toBe(false);
    expect(agentGate({ ...base, searchable: false, enrichmentStop: "exhausted" }).start).toBe(false);
  });
});
