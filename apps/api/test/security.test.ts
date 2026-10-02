import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, INTERNAL_TOKEN, ORIGIN, seedDemo, SF_BBOX, validReport, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await seedDemo(ctx.db);
});
afterAll(async () => ctx.close());

describe("CORS", () => {
  it("allows the configured frontend origin, never '*'", async () => {
    const res = await ctx.app.inject({
      method: "OPTIONS",
      url: "/api/v1/reports",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
  });

  it("gives other origins no CORS grant", async () => {
    const preflight = await ctx.app.inject({
      method: "OPTIONS",
      url: "/api/v1/reports",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const read = await ctx.app.inject({ method: "GET", url: "/api/v1/events", headers: { origin: "https://evil.example" } });
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
    const nullOrigin = await ctx.app.inject({ method: "GET", url: "/api/v1/events", headers: { origin: "null" } });
    expect(nullOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses state-changing browser requests from unexpected origins, even with a valid session", async () => {
    const token = await ctx.signIn("cors-user@example.com");
    const res = await ctx.request({
      method: "POST",
      url: "/api/v1/reports",
      token,
      headers: { origin: "https://evil.example" },
      payload: validReport,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });
});

describe("security headers and errors", () => {
  it("sets defensive headers on every response", async () => {
    const res = await ctx.request({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("echoes well-formed request ids and replaces malformed ones", async () => {
    const good = await ctx.request({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "trace-12345678" } });
    expect(good.headers["x-request-id"]).toBe("trace-12345678");
    const bad = await ctx.request({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "<script>" } });
    expect(bad.headers["x-request-id"]).not.toBe("<script>");
  });

  it("returns generic errors without stack traces or database details", async () => {
    const broken = await createTestContext();
    await broken.closeDatabase();
    const res = await broken.app.inject({ method: "GET", url: "/api/v1/events" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Something went wrong.", request_id: expect.any(String) } });
    expect(res.body).not.toMatch(/stack|pglite|postgres|select|closed/i);
    await broken.close();
  });

  it("rejects unknown query parameters and repeated parameters", async () => {
    expect((await ctx.request({ method: "GET", url: "/api/v1/events?admin=true" })).statusCode).toBe(400);
    expect((await ctx.request({ method: "GET", url: "/api/v1/events?statuses=VERIFIED&statuses=STALE" })).statusCode).toBe(400);
  });

  it("treats search text literally (no SQL or wildcard injection)", async () => {
    for (const q of ["' OR 1=1 --", "%", "_", "\\", "'; DROP TABLE events; --"]) {
      const res = await ctx.request({ method: "GET", url: `/api/v1/events?bbox=${SF_BBOX}&q=${encodeURIComponent(q)}` });
      expect(res.statusCode, q).toBe(200);
      expect(res.json().events).toEqual([]);
    }
    const stillThere = await ctx.request({ method: "GET", url: `/api/v1/events?bbox=${SF_BBOX}` });
    expect(stillThere.json().events.length).toBeGreaterThan(0);
  });

  it("rejects prototype-pollution payloads", async () => {
    const token = await ctx.signIn("proto@example.com");
    const res = await ctx.request({
      method: "POST",
      url: "/api/v1/reports",
      token,
      headers: { "content-type": "application/json" },
      payload: '{"__proto__":{"isAdmin":true},"category":"crash"}',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("internal endpoints", () => {
  it("require the internal token, refuse browsers, and are hidden when unconfigured", async () => {
    const url = "/internal/v1/events/00000000-0000-4000-8000-000000000101/transitions";
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url, headers: { authorization: "Bearer wrong-token" } })).statusCode).toBe(401);
    expect(
      (await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, origin: ORIGIN } })).statusCode,
    ).toBe(403);
    const ok = await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
    expect(ok.statusCode).toBe(200);

    const user = await ctx.signIn("not-an-operator@example.com");
    expect((await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(401);

    const hidden = await createTestContext({ INTERNAL_API_TOKEN: "" });
    expect((await hidden.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).statusCode).toBe(404);
    await hidden.close();
  });
});
