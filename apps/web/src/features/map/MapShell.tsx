import type { Coordinates } from "@verity/contracts";
import { LocateFixed, Plus } from "lucide";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router";
import { DataSourceBanner, TopBar } from "../../app/TopBar";
import { Icon } from "../../components/ui/Icon";
import { useToast } from "../../components/ui/Toast";
import { appConfig } from "../../config/env";
import { debounce } from "../../lib/debounce";
import { locateOnce, useMediaQuery, useNow } from "../../lib/hooks";
import { useTheme } from "../../theme/ThemeProvider";
import { EventPreview } from "../events/EventPreview";
import { FilterChips, feedHeading } from "../events/FeedPanel";
import { DEFAULT_FILTERS, fallbackBBox, filtersToQuery, type EventFilters } from "../events/filters";
import { useEventList } from "../events/queries";
import { BottomSheet } from "./BottomSheet";
import { MapLegend } from "./MapLegend";
import { MapView, type FlyTarget, type MapStatus, type Viewport } from "./MapView";
import type { SheetSnap, ShellContext } from "./shell-context";

interface LandingState {
  center?: Coordinates;
}

/** Map-first layout: desktop sidebar + map, or full-screen map + bottom sheet on mobile. */
export function MapShell() {
  const { resolved: theme } = useTheme();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const now = useNow();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const eventMatch = useMatch("/events/:eventId");
  const routeEventId = eventMatch?.params.eventId ?? null;

  // "Explore nearby" on the landing page hands over an approximate location once.
  const [landingCenter] = useState(() => (location.state as LandingState | null)?.center ?? null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [filters, setFiltersState] = useState<EventFilters>(DEFAULT_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [userLocation, setUserLocation] = useState<Coordinates | null>(landingCenter);
  const [mapStatus, setMapStatus] = useState<MapStatus>("loading");
  const [sheet, setSheet] = useState<SheetSnap>("peek");
  const [sheetPx, setSheetPx] = useState(0);
  const [locating, setLocating] = useState(false);
  const flyKey = useRef(0);

  const setFilters = useCallback((update: (f: EventFilters) => EventFilters) => setFiltersState(update), []);
  const applySearch = useMemo(() => debounce((q: string) => setFiltersState((f) => ({ ...f, q })), 300), []);
  useEffect(() => () => applySearch.cancel(), [applySearch]);

  const focusOn = useCallback((coordinates: Coordinates, zoom?: number) => {
    flyKey.current += 1;
    setFlyTarget({ coordinates, zoom, key: flyKey.current });
  }, []);

  // Drop the one-time router state so a reload doesn't re-apply it.
  useEffect(() => {
    if (landingCenter) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the map can't load, still list events around the default area.
  const bbox = viewport?.bbox ?? (mapStatus === "failed" ? fallbackBBox(appConfig.defaultView.center) : null);
  const zoomedOut = mapStatus !== "failed" && viewport !== null && viewport.bbox === null;
  const query = bbox ? filtersToQuery(filters, bbox) : null;
  const list = useEventList(query);
  const events = useMemo(() => list.data?.events ?? [], [list.data]);

  const preview = previewId && !routeEventId ? events.find((e) => e.id === previewId) ?? null : null;
  const selectedId = routeEventId ?? previewId ?? highlightedId;

  // Leaving or changing the routed event clears any marker preview.
  const [previousRoute, setPreviousRoute] = useState(routeEventId);
  if (previousRoute !== routeEventId) {
    setPreviousRoute(routeEventId);
    setPreviewId(null);
  }

  const onSelectEvent = useCallback(
    (id: string | null) => {
      setPreviewId(id);
      if (id && !isDesktop) setSheet("peek");
    },
    [isDesktop],
  );

  const nearMe = async () => {
    setLocating(true);
    const result = await locateOnce();
    setLocating(false);
    if (result.ok) {
      setUserLocation(result.coordinates);
      focusOn(result.coordinates, 14);
    } else {
      toast.show(result.message, "warning");
    }
  };

  const context: ShellContext = {
    events,
    list: {
      isPending: query !== null && list.isPending,
      isFetching: list.isFetching,
      error: list.error,
      truncated: list.data?.truncated ?? false,
      refetch: () => void list.refetch(),
    },
    zoomedOut,
    mapStatus,
    filters,
    setFilters,
    highlightedId,
    setHighlightedId,
    focusOn,
    setSheet,
    isDesktop,
    now,
  };

  const search = {
    value: searchInput,
    onChange: (v: string) => {
      setSearchInput(v);
      applySearch(v);
    },
  };

  const mapBottomInset = isDesktop ? 0 : sheetPx;
  const heading = feedHeading(events.length, zoomedOut, context.list.isPending);

  return (
    <div className="flex h-full flex-col">
      <TopBar search={search} />
      <DataSourceBanner />
      <div className="relative flex min-h-0 flex-1">
        {isDesktop && (
          <aside className="w-[400px] shrink-0 overflow-y-auto border-r border-line bg-bg" aria-label="Events">
            <Outlet context={context} />
          </aside>
        )}

        <div className="relative min-w-0 flex-1">
          <MapView
            events={events}
            selectedId={selectedId}
            onSelectEvent={onSelectEvent}
            onViewportChange={setViewport}
            flyTarget={flyTarget}
            userLocation={userLocation}
            theme={theme}
            styleUrl={theme === "dark" ? appConfig.map.styleDark : appConfig.map.styleLight}
            initialView={landingCenter ? { center: landingCenter, zoom: 13 } : appConfig.defaultView}
            bottomInset={mapBottomInset}
            onStatusChange={setMapStatus}
          />

          {/* Map overlays */}
          <div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-col items-start gap-2">
            <button
              type="button"
              onClick={nearMe}
              disabled={locating}
              className="pointer-events-auto inline-flex h-11 items-center gap-1.5 rounded-xl bg-surface/95 px-3 text-sm font-medium shadow-md ring-1 ring-line backdrop-blur hover:bg-surface disabled:opacity-60"
            >
              <Icon icon={LocateFixed} size={17} className={locating ? "animate-pulse" : undefined} />
              {locating ? "Locating…" : "Near me"}
            </button>
            {mapStatus === "ready" && <MapLegend />}
          </div>

          {zoomedOut && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
              <p className="rounded-full bg-fg/85 px-3 py-1.5 text-xs font-medium text-bg shadow">Zoom in to see events</p>
            </div>
          )}

          {preview && (
            <div
              className="pointer-events-none absolute inset-x-3 z-30 flex justify-center lg:inset-x-auto lg:bottom-6 lg:left-6 lg:w-[380px]"
              style={isDesktop ? undefined : { bottom: sheetPx + 12 }}
            >
              <EventPreview event={preview} now={now} onClose={() => setPreviewId(null)} />
            </div>
          )}

          {!isDesktop && !routeEventId && (
            <Link
              to="/report"
              state={viewport ? { center: viewport.center } : null}
              className="absolute right-4 z-20 inline-flex h-14 items-center gap-2 rounded-full bg-accent px-5 font-semibold text-accent-fg shadow-lg hover:brightness-110"
              style={{ bottom: sheetPx + 16 }}
              aria-label="Report an event"
            >
              <Icon icon={Plus} size={20} />
              Report
            </Link>
          )}

          {!isDesktop && (
            <BottomSheet
              snap={sheet}
              onSnapChange={setSheet}
              onHeightChange={setSheetPx}
              label={routeEventId ? "Event details" : "Events in this area"}
              header={
                routeEventId ? null : (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold" aria-live="polite">
                      {heading}
                    </p>
                    <FilterChips filters={filters} setFilters={setFilters} />
                  </div>
                )
              }
            >
              <Outlet context={context} />
            </BottomSheet>
          )}
        </div>
      </div>
    </div>
  );
}
