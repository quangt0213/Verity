import type { EventStatus } from "@verity/contracts";
import { cn } from "../../lib/cn";
import { STATUS_DISPLAY } from "../../lib/display";
import { Icon } from "./Icon";

/** Icon + text, so status never depends on color alone. */
export function StatusBadge({ status, size = "sm", className }: { status: EventStatus; size?: "sm" | "md"; className?: string }) {
  const display = STATUS_DISPLAY[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-semibold ring-1 ring-inset whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        display.badgeClass,
        className,
      )}
    >
      <Icon icon={display.icon} size={size === "sm" ? 13 : 15} strokeWidth={2.5} />
      {display.label}
    </span>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-amber-900 uppercase dark:bg-amber-300/15 dark:text-amber-200",
        className,
      )}
      title="Demo data — not a real current event"
    >
      Demo
    </span>
  );
}
