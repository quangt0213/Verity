import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fastMockApi, renderWithApp } from "../../test/render";
import { ReportPage } from "./ReportPage";

function renderReport() {
  return renderWithApp(<ReportPage />, { api: fastMockApi("simulate") });
}

describe("ReportPage schedule fields", () => {
  it("appear only for planned categories, as a labelled group with local-time help", async () => {
    const user = userEvent.setup();
    renderReport();
    expect(screen.queryByRole("group", { name: /When is it scheduled/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Road closure" }));
    expect(screen.queryByRole("group", { name: /When is it scheduled/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Concert" }));
    const group = screen.getByRole("group", { name: /When is it scheduled/ });
    expect(group).toHaveAccessibleDescription(/planned, not that it's happening/);
    expect(group).toHaveAccessibleDescription(/Times are in your time zone/);
    expect(screen.getByLabelText("Starts")).toHaveAttribute("type", "datetime-local");
    expect(screen.getByLabelText("Ends")).toHaveAttribute("type", "datetime-local");
  });

  it("moves focus to the first field that needs attention after a failed submit", async () => {
    const user = userEvent.setup();
    renderReport();
    const submit = screen.getByRole("button", { name: "Submit report" });

    await user.click(submit);
    expect(screen.getByText("Choose a category")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);

    await user.click(screen.getByRole("radio", { name: "Concert" }));
    await user.click(submit);
    expect(screen.getByLabelText("Short title")).toHaveFocus();

    await user.type(screen.getByLabelText("Short title"), "Outdoor concert in the park");
    await user.type(screen.getByLabelText("Starts"), "2026-10-18T20:00");
    await user.type(screen.getByLabelText("Ends"), "2026-10-18T18:00");
    await user.click(submit);
    const ends = screen.getByLabelText("Ends");
    expect(ends).toHaveAttribute("aria-invalid", "true");
    expect(ends).toHaveAccessibleDescription(/after the start/);
    expect(ends).toHaveFocus();
  });
});
