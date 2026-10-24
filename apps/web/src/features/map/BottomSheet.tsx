import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { SheetSnap } from "./shell-context";

/** Smallest peek height; it grows when the header wraps or the device has a bottom safe area. */
export const PEEK_MIN_PX = 148;

export function sheetHeight(snap: SheetSnap, containerHeight: number, peekPx = PEEK_MIN_PX): number {
  const peek = Math.min(peekPx, containerHeight);
  if (snap === "peek") return peek;
  if (snap === "half") return Math.max(peek, Math.round(containerHeight * 0.52));
  return Math.max(peek, containerHeight - 12);
}

export function nearestSnap(height: number, containerHeight: number, peekPx = PEEK_MIN_PX): SheetSnap {
  const options: SheetSnap[] = ["peek", "half", "full"];
  return options.reduce((best, snap) =>
    Math.abs(sheetHeight(snap, containerHeight, peekPx) - height) < Math.abs(sheetHeight(best, containerHeight, peekPx) - height) ? snap : best,
  );
}

/**
 * Peek shows the handle and the whole header (`headerBottomPx` is the header's
 * bottom edge within the sheet), plus the bottom safe area (home indicator).
 */
export function peekHeight(headerBottomPx: number, safeAreaBottomPx: number): number {
  return Math.max(PEEK_MIN_PX, headerBottomPx) + safeAreaBottomPx;
}

const NEXT: Record<SheetSnap, SheetSnap> = { peek: "half", half: "full", full: "peek" };

/**
 * Mobile event sheet with three snap points. The handle is a real button
 * (tap/Enter cycles sizes); dragging is an enhancement for touch users.
 *
 * A drag writes the height straight to the DOM once per animation frame, so it
 * doesn't re-render the sheet or its contents; React state changes only when a
 * drag starts and ends.
 */
export function BottomSheet({
  snap,
  onSnapChange,
  onHeightChange,
  header,
  children,
  label,
}: {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  onHeightChange?: (px: number) => void;
  header: ReactNode;
  children: ReactNode;
  label: string;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(600);
  const [peekPx, setPeekPx] = useState(PEEK_MIN_PX);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startHeight: number; height: number; moved: boolean } | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const hasHeader = Boolean(header);

  useEffect(() => {
    const sheet = sheetRef.current;
    const parent = sheet?.parentElement;
    if (!sheet || !parent) return;
    const update = () => {
      setContainerHeight(parent.clientHeight);
      // The sheet's bottom padding is env(safe-area-inset-bottom).
      const safeArea = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
      const head = headerRef.current;
      setPeekPx(peekHeight(head ? head.offsetTop + head.offsetHeight : 0, safeArea));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    if (headerRef.current) observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, [hasHeader]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const height = sheetHeight(snap, containerHeight, peekPx);

  // Outside a drag the snapped height is applied here rather than through the
  // style prop, so it also replaces whatever height the last drag wrote.
  useLayoutEffect(() => {
    if (!dragging && sheetRef.current) sheetRef.current.style.height = `${height}px`;
  }, [height, dragging]);

  useEffect(() => {
    if (!dragging) onHeightChange?.(height);
  }, [height, dragging, onHeightChange]);

  const endDrag = () => {
    cancelAnimationFrame(frame.current);
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={sheetRef}
      role="region"
      aria-label={label}
      data-snap={snap}
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-3xl bg-surface shadow-[0_-8px_30px_rgba(0,0,0,0.12)] ring-1 ring-line",
        !dragging && "transition-[height] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <button
        type="button"
        className="flex h-7 w-full shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        aria-label={snap === "full" ? "Collapse event list" : "Expand event list"}
        aria-expanded={snap !== "peek"}
        onPointerDown={(e) => {
          drag.current = { startY: e.clientY, startHeight: height, height, moved: false };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const delta = d.startY - e.clientY;
          if (!d.moved && Math.abs(delta) > 4) {
            d.moved = true;
            setDragging(true);
          }
          if (!d.moved) return;
          d.height = Math.min(containerHeight - 12, Math.max(96, d.startHeight + delta));
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => {
            if (drag.current && sheetRef.current) sheetRef.current.style.height = `${drag.current.height}px`;
          });
        }}
        onPointerUp={() => {
          const d = drag.current;
          if (d?.moved) {
            onSnapChange(nearestSnap(d.height, containerHeight, peekPx));
            suppressClick.current = true;
          }
          endDrag();
        }}
        onClick={() => {
          // Taps and keyboard activation cycle sizes; the click that ends a drag doesn't.
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onSnapChange(NEXT[snap]);
        }}
        onPointerCancel={endDrag}
      >
        <span className="h-1.5 w-10 rounded-full bg-line" aria-hidden />
      </button>
      {header && (
        <div ref={headerRef} className="shrink-0 px-4 pb-2">
          {header}
        </div>
      )}
      <div className={cn("min-h-0 flex-1 overscroll-contain", snap === "peek" && !dragging ? "overflow-hidden" : "overflow-y-auto")}>
        {children}
      </div>
    </div>
  );
}
