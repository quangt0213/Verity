import type { IconNode } from "lucide";
import { createElement } from "react";

interface IconProps {
  icon: IconNode;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Provide only when the icon carries meaning not present in nearby text. */
  label?: string;
}

/** Renders a lucide icon node as inline SVG (no innerHTML, no external requests). */
export function Icon({ icon, size = 18, strokeWidth = 2, className, label }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {icon.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
