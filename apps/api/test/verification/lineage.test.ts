import { describe, expect, it } from "vitest";
import { detectAttributions, normalizeOrigin } from "../../src/verification/attribution";
import { LINEAGE_REASONS, type EvidenceRecord } from "../../src/verification/evidence";
import { assignLineages, COMMUNITY_LINEAGE_ID } from "../../src/verification/lineage";
import { communityReport, minutesAgo, news, official } from "./factories";

const lineagesOf = (records: EvidenceRecord[]) => new Set(records.map((r) => r.lineage.lineageId));
const independent = (records: EvidenceRecord[]) => records.filter((r) => r.lineage.countsAsIndependent);

// Long, distinct texts so near-duplicate detection can't accidentally relate them.
const CLOSURE_A =
  "Northbound lanes of Mission Street are closed between 22nd and 24th after a water main break flooded the roadway this morning; crews expect repairs to last into the evening.";
const CLOSURE_B =
  "Our reporter at the scene saw police diverting buses away from Mission near 23rd while utility trucks pumped water from a sinkhole that opened beside the curb.";

describe("attribution detection", () => {
  it("finds explicit named origins and wire syndication markers", () => {
    expect(detectAttributions("Two lanes are closed, according to Caltrans.")).toEqual([
      { origin: "caltrans", label: "Caltrans", kind: "explicit" },
    ]);
    expect(detectAttributions("SAN FRANCISCO (AP) — A water main broke on Mission Street.")).toEqual([
      { origin: "associated press", label: "AP", kind: "syndication" },
    ]);
    expect(detectAttributions("The road is closed, according to the California Highway Patrol.")[0]?.origin).toBe("california highway patrol");
    expect(detectAttributions("Copyright 2026 The Associated Press. All rights reserved.")[0]).toMatchObject({ origin: "associated press", kind: "syndication" });
  });

  it("ignores generic subjects that don't identify one origin", () => {
    expect(detectAttributions("The street is closed, according to police.")).toEqual([]);
    expect(detectAttributions("Officials said the road would reopen tonight.")).toEqual([]);
    expect(detectAttributions("He said in a statement that it was fine.")).toEqual([]);
    expect(normalizeOrigin("The Associated Press")).toBe("associated press");
    expect(normalizeOrigin("AP")).toBe("associated press");
    expect(normalizeOrigin("Witnesses")).toBeNull();
  });
});

describe("evidence lineage", () => {
  it("A: two distinct articles from the SAME publisher are not collapsed", () => {
    const records = assignLineages([
      news({ publisher: "San Francisco Chronicle", sourceName: "San Francisco Chronicle", canonicalUrl: "https://www.sfchronicle.com/bayarea/article/a-1", publisherDomain: "sfchronicle.com", excerpt: CLOSURE_A }),
      news({ publisher: "San Francisco Chronicle", sourceName: "San Francisco Chronicle", canonicalUrl: "https://www.sfchronicle.com/bayarea/article/b-2", publisherDomain: "sfchronicle.com", excerpt: CLOSURE_B }),
    ]);
    expect(lineagesOf(records).size).toBe(2);
    expect(independent(records)).toHaveLength(2);
    expect(records.every((r) => r.lineage.reason === "own_origin")).toBe(true);
  });

  it("B: DIFFERENT publishers explicitly attributing the same origin ARE collapsed, with the reason recorded", () => {
    const nbc = news({ publisher: "NBC Bay Area", canonicalUrl: "https://www.nbcbayarea.com/news/1", excerpt: CLOSURE_A, attributions: detectAttributions("SAN FRANCISCO (AP) — water main") });
    const abc = news({ publisher: "ABC7 News", canonicalUrl: "https://abc7news.com/2", excerpt: CLOSURE_B, attributions: detectAttributions("according to the Associated Press") });
    const records = assignLineages([nbc, abc]);
    expect(lineagesOf(records).size).toBe(1);
    expect(independent(records)).toHaveLength(1);
    const member = records.find((r) => !r.lineage.countsAsIndependent)!;
    expect(member.lineage.reason).toMatch(/^(syndication|explicit_attribution)$/);
    expect(member.lineage.relatedTo).not.toBeNull();
    expect(member.lineage.via).toBeTruthy();
  });

  it("relates a record attributed to a source with that source's own record", () => {
    const caltrans = official({ publisher: "Caltrans", sourceName: "Caltrans", excerpt: CLOSURE_A });
    const article = news({ publisher: "KQED", excerpt: CLOSURE_B, attributions: detectAttributions("The lanes are closed, according to Caltrans.") });
    const records = assignLineages([article, caltrans]);
    expect(lineagesOf(records).size).toBe(1);
    // The primary official record represents the lineage.
    expect(records.find((r) => r.lineage.countsAsIndependent)!.publisher).toBe("Caltrans");
    expect(records.find((r) => r.publisher === "KQED")!.lineage).toMatchObject({ reason: "explicit_attribution", via: "Caltrans" });
  });

  it("relates a wire service's own article to articles syndicating it", () => {
    const ap = news({ publisher: "AP News", canonicalUrl: "https://apnews.com/article/water-main-1", excerpt: CLOSURE_A });
    const local = news({ publisher: "Local Paper", excerpt: CLOSURE_B, attributions: detectAttributions("(AP) — Crews worked") });
    expect(lineagesOf(assignLineages([ap, local])).size).toBe(1);
  });

  it("relates records with the same canonical URL or the same origin metadata", () => {
    const url = "https://outlet.example/story";
    const byUrl = assignLineages([news({ canonicalUrl: url, publisher: "A" }), news({ canonicalUrl: url, publisher: "B" })]);
    expect(lineagesOf(byUrl).size).toBe(1);
    expect(byUrl.find((r) => !r.lineage.countsAsIndependent)!.lineage.reason).toBe("canonical_url");

    const byOrigin = assignLineages([news({ originRef: "wire:story-778" }), news({ originRef: "wire:story-778" })]);
    expect(byOrigin.find((r) => !r.lineage.countsAsIndependent)!.lineage.reason).toBe("same_origin_metadata");
  });

  it("relates near-duplicate copies but not short or merely similar texts", () => {
    const copy = assignLineages([news({ excerpt: CLOSURE_A }), news({ excerpt: `${CLOSURE_A} Updated.` })]);
    expect(lineagesOf(copy).size).toBe(1);
    expect(copy.find((r) => !r.lineage.countsAsIndependent)!.lineage.reason).toBe("near_duplicate");

    expect(lineagesOf(assignLineages([news({ excerpt: "Road closed on Mission" }), news({ excerpt: "Road closed on Mission" })])).size).toBe(2);
    expect(lineagesOf(assignLineages([news({ excerpt: CLOSURE_A }), news({ excerpt: CLOSURE_B })])).size).toBe(2);
  });

  it("chooses the primary record as representative, then the earliest", () => {
    const early = news({ publishedAt: minutesAgo(90), originRef: "o-1" });
    const late = news({ publishedAt: minutesAgo(10), originRef: "o-1" });
    const records = assignLineages([late, early]);
    expect(records.find((r) => r.lineage.countsAsIndependent)!.id).toBe(early.id);

    const primary = news({ publishedAt: minutesAgo(5), originRef: "o-2", isPrimary: true });
    const repeat = news({ publishedAt: minutesAgo(80), originRef: "o-2" });
    expect(assignLineages([repeat, primary]).find((r) => r.lineage.countsAsIndependent)!.id).toBe(primary.id);
  });

  it("keeps community reports in one lineage, separate from external sources even with identical text", () => {
    const records = assignLineages([communityReport({ excerpt: CLOSURE_A }), communityReport({ excerpt: CLOSURE_A }), news({ excerpt: CLOSURE_A })]);
    const community = records.filter((r) => r.sourceType === "community_report");
    expect(new Set(community.map((r) => r.lineage.lineageId))).toEqual(new Set([COMMUNITY_LINEAGE_ID]));
    expect(community.filter((r) => r.lineage.countsAsIndependent)).toHaveLength(1);
    expect(records.find((r) => r.sourceType !== "community_report")!.lineage.lineageId).not.toBe(COMMUNITY_LINEAGE_ID);
  });

  it("is deterministic and explains every grouping without a 'same publisher' reason", () => {
    const input = [
      news({ originRef: "x" }),
      news({ originRef: "x" }),
      news({ excerpt: CLOSURE_A }),
      news({ excerpt: `${CLOSURE_A} More.` }),
      news({ attributions: detectAttributions("according to Caltrans") }),
      official(),
      news({ publisher: "Same Paper" }),
      news({ publisher: "Same Paper" }),
    ];
    const first = assignLineages(input);
    const second = assignLineages([...input].reverse()).reverse();
    expect(second.map((r) => r.lineage)).toEqual(first.map((r) => r.lineage));
    for (const record of first) {
      expect(LINEAGE_REASONS).toContain(record.lineage.reason);
      expect(record.lineage.reason).not.toBe("same_publisher");
      if (!record.lineage.countsAsIndependent) expect(record.lineage.relatedTo).not.toBeNull();
    }
    // Exactly one independent record per lineage.
    for (const id of lineagesOf(first)) expect(first.filter((r) => r.lineage.lineageId === id && r.lineage.countsAsIndependent)).toHaveLength(1);
    expect(first.every((r) => r.lineage.lineageId.length <= 64)).toBe(true);
  });
});
