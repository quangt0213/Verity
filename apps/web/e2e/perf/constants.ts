/** Ports 4280–4289 are reserved for ad-hoc measurement servers (see docs/handoffs/map.md). */
export const PERF_PORT = 4281;
/** Never resolves: every request to it is fulfilled by page.route in the specs. */
export const PERF_API_ORIGIN = "https://verity-api.perf.invalid";
