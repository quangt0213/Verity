import { ACTIVE_STATUSES, CATEGORY_KIND, haversineMeters, jaccard, textTokens, type EventCategory } from "@verity/contracts";
import { and, between, eq, gte, inArray } from "drizzle-orm";
import type { Queryable } from "../db/client";
import { events } from "../db/schema";

export const DEDUPE = {
  maxDistanceM: 300,
  lookbackHours: 12,
  minSimilarity: 0.2,
  /** If the runner-up scores within this margin, the match is ambiguous: keep separate. */
  ambiguityMargin: 0.05,
};

export interface ReportForMatching {
  category: EventCategory;
  title: string;
  description?: string;
  latitude: number;
  longitude: number;
}

/**
 * Find an active event that this report very likely describes: nearby, recent,
 * compatible category and similar wording. Ambiguous matches return null; a
 * duplicate event is better than wrongly merging two different situations.
 * Demo events never absorb real reports.
 */
export async function findDuplicateEvent(db: Queryable, report: ReportForMatching, now: Date): Promise<string | null> {
  const dLat = DEDUPE.maxDistanceM / 111_000;
  const dLng = dLat / Math.max(0.2, Math.cos((report.latitude * Math.PI) / 180));
  const candidates = await db
    .select({
      id: events.id,
      title: events.title,
      summary: events.summary,
      category: events.category,
      latitude: events.latitude,
      longitude: events.longitude,
    })
    .from(events)
    .where(
      and(
        inArray(events.status, [...ACTIVE_STATUSES]),
        eq(events.isDemo, false),
        between(events.latitude, report.latitude - dLat, report.latitude + dLat),
        between(events.longitude, report.longitude - dLng, report.longitude + dLng),
        gte(events.lastUpdatedAt, new Date(now.getTime() - DEDUPE.lookbackHours * 3600_000)),
      ),
    )
    .limit(25);

  const reportTokens = textTokens(`${report.title} ${report.description ?? ""}`);
  const scored = candidates
    .map((c) => {
      const distance = haversineMeters(c, report);
      const sameCategory = c.category === report.category;
      const sameKind = CATEGORY_KIND[c.category as EventCategory] === CATEGORY_KIND[report.category];
      const similarity = jaccard(reportTokens, textTokens(`${c.title} ${c.summary}`));
      const titleSimilarity = jaccard(textTokens(report.title), textTokens(c.title));
      const compatible = sameCategory || (sameKind && titleSimilarity >= 0.5);
      if (distance > DEDUPE.maxDistanceM || !compatible || similarity < DEDUPE.minSimilarity) return null;
      return { id: c.id, score: similarity + (sameCategory ? 0.3 : 0) + (1 - distance / DEDUPE.maxDistanceM) * 0.2 };
    })
    .filter((c): c is { id: string; score: number } => c !== null)
    .sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;
  if (!best) return null;
  if (runnerUp && best.score - runnerUp.score < DEDUPE.ambiguityMargin) return null;
  return best.id;
}
