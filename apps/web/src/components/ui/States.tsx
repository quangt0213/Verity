import { CircleAlert, RefreshCw, type IconNode } from "lucide";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { Icon } from "./Icon";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-lg", className)} aria-hidden />;
}

export function EventCardSkeleton() {
  return (
    <div className="rounded-2xl bg-surface p-3.5 ring-1 ring-line" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon: IconNode;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-6 py-10 text-center", className)}>
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-muted">
        <Icon icon={icon} size={22} />
      </div>
      <p className="mt-3 font-semibold">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("px-6 py-8 text-center", className)}>
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300">
        <Icon icon={CircleAlert} size={22} />
      </div>
      <p className="mt-3 text-sm text-fg">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          <Icon icon={RefreshCw} size={16} />
          Try again
        </Button>
      )}
    </div>
  );
}
