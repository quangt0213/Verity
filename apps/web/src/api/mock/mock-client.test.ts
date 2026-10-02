import { eventDetailSchema, isActiveStatus } from "@verity/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoEvents, demoEventId } from "./fixtures";
import { createMockApi } from "./mock-client";

const NOW = new Date("2026-10-01T15:00:00Z");
const fixtures = buildDemoEvents(NOW);
const SF_BBOX: [number, number, number, number] = [-122.55, 37.7, -122.35, 37.83];

describe("demo fixtures", () => {
  it("all satisfy the shared event contract", () => {
    for (const event of fixtures) {
      const result = eventDetailSchema.safeParse(event);
      expect(result.success, `${event.id}: ${result.error?.message}`).toBe(true);
    }
  });

  it("are all labeled as demo data", () => {
    expect(fixtures.every((e) => e.is_demo)).toBe(true);
  });

  it("never cite a real publication", () => {
    for (const evidence of fixtures.flatMap((e) => e.evidence)) {
      if (evidence.source_url) expect(new URL(evidence.source_url).hostname).toMatch(/\.example$/);
    }
  });

  it("cover every evidence status", () => {
    const statuses = new Set(fixtures.map((e) => e.status));
    for (const s of ["UNVERIFIED", "DEVELOPING", "LIKELY", "VERIFIED", "CONFLICTING", "STALE", "RESOLVED", "REJECTED"]) {
      expect(statuses.has(s as never), s).toBe(true);
    }
  });

  it("keep copied sources from counting as independent", () => {
    const highway = fixtures.find((e) => e.id === demoEventId(101))!;
    expect(highway.source_count).toBe(4);
    expect(highway.independent_source_count).toBe(3);
    const copies = highway.evidence.filter((e) => e.lineage_id === "101-localnews");
    expect(copies.filter((e) => e.counts_as_independent)).toHaveLength(1);
  });
});

describe("mock reads", () => {
  const api = createMockApi({ writes: "off", latencyMs: [0, 0], now: () => NOW });

  it("filters by viewport and hides unsupported reports by default", async () => {
    const { events } = await api.listEvents({ bbox: SF_BBOX });
    expect(events.length).toBeGreaterThan(5);
    expect(events.some((e) => e.status === "REJECTED")).toBe(false);
    const far = await api.listEvents({ bbox: [-74.1, 40.6, -73.8, 40.9] });
    expect(far.events).toHaveLength(0);
  });

  it("filters by category and text", async () => {
    const { events } = await api.listEvents({ bbox: SF_BBOX, categories: ["flooding"], q: "mission" });
    expect(events.map((e) => e.category)).toEqual(["flooding"]);
  });

  it("validates queries like the service would", async () => {
    await expect(api.listEvents({ bbox: [10, 10, 0, 0] })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("returns not_found for unknown events", async () => {
    await expect(api.getEvent("does-not-exist")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("mock writes", () => {
  afterEach(() => vi.useRealTimers());

  const report = {
    category: "crash" as const,
    title: "Two cars collided on Folsom",
    description: "Blocking the right lane",
    location: { coordinates: { latitude: 37.7735, longitude: -122.4125 } },
  };

  it("records nothing when writes are off", async () => {
    const api = createMockApi({ writes: "off", latencyMs: [0, 0] });
    expect(await api.reportEvent(report)).toMatchObject({ ok: false, error: { code: "auth_unavailable" } });
    expect(await api.respond(demoEventId(101), { kind: "confirm" })).toMatchObject({ ok: false });
  });

  it("never turns a single report into a verified event, and never fabricates evidence", async () => {
    vi.useFakeTimers();
    const api = createMockApi({ writes: "simulate", latencyMs: [0, 0], verificationDelaysMs: { start: 10, unavailable: 50 } });
    const pending = api.reportEvent(report);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, simulated: true, data: { outcome: "created" } });
    if (!result.ok) return;

    const created = api.getEvent(result.data.event_id);
    await vi.advanceTimersByTimeAsync(1);
    const fresh = await created;
    expect(fresh.status).toBe("UNVERIFIED");
    expect(fresh.verification_state).toBe("queued");
    expect(fresh.is_demo).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    const later = api.getEvent(result.data.event_id);
    await vi.advanceTimersByTimeAsync(1);
    const after = await later;
    expect(after.status).toBe("UNVERIFIED");
    expect(after.verification_state).toBe("unavailable");
    expect(after.evidence).toHaveLength(1);
    expect(after.timeline.map((t) => t.kind)).toContain("verification_unavailable");
  });

  it("attaches a near-identical nearby report to the existing event", async () => {
    const api = createMockApi({ writes: "simulate", latencyMs: [0, 0], now: () => NOW });
    const result = await api.reportEvent({
      category: "road_closure",
      title: "US-101 northbound closed at Cesar Chavez",
      location: { coordinates: { latitude: 37.749, longitude: -122.4047 } },
    });
    expect(result).toMatchObject({ ok: true, data: { outcome: "attached_to_existing", event_id: demoEventId(101) } });
  });

  it("keeps one answer per question, lets a new answer replace it, and never changes status", async () => {
    const api = createMockApi({ writes: "simulate", latencyMs: [0, 0], now: () => NOW });
    const before = await api.getEvent(demoEventId(102));
    expect(await api.respond(demoEventId(102), { kind: "confirm" })).toMatchObject({ ok: true, data: { changed: true } });
    expect(await api.respond(demoEventId(102), { kind: "confirm" })).toMatchObject({ ok: true, data: { changed: false } });
    expect(await api.getMySignals(demoEventId(102))).toEqual(["CONFIRM"]);
    for (let i = 0; i < 5; i++) await api.respond(demoEventId(102), { kind: "update", text: `Still flooded ${i}` });
    const after = await api.getEvent(demoEventId(102));
    expect(after.community_confirmation_count).toBe(before.community_confirmation_count + 1);
    expect(after.status).toBe(before.status);
    expect(isActiveStatus(after.status)).toBe(true);
  });

  it("returns field errors for invalid reports", async () => {
    const api = createMockApi({ writes: "simulate", latencyMs: [0, 0] });
    const result = await api.reportEvent({ ...report, title: "x", source_url: "http://169.254.169.254/latest" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_failed");
      expect(Object.keys(result.error.fields ?? {})).toEqual(expect.arrayContaining(["title", "source_url"]));
    }
  });
});
