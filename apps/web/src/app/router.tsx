import { CircleAlert, MapPin } from "lucide";
import { useEffect, useRef } from "react";
import { createHashRouter, Link, Navigate, Outlet, useLocation, useNavigate, type RouteObject } from "react-router";
import { EmptyState } from "../components/ui/States";
import { EventDetailPanel } from "../features/events/EventDetailPanel";
import { FeedPanel } from "../features/events/FeedPanel";
import { FollowingPage } from "../features/following/FollowingPage";
import { MapShell } from "../features/map/MapShell";
import { Landing } from "../features/onboarding/Landing";
import { ReportPage } from "../features/report/ReportPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { readStored, STORAGE_KEYS } from "../lib/storage";
import { useMaypop } from "../maypop/MaypopProvider";
import { PageLayout } from "./PageLayout";

/**
 * Hash routing: works from any static host path, and Maypop applies a
 * notification's deep link (`launchPath`) to hash routes.
 */
function Root() {
  const maypop = useMaypop();
  const navigate = useNavigate();
  const location = useLocation();
  const handledLaunch = useRef(false);

  useEffect(() => {
    if (handledLaunch.current || maypop.status === "connecting") return;
    handledLaunch.current = true;
    // launchPath is validated against this app's routes in maypop/session.ts.
    if (maypop.launchPath && location.pathname !== maypop.launchPath) {
      navigate(maypop.launchPath, { replace: true });
    }
  }, [maypop.status, maypop.launchPath, location.pathname, navigate]);

  return <Outlet />;
}

function IndexRedirect() {
  const onboarded = readStored(STORAGE_KEYS.onboarded, (v) => (typeof v === "boolean" ? v : null), false);
  return <Navigate to={onboarded ? "/map" : "/welcome"} replace />;
}

function NotFound() {
  return (
    <PageLayout title="Page not found">
      <EmptyState icon={MapPin} title="There's nothing here">
        <Link to="/map" className="font-medium text-accent hover:underline">
          Back to the map
        </Link>
      </EmptyState>
    </PageLayout>
  );
}

function RouteError() {
  return (
    <div className="grid h-full place-items-center p-6">
      <EmptyState icon={CircleAlert} title="Something went wrong">
        <a href="#/map" className="font-medium text-accent hover:underline">
          Reload the map
        </a>
      </EmptyState>
    </div>
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <IndexRedirect /> },
      { path: "welcome", element: <Landing /> },
      {
        element: <MapShell />,
        children: [
          { path: "map", element: <FeedPanel /> },
          { path: "events/:eventId", element: <EventDetailPanel /> },
        ],
      },
      { path: "report", element: <ReportPage /> },
      { path: "following", element: <FollowingPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createHashRouter(routes);
