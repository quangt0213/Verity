import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "subtle";
type Size = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg shadow-sm hover:brightness-110 active:brightness-95",
  secondary: "bg-surface text-fg ring-1 ring-line hover:bg-surface-2",
  ghost: "text-fg hover:bg-surface-2",
  subtle: "bg-surface-2 text-fg hover:brightness-95 dark:hover:brightness-110",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-11 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2",
  icon: "h-11 w-11 justify-center",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl font-medium transition-[filter,background-color] select-none",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:opacity-60",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
