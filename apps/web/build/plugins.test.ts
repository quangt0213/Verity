import { describe, expect, it } from "vitest";
import { buildCsp, findSecretLikePublicVars } from "./plugins";

describe("public env guard", () => {
  it("flags secret-looking VITE_ variables", () => {
    expect(
      findSecretLikePublicVars({
        VITE_NIMBLE_API_KEY: "x",
        VITE_RAWTREE_API_KEY: "x",
        VITE_SESSION_SECRET: "x",
        VITE_DATABASE_URL: "x",
        VITE_AUTH_TOKEN: "x",
      }).sort(),
    ).toEqual(["VITE_AUTH_TOKEN", "VITE_DATABASE_URL", "VITE_NIMBLE_API_KEY", "VITE_RAWTREE_API_KEY", "VITE_SESSION_SECRET"]);
  });

  it("allows the intended public configuration", () => {
    expect(
      findSecretLikePublicVars({
        VITE_VERITY_API_URL: "https://api.example.com",
        VITE_VERITY_DATA_SOURCE: "api",
        VITE_MAP_STYLE_URL_LIGHT: "https://tiles.example.com/style.json",
        VITE_DEFAULT_CENTER: "37.7,-122.4",
      }),
    ).toEqual([]);
  });
});

describe("buildCsp", () => {
  const csp = buildCsp({
    apiUrl: "https://api.verity.example/base",
    mapStyleUrls: ["https://tiles.openfreemap.org/styles/positron", "not a url"],
    extraMapOrigins: ["https://glyphs.example.com"],
  });

  it("allows connections only to the app, Maypop, the Verity service and the basemap", () => {
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src"));
    expect(connect).toBe(
      "connect-src 'self' https://*.maypop.ai https://api.verity.example https://tiles.openfreemap.org https://glyphs.example.com",
    );
  });

  it("forbids inline/eval scripts, plugins and framing other sites", () => {
    expect(csp).toContain("script-src 'self' https://*.maypop.ai");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
