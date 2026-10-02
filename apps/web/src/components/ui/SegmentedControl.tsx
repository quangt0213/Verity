import type { IconNode } from "lucide";
import { cn } from "../../lib/cn";
import { Icon } from "./Icon";

interface Option<T extends string> {
  value: T;
  label: string;
  icon?: IconNode;
}

/** Radio-group semantics so it works with screen readers and arrow keys. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-xl bg-surface-2 p-1", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const delta = e.key === "ArrowRight" ? 1 : -1;
              const next = options[(index + delta + options.length) % options.length];
              if (next) onChange(next.value);
              const siblings = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
              siblings?.[(index + delta + options.length) % options.length]?.focus();
            }}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
              checked ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg",
            )}
          >
            {option.icon && <Icon icon={option.icon} size={15} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
