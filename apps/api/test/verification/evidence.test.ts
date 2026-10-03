import { describe, expect, it } from "vitest";
import type { sourceRecords } from "../../src/db/schema";
import { detectAttributions } from "../../src/verification/attribution";
import { fromSourceRecord, toSourceRecordValues } from "../../src/verification/evidence";
import { assignLineages } from "../../src/verification/lineage";
import { hoursAgo, minutesAgo, news, NOW } from "./factories";

type Row = typeof sourceRecords.$inferSelect;
const EVENT_ID = "00000000-0000-4000-8000-00000000e001";

/** What the database would hand back for an insert (ids and defaults filled in). */
function asRow(values: ReturnType<typeof toSourceRecordValues>, id: string): Row {
  return {
    id,
    reportId: null,
    sourceUrl: null,
    sourceDomain: null,
    publisher: null,
    publishedAt: null,
    quote: null,
    agentNote: null,
    rawSnapshotRef: null,
    extractionMetadata: null,
    retrievedAt: NOW,
    freshnessState: "fresh",
    locationMatch: "unclear",
    timeMatch: "current",
    createdAt: NOW,
    ...values,
  } as Row;
}

describe("NormalizedEvidence ↔ source_records", () => {
  it("round-trips through the existing columns plus versioned extraction_metadata", () => {
    const original = news({
      canonicalUrl: "https://news.example/story?id=7",
      originalUrl: "https://news.example/story?id=7&utm_source=x",
      publisherDomain: "news.example",
      title: "Mission St closed",
      eventTimeAsReported: hoursAgo(1),
      excerpt: "Northbound lanes are closed, according to Caltrans.",
      note: "Article describes a closure at the reported intersection.",
      attributions: detectAttributions("according to Caltrans"),
      query: "Mission Street road closed",
      providerRequestId: "req-123",
    });
    const [record] = assignLineages([original]);
    const values = toSourceRecordValues(record!, EVENT_ID, { freshness: "fresh", timeMatch: "current" });

    expect(values).toMatchObject({
      sourceUrl: "https://news.example/story?id=7",
      sourceDomain: "news.example",
      quote: original.excerpt,
      agentNote: original.note,
      lineageId: record!.lineage.lineageId,
      countsAsIndependent: true,
    });
    const back = fromSourceRecord(asRow(values, original.id!));
    const { lineage, ...rest } = back;
    const { lineage: _l, ...expected } = record!;
    expect(rest).toEqual(expected);
    expect(lineage).toEqual(record!.lineage);
  });

  it("stores unknown freshness as aging with an unclear time match, and truncates to column limits", () => {
    const [record] = assignLineages([news({ publishedAt: null, excerpt: "x".repeat(2000), title: "t".repeat(400) })]);
    const values = toSourceRecordValues(record!, EVENT_ID, { freshness: "unknown", timeMatch: "unclear" });
    expect(values).toMatchObject({ freshnessState: "aging", timeMatch: "unclear" });
    expect(values.quote).toHaveLength(1000);
    expect((values.extractionMetadata as { title: string }).title).toHaveLength(300);
  });

  it("reads Phase 2 community records (no metadata) and tolerates malformed metadata", () => {
    const community = fromSourceRecord(
      asRow(
        {
          eventId: EVENT_ID,
          sourceType: "community_report",
          sourceName: "Community report",
          stance: "supports",
          sourceClass: "COMMUNITY",
          isPrimary: true,
          lineageId: "community",
          countsAsIndependent: true,
          publishedAt: minutesAgo(10),
        },
        "00000000-0000-4000-8000-00000000c001",
      ),
    );
    expect(community).toMatchObject({ retrievalMethod: "community", classifiedBy: "community", lineage: { reason: "community", lineageId: "community" } });

    const garbage = fromSourceRecord(
      asRow(
        {
          eventId: EVENT_ID,
          sourceType: "web_page",
          sourceName: "Page",
          stance: "supports",
          sourceClass: "UNKNOWN",
          isPrimary: false,
          lineageId: "lin_x",
          countsAsIndependent: true,
          extractionMetadata: { v: 99, attributions: "not an array" },
        },
        "00000000-0000-4000-8000-00000000c002",
      ),
    );
    expect(garbage).toMatchObject({ attributions: [], retrievalMethod: "search", lineage: { reason: "own_origin" } });
  });
});
