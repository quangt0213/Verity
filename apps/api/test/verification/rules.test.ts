import { describe, expect, it } from "vitest";
import { detectAttributions } from "../../src/verification/attribution";
import { RULE_IDS, RULES, type Decision } from "../../src/verification/rules";
import { communityReport, hoursAgo, minutesAgo, minutesFromNow, news, official, run } from "./factories";

const BANNED = /%|probab|confiden|\bprove|\bproof|certain|guarantee/i;

function expectHonestExplanation(d: Decision) {
  expect(d.explanation.length).toBeGreaterThan(0);
  expect(d.explanation.length).toBeLessThanOrEqual(1000);
  expect(d.explanation).not.toMatch(BANNED);
}

describe("decision rule table", () => {
  it("covers every rule id once and always ends with a rule that applies", () => {
    expect(RULES.map((r) => r.id)).toEqual([...RULE_IDS]);
    expect(RULES.at(-1)!.target).toBe("NO_CHANGE");
  });
});

describe("decide: invariants", () => {
  it("F: community support alone never produces VERIFIED, however many reports and confirmations", () => {
    const reports = Array.from({ length: 12 }, () => communityReport());
    const d = run("UNVERIFIED", reports, { community: { confirmations: 40, stillHappening: 25 } });
    expect(d.target).toBeNull();
    expect(d.ruleId).toBe("no_qualifying_evidence");
    expect(d.facts.communitySupport).toBe(true);
    expect(d.explanation).toMatch(/community reports only/i);
    expectHonestExplanation(d);
  });

  it("G: zero external evidence can never produce REJECTED", () => {
    for (const status of ["UNVERIFIED", "DEVELOPING"] as const) {
      for (const retrieval of ["ok", "no_results", "unavailable"] as const) {
        const d = run(status, [communityReport()], { retrieval, community: { disputes: 9, noLongerHappening: 9 } });
        expect(d.target, `${status}/${retrieval}`).toBeNull();
        expect(d.ruleId).toBe("no_qualifying_evidence");
      }
    }
  });

  it("H: no results, timeouts and outages are not evidence: the verdict is identical", () => {
    const evidence = [communityReport(), news()];
    const outcomes = (["ok", "no_results", "unavailable", "not_attempted"] as const).map((retrieval) => run("UNVERIFIED", evidence, { retrieval }));
    expect(new Set(outcomes.map((d) => `${d.target}:${d.ruleId}`)).size).toBe(1);
    expect(outcomes[2]!.explanation).toMatch(/couldn't be checked this time; nothing new was inferred/);
    expect(outcomes[1]!.explanation).toMatch(/found no new sources/);
  });

  it("I: a primary official contradiction with no support rejects an unconfirmed event (the explicit REJECTED rule)", () => {
    const d = run("UNVERIFIED", [communityReport(), official({ stance: "contradicts" })]);
    expect(d).toMatchObject({ target: "REJECTED", ruleId: "rejected_primary_contradiction", actor: "verifier" });
    expect(d.evidenceIds).toHaveLength(1);
    expectHonestExplanation(d);
  });

  it("does not reject on non-official contradiction; it asks for more evidence instead", () => {
    const d = run("UNVERIFIED", [communityReport(), news({ stance: "contradicts" }), news({ stance: "contradicts" })]);
    expect(d.target).toBeNull();
    expect(d.escalation).toBe("contradiction_without_support");
  });

  it("makes a previously supported event CONFLICTING, not REJECTED, when an official source contradicts it", () => {
    const d = run("VERIFIED", [official({ stance: "contradicts" })]);
    expect(d).toMatchObject({ target: "CONFLICTING", ruleId: "conflicting_primary_contradiction" });
  });

  it("J: a verified event reconfirmed by fresh evidence returns reconfirmed without a transition", () => {
    const d = run("VERIFIED", [communityReport(), official()]);
    expect(d).toMatchObject({ target: null, ruleId: "verified_primary_source", guard: "already_in_state", reconfirmed: true, actor: null });
    expect(d.evidenceIds.length).toBeGreaterThan(0);
  });

  it("does not count aging evidence as fresh reconfirmation", () => {
    const d = run("VERIFIED", [official({ publishedAt: hoursAgo(10) })], { event: { firstSeenAt: hoursAgo(11) } });
    expect(d).toMatchObject({ target: null, ruleId: "verified_primary_source", reconfirmed: false });
  });
});

describe("decide: independence counts lineages, not URLs or publishers", () => {
  it("verifies on two independent, located sources", () => {
    const d = run("UNVERIFIED", [communityReport(), news(), news({ locationMatch: "near" })]);
    expect(d).toMatchObject({ target: "VERIFIED", ruleId: "verified_independent_sources" });
  });

  it("does not verify on many URLs of one syndicated story", () => {
    const wire = () => news({ attributions: detectAttributions("SAN FRANCISCO (AP) — Lanes closed") });
    const d = run("UNVERIFIED", [communityReport(), wire(), wire(), wire(), wire()]);
    expect(d.facts.support).toHaveLength(1);
    expect(d).toMatchObject({ target: "LIKELY", ruleId: "likely_multiple_lineages" });
    expect(d.explanation).toMatch(/1 independent source|independent sources \(/);
  });

  it("does not verify on many publishers repeating one attributed origin", () => {
    const repeat = (publisher: string) => news({ publisher, attributions: detectAttributions("according to the Associated Press") });
    const d = run("UNVERIFIED", [repeat("NBC"), repeat("ABC"), repeat("CBS")]);
    expect(d.facts.support).toHaveLength(1);
    expect(d.target).toBe("DEVELOPING");
  });
});

describe("decide: relevance", () => {
  it("ignores evidence about a different location", () => {
    const d = run("UNVERIFIED", [communityReport(), official({ locationMatch: "mismatch" }), news({ locationMatch: "mismatch" })]);
    expect(d.target).toBeNull();
  });

  it("asks for help when sources may describe this event but the location is unclear", () => {
    const d = run("UNVERIFIED", [communityReport(), news({ locationMatch: "unclear" })]);
    expect(d).toMatchObject({ target: null, escalation: "location_unclear" });
  });

  it("ignores evidence about an earlier incident (time mismatch)", () => {
    const d = run("UNVERIFIED", [communityReport(), official({ publishedAt: hoursAgo(20) })], { event: { category: "crash" } });
    expect(d.target).toBeNull();
  });

  it("does not let stale evidence confirm anything, and moves aged-out events to STALE", () => {
    const old = official({ publishedAt: hoursAgo(30) });
    expect(run("UNVERIFIED", [communityReport(), old], { event: { firstSeenAt: hoursAgo(31) } }).target).toBeNull();
    const d = run("VERIFIED", [communityReport(), old], { event: { firstSeenAt: hoursAgo(31) } });
    expect(d).toMatchObject({ target: "STALE", ruleId: "stale_support_aged_out", actor: "system" });
    expectHonestExplanation(d);
  });

  it("does not keep an event verified on fresh community reports once external support aged out", () => {
    const d = run("VERIFIED", [communityReport({ publishedAt: minutesAgo(5) }), official({ publishedAt: hoursAgo(30) })], { event: { firstSeenAt: hoursAgo(31) } });
    expect(d.target).toBe("STALE");
  });
});

describe("decide: state changes", () => {
  it("climbs DEVELOPING → LIKELY → VERIFIED as independent evidence arrives", () => {
    expect(run("UNVERIFIED", [news()]).target).toBe("DEVELOPING");
    expect(run("UNVERIFIED", [communityReport(), news({ locationMatch: "near" })]).target).toBe("LIKELY");
    expect(run("LIKELY", [communityReport(), news({ locationMatch: "near" }), official()]).target).toBe("VERIFIED");
  });

  it("marks disagreement as CONFLICTING and asks for an investigation", () => {
    const d = run("LIKELY", [communityReport(), news(), news({ stance: "contradicts" })]);
    expect(d).toMatchObject({ target: "CONFLICTING", ruleId: "conflicting_sources", escalation: "conflicting_sources" });
  });

  it("resolves on a newer official 'ended' report, but not on an older one", () => {
    const ended = run("VERIFIED", [official({ publishedAt: minutesAgo(40) }), official({ stance: "ended", publishedAt: minutesAgo(5) })]);
    expect(ended).toMatchObject({ target: "RESOLVED", ruleId: "resolved_primary_end" });

    const resumed = run("VERIFIED", [official({ stance: "ended", publishedAt: minutesAgo(40) }), official({ publishedAt: minutesAgo(5) })]);
    expect(resumed.target).toBeNull();
    expect(resumed.reconfirmed).toBe(true);
  });

  it("resolves on two independent 'ended' reports", () => {
    const d = run("VERIFIED", [news({ stance: "ended" }), news({ stance: "ended" })]);
    expect(d).toMatchObject({ target: "RESOLVED", ruleId: "resolved_independent_end" });
  });

  it("never steps a verified event down because one source aged; it waits for STALE", () => {
    const d = run("VERIFIED", [communityReport(), news({ locationMatch: "near" })]);
    expect(d).toMatchObject({ target: null, guard: "no_downgrade", ruleId: "likely_multiple_lineages" });
  });

  it("reopens an ended event as DEVELOPING when fresh support appears (never straight to VERIFIED)", () => {
    expect(run("RESOLVED", [official()])).toMatchObject({ target: "DEVELOPING", guard: "reopened", ruleTarget: "VERIFIED" });
    expect(run("REJECTED", [official()])).toMatchObject({ target: "DEVELOPING", guard: "reopened" });
  });

  it("resolves a scheduled event once its end time has passed", () => {
    const d = run("VERIFIED", [official()], {
      event: { category: "concert", scheduledStartAt: hoursAgo(5), scheduledEndAt: hoursAgo(3), firstSeenAt: hoursAgo(6) },
    });
    expect(d).toMatchObject({ target: "RESOLVED", ruleId: "resolved_schedule_ended", actor: "system" });
  });

  it("verifies a scheduled event before it starts on a current announcement", () => {
    const d = run("UNVERIFIED", [official({ publishedAt: hoursAgo(48) })], {
      event: { category: "festival", scheduledStartAt: minutesFromNow(60), scheduledEndAt: minutesFromNow(600), firstSeenAt: minutesAgo(30) },
    });
    expect(d.target).toBe("VERIFIED");
  });
});

describe("explanations", () => {
  it("are deterministic, bounded, honest and never quote sources", () => {
    const quote = "VERBATIM: lanes closed at the 23rd street intersection until further notice";
    const scenarios = [
      run("UNVERIFIED", [communityReport(), news({ excerpt: quote }), news()]),
      run("UNVERIFIED", [communityReport()], { community: { disputes: 2 } }),
      run("VERIFIED", [official({ publishedAt: hoursAgo(30) })], { event: { firstSeenAt: hoursAgo(31) } }),
      run("LIKELY", [news(), news({ stance: "contradicts" })]),
      run("UNVERIFIED", [official({ stance: "contradicts", sourceName: "X".repeat(500), publisher: null })]),
    ];
    for (const d of scenarios) {
      expectHonestExplanation(d);
      expect(d.explanation).not.toContain("VERBATIM");
    }
    expect(scenarios[1]!.explanation).toMatch(/2 people dispute this; disputes prompt a re-check/);
    const again = run("UNVERIFIED", [communityReport(), news({ excerpt: quote }), news()]);
    expect(again.explanation.replace(/Outlet \w+/g, "")).toBe(scenarios[0]!.explanation.replace(/Outlet \w+/g, ""));
  });
});
