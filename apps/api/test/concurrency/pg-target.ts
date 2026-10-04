import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDatabase, type DatabaseHandle } from "../../src/db/client";
import { isLocalDatabase } from "../../src/db/target-guard";

/**
 * The real-PostgreSQL suites run ONLY against a local, disposable server named
 * by TEST_DATABASE_URL (never DATABASE_URL, never a hosted database). Each
 * suite creates its own throwaway database, migrates it (0000-0005) and drops
 * it afterwards.
 */

export const target = process.env.TEST_DATABASE_URL;

export function refuseUnsafe(url: string): void {
  const parsed = new URL(url);
  if (/supabase\.(co|com)$/i.test(parsed.hostname)) throw new Error("Refusing to run the concurrency suite against Supabase.");
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) throw new Error("TEST_DATABASE_URL must not be the application's DATABASE_URL.");
  if (!isLocalDatabase(url)) throw new Error("TEST_DATABASE_URL must point at a local, disposable PostgreSQL server.");
}
if (target) refuseUnsafe(target);

export interface Throwaway {
  name: string;
  url: string;
  /** Two independent connection pools, like two worker processes. */
  a: DatabaseHandle;
  b: DatabaseHandle;
  drop(): Promise<void>;
}

export async function throwawayDatabase(prefix: string): Promise<Throwaway> {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(target!, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(target!);
  url.pathname = `/${name}`;
  const a = createDatabase(url.toString());
  const b = createDatabase(url.toString());
  await a.migrate();
  return {
    name,
    url: url.toString(),
    a,
    b,
    async drop() {
      await a.close();
      await b.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
