import { describe, expect, it } from "vitest";
import { canonicalizeUrl, publisherDomain } from "../../src/verification/url";

const canon = (raw: string) => {
  const result = canonicalizeUrl(raw);
  if (!result.ok) throw new Error(`rejected: ${raw} (${result.reason})`);
  return result.url;
};

describe("canonicalizeUrl", () => {
  it("C: puts tracking variants of one URL together", () => {
    const variants = [
      "https://News.Example.com/a/story?id=7",
      "https://news.example.com:443/a/story?utm_source=x&id=7",
      "https://news.example.com/a/story?id=7&utm_source=y&utm_medium=social&fbclid=abc",
      "https://news.example.com/a/story?gclid=1&id=7#comments",
      "https://news.example.com./a/story?id=7&mc_cid=9&mc_eid=8",
      "https://news.example.com/a/story?id=7&",
    ];
    expect(new Set(variants.map(canon))).toEqual(new Set(["https://news.example.com/a/story?id=7"]));
  });

  it("orders remaining parameters safely, keeping repeated keys in their original order", () => {
    expect(canon("https://x.example/s?b=2&a=1")).toBe(canon("https://x.example/s?a=1&b=2"));
    expect(canon("https://x.example/s?tag=b&tag=a")).toBe("https://x.example/s?tag=b&tag=a");
    expect(canon("https://x.example/s?tag=b&tag=a")).not.toBe(canon("https://x.example/s?tag=a&tag=b"));
  });

  it("keeps value encoding exactly as it was", () => {
    expect(canon("https://x.example/s?q=a,b&utm_source=z")).toBe("https://x.example/s?q=a,b");
    expect(canon("https://x.example/s?q=a%2Cb")).toBe("https://x.example/s?q=a%2Cb");
  });

  it.each([
    ["article id", "https://x.example/article?id=1", "https://x.example/article?id=2"],
    ["WordPress post", "https://x.example/?p=123", "https://x.example/?p=124"],
    ["pagination", "https://x.example/live?story=a&page=2", "https://x.example/live?story=a&page=3"],
    ["a 'ref' parameter is not assumed to be tracking", "https://x.example/s?ref=alerts", "https://x.example/s"],
    ["a parameter that merely starts with 'utm'", "https://x.example/s?utmost=1", "https://x.example/s"],
    ["trailing slash", "https://x.example/story", "https://x.example/story/"],
    ["path case", "https://x.example/Story", "https://x.example/story"],
    ["AMP path", "https://x.example/story/amp", "https://x.example/story"],
    ["AMP parameter", "https://x.example/story?amp=1", "https://x.example/story"],
    ["mobile host", "https://m.x.example/story", "https://x.example/story"],
    ["www host", "https://www.x.example/story", "https://x.example/story"],
    ["scheme", "http://x.example/story", "https://x.example/story"],
    ["hash route", "https://x.example/#/article/1", "https://x.example/#/article/2"],
    ["hashbang route", "https://x.example/#!/alerts/9", "https://x.example/"],
  ])("D: never merges distinct resources (%s)", (_label, a, b) => {
    expect(canon(a)).not.toBe(canon(b));
  });

  it("drops plain navigation fragments but keeps hash routes", () => {
    expect(canon("https://x.example/story#section-2")).toBe("https://x.example/story");
    expect(canon("https://x.example/#/article/1")).toBe("https://x.example/#/article/1");
  });

  it("reports whether anything changed", () => {
    expect(canonicalizeUrl("https://x.example/story")).toEqual({ ok: true, url: "https://x.example/story", changed: false });
    expect(canonicalizeUrl("https://x.example/story?utm_source=a")).toMatchObject({ ok: true, changed: true });
  });

  it.each([
    "javascript:alert(1)",
    "http://127.0.0.1/admin",
    "http://localhost/x",
    "https://user:pw@x.example/",
    "http://x.example:8080/",
    "not a url",
  ])("refuses unsafe or invalid URLs: %s", (raw) => {
    expect(canonicalizeUrl(raw).ok).toBe(false);
  });
});

describe("publisherDomain", () => {
  it("groups subdomains of one organization using the Public Suffix List", () => {
    expect(publisherDomain("https://news.bbc.co.uk/1/story")).toBe("bbc.co.uk");
    expect(publisherDomain("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(publisherDomain("https://m.sfchronicle.com/x")).toBe("sfchronicle.com");
  });

  it("keeps different sites on a shared hosting suffix distinct", () => {
    expect(publisherDomain("https://alice.github.io/post")).toBe("alice.github.io");
    expect(publisherDomain("https://bob.github.io/post")).toBe("bob.github.io");
  });

  it("has no publisher for IP addresses or unknown suffixes", () => {
    expect(publisherDomain("http://192.168.1.1/x")).toBeNull();
    expect(publisherDomain("https://intranet.invalidtld/x")).toBeNull();
  });
});
