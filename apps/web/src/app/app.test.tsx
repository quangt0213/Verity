import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fastMockApi, renderWithApp } from "../test/render";
import { routes } from "./router";

describe("app shell", () => {
  it("sends first-time visitors to onboarding", async () => {
    renderWithApp(<></>, { routes, path: "/" });
    expect(await screen.findByRole("heading", { name: "Know what's actually happening around you." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Explore nearby/ })).toBeInTheDocument();
  });

  it("keeps the event list working when the map can't load", async () => {
    renderWithApp(<></>, { routes, path: "/map" });
    // jsdom has no WebGL, so the map takes its fallback path...
    expect(await screen.findByText("Map unavailable")).toBeInTheDocument();
    // ...and the list still loads events for the default area.
    const list = await screen.findByRole("region", { name: "Events in this area" });
    await waitFor(() => expect(within(list).getAllByRole("link").length).toBeGreaterThan(3));
    expect(within(list).getByText("US-101 northbound closed near Cesar Chavez St")).toBeInTheDocument();
  });

  it("labels demo data on every screen", async () => {
    renderWithApp(<></>, { routes, path: "/map" });
    expect(await screen.findByText(/These are not real current events/)).toBeInTheDocument();
  });

  it("opens an event with its evidence, community and timeline", async () => {
    renderWithApp(<></>, { routes, path: "/events/00000000-0000-4000-8000-000000000101" });
    expect(await screen.findByRole("heading", { level: 1, name: /US-101 northbound closed/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Why Verity says this" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Community input" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByText("Verified by current evidence.")).toBeInTheDocument();
  });

  it("shows a helpful message for unknown events", async () => {
    renderWithApp(<></>, { routes, path: "/events/not-a-real-event" });
    expect(await screen.findByText(/couldn't be found/)).toBeInTheDocument();
  });
});

describe("report flow", () => {
  async function fillValidReport() {
    await userEvent.click(screen.getByRole("radio", { name: "Crash" }));
    await userEvent.type(screen.getByLabelText("Short title"), "Two cars collided on Folsom St");
  }

  it("validates before submitting", async () => {
    renderWithApp(<></>, { routes, path: "/report", api: fastMockApi("simulate") });
    await userEvent.type(await screen.findByLabelText("Short title"), "x");
    await userEvent.type(screen.getByLabelText(/Source link/), "http://192.168.1.1/admin");
    await userEvent.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByText("Choose a category")).toBeInTheDocument();
    expect(screen.getByText(/at least 4 characters/)).toBeInTheDocument();
    expect(screen.getByText(/not an IP address/)).toBeInTheDocument();
  });

  it("submits nothing when demo writes are off", async () => {
    renderWithApp(<></>, { routes, path: "/report", api: fastMockApi("off") });
    expect(await screen.findByText(/Reporting is off in this demo/)).toBeInTheDocument();
    await fillValidReport();
    await userEvent.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Not recorded/);
  });

  it("creates an unverified community report in demo mode and opens it", async () => {
    const { router } = renderWithApp(<></>, { routes, path: "/report", api: fastMockApi("simulate") });
    await screen.findByLabelText("Short title");
    await fillValidReport();
    await userEvent.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/events\//));
    expect(await screen.findByRole("heading", { level: 1, name: "Two cars collided on Folsom St" })).toBeInTheDocument();
    expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0);
    expect(screen.getByText("Community report — verification in progress")).toBeInTheDocument();
  });
});
