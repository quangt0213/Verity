# Release runbook: migration 0006 and the round-2 release

This runbook releases draft PR #7 (verification relevance, map, layout, report
schedules, migration 0006, paid-work opt-in) to production. **Every gate below
needs its own explicit approval from the project owner.** Approving one gate
never approves the next. Preparing or reviewing this runbook authorizes
nothing.

Git, code and tests win over this file. If they disagree, fix this file.

## What deploys what (verified 2026-10-17 from the repository and GitHub)

| Fact | Evidence | Status |
| --- | --- | --- |
| Railway deploys on merges to `main` only, to `Verity / production` | GitHub deployments exist only for the merge commits `ea7058e`, `053eade` and `cc44449`; no PR branch head was ever deployed | Verified |
| A merge to `main` deploys **both** `verity-api` and `verity-worker` | Commit statuses on `main` from both services (`verity-worker` from `cc44449` on) | Verified |
| `verity-api` deploys have failed before | Its status failed on `ea7058e` and `053eade` | Verified |
| No Railway config-as-code, CI workflow or branch protection | No `railway.json`/`.toml`, `nixpacks`, `Procfile` or `.github/workflows`; no protection rules | Verified |
| API image starts `node dist/server.js` | `apps/api/Dockerfile` `CMD` | Verified |
| Worker start command | The repo defines only `start:worker` = `node dist/worker.js`; the command Railway runs, the Dockerfile path and the root directory are service settings | **Operator must confirm** |
| Railway watch paths and "wait for CI" | Service settings | **Operator must confirm** |
| Maypop rebuild/publish trigger and branch | Maypop leaves no trace in GitHub (no webhooks, deployments, statuses or checks); `maypop.toml` has no branch or publish key | **Operator must confirm** |
| The frontend's API address is compiled in | `VITE_VERITY_DATA_SOURCE` and `VITE_VERITY_API_URL` are build-time variables and also feed the CSP `connect-src`; no `.env.production` is committed. A rebuild without them shows "not connected" | Mechanism verified; Maypop's values **operator must confirm** (names only) |
| Paid Nimble work is off unless configured | Round 2: the four paid budgets default to `0`; missing, blank or whitespace = `0` = no paid call (`apps/api/src/worker/config.ts`, tests in `apps/api/test/worker-config.test.ts` and `test/worker/zero-budgets.test.ts`) | Verified in code; production values **operator must confirm** |
| `MIGRATE_ON_START=true` would apply migrations when the API starts | `apps/api/src/server.ts` | Verified in code; production value **operator must confirm** |

### Publication hold: split the release into two PRs

Merging to `main` deploys the API and the worker, and may make Maypop rebuild
the frontend at the same moment. Nothing in the repository can hold a Maypop
publication. The only hold that can be verified from the repository is to
**split PR #7**:

- **PR A, backend:** contracts, API, worker, migration 0006 and docs, with
  `apps/web` exactly as at `cc44449`. If Maypop rebuilds after PR A, it
  republishes today's frontend. The live frontend was built and checked against
  PR A's backend (`npm run check` passed).
- **PR B, frontend:** `apps/web` and its tests, merged only after the new API
  passes gate 5. PR B's merge also redeploys Railway with unchanged API code.

**Release blocker:** if PR #7 is merged as one PR, the release stays blocked
until the operator confirms how Maypop publishes after a push to `main` and
holds that publication.

### Report compatibility (why the frontend must wait)

| Frontend → API | Report without a schedule | Report with a schedule |
| --- | --- | --- |
| Old → old (today) | Works | Not possible (no schedule field) |
| New → old API | Works (blank schedule keys are omitted) | 400 strict rejection. The form keeps every value and says the service doesn't accept scheduled times yet |
| New → new API, 0006 applied | Works | Works |
| New → new API, **0006 missing** | Works | 500; the transaction rolls back with no partial rows. The form keeps every value |
| Old → new API | Works | Not possible |

| Code → schema | 0005 (production today, as reported) | 0006 |
| --- | --- | --- |
| Running API and worker (`cc44449`) | Works | Works; they never touch `report_schedules` |
| New API | Schedule-bearing reports fail (500, rolled back) | Works |
| New worker | **Refuses to start** (its readiness check requires 0003–0006) | Works |

The worker's readiness check (`apps/api/src/worker/schema-ready.ts`) proves only
that the required tables exist. It does **not** prove that columns, types,
constraints, grants, RLS or policies are correct; gate 3 checks those.

## Gate 1: read-only production preflight

**Approval:** "Run the read-only preflight." No writes anywhere.

The operator confirms in Railway, Maypop, Supabase and GitHub, reporting names
and states only, never values:

1. **Deployed versions:** the Railway `verity-api` and `verity-worker`
   deployments both run `cc44449`; GitHub's latest `Verity / production`
   deployment is `cc44449`; the currently published Maypop build is known and
   can be republished.
2. **Triggers:**
   - Railway services watch `main` (watch paths noted);
   - Maypop's rebuild/publish trigger and branch, and whether auto-publish can
     be held;
   - PR #7 is still a draft and nothing is queued to merge.
3. **Worker command:** the `verity-worker` start command runs `dist/worker.js`
   from the API image (not the API server).
4. **Budgets:** on `verity-worker`, `NIMBLE_DAILY_SEARCH_BUDGET`,
   `NIMBLE_DAILY_EXTRACT_BUDGET`, `NIMBLE_DAILY_AGENT_BUDGET` and
   `NIMBLE_AGENT_MAX_PER_EVENT` are each **explicitly `0`**. The running
   `cc44449` worker still has the old non-zero defaults, so an unset variable
   is **not** safe until PR A is deployed. After PR A, unset, blank or `0` all
   mean no paid calls; keep them explicit anyway.
5. **`MIGRATE_ON_START`** is unset or `false` on `verity-api`. Only the API
   server reads it (`apps/api/src/server.ts`); the worker never migrates.
6. **Maypop build variables** `VITE_VERITY_DATA_SOURCE` and
   `VITE_VERITY_API_URL` are present (names only).
7. **Database, read-only:** run the baseline query from gate 2 and record the
   result.

**Stop** if any item differs. Fix settings only with a separate approval.

## Gate 2: migration-only approval (apply 0006)

**Approval:** "Apply migration 0006 to production." This approves only the
migration, not a merge or deployment.

Preconditions, all required:

1. **A fresh, usable backup:** `pg_dump` taken immediately before, plus proof
   that it is usable (`pg_restore --list` succeeds, or a restore into a
   throwaway local database). Store it outside the repository and outside
   OneDrive.
2. **Baseline history matches the repository** (read-only):

   ```sql
   SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at;
   SELECT to_regclass('public.report_schedules');            -- must be NULL
   SELECT pg_get_userbyid(relowner) FROM pg_class
    WHERE oid = 'public.reports'::regclass;                   -- the owning role
   ```

   Exactly these 6 rows (Drizzle's `hash` is the SHA-256 of the migration file;
   `created_at` is the journal's `when`):

   | Migration | `created_at` | `hash` |
   | --- | --- | --- |
   | 0000_initial | 1790929018350 | `2db773fd56a35b9bacb2d0a82c5a518678e22d0a4549cd1787a4c4f5aa8ef986` |
   | 0001_integrity_triggers | 1790929027637 | `7bf51868b15822d5e0dc64fd741ed2fa950c442081d0fbd47df47dd470ad4544` |
   | 0002_lock_down_supabase_data_api | 1791012919362 | `0f7db4c3c1e5d0123ae036959cb4c6c4b485b918746963a6929a693dea4357f6` |
   | 0003_verification_runs | 1791061001761 | `0b22f1ed684c2b99c41047e02963b03435483518a86138473f04ca1c52e798b8` |
   | 0004_geocode_cache | 1791064022123 | `bb55e3481fd07b4df93a05846560f9480958ad4b023f7590262077edc74b6b92` |
   | 0005_extract_count_agent_resource | 1791095104295 | `1d6f3b18da10edfbc63a1455a9cf4b537d43481504f9f756c9f8309058c9f0dd` |
   | 0006_report_schedules (pending) | 1792236058949 | `abf912614cb60e4eb57c47cf50f30da22b2f0de604cd04d4cf8cfc6e33372a53` |

   **Stop** if the count isn't 6, any hash or timestamp differs, or
   `report_schedules` exists. Drizzle decides what is pending only by
   timestamp, so a mismatch would not stop the migrator by itself.
3. **Only 0006 is pending:** the build being migrated is PR A's merge
   candidate, whose journal ends at 0006 (`apps/api/drizzle/meta/_journal.json`).
4. **One migrator:** exactly one process runs `node dist/migrate.js`
   from PR A's build. The API and worker don't migrate on start (gate 1, item
   5). Drizzle takes no advisory lock.
5. **Same role as the service:** the migration connects as the role that owns
   `reports` (the role the API uses), so the new table has the same owner as
   every other Verity table. Remote connection settings as in the previous
   migrations: `DATABASE_URL`, `VERITY_DB_CA_PATH`, `VERITY_DATABASE_ACK`.
6. **Bounded lock and statement timeouts:** `dist/migrate.js` runs on one
   connection with `lock_timeout` and `statement_timeout` set as startup
   parameters (`MIGRATE_LOCK_TIMEOUT_MS`, default 5000;
   `MIGRATE_STATEMENT_TIMEOUT_MS`, default 60000; `0` is refused). It reads
   them back with `SHOW`, logs only the values, and refuses to migrate if they
   didn't take effect (`apps/api/src/db/migrate-runner.ts`). A lock wait or
   statement over its bound fails the migration transaction, which rolls back
   completely (proven on real PostgreSQL: `test/concurrency/migrate-gate.pg.test.ts`).
   **Use a direct or session-mode connection** (Supabase pooler port 5432, or
   the direct host), not the transaction-mode pooler (port 6543), which may not
   keep session settings. The operator confirms which connection is used.
   Expected log line: `Migration timeouts in effect: lock_timeout=5s
   statement_timeout=1min`.
7. **Timing:** a quiet period. Adding the foreign key briefly blocks report
   writes (`SHARE ROW EXCLUSIVE` on `reports`).

The running `cc44449` API and worker keep working after 0006 (they never
reference the new table). **Stop** after this gate.

## Gate 3: post-migration verification (read-only)

**Approval:** part of gate 2, but its results must be reported before gate 4
is requested.

```sql
-- History: seven rows, the newest is 0006 with the expected hash.
SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;          -- 7, 1792236058949
SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = 1792236058949;
  -- abf912614cb60e4eb57c47cf50f30da22b2f0de604cd04d4cf8cfc6e33372a53

-- Table shape.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'report_schedules'
 ORDER BY ordinal_position;
  -- report_id uuid NO; scheduled_start_at timestamptz NO; scheduled_end_at timestamptz YES;
  -- created_at timestamptz NO now()

-- Constraints: primary key, order CHECK, FK to reports ON DELETE CASCADE.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'public.report_schedules'::regclass ORDER BY conname;
  -- report_schedules_order          CHECK (scheduled_end_at IS NULL OR scheduled_end_at >= scheduled_start_at)
  -- report_schedules_pkey           PRIMARY KEY (report_id)
  -- report_schedules_report_id_reports_id_fk FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  -- PostgreSQL 18+ also lists three "..._not_null" rows (report_id, scheduled_start_at, created_at).

-- RLS on, no policies, same owner as reports.
SELECT relrowsecurity, pg_get_userbyid(relowner) FROM pg_class
 WHERE oid IN ('public.report_schedules'::regclass, 'public.reports'::regclass);
SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'report_schedules';  -- 0

-- No effective client-role privileges (includes PUBLIC and inherited grants).
SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.report_schedules', p) AS allowed
  FROM unnest(ARRAY['anon', 'authenticated']) AS r,
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p;
  -- every row false

-- Service access, run as the API's role.
SELECT p, has_table_privilege(current_user, 'public.report_schedules', p)
  FROM unnest(ARRAY['SELECT', 'INSERT', 'DELETE']) AS p;  -- every row true
```

Also confirm that the running `cc44449` API still answers `GET /api/v1/health`
and the running worker keeps polling (logs only).

**Stop** if anything differs. Recovery for a failed migration: the migration is
one transaction, so a failure leaves 0005 intact. Re-run the gate 2 baseline
query and report.

## Gate 4: merge PR A and deploy the backend (frontend held)

**Approval:** "Merge PR A." It must name the PR and its head SHA.

1. PR A is reviewed; its head is the commit the approval names; gates 1–3
   passed.
2. Merge PR A. Railway deploys `verity-api` and `verity-worker` from the merge
   commit. Any Maypop rebuild republishes the unchanged frontend.
3. Watch both deployments reach success. If `verity-api` fails, roll back (see
   below) and stop.
4. Do **not** merge PR B.

## Gate 5: production smoke writes and worker verification

**Approval:** "Run the production smoke test." The approval names the test
account, the location used and how the test reports will be retired.

1. `GET /api/v1/health` on the new API.
2. One report **without** a schedule → 201.
3. One report **with** a schedule (planned category) → 201; confirm one new
   `report_schedules` row (count only, read-only).
4. Worker: the logs show the readiness check passed; jobs are deferred with
   `search_budget_exhausted` (budgets 0, no Nimble call); the aging sweep runs.
5. Confirm in the Nimble dashboard (read-only) that no new paid call was made.

## Gate 6: publish the new frontend

**Approval:** "Merge PR B / publish the frontend." Only after gate 5 passed.

1. Merge PR B (Railway redeploys the API and worker with unchanged API code;
   the worker restart is lease-safe).
2. Maypop publishes the new frontend (or the operator publishes it).
3. Smoke inside Maypop:
   - `/welcome`, `/map`, `/report` and one event detail;
   - the lazy map chunk loads, and the map worker's tile requests aren't
     blocked by Maypop's response headers (a meta CSP doesn't cover workers);
   - scrolling the sidebar or bottom sheet never scrolls the page or the host;
   - places show around San Jose;
   - a report with a schedule submits.

## Gate 7: any paid verification run

**Approval:** "Run paid verification" with explicit budgets (for example
search 3, extract 4, Agent 0) and a time window. Set the worker variables,
observe, and set them back to `0` afterwards. V2 (Agent reads after the
extraction slots are used) stays deferred.

## Rollback

| Situation | Action | Schema |
| --- | --- | --- |
| Frontend misbehaves after gate 6 | Republish the previous Maypop build, or revert PR B on `main` (with approval). Unpublishing the frontend first is always safe: old frontends never send a schedule | Keep 0006 |
| API or worker fails after gate 4 | Railway: redeploy the previous deployment (`cc44449`) for both services. If the new frontend is already live, schedule-bearing reports get the "doesn't accept scheduled times yet" message; everything else works | Keep 0006: the old code ignores `report_schedules` |
| Bad data or migration problem | Stop and report. Restore from the gate 2 backup only with explicit approval | — |

Rollback restores compatible application builds and **retains 0006**.
Removing it deletes every reporter's schedule claim, so it needs a **separate
emergency approval**, and only after no deployed code uses the table:

```sql
-- EMERGENCY ONLY, separately approved. Deletes all reporter schedule claims.
BEGIN;
DROP TABLE report_schedules;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792236058949;
COMMIT;
```

This reversal was rehearsed on a throwaway PostgreSQL 18.6 (2026-10-17); it
returned the database to its 0005 fingerprint.

## Rehearsal of gates 2 and 3 (2026-10-17, throwaway local PostgreSQL 18)

Supabase-like roles: a non-superuser owner, `anon` and `authenticated` with
`USAGE` on `public` and default `ALL` grants on the owner's new tables. The
built `dist/migrate.js` from `team/integration` was used throughout.

- The 0005 database (seeded demo data, 124 rows in 15 tables) gave exactly the
  six baseline rows in the table above, `report_schedules` absent, owner = the
  service role.
- With another session holding `reports` locked and
  `MIGRATE_LOCK_TIMEOUT_MS=500`, the migrator logged `lock_timeout=500ms`,
  failed with SQLSTATE `55P03` after 1.2 s, and left 6 history rows and no
  table.
- After the lock cleared, 0006 applied (`lock_timeout=5s
  statement_timeout=1min`); a repeat run was a no-op.
- Gate 3: 7 rows, newest `1792236058949` with the expected hash; columns,
  CHECK, primary key and cascading FK as listed; RLS on and same owner as
  `reports`; 0 policies; 0 of 14 client-role privilege checks allowed; the
  service role can select, insert and delete. All 15 existing tables were
  identical (row count and md5 of every row).

A real Supabase project can still differ (roles, pooler, PostgreSQL version),
so gates 1–3 are not replaced by this rehearsal.
