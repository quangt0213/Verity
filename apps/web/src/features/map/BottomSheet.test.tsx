import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BottomSheet, nearestSnap, PEEK_MIN_PX, peekHeight, sheetHeight } from "./BottomSheet";
import type { SheetSnap } from "./shell-context";

const CONTAINER = 700;

let frames: FrameRequestCallback[] = [];
const flushFrames = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb(performance.now()));
  });

beforeEach(() => {
  frames = [];
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(CONTAINER);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    if (id > 0) frames[id - 1] = () => {};
  });
});

function Harness({ onCommit, onHeightChange }: { onCommit?: () => void; onHeightChange?: (px: number) => void }) {
  const [snap, setSnap] = useState<SheetSnap>("peek");
  return (
    <div>
      <Profiler id="sheet" onRender={() => onCommit?.()}>
        <BottomSheet snap={snap} onSnapChange={setSnap} onHeightChange={onHeightChange} header={<p>10 events</p>} label="Events in this area">
          <ul>
            <li>Event</li>
          </ul>
        </BottomSheet>
      </Profiler>
    </div>
  );
}

describe("sheet geometry", () => {
  it("snaps to peek, about half and nearly full", () => {
    expect(sheetHeight("peek", CONTAINER)).toBe(PEEK_MIN_PX);
    expect(sheetHeight("half", CONTAINER)).toBe(364);
    expect(sheetHeight("full", CONTAINER)).toBe(688);
    expect(sheetHeight("peek", 100)).toBe(100);
  });

  it("grows the peek for a wrapped header and the bottom safe area", () => {
    expect(peekHeight(128, 0)).toBe(PEEK_MIN_PX);
    expect(peekHeight(188, 0)).toBe(188);
    expect(peekHeight(128, 34)).toBe(PEEK_MIN_PX + 34);
    // Half never drops below a tall peek.
    expect(sheetHeight("half", 300, 200)).toBe(200);
  });

  it("picks the nearest snap", () => {
    expect(nearestSnap(150, CONTAINER)).toBe("peek");
    expect(nearestSnap(420, CONTAINER)).toBe("half");
    expect(nearestSnap(600, CONTAINER)).toBe("full");
  });
});

describe("BottomSheet", () => {
  it("the handle is a button that cycles sizes on click and keyboard activation", () => {
    render(<Harness />);
    const sheet = screen.getByRole("region", { name: "Events in this area" });
    const handle = screen.getByRole("button", { name: "Expand event list" });
    expect(handle).toHaveAttribute("aria-expanded", "false");
    expect(sheet.style.height).toBe(`${PEEK_MIN_PX}px`);

    fireEvent.click(handle);
    expect(sheet).toHaveAttribute("data-snap", "half");
    expect(handle).toHaveAttribute("aria-expanded", "true");
    expect(sheet.style.height).toBe("364px");

    fireEvent.click(handle);
    expect(screen.getByRole("button", { name: "Collapse event list" })).toBeInTheDocument();
    fireEvent.click(handle);
    expect(sheet).toHaveAttribute("data-snap", "peek");
  });

  it("drags without re-rendering per pointer move, then snaps to the nearest size", () => {
    let commits = 0;
    const heights: number[] = [];
    render(<Harness onCommit={() => commits++} onHeightChange={(px) => heights.push(px)} />);
    const sheet = screen.getByRole("region", { name: "Events in this area" });
    const handle = screen.getByRole("button", { name: "Expand event list" });
    heights.length = 0;

    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 });
    const before = commits;
    for (let y = 590; y >= 380; y -= 10) fireEvent.pointerMove(handle, { clientY: y, pointerId: 1 });
    // One commit when the drag starts (to drop the snap transition); none per move.
    expect(commits - before).toBeLessThanOrEqual(1);
    flushFrames();
    expect(sheet.style.height).toBe(`${PEEK_MIN_PX + 220}px`);
    expect(heights).toEqual([]);

    fireEvent.pointerUp(handle, { clientY: 380, pointerId: 1 });
    fireEvent.click(handle); // The click that ends a drag doesn't also cycle the size.
    expect(sheet).toHaveAttribute("data-snap", "half");
    expect(sheet.style.height).toBe("364px");
    expect(heights).toEqual([364]);
  });

  it("a cancelled drag returns to the current snap", () => {
    render(<Harness />);
    const sheet = screen.getByRole("region", { name: "Events in this area" });
    const handle = screen.getByRole("button", { name: "Expand event list" });
    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    flushFrames();
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(sheet).toHaveAttribute("data-snap", "peek");
    expect(sheet.style.height).toBe(`${PEEK_MIN_PX}px`);
  });
});
