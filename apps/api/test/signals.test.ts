import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { communitySignals, eventStateTransitions, verificationJobs } from "../src/db/schema";
import { createTestContext, INTERNAL_TOKEN, validReport, type TestContext } from "./helpers";

let ctx: TestContext;
let reporter: string;
let eventId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  reporter = await ctx.signIn("signal-reporter@example.com");
  const res = await ctx.request({ method: "POST", url: "/api/v1/reports", token: reporter, payload: validReport });
  eventId = res.json().event_id;
});
afterAll(async () => ctx.close());

const signal = (type: string, token: string, id = eventId) =>
  ctx.request({ method: "POST", url: `/api/v1/events/${id}/signals`, token, payload: { type } });
const detail = async (id = eventId) => (await ctx.request({ method: "GET", url: `/api/v1/events/${id}` })).json();

describe("community signals", () => {
  it("persists a confirmation and counts it server-side", async () => {
    const voter = await ctx.signIn("voter-1@example.com");
    const res = await signal("CONFIRM", voter);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ type: "CONFIRM", changed: true });
    const d = await detail();
    expect(d.community_confirmation_count).toBe(1);
    expect(d.community.recent_confirmations).toBe(1);
  });

  it("does not let one account inflate a count", async () => {
    const voter = await ctx.signIn("voter-2@example.com");
    expect((await signal("CONFIRM", voter)).statusCode).toBe(201);
    const repeat = await signal("CONFIRM", voter);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().changed).toBe(false);
    expect((await detail()).community_confirmation_count).toBe(2);
  });

  it("lets a newer answer supersede the older one, keeping history", async () => {
    const voter = await ctx.signIn("voter-3@example.com");
    await signal("CONFIRM", voter);
    expect((await detail()).community_confirmation_count).toBe(3);
    await signal("DISPUTE", voter);
    const d = await detail();
    expect(d.community_confirmation_count).toBe(2);
    expect(d.community_dispute_count).toBe(1);

    const userId = await ctx.userIdFor(voter);
    const rows = await ctx.db
      .select()
      .from(communitySignals)
      .where(and(eq(communitySignals.eventId, eventId), eq(communitySignals.userId, userId)));
    expect(rows.map((r) => [r.type, r.active])).toEqual(
      expect.arrayContaining([
        ["CONFIRM", false],
        ["DISPUTE", true],
      ]),
    );
  });

  it("tracks 'still happening' separately from confirm/dispute", async () => {
    const voter = await ctx.signIn("voter-4@example.com");
    await signal("CONFIRM", voter);
    await signal("STILL_HAPPENING", voter);
    await signal("NOT_SURE", voter);
    const mine = (await ctx.request({ method: "GET", url: `/api/v1/events/${eventId}/signals/mine`, token: voter })).json();
    expect(mine.signals.map((s: { type: string }) => s.type).sort()).toEqual(["CONFIRM", "NOT_SURE"]);
    const d = await detail();
    expect(d.community.still_happening).toEqual({ yes: 0, no: 0, not_sure: 1 });
  });

  it("never verifies an event, however many people confirm it", async () => {
    for (let i = 0; i < 8; i++) await signal("CONFIRM", await ctx.signIn(`crowd-${i}@example.com`));
    const d = await detail();
    expect(d.community_confirmation_count).toBeGreaterThanOrEqual(10);
    expect(d.status).toBe("UNVERIFIED");
    const audit = await ctx.db.select().from(eventStateTransitions).where(eq(eventStateTransitions.eventId, eventId));
    expect(audit.map((a) => a.toStatus)).toEqual(["UNVERIFIED"]);
  });

  it("queues re-verification on disputes without duplicating open jobs", async () => {
    const open = await ctx.db
      .select()
      .from(verificationJobs)
      .where(and(eq(verificationJobs.eventId, eventId), eq(verificationJobs.status, "pending")));
    expect(open).toHaveLength(1);
  });

  it("validates input and ignores client-supplied identity", async () => {
    const voter = await ctx.signIn("voter-5@example.com");
    expect((await signal("VERIFY", voter)).statusCode).toBe(400);
    const claim = await ctx.request({
      method: "POST",
      url: `/api/v1/events/${eventId}/signals`,
      token: voter,
      payload: { type: "CONFIRM", user_id: "someone-else", count: 100 },
    });
    expect(claim.statusCode).toBe(400);
    expect((await signal("CONFIRM", voter, "00000000-0000-4000-8000-00000000ffff")).statusCode).toBe(404);
    expect((await signal("CONFIRM", voter, "not-a-uuid")).statusCode).toBe(404);
  });

  it("refuses answers once an event has ended", async () => {
    const res = await ctx.request({ method: "POST", url: "/api/v1/reports", token: reporter, payload: { ...validReport, title: "Short-lived road closure on Fell", location: { coordinates: { latitude: 37.774, longitude: -122.437 } } } });
    const id = res.json().event_id;
    const transition = await ctx.app.inject({
      method: "POST",
      url: `/internal/v1/events/${id}/transition`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { to: "RESOLVED", reason: "Test: confirmed reopened" },
    });
    expect(transition.statusCode).toBe(200);
    const voter = await ctx.signIn("late-voter@example.com");
    expect((await signal("CONFIRM", voter, id)).statusCode).toBe(409);
  });
});

describe("follows", () => {
  it("follows, lists and unfollows events for the signed-in account", async () => {
    const user = await ctx.signIn("follower@example.com");
    const follow = await ctx.request({ method: "POST", url: `/api/v1/events/${eventId}/follow`, token: user });
    expect(follow.json()).toEqual({ following: true });
    // Idempotent.
    await ctx.request({ method: "POST", url: `/api/v1/events/${eventId}/follow`, token: user });
    const list = (await ctx.request({ method: "GET", url: "/api/v1/me/following", token: user })).json();
    expect(list.events.map((e: { id: string }) => e.id)).toEqual([eventId]);

    // Another account's follows are separate.
    const other = await ctx.signIn("not-a-follower@example.com");
    expect((await ctx.request({ method: "GET", url: "/api/v1/me/following", token: other })).json().events).toEqual([]);

    const unfollow = await ctx.request({ method: "DELETE", url: `/api/v1/events/${eventId}/follow`, token: user });
    expect(unfollow.json()).toEqual({ following: false });
    expect((await ctx.request({ method: "GET", url: "/api/v1/me/following", token: user })).json().events).toEqual([]);
  });

  it("404s for events that don't exist", async () => {
    const user = await ctx.signIn("follower-2@example.com");
    const res = await ctx.request({ method: "POST", url: "/api/v1/events/00000000-0000-4000-8000-00000000ffff/follow", token: user });
    expect(res.statusCode).toBe(404);
  });
});
