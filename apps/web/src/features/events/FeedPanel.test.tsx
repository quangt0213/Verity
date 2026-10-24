import type { EventDetail, EventSummary } from "@verity/contracts";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDemoEvents } from "../../api/mock/fixtures";
import { renderWithApp } from "../../test/render";
import type { ShellContext } from "../map/shell-context";
import { sameEventSummary } from "./EventCard";
import { FEED_PAGE_SIZE, FeedPanel } from "./FeedPanel";
import { DEFAULT_FILTERS, type EventFilters } from "./filters";

// EventCard calls scheduleText once per render, so its calls count card renders.
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../lib/time", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/time")>();
  return {
    ...original,
    scheduleText: (...args: Parameters<typeof original.scheduleText>) => {
      renders.count++;
      return original.scheduleText(...args);
    },
  };
});

const NOW = new Date("2026-10-01T15:00:00Z");
const base = buildDemoEvents(NOW)[0]!;

function summaryOf(detail: EventDetail): EventSummary {
  const { current_claims: _c, evidence_summary: _s, evidence: _e, timeline: _t, community: _m, ...summary } = detail;
  return summary;
}

function manyEvents(n: number): EventSummary[] {
  return Array.from({ length: n }, (_, i) => ({ ...summaryOf(base), id: `evt-${i}`, title: `Event number ${i}` }));
}

/** The test drives the shell's state through these, set once the shell mounts. */
const controls: { setEvents?: (events: EventSummary[]) => void; setFilters?: ShellContext["setFilters"] } = {};

function Shell({ initial, truncated = false }: { initial: EventSummary[]; truncated?: boolean }) {
  const [events, setEventsState] = useState(initial);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<EventFilters>(DEFAULT_FILTERS);
  useEffect(() => {
    controls.setEvents = setEventsState;
    controls.setFilters = setFiltersState;
  }, []);
  const context: ShellContext = {
    events,
    list: { isPending: false, isFetching: false, error: null, truncated, refetch: () => {} },
    zoomedOut: false,
    mapStatus: "ready",
    filters,
    setFilters: setFiltersState,
    highlightedId,
    setHighlightedId,
    focusOn: () => {},
    setSheet: () => {},
    isDesktop: true,
    now: NOW.getTime(),
  };
  return <Outlet context={context} />;
}

function renderFeed(events: EventSummary[], truncated = false) {
  return renderWithApp(<></>, { routes: [{ path: "/", element: <Shell initial={events} truncated={truncated} />, children: [{ index: true, element: <FeedPanel /> }] }] });
}

/**
 * The rendered cards, in order. A DOM query rather than getAllByRole: computing
 * the accessible name of every card dominated this file's run time. Names are
 * still asserted where they matter.
 */
const cards = () => [...screen.getByRole("list").querySelectorAll<HTMLElement>(":scope > li > a")];

beforeEach(() => {
  renders.count = 0;
});

describe("FeedPanel", () => {
  it("renders the first page of cards and reveals more on request, keeping counts and order", async () => {
    const user = userEvent.setup();
    renderFeed(manyEvents(110), true);
    expect(await screen.findByRole("heading", { name: "110 events in this area" })).toBeInTheDocument();
    expect(cards()).toHaveLength(FEED_PAGE_SIZE);
    expect(cards()[0]).toHaveAccessibleName(/Event number 0/);
    expect(screen.getByText(`Showing ${FEED_PAGE_SIZE} of 110`)).toHaveAttribute("role", "status");

    await user.click(screen.getByRole("button", { name: "Show 50 more" }));
    expect(cards()).toHaveLength(100);
    // Focus continues at the first card that appeared, in the original order.
    expect(document.activeElement).toBe(cards()[50]);
    expect(cards()[50]).toHaveAccessibleName(/Event number 50/);
    expect(screen.getByText("Showing 100 of 110")).toHaveAttribute("role", "status");

    await user.click(screen.getByRole("button", { name: "Show 10 more" }));
    expect(cards()).toHaveLength(110);
    expect(document.activeElement).toBe(cards()[100]);
    expect(screen.queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
    // The truncation notice stays last.
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[items.length - 1]).toHaveTextContent("More events match. Zoom in to see them all.");
  });

  it("shows every card without a button when they fit on one page", async () => {
    renderFeed(manyEvents(12));
    expect(await screen.findByRole("heading", { name: "12 events in this area" })).toBeInTheDocument();
    expect(cards()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it("a hover re-renders only the cards whose highlight changed", async () => {
    renderFeed(manyEvents(60));
    await screen.findByRole("heading", { name: "60 events in this area" });
    renders.count = 0;
    fireEvent.mouseEnter(cards()[3]!);
    expect(renders.count).toBe(1);
    renders.count = 0;
    fireEvent.mouseLeave(cards()[3]!);
    fireEvent.mouseEnter(cards()[4]!);
    // Card 3 loses the highlight, card 4 gains it.
    expect(renders.count).toBe(2);
  });

  it("a refetch with equal events re-renders no cards; a changed event re-renders only itself", async () => {
    const events = manyEvents(60);
    renderFeed(events);
    await screen.findByRole("heading", { name: "60 events in this area" });
    renders.count = 0;
    act(() => controls.setEvents!(events.map((e) => structuredClone(e))));
    expect(renders.count).toBe(0);
    act(() => controls.setEvents!(events.map((e, i) => (i === 7 ? { ...structuredClone(e), title: "Event number 7, updated" } : structuredClone(e)))));
    expect(renders.count).toBe(1);
  });

  it("a new filter starts again from the first page", async () => {
    const user = userEvent.setup();
    renderFeed(manyEvents(60));
    await user.click(await screen.findByRole("button", { name: "Show 10 more" }));
    expect(cards()).toHaveLength(60);
    act(() => controls.setFilters!((f) => ({ ...f, kind: "planned" })));
    expect(cards()).toHaveLength(FEED_PAGE_SIZE);
  });
});

describe("sameEventSummary", () => {
  it("compares by value, including nested fields", () => {
    const a = summaryOf(base);
    expect(sameEventSummary(a, structuredClone(a))).toBe(true);
    expect(sameEventSummary(a, { ...a, status: "RESOLVED" })).toBe(false);
    expect(sameEventSummary(a, { ...a, coordinates: { ...a.coordinates, latitude: a.coordinates.latitude + 0.01 } })).toBe(false);
  });
});
