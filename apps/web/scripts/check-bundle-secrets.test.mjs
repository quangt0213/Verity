import { describe, expect, it } from "vitest";
import { scanText } from "./check-bundle-secrets.mjs";

describe("bundle secret scan", () => {
  it("passes ordinary client code", () => {
    expect(scanText('fetch(url,{headers:{Authorization:"Bearer "+token}})')).toEqual([]);
  });

  it("flags server secret names, credential shapes and known secret values", () => {
    expect(scanText('const k = process.env.NIMBLE_API_KEY')).toContain('secret variable name "NIMBLE_API_KEY"');
    expect(scanText("postgres://verity:hunter22@db.internal:5432/verity")).toContain("database URL with credentials");
    expect(scanText("-----BEGIN PRIVATE KEY-----")).toContain("PEM private key");
    expect(scanText(`k="rt_${"a".repeat(32)}"`)).toContain("RawTree API key");
    expect(scanText("x=sk_live_supersecretvalue", ["sk_live_supersecretvalue"])).toContain("a secret value from the environment");
  });
});
