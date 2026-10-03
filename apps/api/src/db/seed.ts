import { randomUUID } from "node:crypto";
import type { EventDetail } from "@verity/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { eventStateTransitions, events, eventTimeline, sourceRecords } from "./schema";

/**
 * Insert demo events (development only). Every row is flagged is_demo and the
 * fixtures' sources live on the reserved .example domain, so demo data can
 * never be mistaken for real, current events. Callers must refuse production.
 */
export async function insertDemoEvents(db: Database, demo: EventDetail[]): Promise<number> {
  return db.transaction(async (tx) => {
    // Demo events arrive in their final status; mark this as an audited transition path.
    await tx.execute(sql`select set_config('verity.transition_in_progress', 'on', true)`);
    for (const event of demo) {
      await tx.insert(events).values({
        id: event.id,
        title: event.title,
        summary: event.summary,
        category: event.category,
        latitude: event.coordinates.latitude,
        longitude: event.coordinates.longitude,
        approximateLocation: event.approximate_location,
        affectedRadiusM: event.affected_area?.radius_m ?? null,
        status: event.status,
        verificationState: event.verification_state,
        origin: event.origin,
        evidenceSummary: event.evidence_summary,
        firstSeenAt: new Date(event.first_seen_at),
        lastUpdatedAt: new Date(event.last_updated_at),
        lastVerifiedAt: event.last_verified_at ? new Date(event.last_verified_at) : null,
        lastCheckedAt: event.last_checked_at ? new Date(event.last_checked_at) : null,
        scheduledStartAt: event.scheduled_start_at ? new Date(event.scheduled_start_at) : null,
        scheduledEndAt: event.scheduled_end_at ? new Date(event.scheduled_end_at) : null,
        expiresAt: event.expires_at ? new Date(event.expires_at) : null,
        isDemo: true,
      });
      await tx.insert(eventStateTransitions).values({
        eventId: event.id,
        fromStatus: null,
        toStatus: event.status,
        reason: "Demo data seeded for development",
        actorType: "admin",
      });
      const evidenceIds = new Map<string, string>();
      for (const e of event.evidence) {
        const id = randomUUID();
        evidenceIds.set(e.id, id);
        await tx.insert(sourceRecords).values({
          id,
          eventId: event.id,
          sourceType: e.source_type,
          sourceName: e.source_name,
          sourceUrl: e.source_url,
          sourceDomain: e.source_domain,
          publisher: e.publisher,
          publishedAt: e.published_at ? new Date(e.published_at) : null,
          retrievedAt: new Date(e.retrieved_at),
          quote: e.quote,
          agentNote: e.agent_note,
          stance: e.stance,
          sourceClass: e.source_class,
          isPrimary: e.is_primary,
          lineageId: e.lineage_id,
          countsAsIndependent: e.counts_as_independent,
          freshnessState: e.freshness_state,
          locationMatch: e.location_match,
          timeMatch: e.time_match,
        });
      }
      for (const t of event.timeline) {
        await tx.insert(eventTimeline).values({
          eventId: event.id,
          at: new Date(t.at),
          kind: t.kind,
          label: t.label,
          detail: t.detail,
          fromStatus: t.from_status,
          toStatus: t.to_status,
          sourceRecordId: t.evidence_id ? (evidenceIds.get(t.evidence_id) ?? null) : null,
          actorType: t.kind === "report_received" || t.kind === "community_update" ? "community" : "verifier",
        });
      }
    }
    return demo.length;
  });
}
