import { X } from "lucide";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Icon } from "./Icon";

type Tone = "info" | "success" | "warning";

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

interface ToastContextValue {
  show: (message: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (message: string, tone: Tone = "info") => {
      const id = nextId.current++;
      setItems((all) => [...all.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 4.25rem)" }}
        aria-live="polite"
        role="status"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex max-w-md items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ring-1",
              t.tone === "success" && "bg-emerald-50 text-emerald-900 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-400/20",
              t.tone === "warning" && "bg-amber-50 text-amber-950 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-400/20",
              t.tone === "info" && "bg-surface text-fg ring-line",
            )}
          >
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-m-1 rounded-md p-1 opacity-70 hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <Icon icon={X} size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
