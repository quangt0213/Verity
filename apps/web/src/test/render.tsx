import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { ApiProvider } from "../api/ApiProvider";
import { createMockApi } from "../api/mock/mock-client";
import type { VerityApi } from "../api/types";
import { ToastProvider } from "../components/ui/Toast";
import { MaypopProvider } from "../maypop/MaypopProvider";
import { STANDALONE } from "../maypop/session";
import { ThemeProvider } from "../theme/ThemeProvider";

const standalone = async () => ({ sdk: null, snapshot: STANDALONE });

export function fastMockApi(writes: "off" | "simulate" = "off"): VerityApi {
  return createMockApi({ writes, latencyMs: [0, 0] });
}

/** Render with every app provider, a fresh query cache and an in-memory router. */
export function renderWithApp(
  ui: ReactElement,
  { api = fastMockApi(), path = "/", routes }: { api?: VerityApi; path?: string; routes?: RouteObject[] } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  const router = createMemoryRouter(routes ?? [{ path: "*", element: ui }], { initialEntries: [path] });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <MaypopProvider connect={standalone}>
          <ThemeProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ThemeProvider>
        </MaypopProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
  return { ...result, router, api };
}
