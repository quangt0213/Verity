import type { AppConfig } from "../config/env";
import { createHttpApi } from "./http-client";
import { createMockApi } from "./mock/mock-client";
import { createUnconfiguredApi } from "./unconfigured-client";
import type { VerityApi } from "./types";

export function createApi(config: AppConfig): VerityApi {
  switch (config.dataSource.kind) {
    case "api":
      return createHttpApi(config.dataSource.baseUrl);
    case "mock":
      return createMockApi({ writes: config.dataSource.writes });
    case "unconfigured":
      return createUnconfiguredApi(config.dataSource.reason);
  }
}

export type { VerityApi } from "./types";
