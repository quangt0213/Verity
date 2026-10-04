import { and, eq, sql } from "drizzle-orm";
import type { Queryable } from "../db/client";
import { rateLimitCounters } from "../db/schema";

/**
 * Global daily budgets for paid external work, kept in rate_limit_counters
 * (one row per kind and UTC day). Reservation is a single conditional upsert,
 * so concurrent workers can never jointly exceed the cap. Exhausting a budget
 * defers work; it is never evidence about an event.
 */

export type BudgetKind = "search" | "extract" | "agent";

const DAY_MS = 24 * 60 * 60_000;
const dayStart = (now: Date) => new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
const budgetKey = (kind: BudgetKind) => `budget:${kind}`;

/** Reserve `amount` units of today's budget. False (and nothing reserved) if it would exceed `cap`. */
export async function reserveBudget(db: Queryable, kind: BudgetKind, amount: number, cap: number, now: Date): Promise<boolean> {
  if (amount <= 0) return true;
  if (amount > cap) return false;
  const windowStart = dayStart(now);
  const rows = await db
    .insert(rateLimitCounters)
    .values({ key: budgetKey(kind), windowStart, count: amount, expiresAt: new Date(windowStart.getTime() + 2 * DAY_MS) })
    .onConflictDoUpdate({
      target: [rateLimitCounters.key, rateLimitCounters.windowStart],
      set: { count: sql`${rateLimitCounters.count} + excluded.count` },
      setWhere: sql`${rateLimitCounters.count} + excluded.count <= ${cap}`,
    })
    .returning({ count: rateLimitCounters.count });
  return rows.length > 0;
}

/** Return unused units (e.g. searches reserved but not performed). */
export async function releaseBudget(db: Queryable, kind: BudgetKind, amount: number, reservedAt: Date): Promise<void> {
  if (amount <= 0) return;
  await db
    .update(rateLimitCounters)
    .set({ count: sql`greatest(${rateLimitCounters.count} - ${amount}, 0)` })
    .where(and(eq(rateLimitCounters.key, budgetKey(kind)), eq(rateLimitCounters.windowStart, dayStart(reservedAt))));
}

export async function budgetUsed(db: Queryable, kind: BudgetKind, now: Date): Promise<number> {
  const [row] = await db
    .select({ count: rateLimitCounters.count })
    .from(rateLimitCounters)
    .where(and(eq(rateLimitCounters.key, budgetKey(kind)), eq(rateLimitCounters.windowStart, dayStart(now))));
  return row?.count ?? 0;
}
