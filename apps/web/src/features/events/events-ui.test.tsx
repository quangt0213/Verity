import type { EventDetail, EventSummary, Evidence } from "@verity/contracts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildDemoEvents, demoEventId } from "../../api/mock/fixtures";
import { fastMockApi, renderWithApp } from "../../test/render";
import { CommunitySection } from "./detail/CommunitySection";
import { EvidenceSection } from "./detail/EvidenceSection";
import { EventCard } from "./EventCard";

const NOW = new Date("2026-10-01T15:00:00Z");
const fixtures = buildDemoEvents(NOW);
const highway = fixtures.find((e) => e.id === demoEventId(101))!;

function summaryOf(detail: EventDetail): EventSummary {
  const { current_claims: _c, evidence_summary: _s, evidence: _e, timeline: _t, community: _m, ...summary } = detail;
  return summary;
}

describe("EventCard", () => {
  it("shows status, independent sources and when it was last checked", () => {
    renderWithApp(<EventCard event={summaryOf(highway)} now={NOW.getTime()} />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("3 independent sources (4 total)")).toBeInTheDocument();
    expect(screen.getByText("checked 4 min ago")).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("renders script injection in titles as harmless text", () => {
    const hostile = { ...summaryOf(highway), title: '<img src=x onerror="alert(1)"><script>alert(2)</script>' };
    const { container } = renderWithApp(<EventCard event={hostile} now={NOW.getTime()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(hostile.title)).toBeInTheDocument();
  });

  it("labels unverified community reports as verification in progress", () => {
    const smoke = fixtures.find((e) => e.id === demoEventId(108))!;
    renderWithApp(<EventCard event={summaryOf(smoke)} now={NOW.getTime()} />);
    expect(screen.getByText("Community report — verification in progress")).toBeInTheDocument();
    expect(screen.getByText("verifying now")).toBeInTheDocument();
  });
});

describe("EvidenceSection", () => {
  const base: Evidence = highway.evidence[0]!;

  function withEvidence(evidence: Evidence[], isDemo = false): EventDetail {
    return { ...highway, is_demo: isDemo, evidence, source_count: evidence.length, independent_source_count: evidence.length };
  }

  it("never renders a javascript: source as a link", () => {
    const { container } = renderWithApp(
      <EvidenceSection event={withEvidence([{ ...base, source_url: "javascript:alert(1)", source_domain: null }])} now={NOW.getTime()} />,
    );
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
  });

  it("links real sources safely in a new tab", () => {
    const { container } = renderWithApp(
      <EvidenceSection
        event={withEvidence([{ ...base, source_url: "https://www.dot.ca.gov/incident/1", source_domain: "www.dot.ca.gov" }])}
        now={NOW.getTime()}
      />,
    );
    const link = container.querySelector("a[href='https://www.dot.ca.gov/incident/1']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("disables demo source links and labels them", () => {
    const { container } = renderWithApp(<EvidenceSection event={highway} now={NOW.getTime()} />);
    expect(container.querySelectorAll("a[target='_blank']")).toHaveLength(0);
    expect(screen.getAllByText(/Demo source/).length).toBeGreaterThan(0);
  });

  it("groups copies of one report under one source, and labels what repeats what", async () => {
    renderWithApp(<EvidenceSection event={highway} now={NOW.getTime()} />);
    // 4 pages, 3 independent sources: the copy is grouped, not listed as a separate confirmation.
    expect(screen.getByText(/3 independent sources from 4 pages\. Copies of the same report count once\./)).toBeInTheDocument();
    expect(screen.getByText(/Also reported by 1 other page using the same underlying report/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(screen.getByText(/Repeats reporting from/)).toBeInTheDocument();
    expect(screen.getByText("Official source")).toBeInTheDocument();
    expect(screen.getAllByText("Primary source").length).toBeGreaterThan(0);
  });

  it("keeps Verity's own notes apart from verbatim quotes", () => {
    renderWithApp(<EvidenceSection event={withEvidence([{ ...base, agent_note: "Lane status checked against the incident map." }])} now={NOW.getTime()} />);
    expect(screen.getByText(/Verity's note \(not a quote\):/)).toBeInTheDocument();
  });

  it("shows a date-only time as a date and an exact time as an age, and marks out-of-date sources", () => {
    const now = Date.parse("2026-10-04T15:00:00Z");
    const dateOnly = { ...base, id: "d1", lineage_id: "l1", published_at: "2026-10-04T00:00:00.000Z", published_at_precision: "day" as const };
    const exact = { ...base, id: "d2", lineage_id: "l2", published_at: "2026-10-04T14:42:00.000Z", published_at_precision: "instant" as const };
    const stale = { ...base, id: "d3", lineage_id: "l3", freshness_state: "stale" as const, published_at: "2026-10-01T09:00:00.000Z" };
    renderWithApp(<EvidenceSection event={withEvidence([dateOnly, exact, stale])} now={now} />);
    expect(screen.getByText("Published Oct 4 (date only)")).toBeInTheDocument();
    expect(screen.getByText("Published 18 min ago")).toBeInTheDocument();
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.queryByText(/Published \d+ h ago/)).toBeNull();
  });

  it("shows extended-verification provenance subtly, never as a trust badge", () => {
    renderWithApp(<EvidenceSection event={withEvidence([{ ...base, found_via: "extended_verification" }])} now={NOW.getTime()} />);
    expect(screen.getByText("Source discovered during extended verification")).toBeInTheDocument();
    expect(screen.queryByText(/\bAI\b|\bagent\b/i)).toBeNull();
  });

  it("shows a date-only publication time as a calendar date, never as a clock-based age", () => {
    const dateOnly = { ...base, published_at: "2026-10-01T00:00:00.000Z", published_at_precision: "day" as const };
    renderWithApp(<EvidenceSection event={withEvidence([dateOnly])} now={Date.parse("2026-10-01T15:00:00Z")} />);
    expect(screen.getByText(/Published Oct 1 \(date only\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Published \d+ h ago/)).toBeNull();
  });

  it("renders hostile quotes as text", () => {
    const { container } = renderWithApp(
      <EvidenceSection event={withEvidence([{ ...base, quote: "<b onmouseover=alert(1)>closed</b>" }])} now={NOW.getTime()} />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<b onmouseover=alert\(1\)>closed<\/b>/)).toBeInTheDocument();
  });
});

describe("CommunitySection", () => {
  it("explains that answers aren't recorded when demo writes are off", async () => {
    renderWithApp(<CommunitySection event={highway} />, { api: fastMockApi("off") });
    expect(screen.getByText(/answers aren't recorded in this demo/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Not recorded/)).toBeInTheDocument();
    // Nothing pretends to be saved.
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the viewer's own answer, lets them change it, and never changes status", async () => {
    renderWithApp(<CommunitySection event={highway} />, { api: fastMockApi("simulate") });
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("button", { name: "Confirmed" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Dispute" }));
    expect(await screen.findByRole("button", { name: "Disputed" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-pressed", "false");
  });

  it("asks whether an active event is still happening", () => {
    renderWithApp(<CommunitySection event={highway} />);
    expect(screen.getByRole("group", { name: "Is this still happening?" })).toBeInTheDocument();
    for (const name of ["Yes", "No", "Not sure"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("doesn't ask about events that have ended", () => {
    const resolved = fixtures.find((e) => e.status === "RESOLVED")!;
    renderWithApp(<CommunitySection event={resolved} />);
    expect(screen.queryByText("Is this still happening?")).toBeNull();
  });
});
