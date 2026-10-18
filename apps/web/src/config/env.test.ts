import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_STYLE_LIGHT } from "./defaults";
import { parseApiBaseUrl, resolveConfig } from "./env";

describe("resolveConfig", () => {
  it("never silently shows demo data in a production build", () => {
    const config = resolveConfig({}, false);
    expect(config.dataSource.kind).toBe("unconfigured");
  });

  it("uses labeled demo data in development when no service is configured", () => {
    expect(resolveConfig({}, true).dataSource).toEqual({ kind: "mock", writes: "simulate" });
  });

  it("allows an explicit demo build, with simulated writes off by default", () => {
    expect(resolveConfig({ VITE_VERITY_DATA_SOURCE: "mock" }, false).dataSource).toEqual({ kind: "mock", writes: "off" });
    expect(resolveConfig({ VITE_VERITY_DATA_SOURCE: "mock", VITE_MOCK_WRITES: "simulate" }, false).dataSource).toEqual({
      kind: "mock",
      writes: "simulate",
    });
  });

  it("uses the configured https service", () => {
    expect(resolveConfig({ VITE_VERITY_API_URL: "https://api.verity.example/" }, false).dataSource).toEqual({
      kind: "api",
      baseUrl: "https://api.verity.example",
    });
  });

  it("refuses an insecure service URL in production", () => {
    expect(resolveConfig({ VITE_VERITY_API_URL: "http://api.verity.example" }, false).dataSource.kind).toBe("unconfigured");
  });

  it("falls back to default map styles for invalid URLs", () => {
    expect(resolveConfig({ VITE_MAP_STYLE_URL_LIGHT: "javascript:alert(1)" }, true).map.styleLight).toBe(DEFAULT_MAP_STYLE_LIGHT);
  });
});

describe("parseApiBaseUrl", () => {
  it("rejects credentials, queries and non-https URLs", () => {
    expect(parseApiBaseUrl("https://user:pass@api.example.com", false)).toHaveProperty("error");
    expect(parseApiBaseUrl("https://api.example.com/?key=abc", false)).toHaveProperty("error");
    expect(parseApiBaseUrl("http://api.example.com", false)).toHaveProperty("error");
    expect(parseApiBaseUrl("not a url", false)).toHaveProperty("error");
  });

  it("allows plain http only for localhost during development", () => {
    expect(parseApiBaseUrl("http://localhost:8787", true)).toBe("http://localhost:8787");
    expect(parseApiBaseUrl("http://localhost:8787", false)).toHaveProperty("error");
    expect(parseApiBaseUrl("http://10.0.0.5:8787", true)).toHaveProperty("error");
  });
});
