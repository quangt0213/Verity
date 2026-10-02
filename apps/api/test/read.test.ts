import { eventDetailSchema, evidenceListResponseSchema, listEventsResponseSchema, timelineResponseSchema } from "@verity/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, seedDemo, SF_BBOX, type TestContext } from "./helpers";

let ctx: TestContext;
const HIGHWAY = "00000000-0000-4000-8000-000000000101";
beforeAll(async () => {
  ctx = await createTestContext();
  await seedDemo(ctx.db);
});
afterAll(async () => ctx.close());

const get = async (url: string) => ctx.request({ method: "GET", url });

describe("public read API", () => {
  it("lists events in a viewport without authentication, matching the shared contract", async () => {
    const res = await get(`/api/v1/events?bbox=${SF_BBOX}`);
    expect(res.statusCode).toBe(200);
    const body = listEventsResponseSchema.parse(res.json());
    expect(body.events.length).toBeGreaterThan(5);
    expect(body.events.every((e) => e.is_demo)).toBe(true);
    // REJECTED is hidden unless asked for.
    expect(body.events.some((e) => e.status === "REJECTED")).toBe(false);
  });

  it("filters by bbox, status, category and freshness", async () => {
    const far = (await get("/api/v1/events?bbox=-74.1,40.6,-73.8,40.9")).json();
    expect(far.events).toEqual([]);
    const verified = (await get(`/api/v1/events?bbox=${SF_BBOX}&statuses=VERIFIED`)).json();
    expect(verified.events.every((e: { status: string }) => e.status === "VERIFIED")).toBe(true);
    const flooding = (await get(`/api/v1/events?bbox=${SF_BBOX}&categories=flooding`)).json();
    expect(flooding.events.map((e: { category: string }) => e.category)).toEqual(["flooding"]);
    const recent = (await get(`/api/v1/events?bbox=${SF_BBOX}&updated_since=${new Date(Date.now() - 15 * 60_000).toISOString()}`)).json();
    for (const e of recent.events) expect(Date.parse(e.last_updated_at)).toBeGreaterThanOrEqual(Date.now() - 15 * 60_000 - 1000);
    const rejected = (await get(`/api/v1/events?bbox=${SF_BBOX}&statuses=REJECTED`)).json();
    expect(rejected.events).toHaveLength(1);
  });

  it("paginates with an opaque cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const res = (await get(`/api/v1/events?bbox=${SF_BBOX}&limit=4${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...res.events.map((e: { id: string }) => e.id));
      cursor = res.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    const all = (await get(`/api/v1/events?bbox=${SF_BBOX}`)).json().events.map((e: { id: string }) => e.id);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...all].sort());
  });

  it("validates list queries", async () => {
    expect((await get("/api/v1/events?bbox=10,10,0,0")).statusCode).toBe(400);
    expect((await get("/api/v1/events?bbox=-130,30,-110,45")).statusCode).toBe(400);
    expect((await get("/api/v1/events?statuses=PROBABLY")).statusCode).toBe(400);
    expect((await get("/api/v1/events?limit=100000")).statusCode).toBe(400);
  });

  it("returns event detail, evidence and timeline in contract shape", async () => {
    const detail = eventDetailSchema.parse((await get(`/api/v1/events/${HIGHWAY}`)).json());
    expect(detail.status).toBe("VERIFIED");
    expect(detail.source_count).toBe(4);
    expect(detail.independent_source_count).toBe(3);

    const evidence = evidenceListResponseSchema.parse((await get(`/api/v1/events/${HIGHWAY}/evidence`)).json());
    expect(evidence.evidence).toHaveLength(4);
    const timeline = timelineResponseSchema.parse((await get(`/api/v1/events/${HIGHWAY}/timeline`)).json());
    expect(timeline.timeline.length).toBeGreaterThan(3);
  });

  it("404s cleanly for unknown or malformed ids", async () => {
    expect((await get("/api/v1/events/00000000-0000-4000-8000-00000000ffff")).statusCode).toBe(404);
    expect((await get("/api/v1/events/../../internal")).statusCode).toBe(404);
    expect((await get("/api/v1/events/1%20OR%201=1/evidence")).statusCode).toBe(404);
  });
});
