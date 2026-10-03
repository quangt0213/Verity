import {
  evidenceListResponseSchema,
  listEventsQuerySchema,
  timelineResponseSchema,
  type EventCategory,
  type EventStatus,
} from "@verity/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { sql } from "drizzle-orm";
import { eventExists, getEventDetail, getEvidence, getTimeline, listEvents } from "../domain/read-model";
import { ApiError, notFound, parseInput } from "../security/errors";

const idSchema = z.uuid();

export function parseEventId(params: unknown): string {
  const id = (params as { id?: unknown }).id;
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw notFound("Event not found.");
  return parsed.data;
}

const list = (v: unknown) => (typeof v === "string" && v.length > 0 ? v.split(",").map((s) => s.trim()) : undefined);
const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : undefined);

/** Map query-string text onto the shared (strict) list schema. */
export function parseListQuery(query: Record<string, unknown>) {
  const known = new Set(["bbox", "categories", "statuses", "q", "limit", "cursor", "updated_since"]);
  for (const key of Object.keys(query)) {
    if (!known.has(key)) throw new ApiError(400, "validation_failed", "Unknown query parameter.", { fields: { [key]: "Unexpected field" } });
  }
  for (const value of Object.values(query)) {
    if (Array.isArray(value)) throw new ApiError(400, "validation_failed", "Repeated query parameters are not supported.");
  }
  const bbox = list(query.bbox)?.map(Number);
  return parseInput(listEventsQuerySchema, {
    ...(bbox ? { bbox } : {}),
    ...(list(query.categories) ? { categories: list(query.categories) } : {}),
    ...(list(query.statuses) ? { statuses: list(query.statuses) } : {}),
    ...(typeof query.q === "string" && query.q ? { q: query.q } : {}),
    ...(num(query.limit) !== undefined ? { limit: num(query.limit) } : {}),
    ...(typeof query.cursor === "string" && query.cursor ? { cursor: query.cursor } : {}),
    ...(typeof query.updated_since === "string" && query.updated_since ? { updated_since: query.updated_since } : {}),
  });
}

/** Publicly readable, public-safe endpoints. No account needed to browse. */
export async function publicRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/api/v1/health", async () => {
    await db.execute(sql`select 1`);
    return { status: "ok" };
  });

  app.get("/api/v1/events", async (request) => {
    const q = parseListQuery(request.query as Record<string, unknown>);
    return listEvents(db, {
      bbox: q.bbox as [number, number, number, number] | undefined,
      categories: q.categories as EventCategory[] | undefined,
      statuses: q.statuses as EventStatus[] | undefined,
      q: q.q,
      limit: q.limit,
      cursor: q.cursor,
      updatedSince: q.updated_since,
    });
  });

  app.get("/api/v1/events/:id", async (request) => {
    const detail = await getEventDetail(db, parseEventId(request.params));
    if (!detail) throw notFound("Event not found.");
    return detail;
  });

  app.get("/api/v1/events/:id/evidence", async (request) => {
    const id = parseEventId(request.params);
    if (!(await eventExists(db, id))) throw notFound("Event not found.");
    return evidenceListResponseSchema.parse({ evidence: await getEvidence(db, id) });
  });

  app.get("/api/v1/events/:id/timeline", async (request) => {
    const id = parseEventId(request.params);
    if (!(await eventExists(db, id))) throw notFound("Event not found.");
    return timelineResponseSchema.parse({ timeline: await getTimeline(db, id) });
  });
}
