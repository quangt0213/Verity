/**
 * Which database a command may touch. Development commands (worker, migrate,
 * seed) read `apps/api/.env`, and that file can point at a hosted production
 * database. Remembering not to run them is not a safeguard, so:
 *
 *   - LOCAL databases (PGlite, or Postgres on a loopback address) are always
 *     allowed, except for production-mode safety rules elsewhere.
 *   - A REMOTE database needs an explicit, specific acknowledgement:
 *     VERITY_DATABASE_ACK must equal that database's host name. Copying the
 *     host into a second variable is deliberate; a stale .env is not.
 *   - The worker additionally needs NODE_ENV=production to touch a remote
 *     database (it would otherwise process real jobs from a dev machine).
 *   - Demo seeding never touches a remote database.
 *
 * A legitimate deployment sets NODE_ENV=production, DATABASE_URL and
 * VERITY_DATABASE_ACK=<the same host> in the host's environment.
 */

export type GuardedPurpose = "worker" | "migrate" | "seed";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The Postgres host of a URL, lowercased; null for PGlite or an unparseable URL. */
export function databaseHost(url: string): string | null {
  if (url.startsWith("pglite:")) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalDatabase(url: string): boolean {
  if (url.startsWith("pglite:")) return true;
  const host = databaseHost(url);
  return host !== null && LOOPBACK.has(host);
}

/** Problems that forbid `purpose` from using `databaseUrl`; empty when allowed. Never includes the URL or credentials. */
export function databaseTargetProblems(
  purpose: GuardedPurpose,
  databaseUrl: string,
  env: { NODE_ENV?: string; VERITY_DATABASE_ACK?: string },
): string[] {
  if (isLocalDatabase(databaseUrl)) return [];
  const host = databaseHost(databaseUrl);
  if (!host) return ["DATABASE_URL is not a recognizable postgres:// URL"];
  if (purpose === "seed") return ["Refusing to seed demo data into a remote database; seeding is for local databases only"];
  const problems: string[] = [];
  if (purpose === "worker" && env.NODE_ENV !== "production") {
    problems.push("The verification worker uses a remote database only with NODE_ENV=production (DATABASE_URL is not local)");
  }
  if ((env.VERITY_DATABASE_ACK ?? "").trim().toLowerCase() !== host) {
    problems.push(`DATABASE_URL is a remote database: set VERITY_DATABASE_ACK to its host name to confirm ${purpose === "migrate" ? "migrating" : "using"} it on purpose`);
  }
  return problems;
}

export class DatabaseTargetError extends Error {}

export function assertDatabaseTarget(purpose: GuardedPurpose, databaseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const problems = databaseTargetProblems(purpose, databaseUrl, env);
  if (problems.length > 0) throw new DatabaseTargetError(`Refusing to run (${purpose}):\n- ${problems.join("\n- ")}`);
}
