import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { EmailDeliveryError, RESEND_ENDPOINT, resendMailer } from "../src/auth/mailer";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { json, mockFetch } from "./providers/mock-fetch";

// Never a real key, and no test here reaches the network: every fetch is a stub.
const KEY = `re_test_${"k".repeat(24)}`;
const FROM = "Verity <login@veritylive.app>";
const TO = "alice@example.com";
const CODE = "482913";

const send = (fetch: typeof globalThis.fetch, timeoutMs?: number) =>
  resendMailer({ apiKey: KEY, from: FROM, fetch, timeoutMs }).sendSignInCode({ to: TO, code: CODE });

/** A delivery error, checked to carry no key, code or recipient. */
async function deliveryError(promise: Promise<void>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EmailDeliveryError);
  const message = (error as Error).message;
  for (const secret of [KEY, CODE, TO]) expect(message).not.toContain(secret);
  return message;
}

describe("resend mailer", () => {
  it("sends the sign-in email to Resend's API only, with the existing content", async () => {
    const mock = mockFetch(() => json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    await send(mock.fetch);

    expect(mock.calls).toHaveLength(1);
    const [call] = mock.calls;
    expect(call!.url).toBe("https://api.resend.com/emails");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call!.headers["content-type"]).toBe("application/json");
    expect(call!.signal).toBeInstanceOf(AbortSignal);
    expect(call!.body).toEqual({
      from: FROM,
      to: [TO],
      subject: `${CODE} is your Verity sign-in code`,
      text: [
        `Your Verity sign-in code is ${CODE}.`,
        "",
        "It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.",
        "",
        "Verity will never ask you for this code outside the app.",
      ].join("\n"),
    });
  });

  it("refuses redirects, so the key never leaves the Resend endpoint", async () => {
    let redirect: RequestInit["redirect"];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return json({ id: "x" });
    }) as typeof globalThis.fetch;
    await send(fetch);
    expect(redirect).toBe("error");
    expect(RESEND_ENDPOINT).toBe("https://api.resend.com/emails");
  });

  it.each([
    [401, "missing_api_key", "resend_http_401 missing_api_key"],
    [403, "restricted_api_key", "resend_http_403 restricted_api_key"],
    [403, "validation_error", "resend_http_403 validation_error"],
  ])("fails on an authentication or authorization error (%i %s)", async (status, name, expected) => {
    const mock = mockFetch(() => json({ statusCode: status, name, message: `API key ${KEY} rejected for ${TO}` }, status));
    expect(await deliveryError(send(mock.fetch))).toBe(expected);
  });

  it.each([
    [422, "missing_required_field"],
    [429, "rate_limit_exceeded"],
    [500, "application_error"],
    [503, "service_unavailable"],
  ])("fails on an API error (%i %s)", async (status, name) => {
    const mock = mockFetch(() => json({ statusCode: status, name, message: "details" }, status));
    expect(await deliveryError(send(mock.fetch))).toBe(`resend_http_${status} ${name}`);
  });

  it("ignores an error body that isn't Resend's JSON, or a type that doesn't look like one", async () => {
    const html = mockFetch(() => new Response(`<html>${CODE}</html>`, { status: 502 }));
    expect(await deliveryError(send(html.fetch))).toBe("resend_http_502");
    const odd = mockFetch(() => json({ name: `Bearer ${KEY}` }, 400));
    expect(await deliveryError(send(odd.fetch))).toBe("resend_http_400");
  });

  it("treats any non-success status as a failure, even without a body", async () => {
    const mock = mockFetch(() => new Response(null, { status: 404 }));
    expect(await deliveryError(send(mock.fetch))).toBe("resend_http_404");
  });

  it("fails on a network error without echoing it", async () => {
    const mock = mockFetch(() => {
      throw new TypeError(`fetch failed for ${TO} with ${KEY}`);
    });
    expect(await deliveryError(send(mock.fetch))).toBe("resend_network");
  });

  it("gives up when the API doesn't answer in time", async () => {
    // Hangs until the mailer's own timeout aborts the request.
    const mock = mockFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal!.addEventListener("abort", () => reject(call.signal!.reason));
        }),
    );
    expect(await deliveryError(send(mock.fetch, 20))).toBe("resend_timeout after 20 ms");
  });
});

describe("resend transport in the sign-in flow", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function resendApp() {
    const config = loadConfig({
      NODE_ENV: "test",
      VERITY_ALLOWED_ORIGINS: "https://app.verity.test",
      AUTH_EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: KEY,
      AUTH_EMAIL_FROM: FROM,
    });
    const database = createDatabase("pglite:memory");
    await database.migrate();
    const app = await buildApp({ config, db: database.db });
    const start = (email: string) =>
      app.inject({ method: "POST", url: "/api/v1/auth/email/start", payload: { email }, headers: { origin: "https://app.verity.test" } });
    return { app, start, close: async () => (await app.close(), await database.close()) };
  }

  it("delivers a six-digit code through Resend, and the code signs in", async () => {
    const mock = mockFetch(() => json({ id: "email-id" }));
    vi.stubGlobal("fetch", mock.fetch);
    const ctx = await resendApp();
    try {
      const start = await ctx.start(TO);
      expect(start.statusCode).toBe(202);
      await vi.waitFor(() => expect(mock.calls).toHaveLength(1));
      const code = /^(\d{6}) is your Verity sign-in code$/.exec(String(mock.calls[0]!.body!.subject))?.[1];
      expect(code).toMatch(/^\d{6}$/);
      expect(mock.calls[0]!.body!.from).toBe(FROM);

      const verify = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/email/verify",
        payload: { email: TO, code },
        headers: { origin: "https://app.verity.test" },
      });
      expect(verify.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it("answers the same when delivery fails, and logs only a safe reason", async () => {
    const mock = mockFetch(() => json({ statusCode: 401, name: "missing_api_key", message: "Missing API key" }, 401));
    vi.stubGlobal("fetch", mock.fetch);
    const ctx = await resendApp();
    const errors = vi.spyOn(ctx.app.log, "error");
    try {
      const failed = await ctx.start(TO);
      expect(failed.statusCode).toBe(202);
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith({ err: "resend_http_401 missing_api_key" }, "sign-in email delivery failed"));
      const logged = JSON.stringify(errors.mock.calls);
      const code = /^(\d{6})/.exec(String(mock.calls[0]!.body!.subject))![1]!;
      for (const secret of [KEY, code, TO]) expect(logged).not.toContain(secret);

      mock.calls.length = 0;
      const other = await ctx.start("bob@example.com");
      expect(other.statusCode).toBe(failed.statusCode);
      expect(other.body).toBe(failed.body);
    } finally {
      await ctx.close();
    }
  });
});
