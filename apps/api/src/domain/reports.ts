import { CATEGORY_KIND, type ReportEventPayload, type ReportEventResult } from "@verity/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { events, eventTimeline, reports, sourceRecords } from "../db/schema";
import { findDuplicateEvent } from "./dedupe";
import { enqueueVerification } from "./outbox";
import { recordCreation } from "./transitions";

const COMMUNITY_LINEAGE = "community";

/**
 * Store a community report. In ONE transaction:
 *   report row → canonical event (new, or an existing duplicate) → community
 *   evidence record → timeline entry → verification outbox job.
 * No network calls happen inside it; verification runs after commit (Phase 3).
 * The reporter comes from the authenticated session, never the request body.
 * New events are always UNVERIFIED.
 */
export async function createReport(db: Database, reporterUserId: string, input: ReportEventPayload, now = new Date()): Promise<ReportEventResult> {
  const { latitude, longitude } = input.location.coordinates;

  return db.transaction(async (tx) => {
    // Serialize concurrent reports for the same kind of thing in the same ~1 km
    // cell, so near-simultaneous duplicates attach instead of racing.
    const cell = `${CATEGORY_KIND[input.category]}:${latitude.toFixed(2)}:${longitude.toFixed(2)}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${cell}, 0))`);

    const duplicateId = await findDuplicateEvent(
      tx,
      { category: input.category, title: input.title, description: input.description, latitude, longitude },
      now,
    );

    let eventId: string;
    let outcome: ReportEventResult["outcome"];
    if (duplicateId) {
      outcome = "attached_to_existing";
      eventId = duplicateId;
      // Lock the event row so evidence independence is decided consistently.
      await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).for("update");
      await tx.update(events).set({ lastUpdatedAt: now, updatedAt: now }).where(eq(events.id, eventId));
    } else {
      outcome = "created";
      const [created] = await tx
        .insert(events)
        .values({
          title: input.title,
          summary: input.description ?? "",
          category: input.category,
          latitude,
          longitude,
          approximateLocation: input.location.label ?? "Location pinned on the map",
          status: "UNVERIFIED",
          verificationState: "idle",
          origin: "community_report",
          createdByUserId: reporterUserId,
          firstSeenAt: now,
          lastUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: events.id });
      eventId = created!.id;
      await recordCreation(tx, eventId, "Community report received", { type: "community", userId: reporterUserId });
    }

    const [report] = await tx
      .insert(reports)
      .values({
        eventId,
        reporterUserId,
        category: input.category,
        title: input.title,
        description: input.description ?? null,
        latitude,
        longitude,
        locationLabel: input.location.label ?? null,
        sourceUrl: input.source_url ?? null,
        observedAt: input.observed_at ? new Date(input.observed_at) : null,
        attachOutcome: outcome,
        createdAt: now,
      })
      .returning({ id: reports.id });
    const reportId = report!.id;

    // Community reports form one lineage per event: many reporters add weight
    // to the community signal but count as a single independent source.
    const [existingIndependent] = await tx
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(eq(sourceRecords.eventId, eventId), eq(sourceRecords.lineageId, COMMUNITY_LINEAGE), eq(sourceRecords.countsAsIndependent, true)),
      )
      .limit(1);
    const [evidence] = await tx
      .insert(sourceRecords)
      .values({
        eventId,
        reportId,
        sourceType: "community_report",
        sourceName: "Community report",
        // The reporter's link is stored on the report only. It is not fetched
        // or shown until Phase 3 checks it.
        sourceUrl: null,
        publishedAt: input.observed_at ? new Date(input.observed_at) : now,
        retrievedAt: now,
        quote: (input.description || input.title).slice(0, 1000),
        stance: "supports",
        sourceClass: "COMMUNITY",
        isPrimary: true,
        lineageId: COMMUNITY_LINEAGE,
        countsAsIndependent: !existingIndependent,
        freshnessState: "fresh",
        locationMatch: "unclear",
        timeMatch: "current",
        createdAt: now,
      })
      .returning({ id: sourceRecords.id });

    await tx.insert(eventTimeline).values({
      eventId,
      at: now,
      kind: outcome === "created" ? "report_received" : "report_merged",
      label: outcome === "created" ? "Community report received" : "Similar community report attached",
      sourceRecordId: evidence!.id,
      actorType: "community",
    });

    await enqueueVerification(tx, {
      eventId,
      reason: outcome === "created" ? "NEW_REPORT" : "REPORT_ATTACHED",
      idempotencyKey: `verify:report:${reportId}`,
    });

    return { event_id: eventId, report_id: reportId, outcome };
  });
}
