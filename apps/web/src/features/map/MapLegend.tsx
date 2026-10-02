import { Layers, X } from "lucide";
import { useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { MARKER_GROUPS, type MarkerGroup } from "../../lib/display";

const ORDER: MarkerGroup[] = ["urgent", "developing", "unverified", "planned", "inactive"];

export function MapLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto">
      {open ? (
        <div className="w-56 rounded-2xl bg-surface/95 p-3 text-sm shadow-lg ring-1 ring-line backdrop-blur" role="dialog" aria-label="Map legend">
          <div className="flex items-center justify-between">
            <p className="font-semibold">Map key</p>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1 text-muted hover:bg-surface-2" aria-label="Close map key">
              <Icon icon={X} size={16} />
            </button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {ORDER.map((group) => {
              const g = MARKER_GROUPS[group];
              return (
                <li key={group} className="flex items-center gap-2">
                  <span
                    className="h-4 w-4 shrink-0 rounded-full"
                    style={g.hollow ? { border: `2px dashed ${g.color}` } : { backgroundColor: g.color }}
                    aria-hidden
                  />
                  {g.label}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">Icons show the category. Open an event for its evidence.</p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-surface/95 px-3 text-sm font-medium shadow-md ring-1 ring-line backdrop-blur hover:bg-surface"
          aria-label="Show map key"
        >
          <Icon icon={Layers} size={17} />
          <span className="hidden sm:inline">Key</span>
        </button>
      )}
    </div>
  );
}
