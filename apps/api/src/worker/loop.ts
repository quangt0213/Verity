import { DEFAULT_POLICY } from "../verification/policy";
import { claimJobs } from "./jobs";
import { processJob, type WorkerDeps } from "./process";
import { reapExpiredLeases } from "./settle";
import { sweepAging } from "./sweep";

/**
 * The worker's scheduling loop: reap expired leases, run the aging sweep when
 * due, claim up to the free concurrency, process claims in parallel, repeat.
 * Stops claiming as soon as `signal` aborts and waits for in-flight attempts.
 */
export function createWorker(deps: WorkerDeps & { workerId: string }) {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const inFlight = new Set<Promise<unknown>>();
  let lastSweep = 0;

  async function tick(): Promise<{ claimed: number }> {
    const now = deps.now();
    await reapExpiredLeases(deps.db, { now, leaseSeconds: deps.config.leaseSeconds, random: deps.random, policy });
    if (now.getTime() - lastSweep >= policy.sweep.intervalMinutes * 60_000) {
      lastSweep = now.getTime();
      const swept = await sweepAging(deps.db, { now, policy });
      if (swept.length > 0) deps.log.info({ swept: swept.length }, "aging sweep applied");
    }
    const free = deps.config.concurrency - inFlight.size;
    const leases = await claimJobs(deps.db, { workerId: deps.workerId, limit: free, now: deps.now() });
    for (const lease of leases) {
      const task = processJob(deps, lease).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    return { claimed: leases.length };
  }

  async function run(signal: AbortSignal): Promise<void> {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (!signal.aborted) {
      try {
        const { claimed } = await tick();
        if (claimed === 0) await sleep(deps.config.pollIntervalMs);
      } catch (error) {
        deps.log.error({ error: error instanceof Error ? error.name : "unknown" }, "worker tick failed");
        await sleep(deps.config.pollIntervalMs);
      }
    }
    await Promise.allSettled([...inFlight]);
  }

  return { tick, run, inFlight: () => inFlight.size, drain: () => Promise.allSettled([...inFlight]) };
}
