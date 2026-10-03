import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authSessions, authVerifications, reports, users } from "../src/db/schema";
import { createTestContext, validReport, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

describe("passwordless sign-in", () => {
  it("emails a 6-digit code, stores it hashed, and exchanges it for a bearer token", async () => {
    const start = await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "Alice@Example.com" } });
    expect(start.statusCode).toBe(202);
    const code = ctx.mailer.lastCodeFor("alice@example.com");
    expect(code).toMatch(/^\d{6}$/);

    const stored = await ctx.db.select().from(authVerifications);
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(row.value).not.toContain(code!);

    const verify = await ctx.request({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      payload: { email: "alice@example.com", code },
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.json();
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.user.email_masked).toBe("a•••@example.com");
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);

    const me = await ctx.request({ method: "GET", url: "/api/v1/me", token: body.token });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email_masked).toBe("a•••@example.com");
  });

  it("rejects a wrong code, and codes are single-use", async () => {
    await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "bob@example.com" } });
    const code = ctx.mailer.lastCodeFor("bob@example.com")!;
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await ctx.request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email: "bob@example.com", code: wrong } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/incorrect or has expired/);

    const ok = await ctx.request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email: "bob@example.com", code } });
    expect(ok.statusCode).toBe(200);
    const reuse = await ctx.request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email: "bob@example.com", code } });
    expect(reuse.statusCode).toBe(400);
  });

  it("invalidates a code after too many wrong attempts", async () => {
    await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "carol@example.com" } });
    const code = ctx.mailer.lastCodeFor("carol@example.com")!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await ctx.request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email: "carol@example.com", code: wrong } });
    }
    const late = await ctx.request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email: "carol@example.com", code } });
    expect(late.statusCode).toBe(400);
  });

  it("gives the same answer whether or not an account exists", async () => {
    await ctx.signIn("existing@example.com");
    const existing = await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "existing@example.com" } });
    const fresh = await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "nobody-yet@example.com" } });
    expect(existing.statusCode).toBe(fresh.statusCode);
    expect(existing.body).toBe(fresh.body);
  });

  it("rate-limits code requests per email", async () => {
    const email = "spam-target@example.com";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email } })).statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("validates sign-in input", async () => {
    expect((await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "not-an-email" } })).statusCode).toBe(400);
    expect(
      (await ctx.request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email: "a@example.com", code: "12ab" } })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email: "a@example.com", maypop_user_id: "x" } }))
        .statusCode,
    ).toBe(400);
  });

  it("signing out revokes the session", async () => {
    const token = await ctx.signIn("leaver@example.com");
    expect((await ctx.request({ method: "GET", url: "/api/v1/me", token })).statusCode).toBe(200);
    expect((await ctx.request({ method: "POST", url: "/api/v1/auth/sign-out", token })).statusCode).toBe(204);
    expect((await ctx.request({ method: "GET", url: "/api/v1/me", token })).statusCode).toBe(401);
  });

  it("never records IP addresses on sessions", async () => {
    await ctx.signIn("private@example.com");
    const sessions = await ctx.db.select({ ip: authSessions.ipAddress }).from(authSessions);
    expect(sessions.every((s) => s.ip === null)).toBe(true);
  });
});

describe("authorization", () => {
  it("rejects anonymous protected writes with a friendly prompt", async () => {
    for (const [method, url, payload] of [
      ["POST", "/api/v1/reports", validReport],
      ["POST", "/api/v1/events/00000000-0000-4000-8000-000000000101/signals", { type: "CONFIRM" }],
      ["POST", "/api/v1/events/00000000-0000-4000-8000-000000000101/follow", undefined],
      ["DELETE", "/api/v1/events/00000000-0000-4000-8000-000000000101/follow", undefined],
      ["GET", "/api/v1/me/following", undefined],
      ["GET", "/api/v1/me", undefined],
    ] as const) {
      const res = await ctx.request({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error).toMatchObject({ code: "auth_required", message: "Sign in to contribute." });
    }
  });

  it("rejects forged or malformed bearer tokens", async () => {
    for (const token of ["not-a-real-token-but-long-enough-0000", "abc.def", "x".repeat(600)]) {
      const res = await ctx.request({ method: "GET", url: "/api/v1/me", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("derives the reporter from the session; a client can't claim another user", async () => {
    const alice = await ctx.signIn("reporter-a@example.com");
    const bob = await ctx.signIn("reporter-b@example.com");
    const aliceId = await ctx.userIdFor(alice);

    const forged = await ctx.request({
      method: "POST",
      url: "/api/v1/reports",
      token: bob,
      payload: { ...validReport, created_by: aliceId, reporter_user_id: aliceId },
    });
    expect(forged.statusCode).toBe(400);
    expect(Object.keys(forged.json().error.fields)).toEqual(expect.arrayContaining(["_"]));

    const ok = await ctx.request({ method: "POST", url: "/api/v1/reports", token: bob, payload: validReport });
    expect(ok.statusCode).toBe(201);
    const [row] = await ctx.db.select().from(reports).where(eq(reports.id, ok.json().report_id));
    expect(row!.reporterUserId).toBe(await ctx.userIdFor(bob));
    expect(row!.reporterUserId).not.toBe(aliceId);
  });

  it("gives Maypop display identity no authority", async () => {
    const maypopHeaders = {
      "x-maypop-user-id": "5f0c7c3e-1111-4222-8333-444455556666",
      "x-maypop-role": "admin",
      "x-maypop-username": "Developer",
    };
    const anon = await ctx.request({ method: "POST", url: "/api/v1/reports", headers: maypopHeaders, payload: validReport });
    expect(anon.statusCode).toBe(401);

    const token = await ctx.signIn("maypop-tester@example.com");
    const withBodyClaim = await ctx.request({
      method: "POST",
      url: "/api/v1/reports",
      token,
      payload: { ...validReport, maypop_user_id: "5f0c7c3e-1111-4222-8333-444455556666", role: "admin" },
    });
    expect(withBodyClaim.statusCode).toBe(400);

    // No user is ever created or linked from a Maypop claim.
    const all = await ctx.db.select({ email: users.email }).from(users);
    expect(all.some((u) => u.email.includes("maypop") && u.email !== "maypop-tester@example.com")).toBe(false);
  });
});
