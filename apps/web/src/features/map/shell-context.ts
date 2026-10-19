import type { Coordinates, EventSummary } from "@verity/contracts";
import { useOutletContext } from "react-router";
import type { EventFilters } from "../events/filters";
import type { MapStatus } from "./MapView";

export type SheetSnap = "peek" | "half" | "full";

export interface ShellContext {
  events: EventSummary[];
  list: {
    isPending: boolean;
    /** Unused by the outlets; optional so MapShell can stop passing it (re-renders the feed on every fetch). */
    isFetching?: boolean;
    error: unknown;
    truncated: boolean;
    refetch: () => void;
  };
  /** The viewport is too large to query; the user should zoom in. */
  zoomedOut: boolean;
  mapStatus: MapStatus;
  filters: EventFilters;
  setFilters: (update: (f: EventFilters) => EventFilters) => void;
  highlightedId: string | null;
  setHighlightedId: (id: string | null) => void;
  focusOn: (coordinates: Coordinates, zoom?: number) => void;
  setSheet: (snap: SheetSnap) => void;
  isDesktop: boolean;
  now: number;
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}
