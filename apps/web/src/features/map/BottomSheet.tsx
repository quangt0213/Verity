import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { SheetSnap } from "./shell-context";

const PEEK_PX = 148;

export function sheetHeight(snap: SheetSnap, containerHeight: number): number {
  if (snap === "peek") return Math.min(PEEK_PX, containerHeight);
  if (snap === "half") return Math.round(containerHeight * 0.52);
  return Math.max(PEEK_PX, containerHeight - 12);
}

function nearestSnap(height: number, containerHeight: number): SheetSnap {
  const options: SheetSnap[] = ["peek", "half", "full"];
  return options.reduce((best, snap) =>
    Math.abs(sheetHeight(snap, containerHeight) - height) < Math.abs(sheetHeight(best, containerHeight) - height) ? snap : best,
  );
}

const NEXT: Record<SheetSnap, SheetSnap> = { peek: "half", half: "full", full: "peek" };

/**
 * Mobile event sheet with three snap points. The handle is a real button
 * (tap/Enter cycles sizes); dragging is an enhancement for touch users.
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
  const [containerHeight, setContainerHeight] = useState(600);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const parent = sheetRef.current?.parentElement;
    if (!parent) return;
    const update = () => setContainerHeight(parent.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const height = dragHeight ?? sheetHeight(snap, containerHeight);

  useEffect(() => {
    if (dragHeight === null) onHeightChange?.(height);
  }, [height, dragHeight, onHeightChange]);

  return (
    <div
      ref={sheetRef}
      role="region"
      aria-label={label}
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-3xl bg-surface shadow-[0_-8px_30px_rgba(0,0,0,0.12)] ring-1 ring-line",
        dragHeight === null && "transition-[height] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ height }}
    >
      <button
        type="button"
        className="flex h-7 w-full shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        aria-label={snap === "full" ? "Collapse event list" : "Expand event list"}
        aria-expanded={snap !== "peek"}
        onPointerDown={(e) => {
          drag.current = { startY: e.clientY, startHeight: height, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const delta = d.startY - e.clientY;
          if (Math.abs(delta) > 4) d.moved = true;
          if (d.moved) setDragHeight(Math.min(containerHeight - 12, Math.max(96, d.startHeight + delta)));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved && dragHeight !== null) {
            onSnapChange(nearestSnap(dragHeight, containerHeight));
            suppressClick.current = true;
          }
          setDragHeight(null);
        }}
        onClick={() => {
          // Taps and keyboard activation cycle sizes; the click that ends a drag doesn't.
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onSnapChange(NEXT[snap]);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragHeight(null);
        }}
      >
        <span className="h-1.5 w-10 rounded-full bg-line" aria-hidden />
      </button>
      {header && <div className="shrink-0 px-4 pb-2">{header}</div>}
      <div className={cn("min-h-0 flex-1 overscroll-contain", snap === "peek" && dragHeight === null ? "overflow-hidden" : "overflow-y-auto")}>
        {children}
      </div>
    </div>
  );
}
