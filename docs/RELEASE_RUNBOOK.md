# Release runbook: migration 0006 and the round-2 release

This runbook releases draft PR #7 (verification relevance, map, layout, report
schedules, migration 0006, paid-work opt-in) to production as two PRs (PR A
backend, PR B frontend; see "Publication hold").

## Approvals

**Every gate needs its own explicit approval from the project owner, using
that gate's phrase.**

- An approval names its gate, for example "Approve gate 2: apply migration 0006
  to production." A bare "go ahead", "yes", "merge" or "ship it" approves
  nothing.
- **Approving one gate never implies the next**, even when the next gate is
  read-only or the steps run back to back.
- **Preparing, reviewing or publishing the draft PRs grants no production
  authorization.** That covers marking PR A or PR B ready for review,
  requesting review, or approving the PRs on GitHub. Neither does preparing or
  reviewing this runbook.
- A retry is covered by the original approval only where this runbook says so
  (gate 2, "If the migrator doesn't finish cleanly"). Every other retry needs
  a new approval.

| Gate | Approval phrase | What it authorizes |
| --- | --- | --- |
| 1 | "Approve gate 1: read-only production preflight." | Read-only checks in Railway, Maypop, Supabase and GitHub |
| 2 | "Approve gate 2: apply migration 0006 to production." | Running the migrator for 0006 after the backup evidence is accepted, plus only the retries its outcome table allows |
| 3 | "Approve gate 3: post-migration verification (read-only)." | The gate 3 queries and the health and log checks |
| 4 | "Approve gate 4: merge PR A at `<head SHA>`." | Merging PR A, which deploys the API and worker |
| 5 | "Approve gate 5: production smoke test with `<account>`, `<location>`, `<retirement plan>`." | The listed test writes |
| 6 | "Approve gate 6: merge PR B at `<head SHA>` and publish the frontend." | Merging PR B and publishing on Maypop |
| 7 | "Approve gate 7: paid verification with budgets `<…>` from `<start>` to `<end>`." | The stated budgets for the stated window |
| — | "Approve rollback of `<frontend / API and worker>` to `<build or deployment>`." | Only that rollback (see Rollback) |
| — | "Approve restore from the gate 2 backup." / "Approve emergency reversal of 0006." | Only that recovery action |

Git, code and tests win over this file. If they disagree, fix this file.

## What deploys what (repository and GitHub 2026-10-17; Railway, Maypop and GitHub dashboards 2026-10-18)

| Fact | Evidence | Status |
| --- | --- | --- |
| Railway deploys on merges to `main` only, to `Verity / production` | GitHub deployments exist only for the merge commits `ea7058e`, `053eade` and `cc44449`; no PR branch head was ever deployed | Verified |
| A merge to `main` deploys **both** `verity-api` and `verity-worker` | Commit statuses on `main` from both services (`verity-worker` from `cc44449` on) | Verified |
| `verity-api` deploys have failed before | Its status failed on `ea7058e` and `053eade` | Verified |
| No Railway config-as-code, CI workflow or branch protection | No `railway.json`/`.toml`, `nixpacks`, `Procfile` or `.github/workflows`; no protection rules | Verified |
| API image starts `node dist/server.js` | `apps/api/Dockerfile` `CMD` | Verified |
| Worker start command | Railway `verity-worker`: custom start command `node dist/worker.js`, Dockerfile `/apps/api/Dockerfile`, no root directory. `verity-api`: no custom start command (Dockerfile `CMD`), `RAILWAY_DOCKERFILE_PATH=/apps/api/Dockerfile`, no pre-deploy step | Verified 2026-10-18 (Railway dashboard) |
| Railway branch, watch paths, environments | Both services: branch `main`, automatic deploys on, **no watch paths** (any merge redeploys both). One environment, `production`; **PR environments are off**. The Railway GitHub App has access to all repositories | Verified 2026-10-18 (Railway and GitHub dashboards) |
| Maypop rebuild/publish path | The published v2 was built from Maypop's editor workspace: iteration 1 "Scaffold React and Vite app", iteration 2 "Imported Verity from your GitHub", iteration 3 "The approved synchronization" (Oct 12, latest). That is `cc44449`'s `apps/web` with 71 of 73 source files identical; `src/config/env.ts` (plus its test) adds a guard. Maypop leaves no trace in GitHub, and no Maypop app or OAuth grant is listed on the account. Whether a push syncs or publishes by itself, and what the editor's "Done" does, are **not verified**. Treat Done, Revert, Discard and any sync as publish-adjacent, needing their own approval | Workspace and history verified 2026-10-18; trigger **unverified** |
| The frontend's API address is compiled in | `VITE_VERITY_DATA_SOURCE` and `VITE_VERITY_API_URL` are build-time variables and also feed the CSP `connect-src`; no `.env.production` is committed. A rebuild without them shows "not connected". The published v2 bundle contains data source `api` and the production API origin in its CSP | Mechanism and v2 values verified; **where Maypop stores them is not visible** in its UI (gate 6 risk) |
| Paid Nimble work is off unless configured | Round 2: the four paid budgets default to `0`; missing, blank or whitespace = `0` = no paid call (`apps/api/src/worker/config.ts`, tests in `apps/api/test/worker-config.test.ts` and `test/worker/zero-budgets.test.ts`). Production `verity-worker`: all four are explicitly `0`; `NIMBLE_MAX_EXTRACTS_PER_JOB=0`, `NIMBLE_MAX_SEARCHES_PER_JOB=1` | Verified 2026-10-18 (Railway dashboard). Re-check before each gate |
| `MIGRATE_ON_START=true` would apply migrations when the API starts | `apps/api/src/server.ts`. Production `verity-api`: `MIGRATE_ON_START=false` | Verified 2026-10-18 (Railway dashboard). Re-check before gate 4 |

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
  After PR A merges, PR B must be **reconciled with the current `main`** (merge
  `main` into it, or rebase it onto `main`). Its diff against `main` must then
  be re-checked to contain only `apps/web/**` before gate 6 is requested (see
  gate 6).

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

**Approval:** "Approve gate 1: read-only production preflight." No writes
anywhere.

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

**Stop** if any item differs. Changing a setting needs its own approval that
names the setting; gate 1's approval is read-only.

## Gate 2: migration-only approval (apply 0006)

**Approval:** "Approve gate 2: apply migration 0006 to production." This
approves only the migration: not gate 3, not a merge, not a deployment. Request
it only after the backup evidence below has been presented.

Preconditions, all required:

1. **A fresh, validated backup.** Procedure:
   [BACKUP_RESTORE_PLAN.md](BACKUP_RESTORE_PLAN.md), approved separately with
   "Approve production backup: read-only `pg_dump` of the Verity schemas, plus
   a local restore validation." Take a `pg_dump` (custom format, `-Fc`)
   immediately before the migration window. Store it outside the repository and
   outside OneDrive. There are two levels of validation, and they prove
   different things:
   - **Inventory validation:** `pg_restore --list <dump>` reads the archive's
     table of contents. It proves the file is readable and lists the expected
     objects. It does **not** prove the dump can be restored.
   - **Restore validation:** full `pg_restore` runs with PostgreSQL 17 tools
     into new databases on a disposable local PostgreSQL 17 server (never
     production or any shared database). There are two modes, a plain-data
     restore and an owner-preserving restore. Then every check in the plan,
     including:
     - all 15 Verity tables in `public` exist (every `CREATE TABLE` in
       0000–0005);
     - the row counts of every `public` and `drizzle` table equal the counts
       taken inside the snapshot that `pg_dump` used;
     - `drizzle.__drizzle_migrations` has exactly the 6 rows and hashes in item 2;
     - owners and the effective `anon`/`authenticated`/`service_role`
       privileges equal production's.

   **Freshness.** Production keeps accepting writes, so a backup goes stale
   as soon as it is taken. Take the gate 2 backup and its restore validation
   in the same window as the migration, immediately before it. An earlier
   validated backup proves the procedure works and serves as a fallback, but
   it is not the gate 2 backup. The 2026-10-19 00:19Z backup is one of these.

   **Restore validation is required for gate 2 approval.** The only exception
   is if the approver explicitly accepts inventory-only validation and the
   accepted risk is recorded with the approval: a backup that may not restore.

   **Evidence the operator presents before approval.** Facts only: never dump
   contents, data rows or connection strings, and never paste any of them into
   docs, PRs or chat.
   - dump start and end timestamps (UTC);
   - `pg_dump`/`pg_restore` versions and the production server version;
   - file size and SHA-256 checksum;
   - storage location, described (for example "encrypted external drive", not
     a path inside the repository or OneDrive);
   - the `pg_restore --list` result (succeeded, entry count);
   - the restore result (succeeded with no errors, or the exact error class)
     and the table, row-count and migration-history comparison above.
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
   **Connection: the direct database host**, `db.<project ref>.supabase.co:5432`,
   with user `postgres`, verified TLS (`VERITY_DB_CA_PATH` = the repo's
   `apps/api/certs/prod-ca-2021.crt`) and `VERITY_DATABASE_ACK` set to that
   host. Evidence, from a harmless probe on 2026-10-18 (connect, `SHOW`,
   `SELECT 1` only):
   - **Session pooler (the service's `DATABASE_URL`, port 5432): unusable as
     is.** It drops startup parameters (lock timeout `0`, statement timeout
     `2min`, `application_name` rewritten), so the migrator refuses (exit 2).
     A session-level `SET` does hold on one pinned backend across
     transactions. That fallback would need a code change, which was not
     built because the direct host works.
   - **Direct host:** DNS is IPv6-only. It was reachable from the operator
     workstation over IPv6, TLS verified with the repo CA, authentication
     worked, and **all three startup parameters were honored** (5s, 1min,
     `verity-migrate`).
   - **Not the transaction pooler** (port 6543).

   **Run the migrator from an IPv6-capable machine.** A Railway service or an
   IPv4-only network can't reach the direct host unless Supabase's IPv4
   add-on is enabled. Before gate 2, re-check that the host is reachable from
   the machine that will run it.
   Expected log lines: `Migration timeouts in effect: lock_timeout=5s
   statement_timeout=1min`, then `Migration session
   application_name=verity-migrate`. The second line is informational only. If
   it shows a different name or `(other)`, the run continues, and the
   uncertain-outcome procedure must use its fallback check.
   - **The statement timeout bounds each statement, not the whole run.** A
     run with several statements can take longer than
     `MIGRATE_STATEMENT_TIMEOUT_MS` in total without any of them timing out.
   - **An effective-timeout mismatch is a failed safety check, and nothing is
     applied** (exit 2, "Migration refused: safety check failed (the connection
     did not keep the requested lock_timeout/statement_timeout)…"). It means the
     values the server reported differ from the requested ones. A transaction-mode pooler is one possible
     cause, but not the only one: a role or database default, a proxy, or a
     server that rewrites settings could also do it. Confirm what the
     connection actually is before retrying, and don't raise or remove the
     limits to make the check pass.
   - Any other failure: see "If the migrator doesn't finish cleanly" below.
7. **Timing:** a quiet period. Adding the foreign key briefly blocks report
   writes (`SHARE ROW EXCLUSIVE` on `reports`).

The running `cc44449` API and worker keep working after 0006 (they never
reference the new table). **Stop** after this gate.

### If the migrator doesn't finish cleanly

Success is exit code 0, ending with `Migrations applied.` (after the
timeouts and application_name lines in item 6).
Anything else falls into one of three outcome classes; the exit code and the
message say which (`apps/api/src/db/migrate-runner.ts`, `apps/api/src/scripts/migrate.ts`).

- Output never contains a URL, host, user, password or driver message. The
  only variable part, `<…>` below, is a SQLSTATE (for example `SQLSTATE 55P03`)
  or an error-code name (for example `ECONNRESET`).
- Exit codes used to be a single `1`. **Anything that checks for exit `1` must
  change**; a plain non-zero check still works.
- **Never retry automatically.** The migrator itself never retries, and no
  script, loop or restart policy may re-run it.

| Outcome class | Exit | Message (exact) | What happened | What to do |
| --- | --- | --- | --- | --- |
| **Configuration refusal: nothing attempted** | 2 | `Migration refused: invalid or incomplete database configuration. Nothing was applied. Fix the configuration, then run again.` (the next line names the variable, never its value) | Invalid environment, or a missing or corrupt CA file | Fix the named setting (names only, never values). Re-run the gate 2 baseline query; it must still show 6 rows and no table. Retrying under the same gate 2 approval is allowed once it's fixed and the approver is told. |
| | 2 | `Migration refused: database target check failed. Nothing was applied.` (the next lines list the problems) | The remote-target guard refused (for example a missing or wrong `VERITY_DATABASE_ACK`) | Same as above |
| | 2 | `Migration refused: safety check failed (the connection did not keep the requested lock_timeout/statement_timeout). Nothing was applied. Use a direct or session-mode connection, then run again.` | The effective-timeout safety check failed (item 6). The connection may be a transaction-mode pooler, or something else may override the settings | Confirm what the connection actually is before re-running. Don't loosen the limits. Then same as above |
| | 3 | `Migration not attempted: could not connect to or authenticate with the database (<…>). Nothing was applied. Check the connection settings, then run again.` | Connect, authentication or TLS failure before any migration SQL ran (for example `28P01`, `3D000`, `ECONNREFUSED`, certificate errors, `CONNECT_TIMEOUT`) | Same as above |
| **Confirmed server-side failure: rolled back** | 4 | `Migration failed: the server rejected a statement (SQLSTATE <…>). PostgreSQL rolled back the migration transaction; nothing from it was applied. Resolve the cause (for 55P03 or 57014, wait until the blocking session is gone), then run again.` | The server returned a SQLSTATE inside the migration transaction (`55P03` lock timeout, `57014` statement timeout, or a constraint or syntax error), and PostgreSQL rolled the transaction back | Re-run the gate 2 baseline query (6 rows, no table). Find the cause: a blocking session or a slow statement. Don't raise the limits blindly. Report to the approver; a retry needs the approver's go-ahead under the same gate 2 approval. |
| **Uncertain outcome** | 5 | `Migration outcome UNKNOWN: the connection failed while migrations were running (<…>). Do not retry yet. Confirm the previous migration session has ended (pg_stat_activity), then inspect drizzle.__drizzle_migrations and the schema to see whether the migration was applied before deciding to run again.` | The connection failed after migrations started (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `CONNECTION_CLOSED/ENDED/DESTROYED`, a TLS error mid-run, SQLSTATE class `08` or `57P01`–`57P03`, or no code at all). **The commit may or may not have happened.** | Follow the procedure below. |

The verifier rehearsed these on real PostgreSQL:
- a terminated migrator backend → exit 5 (`CONNECTION_CLOSED`);
- `55P03` and `57014` → exit 4;
- a missing database → exit 3 (`SQLSTATE 3D000`).

#### Uncertain outcome: procedure

1. **Don't retry yet.**
2. **Confirm the previous migration session has ended.** Read-only, as the
   service role.

   **Primary check.** The migrator's single connection identifies itself as
   `verity-migrate`. Its log prints `Migration session
   application_name=verity-migrate` right after the timeouts line. The API and
   worker pools use the driver default, `postgres.js`.

   ```sql
   SELECT pid, state, xact_start, wait_event_type
     FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name = 'verity-migrate';
   ```

   **Fallback check:** use this if the migrator's log printed a different name
   or `(other)` (a pooler didn't pass the name through), or if the log line is
   missing. Run it anyway when in doubt; it's read-only:

   ```sql
   -- Sessions that could still be the migrator: touching the migration objects,
   -- holding a transaction open, or locking reports/report_schedules.
   SELECT a.pid, a.state, a.xact_start, a.wait_event_type
     FROM pg_stat_activity a
    WHERE a.datname = current_database()
      AND a.usename = current_user          -- the migrator used the service role
      AND a.pid <> pg_backend_pid()
      AND (a.query ILIKE '%report_schedules%'
           OR a.query ILIKE '%__drizzle_migrations%'
           OR a.state LIKE 'idle in transaction%');

   SELECT l.pid, l.mode, l.granted, c.relname
     FROM pg_locks l
     JOIN pg_class c ON c.oid = l.relation
    WHERE c.relname IN ('reports', 'report_schedules', '__drizzle_migrations')
      AND l.mode NOT IN ('AccessShareLock', 'RowShareLock', 'RowExclusiveLock')  -- the API's ordinary reads and writes
      AND l.pid <> pg_backend_pid();
   ```

   The application name isn't part of the safety gate: a different name never
   refuses the run. That's why the fallback matches on the migration objects,
   open transactions and strong locks (the migrator holds
   `ShareRowExclusiveLock` on `reports` while adding the foreign key).
   Report counts and states only, never query text or client addresses. The
   session has ended when the primary check returns no rows and the fallback
   shows no migrator session (no transaction open on the migration objects, no
   strong lock held on them). If one is
   still there, wait and check again. Ending it with `pg_terminate_backend` is
   a write and needs its own approval.
3. **Inspect the history and the schema** (read-only):

   ```sql
   SELECT count(*) AS rows,
          max(created_at) AS newest_created_at,
          (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1) AS newest_hash
     FROM drizzle.__drizzle_migrations;
   SELECT to_regclass('public.report_schedules');
   ```

4. **Decide with the approver.** Only these outcomes are allowed:

   | History | `report_schedules` | Meaning | Next step |
   | --- | --- | --- | --- |
   | 6 rows, newest `1791095104295` / `1d6f3b18…`, hashes as in item 2 | `NULL` | Rolled back or never started | A retry is allowed **under the same gate 2 approval**, once the approver agrees and step 2 confirmed no session remains |
   | 7 rows, newest `1792236058949` / `abf91261…` | exists | Committed | Don't retry. Go to gate 3 (its own approval) |
   | Anything else (6 rows with the table, 7 rows without it, other counts or hashes) | — | Unexpected state | **Stop.** Report to the approver; no further write without a new approval |

## Gate 3: post-migration verification (read-only)

**Approval:** "Approve gate 3: post-migration verification (read-only)."
Gate 2's approval doesn't include it. Report its results before gate 4 is
requested.

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

**Stop** if anything differs, and report.

Recovery depends on how gate 2 ended (see "If the migrator doesn't finish
cleanly"):
- **Configuration refusal** or **confirmed server-side failure:** nothing
  committed, so 0005 is intact.
- **Uncertain outcome:** don't assume either way. The history and schema
  inspection decides: retry, gate 3, or stop.

A gate 3 result that matches neither 0005 nor the expected 0006 state is a
stop. Fixing it needs a new approval (a restore or an emergency reversal).

## Gate 4: merge PR A and deploy the backend (frontend held)

**Approval:** "Approve gate 4: merge PR A at `<head SHA>`." The SHA must be
PR A's current head. If PR A changes after the approval, the approval lapses.

1. PR A is reviewed; its head is the commit the approval names; gates 1–3
   passed.
2. Merge PR A. Railway deploys `verity-api` and `verity-worker` from the merge
   commit. Any Maypop rebuild republishes the unchanged frontend.
3. Watch both deployments reach success. If either fails or misbehaves,
   **stop** and report. Roll back (see below) only under its own rollback
   approval.
4. Do **not** merge PR B.

## Gate 5: production smoke writes and worker verification

**Approval:** "Approve gate 5: production smoke test with `<account>`,
`<location>`, `<retirement plan>`." It names the test account, the location
used and how the test reports will be retired. Gate 4's approval doesn't
include it.

1. `GET /api/v1/health` on the new API.
2. One report **without** a schedule → 201.
3. One report **with** a schedule (planned category) → 201; confirm one new
   `report_schedules` row (count only, read-only).
4. Worker: the logs show the readiness check passed; jobs are deferred with
   `search_budget_exhausted` (budgets 0, no Nimble call); the aging sweep runs.
5. Confirm in the Nimble dashboard (read-only) that no new paid call was made.

## Gate 6: publish the new frontend

**Approval:** "Approve gate 6: merge PR B at `<head SHA>` and publish the
frontend." Request it only after gate 5 passed and PR B has been reconciled
with `main` (below). The SHA must be PR B's head after reconciliation.

Before requesting approval:

1. **Reconcile PR B with the current `main`.** PR A's merge moved `main`.
   Change PR B's base on GitHub from `release/backend` to `main` (GitHub may
   do this itself if `release/backend` is deleted after the merge). Either
   merge `main` into PR B or rebase it onto `main` (push without force: prefer
   the merge), then re-run `npm run check` and the Playwright suites on the
   result.
2. **Re-check that PR B is frontend-only.** The diff against `main` may touch
   only `apps/web/**`:

   ```sh
   git fetch origin
   git diff --name-only origin/main...<PR B head> | grep -v '^apps/web/'   # must print nothing
   ```

   **Stop** if anything outside `apps/web/` appears. That code was never part
   of gates 2–5 and would deploy to Railway with PR B.

After approval:

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

**Approval:** "Approve gate 7: paid verification with budgets `<…>` from
`<start>` to `<end>`." It states explicit budgets (for example search 3,
extract 4, Agent 0) and a time window. Set the worker variables,
observe, and set them back to `0` afterwards. V2 (Agent reads after the
extraction slots are used) stays deferred.

## Rollback

| Situation | Action | Schema |
| --- | --- | --- |
| Frontend misbehaves after gate 6 | With "Approve rollback of the frontend to `<build>`". Old frontends never send a schedule, so going back is always schema-safe. **No exact restore of v2 has been verified.** The options and their limits are in "Frontend recovery (Maypop)" below. **Before gate 6, establish how Maypop restores a published version** | Keep 0006 |
| API or worker fails after gate 4 | With "Approve rollback of the API and worker to `cc44449`": in Railway, redeploy the previous deployment (`cc44449`) for both services. This also brings back `cc44449`'s job over-claim defect, harmless while every paid budget is 0. If the new frontend is already live, schedule-bearing reports get the "doesn't accept scheduled times yet" message; everything else works | Keep 0006: the old code ignores `report_schedules` |
| Bad data or migration problem | Stop and report. Restore from the gate 2 backup only with "Approve restore from the gate 2 backup." | — |

Rollback restores compatible application builds and **retains 0006**.
Removing it deletes every reporter's schedule claim, so it needs its own
approval, "Approve emergency reversal of 0006.", and only after no deployed code uses the table:

```sql
-- EMERGENCY ONLY, separately approved. Deletes all reporter schedule claims.
BEGIN;
DROP TABLE report_schedules;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792236058949;
COMMIT;
```

This reversal was rehearsed on a throwaway PostgreSQL 18.6 (2026-10-17); it
returned the database to its 0005 fingerprint.

### Frontend recovery (Maypop)

What is known, as of 2026-10-18: the published frontend is v2. Its source is
Maypop editor iteration 3, which is `cc44449`'s `apps/web` plus a guard in
`src/config/env.ts` and its test. Maypop rewrites `index.html` when it
publishes (injected scripts and a version id).

| Option | What it produces | Status |
| --- | --- | --- |
| A published-version restore in Maypop | v2 exactly, if Maypop offers one | **Unverified.** No published-version list or restore was seen in the UI |
| Editor iteration "Revert", then publishing | Whatever Maypop builds from the reverted workspace | **Unverified**, both what Revert does and what publishing does afterwards. Not a rollback until proven |
| Rebuild of known source (`cc44449`'s `apps/web` plus v2's `env.ts` guard, or PR B's previous head), then publishing | A **replacement artifact** with the same app behaviour as v2, **not a byte-identical restoration of v2**: different file hashes, slightly different CSS, a different toolchain | Building is verified locally. Publishing it through Maypop is **unverified** |
| The downloaded copy of v2's files | **Forensic evidence only.** It's incomplete (missing the Maypop SDK chunk that loads only in the frame), and its `index.html` already contains Maypop's injections | **Never upload or publish it** |

Until a recovery path is proven, keep what exists:
- **The editor draft:** no Done, Discard, Revert, sync or Unlink without an
  approval that names the action.
- **The forensic copy:** leave it untouched where it is.

Maypop's publication and rollback behaviour stays **unverified** in this runbook
until it has been observed.

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
