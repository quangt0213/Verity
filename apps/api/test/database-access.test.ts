import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client";
import { createTestContext, INTERNAL_TOKEN, SUPABASE_LIKE_SETUP, validReport, type TestContext } from "./helpers";

// Verity's database is reached only by the Verity service. Hosted Postgres
// (Supabase) also exposes the public schema to its client APIs through the
// anon/authenticated roles; migration 0002 must close that path without
// affecting the service.

const VERITY_TABLES = [
  "auth_accounts",
  "auth_sessions",
  "auth_verifications",
  "community_signals",
  "event_follows",
  "event_state_transitions",
  "event_timeline",
  "events",
  "rate_limit_counters",
  "reports",
  "source_records",
  "users",
  "verification_jobs",
  "verification_runs",
];
const CLIENT_ROLES = ["anon", "authenticated"] as const;
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** A text[] literal from fixed identifiers (constants only, never user input). */
const textArray = (values: readonly string[]) => sql.raw(`ARRAY[${values.map((v) => `'${v}'`).join(", ")}]::text[]`);

async function rows<T>(db: Database, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** Runs `fn` in a transaction that is always rolled back. */
async function inRolledBackTransaction(db: Database, fn: (tx: Database) => Promise<void>): Promise<void> {
  const rollback = new Error("rollback");
  try {
    await db.transaction(async (tx) => {
      await fn(tx as unknown as Database);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** Runs `query` as a client role in a transaction that is always rolled back. */
async function asClientRole(db: Database, role: string, query: SQL): Promise<string | undefined> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
      await tx.execute(query);
      throw new Error("query was allowed");
    });
  } catch (error) {
    return pgCode(error);
  }
  return undefined;
}

async function rlsDisabledTables(db: Database): Promise<string[]> {
  const result = await rows<{ relname: string }>(
    db,
    sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
  );
  return result.map((r) => r.relname);
}

describe("plain Postgres (no Supabase roles)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  it("applies the lockdown migration and enables RLS on every table, including future ones", async () => {
    const tables = await rows<{ relname: string }>(
      ctx.db,
      sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    expect(tables.map((t) => t.relname)).toEqual(VERITY_TABLES);
    // A new table in a later migration must enable RLS too, or this fails.
    expect(await rlsDisabledTables(ctx.db)).toEqual([]);
  });
});

describe("Supabase-like hosted Postgres", () => {
  let ctx: TestContext;
  let eventId: string;
  beforeAll(async () => {
    ctx = await createTestContext({}, {
      beforeMigrate: async (db) => {
        for (const statement of SUPABASE_LIKE_SETUP) await db.execute(sql.raw(statement));
      },
    });
  });
  afterAll(async () => ctx.close());

  it("runs the service as the non-superuser, non-BYPASSRLS table owner", async () => {
    const [role] = await rows<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      ctx.db,
      sql`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ current_user: "verity_service", rolsuper: false, rolbypassrls: false });
    const owners = await rows<{ owner: string }>(
      ctx.db,
      sql`select distinct pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(owners).toEqual([{ owner: "verity_service" }]);
  });

  it("keeps every normal service operation working under RLS", async () => {
    const reporter = await ctx.signIn("owner-reporter@example.com");
    const voter = await ctx.signIn("owner-voter@example.com");
    expect((await ctx.request({ method: "GET", url: "/api/v1/me", token: reporter })).statusCode).toBe(200);

    const report = await ctx.request({ method: "POST", url: "/api/v1/reports", token: reporter, payload: validReport });
    expect(report.statusCode).toBe(201);
    eventId = report.json().event_id;
    // A second nearby report attaches to the same event (advisory lock, dedupe).
    const merged = await ctx.request({ method: "POST", url: "/api/v1/reports", token: voter, payload: validReport });
    expect(merged.json().event_id).toBe(eventId);

    const confirm = await ctx.request({ method: "POST", url: `/api/v1/events/${eventId}/signals`, token: voter, payload: { type: "CONFIRM" } });
    expect(confirm.statusCode).toBe(201);
    const change = await ctx.request({ method: "POST", url: `/api/v1/events/${eventId}/signals`, token: voter, payload: { type: "DISPUTE" } });
    expect(change.json()).toEqual({ type: "DISPUTE", changed: true });

    expect((await ctx.request({ method: "POST", url: `/api/v1/events/${eventId}/follow`, token: voter })).json()).toEqual({ following: true });
    const following = (await ctx.request({ method: "GET", url: "/api/v1/me/following", token: voter })).json();
    expect(following.events.map((e: { id: string }) => e.id)).toEqual([eventId]);
    expect((await ctx.request({ method: "DELETE", url: `/api/v1/events/${eventId}/follow`, token: voter })).json()).toEqual({ following: false });

    const transition = await ctx.app.inject({
      method: "POST",
      url: `/internal/v1/events/${eventId}/transition`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { to: "DEVELOPING", reason: "Test: owner role under RLS", expected_from: "UNVERIFIED" },
    });
    expect(transition.statusCode).toBe(200);

    const detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${eventId}` })).json();
    expect(detail.status).toBe("DEVELOPING");
    expect(detail.community_dispute_count).toBe(1);
    expect(detail.timeline.length).toBeGreaterThan(0);
    const list = (await ctx.request({ method: "GET", url: "/api/v1/events?bbox=-122.55,37.7,-122.35,37.83" })).json();
    expect(list.events.map((e: { id: string }) => e.id)).toContain(eventId);

    expect((await ctx.request({ method: "POST", url: "/api/v1/auth/sign-out", token: reporter })).statusCode).toBe(204);
    expect((await ctx.request({ method: "GET", url: "/api/v1/me", token: reporter })).statusCode).toBe(401);
  });

  it("enables RLS on every Verity table and defines no policies", async () => {
    expect(await rlsDisabledTables(ctx.db)).toEqual([]);
    const policies = await rows<{ n: number }>(ctx.db, sql`select count(*)::int as n from pg_policies where schemaname = 'public'`);
    expect(policies[0]!.n).toBe(0);
  });

  it("leaves anon and authenticated with no table or function privileges", async () => {
    const granted = await rows<{ grant: string }>(
      ctx.db,
      sql`select r.role || ' ' || p.priv || ' ' || t.tbl as grant
          from unnest(${textArray(CLIENT_ROLES)}) r(role),
               unnest(${textArray(TABLE_PRIVILEGES)}) p(priv),
               unnest(${textArray(VERITY_TABLES)}) t(tbl)
          where has_table_privilege(r.role, 'public.' || t.tbl, p.priv)
          union all
          select r.role || ' EXECUTE ' || f.proname
          from unnest(${textArray(CLIENT_ROLES)}) r(role), pg_proc f join pg_namespace n on n.oid = f.pronamespace
          where n.nspname = 'public' and f.proname like 'verity\\_%' and has_function_privilege(r.role, f.oid, 'EXECUTE')`,
    );
    expect(granted).toEqual([]);
  });

  it("refuses reads and writes from client roles at query time", async () => {
    for (const role of CLIENT_ROLES) {
      expect(await asClientRole(ctx.db, role, sql`select * from users`), `${role} select users`).toBe("42501");
      expect(await asClientRole(ctx.db, role, sql`select token from auth_sessions`), `${role} select sessions`).toBe("42501");
      expect(await asClientRole(ctx.db, role, sql`select * from events`), `${role} select events`).toBe("42501");
      expect(
        await asClientRole(ctx.db, role, sql`insert into events (title, category, latitude, longitude, approximate_location, origin)
          values ('Injected', 'other', 0, 0, 'x', 'community_report')`),
        `${role} insert events`,
      ).toBe("42501");
      expect(await asClientRole(ctx.db, role, sql`update events set title = 'Rewritten'`), `${role} update events`).toBe("42501");
      expect(await asClientRole(ctx.db, role, sql`delete from event_follows`), `${role} delete follows`).toBe("42501");
      expect(await asClientRole(ctx.db, role, sql`select * from verification_runs`), `${role} select runs`).toBe("42501");
      expect(
        await asClientRole(ctx.db, role, sql`update verification_runs set agent_run_id = 'forged'`),
        `${role} update runs`,
      ).toBe("42501");
    }
  });

  it("does not grant future tables to client roles", async () => {
    await inRolledBackTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`create table future_probe (id int)`);
      const [granted] = await rows<{ anon: boolean; authenticated: boolean }>(
        tx,
        sql`select has_table_privilege('anon', 'future_probe', 'SELECT') as anon,
                   has_table_privilege('authenticated', 'future_probe', 'SELECT') as authenticated`,
      );
      expect(granted).toEqual({ anon: false, authenticated: false });
    });
  });

  it("still hides every row through RLS if a grant is ever added by mistake", async () => {
    let visible: number | undefined;
    await inRolledBackTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`grant select on events, users to anon`);
      await tx.execute(sql`set local role anon`);
      const [counts] = await rows<{ events: number; users: number }>(
        tx,
        sql`select (select count(*) from events)::int as events, (select count(*) from users)::int as users`,
      );
      visible = counts!.events + counts!.users;
    });
    expect(visible).toBe(0);
    // The owner still sees them.
    const [owner] = await rows<{ n: number }>(ctx.db, sql`select count(*)::int as n from events where id = ${eventId}`);
    expect(owner!.n).toBe(1);
  });
});
