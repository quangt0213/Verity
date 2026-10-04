import { describe, expect, it } from "vitest";
import { extractPublication, extractTitle, markdownToText, PAGE_LIMITS } from "../../src/verification/page-metadata";
import { DEFAULT_POLICY } from "../../src/verification/policy";
import { NOW } from "./factories";

const pub = (html: string) => extractPublication(html, NOW, DEFAULT_POLICY.dayPrecision, DEFAULT_POLICY.timeConflictToleranceMinutes);
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const meta = (attr: string, key: string, content: string) => `<meta ${attr}="${key}" content="${content}">`;

describe("publication date from page metadata (deterministic, by precedence)", () => {
  it("reads schema.org datePublished on an article, as an instant when it has a zone", () => {
    expect(pub(ld({ "@context": "https://schema.org", "@type": "NewsArticle", datePublished: "2026-10-03T03:30:00-07:00" }))).toEqual({
      time: { at: new Date("2026-10-03T10:30:00Z"), precision: "instant" },
      conflict: false,
      source: "json_ld",
      candidates: 1,
    });
  });

  it("finds articles inside @graph and with @type arrays", () => {
    const html = ld({ "@graph": [{ "@type": "WebSite" }, { "@type": ["NewsArticle", "Thing"], datePublished: "2026-10-03T08:00:00Z" }] });
    expect(pub(html).time).toEqual({ at: new Date("2026-10-03T08:00:00Z"), precision: "instant" });
  });

  it("follows the precedence: JSON-LD, then article:published_time, then other publication meta, then <time pubdate>", () => {
    expect(pub(meta("property", "article:published_time", "2026-10-03T07:00:00Z")).source).toBe("article_meta");
    expect(pub(meta("itemprop", "datePublished", "2026-10-03T07:00:00Z")).source).toBe("meta");
    expect(pub(meta("name", "parsely-pub-date", "2026-10-03T07:00:00Z")).source).toBe("meta");
    expect(pub(`<time itemprop="datePublished" datetime="2026-10-03T07:00:00Z">Oct 3</time>`).source).toBe("time_element");
    expect(pub(`<time pubdate datetime="2026-10-03T07:00:00Z">Oct 3</time>`).source).toBe("time_element");
    const all = ld({ "@type": "Article", datePublished: "2026-10-03T07:00:00Z" }) + meta("property", "article:published_time", "2026-10-03T07:00:30Z");
    expect(pub(all)).toMatchObject({ source: "json_ld", candidates: 2, conflict: false });
  });

  it("preserves precision: a date alone is a day; a consistent exact timestamp makes it precise", () => {
    expect(pub(ld({ "@type": "Article", datePublished: "2026-10-03" })).time).toEqual({ at: new Date("2026-10-03T00:00:00Z"), precision: "day" });
    const both = ld({ "@type": "Article", datePublished: "2026-10-03" }) + meta("property", "article:published_time", "2026-10-03T06:15:00Z");
    expect(pub(both).time).toEqual({ at: new Date("2026-10-03T06:15:00Z"), precision: "instant" });
  });

  it("withholds the time when credible publication fields materially conflict", () => {
    const html = ld({ "@type": "Article", datePublished: "2026-10-03T07:00:00Z" }) + meta("property", "article:published_time", "2026-09-12T07:00:00Z");
    expect(pub(html)).toEqual({ time: null, conflict: true, source: null, candidates: 2 });
    // Two article objects on one page with different dates (e.g. a list of stories): withheld too.
    expect(pub(ld([{ "@type": "NewsArticle", datePublished: "2026-10-03T07:00:00Z" }, { "@type": "NewsArticle", datePublished: "2026-10-01T07:00:00Z" }])).conflict).toBe(true);
  });

  it("never uses modification dates, comment dates, copyright years, generic <time> or dates in the prose", () => {
    const html = [
      ld({ "@type": "NewsArticle", dateModified: "2026-10-03T11:00:00Z", comment: [{ "@type": "Comment", datePublished: "2026-10-03T11:30:00Z" }] }),
      ld({ "@type": "Event", startDate: "2026-10-03T10:00:00Z", datePublished: "2026-10-03T10:00:00Z" }),
      meta("property", "article:modified_time", "2026-10-03T11:00:00Z"),
      meta("property", "og:updated_time", "2026-10-03T11:00:00Z"),
      meta("name", "date", "2026-10-03"),
      `<time datetime="2026-10-03T10:00:00Z">10 AM</time>`,
      "<p>Published October 3, 2026 at 9:00 AM. © 2026 Example News.</p>",
    ].join("\n");
    expect(pub(html)).toEqual({ time: null, conflict: false, source: null, candidates: 0 });
  });

  it("returns nothing when there is no publication metadata, and rejects unparseable or implausible values", () => {
    expect(pub("<html><head><title>x</title></head><body>No dates</body></html>").time).toBeNull();
    expect(pub(meta("property", "article:published_time", "3 hours ago")).time).toBeNull();
    expect(pub(meta("property", "article:published_time", "2031-01-01T00:00:00Z")).time).toBeNull();
  });

  it("treats the page as hostile data: malformed JSON, scripts and oversized blocks are ignored with bounded work", () => {
    const hostile = [
      `<script type="application/ld+json">{"@type":"Article","datePublished":</script>`,
      `<script>window.datePublished = "2026-10-03T07:00:00Z"; fetch("https://evil.example")</script>`,
      `<script type="application/ld+json">${" ".repeat(PAGE_LIMITS.jsonLdBlockChars + 1)}</script>`,
      `<meta property="article:published_time" content="2026-10-03T07:00:00Z" onload="alert(1)">`,
    ].join("");
    expect(pub(hostile)).toMatchObject({ source: "article_meta", candidates: 1 });
    // Thousands of meta tags: only a bounded number is examined.
    const flood = Array.from({ length: 5000 }, () => meta("name", "viewport", "width=device-width")).join("") + meta("property", "article:published_time", "2026-10-03T07:00:00Z");
    expect(pub(flood).time).toBeNull();
    // Deeply nested JSON-LD stops at the depth bound.
    let deep: Record<string, unknown> = { "@type": "Article", datePublished: "2026-10-03T07:00:00Z" };
    for (let i = 0; i < 50; i++) deep = { "@type": "WebPage", mainEntity: deep };
    expect(pub(ld(deep)).time).toBeNull();
  });
});

describe("page text and title", () => {
  it("turns Readability markdown into plain text, keeping words and line structure, dropping links and images", () => {
    const md = "# Mission St closed\n\n![photo](https://img.example/a.jpg)\nAll lanes of [Mission St](https://x.example) are **closed** at 22nd St.\n\n- Detour via Valencia St\n> Police said crews are on scene.";
    const text = markdownToText(md);
    expect(text).toBe("Mission St closed\n\nAll lanes of Mission St are closed at 22nd St.\n\nDetour via Valencia St\nPolice said crews are on scene.");
    expect(text).not.toMatch(/https?:|!\[|\]\(/);
  });

  it("caps the text kept for evidence processing", () => {
    expect(markdownToText("word ".repeat(100_000)).length).toBeLessThanOrEqual(PAGE_LIMITS.textChars);
  });

  it("reads og:title, else <title>, as plain capped text", () => {
    expect(extractTitle(`<meta property="og:title" content="Mission St &amp; 22nd closed">`)).toBe("Mission St & 22nd closed");
    expect(extractTitle(`<title>  <b>Road</b> closed\n now </title>`)).toBe("Road closed now");
    expect(extractTitle(`<title>${"x".repeat(1000)}</title>`)!.length).toBe(PAGE_LIMITS.titleChars);
    expect(extractTitle("<p>none</p>")).toBeNull();
  });
});
