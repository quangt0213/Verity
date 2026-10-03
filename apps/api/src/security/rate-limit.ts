import { createHmac } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { Queryable } from "../db/client";
import { rateLimitCounters } from "../db/schema";
import { ApiError } from "./errors";

export interface LimitRule {
  /** Logical bucket name, e.g. "report:user". */
  name: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Rate-limit policies. Account- and network-level limits are applied together
 * where both identifiers exist. Phase 3 will add stricter, separate budgets for
 * anything that can trigger external verification.
 */
export const RATE_LIMITS = {
  authStartPerEmail: { name: "auth-start:email", limit: 5, windowSeconds: 15 * 60 },
  authStartPerEmailDaily: { name: "auth-start:email:day", limit: 20, windowSeconds: 24 * 3600 },
  authStartPerIp: { name: "auth-start:ip", limit: 20, windowSeconds: 15 * 60 },
  authVerifyPerEmail: { name: "auth-verify:email", limit: 10, windowSeconds: 15 * 60 },
  authVerifyPerIp: { name: "auth-verify:ip", limit: 40, windowSeconds: 15 * 60 },
  reportPerUser: { name: "report:user", limit: 10, windowSeconds: 3600 },
  reportPerUserDaily: { name: "report:user:day", limit: 30, windowSeconds: 24 * 3600 },
  reportPerIp: { name: "report:ip", limit: 30, windowSeconds: 3600 },
  signalPerUser: { name: "signal:user", limit: 60, windowSeconds: 3600 },
  signalPerIp: { name: "signal:ip", limit: 300, windowSeconds: 3600 },
  followPerUser: { name: "follow:user", limit: 120, windowSeconds: 3600 },
} satisfies Record<string, LimitRule>;

export class RateLimiter {
  private hits = 0;

  constructor(
    private readonly db: Queryable,
    private readonly secret: string,
  ) {}

  /** Keys are HMACs so raw emails and IP addresses are never stored. */
  private key(rule: LimitRule, identifier: string): string {
    const digest = createHmac("sha256", this.secret).update(`${rule.name}\u0000${identifier}`).digest("base64url");
    return `${rule.name}:${digest.slice(0, 32)}`;
  }

  async consume(rule: LimitRule, identifier: string, now = new Date()): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs);
    const [row] = await this.db
      .insert(rateLimitCounters)
      .values({ key: this.key(rule, identifier), windowStart, count: 1, expiresAt })
      .onConflictDoUpdate({
        target: [rateLimitCounters.key, rateLimitCounters.windowStart],
        set: { count: sql`${rateLimitCounters.count} + 1` },
      })
      .returning({ count: rateLimitCounters.count });

    if (++this.hits % 200 === 0) {
      // Opportunistic cleanup of expired windows.
      await this.db.delete(rateLimitCounters).where(lt(rateLimitCounters.expiresAt, now));
    }
    const count = row?.count ?? 1;
    return {
      allowed: count <= rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)),
    };
  }

  /** Consume every (rule, identifier) pair; throw 429 if any is exhausted. */
  async enforce(checks: Array<[LimitRule, string | null | undefined]>): Promise<void> {
    let retryAfter = 0;
    for (const [rule, identifier] of checks) {
      if (!identifier) continue;
      const result = await this.consume(rule, identifier);
      if (!result.allowed) retryAfter = Math.max(retryAfter, result.retryAfterSeconds);
    }
    if (retryAfter > 0) {
      throw new ApiError(429, "rate_limited", "Too many requests. Please try again later.", { retryAfterSeconds: retryAfter });
    }
  }
}
