import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import { createApi } from "../api";
import { ApiProvider } from "../api/ApiProvider";
import { ToastProvider } from "../components/ui/Toast";
import { appConfig } from "../config/env";
import { MaypopProvider } from "../maypop/MaypopProvider";
import { ThemeProvider } from "../theme/ThemeProvider";
import { router } from "./router";

const api = createApi(appConfig);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: true },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <MaypopProvider>
          <ThemeProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ThemeProvider>
        </MaypopProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
