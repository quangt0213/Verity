import type { Maypop } from "@basilica-digital/maypop-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMaypop, safeLaunchPath, shareLink, snapshotFrom } from "./session";

function fakeSdk(overrides: Partial<Record<string, unknown>> = {}): Maypop {
  return {
    ready: () => Promise.resolve(),
    user: {
      id: "5f0c7c3e-1111-4222-8333-444455556666",
      username: "Alex",
      role: "admin",
      avatarUrl: "https://img.example.com/a.png",
      connected: true,
      isAnonymous: false,
      scopes: "identity:read kv:read kv:write",
    },
    mode: "read-write",
    permissions: ["identity:read", "kv:read", "kv:write"],
    signInRequired: false,
    theme: "dark",
    launchPath: "/events/00000000-0000-4000-8000-000000000101",
    signIn: vi.fn(),
    share: vi.fn(() => Promise.resolve()),
    on: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as Maypop;
}

afterEach(() => vi.useRealTimers());

describe("connectMaypop", () => {
  it("stays standalone outside an iframe without loading the SDK", async () => {
    const load = vi.fn();
    const result = await connectMaypop({ embedded: false, load });
    expect(result.snapshot.status).toBe("standalone");
    expect(load).not.toHaveBeenCalled();
  });

  it("connects when the host completes the handshake", async () => {
    const result = await connectMaypop({ embedded: true, load: async () => fakeSdk() });
    expect(result.snapshot).toMatchObject({
      status: "connected",
      viewer: { username: "Alex", isAnonymous: false, roleHint: "admin" },
      hostTheme: "dark",
      mode: "read-write",
    });
  });

  it("continues standalone if no host answers in time", async () => {
    vi.useFakeTimers();
    const pending = connectMaypop({ embedded: true, timeoutMs: 1000, load: async () => fakeSdk({ ready: () => new Promise(() => {}) }) });
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).snapshot.status).toBe("standalone");
  });

  it("continues standalone if the SDK can't load", async () => {
    const result = await connectMaypop({
      embedded: true,
      load: async () => {
        throw new Error("blocked");
      },
    });
    expect(result.snapshot.status).toBe("standalone");
  });
});

describe("snapshotFrom", () => {
  it("drops non-http avatar URLs", () => {
    const sdk = fakeSdk({
      user: { id: "x", username: "Eve", role: "reader", avatarUrl: "javascript:alert(1)", connected: true, isAnonymous: false, scopes: "" },
    });
    expect(snapshotFrom(sdk).viewer?.avatarUrl).toBeNull();
  });

  it("keeps the role only as a display hint", () => {
    const snapshot = snapshotFrom(fakeSdk());
    expect(snapshot.viewer).not.toHaveProperty("role");
    expect(snapshot.viewer?.roleHint).toBe("admin");
  });
});

describe("safeLaunchPath", () => {
  it("only accepts this app's routes", () => {
    expect(safeLaunchPath("/events/abc-123")).toBe("/events/abc-123");
    expect(safeLaunchPath("/settings")).toBe("/settings");
    expect(safeLaunchPath("/events/../../admin")).toBeNull();
    expect(safeLaunchPath("javascript:alert(1)")).toBeNull();
    expect(safeLaunchPath("https://evil.example/")).toBeNull();
    expect(safeLaunchPath(null)).toBeNull();
  });
});

describe("shareLink", () => {
  it("uses Maypop's share card and surfaces its user-facing errors", async () => {
    const ok = await shareLink(fakeSdk(), "/events/abc", "Title");
    expect(ok).toEqual({ ok: true, via: "maypop" });

    const failing = fakeSdk({
      share: () => Promise.reject(Object.assign(new Error("This app must be published to a group before you can share."), { code: "maypop/share-unavailable" })),
    });
    expect(await shareLink(failing, "/events/abc", "Title")).toEqual({
      ok: false,
      message: "This app must be published to a group before you can share.",
    });
  });
});
