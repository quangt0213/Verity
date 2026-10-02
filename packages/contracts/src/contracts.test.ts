import { describe, expect, it } from "vitest";
import {
  bboxSchema,
  checkPublicHttpUrl,
  communityResponseInputSchema,
  eventSummarySchema,
  isSafeHttpUrl,
  LIMITS,
  listEventsQuerySchema,
  normalizeMultiline,
  normalizeSingleLine,
  reportEventInputSchema,
} from "./index";

const validReport = {
  category: "road_closure",
  title: "Road blocked near Mission St",
  description: "Two lanes closed, police directing traffic.",
  location: { coordinates: { latitude: 37.76, longitude: -122.42 }, label: "Mission St & 24th" },
  source_url: "https://www.sfchronicle.com/bayarea/article/closure.php",
};

describe("reportEventInputSchema", () => {
  it("accepts a well-formed report", () => {
    const parsed = reportEventInputSchema.parse(validReport);
    expect(parsed.title).toBe("Road blocked near Mission St");
  });

  it.each([
    ["latitude above 90", { latitude: 90.0001, longitude: 0 }],
    ["latitude below -90", { latitude: -91, longitude: 0 }],
    ["longitude above 180", { latitude: 0, longitude: 180.5 }],
    ["longitude below -180", { latitude: 0, longitude: -181 }],
    ["NaN latitude", { latitude: Number.NaN, longitude: 0 }],
    ["infinite longitude", { latitude: 0, longitude: Number.POSITIVE_INFINITY }],
    ["string coordinates", { latitude: "37.7", longitude: "-122.4" }],
  ])("rejects invalid coordinates: %s", (_label, coordinates) => {
    const result = reportEventInputSchema.safeParse({
      ...validReport,
      location: { coordinates },
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized descriptions", () => {
    const result = reportEventInputSchema.safeParse({
      ...validReport,
      description: "x".repeat(LIMITS.descriptionMax + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized and too-short titles", () => {
    expect(
      reportEventInputSchema.safeParse({ ...validReport, title: "y".repeat(LIMITS.titleMax + 1) }).success,
    ).toBe(false);
    expect(reportEventInputSchema.safeParse({ ...validReport, title: "  a  " }).success).toBe(false);
  });

  it("rejects unknown categories", () => {
    expect(reportEventInputSchema.safeParse({ ...validReport, category: "alien_landing" }).success).toBe(
      false,
    );
  });

  it("rejects unknown fields, including client-supplied identity", () => {
    expect(reportEventInputSchema.safeParse({ ...validReport, user_id: "someone-else" }).success).toBe(false);
    expect(reportEventInputSchema.safeParse({ ...validReport, status: "VERIFIED" }).success).toBe(false);
  });

  it.each([
    "not a url",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://",
  ])("rejects malformed or non-http URLs: %s", (source_url) => {
    expect(reportEventInputSchema.safeParse({ ...validReport, source_url }).success).toBe(false);
  });

  it("strips control and bidi-override characters from titles", () => {
    const parsed = reportEventInputSchema.parse({
      ...validReport,
      title: `Crash${String.fromCharCode(0x202e)}on${String.fromCharCode(0x07)} Main   St`,
    });
    expect(parsed.title).toBe("Crashon Main St");
  });
});

describe("checkPublicHttpUrl (SSRF first gate)", () => {
  it.each([
    "http://localhost/admin",
    "http://localhost.:8080/",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://10.0.0.5/",
    "http://172.16.4.1/",
    "http://192.168.1.1/router",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0/",
    "http://printer.local/",
    "http://intranet/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
  ])("rejects %s", (url) => {
    expect(checkPublicHttpUrl(url).ok).toBe(false);
  });

  it.each([
    "https://www.dot.ca.gov/caltrans-near-me/district-4",
    "http://www.sfgate.com/news/article.php",
    "https://example.com:443/path?q=1",
  ])("accepts public URL %s", (url) => {
    expect(checkPublicHttpUrl(url).ok).toBe(true);
  });
});

describe("isSafeHttpUrl", () => {
  it("only allows absolute http(s) links", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("/relative")).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
  });
});

describe("communityResponseInputSchema", () => {
  it("accepts each supported response kind", () => {
    for (const input of [
      { kind: "confirm" },
      { kind: "dispute", reason: "Road is open now" },
      { kind: "resolved" },
      { kind: "still_happening", answer: "not_sure" },
      { kind: "update", text: "Now only one lane closed." },
    ]) {
      expect(communityResponseInputSchema.safeParse(input).success).toBe(true);
    }
  });

  it("rejects attempts to act as another user or set a status", () => {
    expect(communityResponseInputSchema.safeParse({ kind: "confirm", user_id: "u_2" }).success).toBe(false);
    expect(communityResponseInputSchema.safeParse({ kind: "confirm", role: "admin" }).success).toBe(false);
    expect(communityResponseInputSchema.safeParse({ kind: "verify" }).success).toBe(false);
  });

  it("rejects empty updates", () => {
    expect(communityResponseInputSchema.safeParse({ kind: "update", text: "   " }).success).toBe(false);
  });
});

describe("listEventsQuerySchema / bbox", () => {
  it("accepts a city-sized viewport", () => {
    expect(listEventsQuerySchema.safeParse({ bbox: [-122.55, 37.7, -122.35, 37.82] }).success).toBe(true);
  });

  it("rejects inverted and oversized viewports", () => {
    expect(bboxSchema.safeParse([-122.35, 37.7, -122.55, 37.82]).success).toBe(false);
    expect(bboxSchema.safeParse([-130, 30, -110, 45]).success).toBe(false);
  });
});

describe("eventSummarySchema", () => {
  it("rejects more independent sources than total sources", () => {
    const result = eventSummarySchema.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Test",
      summary: "",
      category: "crash",
      coordinates: { latitude: 1, longitude: 1 },
      approximate_location: "Somewhere",
      affected_area: null,
      status: "VERIFIED",
      verification_state: "idle",
      origin: "community_report",
      source_count: 1,
      independent_source_count: 3,
      community_confirmation_count: 0,
      community_dispute_count: 0,
      first_seen_at: "2026-10-01T12:00:00Z",
      last_updated_at: "2026-10-01T12:00:00Z",
      last_verified_at: null,
      last_checked_at: null,
      scheduled_start_at: null,
      scheduled_end_at: null,
      expires_at: null,
      is_demo: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("text normalization", () => {
  it("collapses whitespace on single lines", () => {
    expect(normalizeSingleLine("  a \n\t b  ")).toBe("a b");
  });

  it("keeps paragraph breaks but caps blank runs", () => {
    expect(normalizeMultiline("one\r\n\r\n\r\n\r\ntwo  three")).toBe("one\n\ntwo three");
  });
});
