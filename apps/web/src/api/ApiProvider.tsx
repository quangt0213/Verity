import { createContext, useContext, type ReactNode } from "react";
import type { VerityApi } from "./types";

const ApiContext = createContext<VerityApi | null>(null);

export function ApiProvider({ api, children }: { api: VerityApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): VerityApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}
