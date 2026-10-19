# Workstream status

The single status dashboard for the current multi-agent sprint. The lead
maintains this file on `team/integration`. Each workstream keeps its detailed
handoff in `docs/handoffs/<workstream>.md` on its own branch; the lead copies
the summary row here when it collects status.

Git, code and tests win over this file. If they disagree, fix this file.

| | |
| --- | --- |
| Last synchronized | 2026-10-19 (round 5: production backup taken and restore-validated locally; release branches local only, not pushed) |
| Sprint baseline | `origin/main` = `cc44449` (merge of PR #6). All four worktrees start here. |
| Integration branch | `team/integration` (worktree `<worktrees>/integration`) |
| Worktrees | `<worktrees>` is a local folder outside the repository and outside OneDrive; the exact path is in the local, untracked `docs/HANDOFF.md`. |
| Production | Unchanged by this sprint. No deploys, migrations, live Nimble calls or pushes to `main`. |
| Release runbook | [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md): seven separately approved gates. Nothing in this file authorizes a production action. |
| Baseline checks | 2026-10-17 on `cc44449`: `npm run check` passed: 691 tests (51 contracts + 551 API + 89 web; 13 real-PostgreSQL skipped), typecheck, lint, builds, bundle secret scan. Playwright not run at baseline. |

## Dashboard

Stage values: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`, `DONE`.

| Workstream | Agent | Stage | Branch | Tests | Blocker | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| Verification intelligence | `verifier` | REVIEW (round 5 merged) | `team/verification-r5` @ `41a1c5c` | Round 5: backup plan on PostgreSQL 17 rehearsed twice. Restore validation of the production archive PASS in both modes | None | Review |
| Map / build and release path | `map-perf` | REVIEW (round 5 merged) | `team/map-build-r5` @ `ee4b9d2` | Round 5: docs only. Protected destination; archive hash match; TOC 150/143 explained; frontend recovery wording | Maypop publish trigger and published-version restore unverified | Review |
| Layout and report compatibility | `layout` | REVIEW (round 5 merged) | `team/layout-r5` @ `005ecf7` | Round 5: docs only. Mobile-iframe, writes and worker data covered locally; duplicate resubmission stated exactly | Phone-only and Maypop-host checks | Review |
| Integration and release readiness | lead | REVIEW | `team/integration` (local, ahead of PRs #8/#9) | See "Round 5: production backup" | Migration host (IPv6), Maypop restore path, fresh backup in the migration window | User: approve publishing the updated release branches |

### Integration log

| Commit | Step |
| --- | --- |
| `379c118` | Merge `team/layout-fixes` |
| `b8a2333` | Lead: `layout-mapshell-2` (aside containment and width, mobile overlays); `evidence.spec` overflow measured inside `#root`; safe-area spec waits for animations (it failed in the full parallel run) |
| `a2dea65` | Merge `team/verification` |
| `cc0e74e` | Merge `team/map-performance` |
| `642836a` | Lead: `map-perf-mapshell-1-integration` (memoized shell context); SECURITY.md and ARCHITECTURE.md updates |
| `1f7507b` | Merge `team/layout-fixes` follow-up (memoized cards, 50-card pages, schedule fields) |
| `c0264c3` | Pre-deployment review: real-PostgreSQL test updated for 0006, mobile Maypop-like iframe regression, San Jose map acceptance, this review, local paths removed from tracked docs (PR #7 head) |
| `ba65800` | Round 2: merge `team/verification-r2` (zero-default paid budgets, 0006 regression tests) |
| `3a66faa` | Round 2: merge `team/map-build-r2` (release path, publication hold) |
| `e432df4` | Round 2: merge `team/layout-r2` (report submission across API versions) |
| `6987975` | Round 2: merge `team/verification-r2` follow-up (migrator lock and statement timeouts) |
| `f3a4008`, `83c4340`, `be0e16b` | Round 2 lead: [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) (seven gates, gate 2/3 rehearsal), opt-in budgets in README/SECURITY/ARCHITECTURE, roadmap release-safety items, this file |
| `cd3c6a6`, `6a2f5fe` | Round 3: merge `team/verification-r3` (failure classes, then `application_name`) |
| `655227f` | Round 3: merge `team/map-build-r3` (runbook) |
| `e748524` | Round 3: merge `team/layout-r3` (unknown outcomes, arrival check, FeedPanel test speed) |
| `d63c448` | Round 3 lead: PR B base change in the runbook, this file |
| `8702473` | Round 4 lead: [BACKUP_RESTORE_PLAN.md](BACKUP_RESTORE_PLAN.md) (rehearsed locally), corrected intermittent-test count |
| `fef2070` | Round 4: merge `team/verification-r4` (claim-limit fix, harness isolation, migration connection assessment) |
| `d24c04a` | Round 4: merge `team/map-build-r4` (v2 provenance, rollback evidence) |
| `15a2121` | Round 4: merge `team/layout-r4` (v2 × candidate backend) |
| `d5c5445` | Round 4 lead: runbook facts from the dashboards, migration connection, rollback limits, this file |
| `1534ae2` | Round 4: merge `team/verification-r4` follow-up (claim audit and production impact) |
| `a5dcb15` | Round 5: merge `team/verification-r5` (PostgreSQL 17 backup plan, rehearsals, restore validation record) |
| `80588dc` | Round 5: merge `team/map-build-r5` (backup destination, evidence handling, frontend recovery wording, TOC explanation) |
| `54455a7` | Round 5: merge `team/layout-r5` (v2 compatibility coverage, duplicate-resubmission limitation) |
| next commit | Round 5 lead: backup record, runbook restore-validation and freshness wording, verification handoff escapes and local paths, this file |

## User decisions (2026-10-17)

1. **Migration 0006:** reviewed (below); **not applied**. Applying it needs explicit approval.
2. **Scheduled vs occurring:** kept separate; verification standards not weakened. Future enhancement recorded in [ROADMAP.md](ROADMAP.md): official schedule evidence shown separately.
3. **Reporter links:** stay never fetched this sprint.
4. **V2 (Agent page reads):** deferred. **Every paid Nimble budget stays at zero.**
5. **Map and layout trade-offs:** provisionally accepted (POI density, preconnect, +150 ms cold `/map`, Report button hidden while a preview is open, sidebar `clamp(360px, 30vw, 440px)`, pull-to-refresh off when top-level on mobile). Padded query bbox: not built.

## Round 5: production backup (2026-10-18/19)

Authorized: "Approve production backup: read-only `pg_dump` of the Verity
schemas, plus local restore validation." Nothing was migrated, restored into
production, merged, deployed, published or pushed. Details are in
[BACKUP_RESTORE_PLAN.md](BACKUP_RESTORE_PLAN.md) and the round 5 and 5b
sections of `docs/handoffs/verification.md` and `docs/handoffs/map.md`.

- **Scope:** Verity application backup (schemas `public` + `drizzle`). Not a
  complete Supabase project backup.
- **Provenance:** another session of the user ran
  `backup.mjs --source production` on 2026-10-19 from 00:19:05Z to 00:19:20Z.
  - The verifier's two attempts were denied by the Claude Code permission
    classifier and never ran.
  - Codex did not run it; it only checked PostgreSQL executable versions.
  - An earlier shell error seen outside this team remains unexplained. The
    PATH hypothesis is retired: the explicit PostgreSQL 17 path works, even
    though PATH resolves to 18.6.
- **Preflight (facts record):**
  - server 17.11, verified TLS over IPv6 on the direct host;
  - history 6/6 matching the runbook, `report_schedules` absent, 15 tables;
  - no forced RLS, and every row visible to the dump role.
- **Archive:**
  - `pg_dump` 17.11, custom format, owners and ACLs kept; exit 0;
  - 74,588 bytes, SHA-256 `ce188e95…b8c6d`. Map-perf recomputed the hash
    (match) and wrote the `.sha256` sidecar;
  - 143 listed TOC entries of 150 in the header. The other 7 are 3 archive
    settings plus 4 database-level entries used only with `--create`.
- **Restore validation (03:52Z):** PostgreSQL 17.11 on 127.0.0.1, password
  auth, no `trust` rule.
  - The `DROP` guard self-test passed first.
  - Mode a (plain data) and mode b (owners and ACLs, including the 6 default
    privilege entries) both exited 0, and every check passed:
    - same-snapshot counts, 0 mismatches;
    - 6 history hashes and timestamps;
    - `report_schedules` absent;
    - constraints, indexes, 2 functions, 3 enabled triggers, RLS 15/15;
    - owners and the client-role privilege fingerprint equal production's.
  - Mode b created `anon`, `authenticated`, `service_role` and
    `supabase_admin` as NOLOGIN roles, only in the disposable cluster.
- **Not proven:**
  - recovery of anything outside `public`/`drizzle`, and database-level
    settings (restores ran without `--create`);
  - the guard's other-server case on this run (it passed in rehearsal);
  - disk encryption of the protected destination (unknown without admin).
- **Cleanup:** the lead verified the PostgreSQL 17 server was stopped, then
  deleted the restore data directory and the restore logs. The archive, the
  sidecar, the evidence files and the dump log are kept, operator-only.
  - **Retention:** keep them until 0006 is verified in production and the
    release has run cleanly for an agreed period.
- **Freshness:** the backup reflects 2026-10-19 00:19Z, and production keeps
  accepting writes. Gate 2 needs a fresh backup and restore validation taken
  immediately before the migration (runbook, gate 2 item 1).

**Successful restoration does not authorize gate 2.**

## Gate 1 inspection (2026-10-18): completed with unresolved findings

Gate 1 was an inspection round. It did **not** fully pass. Read-only results,
08:12–08:45 UTC, with follow-ups in round 4:

| Item | Result |
| --- | --- |
| GitHub: PRs #7/#8/#9 drafts at `c0264c3`/`19db3e1`/`c11bfe5`, `main` = `cc44449`, no deployments on release heads | PASS |
| Railway: both services on `cc44449`, worker budgets explicitly 0, `MIGRATE_ON_START=false`, start commands, branch `main`, no watch paths, PR environments off | PASS |
| Database: 6 history rows match the baseline hashes, no `report_schedules`, same owner on 15 tables, RLS 15/15, 0 policies, client roles have no privileges | PASS |
| Paid spend: 1 search ever (the first live test, 2026-10-17 03:53 UTC); 0 extracts, 0 Agent runs | PASS |
| Published frontend (v2): API mode, map, detail and report form work read-only; no writes | PASS (known desktop blank-space bug, fixed in PR B) |
| Migration connection | FAIL on the session pooler. Round 4: PASS on the direct host from an IPv6 workstation (below) |
| Fresh backup with restore proof | FAIL: none exists. Round 4: plan written and rehearsed locally; the production dump needs its own approval |
| Maypop publication trigger, published-version restore, where `VITE_*` values are stored | UNVERIFIED (round 4 narrowed it; below) |
| Phone width in production; console inside the Maypop page | UNVERIFIED (local tests cover them) |

## Round 4: gate 1 follow-ups (2026-10-18, local only)

Authorized: local investigation, development, tests and documentation, plus
read-only follow-ups. Nothing was migrated, dumped, merged, deployed,
published or pushed.

**Intermittent two-worker test: cause established (`verifier`).**
- **Production defect.** `claimJobs` (`apps/api/src/worker/jobs.ts`,
  unchanged since `cc44449`, so deployed today) used `UPDATE … WHERE id IN
  (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`. PostgreSQL planned it as a
  nested-loop semi-join that re-scans the locking subquery, so **one call
  claimed every ready job whatever the limit**: 30 of 30 on PostgreSQL 18.6,
  6 of 6 on PGlite. `VERIFICATION_WORKER_CONCURRENCY` was not enforced, and
  worker processes didn't share load.
- **What it never allowed:** a paid call beyond a daily budget.
  `reserveBudget` reserves atomically before each call. With every budget at
  0 in production, over-claimed jobs simply defer.
- **Fix:** a `MATERIALIZED` CTE that locks the ready rows exactly once.
  `test/worker/claim-limit.test.ts` fails before the fix and passes after.
- **Harness defects** that passed only because of the over-claim: the
  two-worker test shared a database with earlier tests' leftover ready jobs
  (it now has its own database and asserts each claim is ≤ 2, only its own
  jobs, nothing left running); the lifecycle test and the `claimFor` helper
  were also corrected.
- **Ruled out with evidence:** cross-file database sharing, CPU contention
  (24 busy loops), database contention (pgbench -c 24), database errors.
- **Counts:**
  - parallel real-PostgreSQL suite before the fix: 8 of 20 failing (verifier,
    round 4);
  - earlier observation: 4 of 16 (verifier, rounds 3–4);
  - after the fix: 0 of 20 parallel, 0 of 20 under CPU load, 0 of 20 under
    database load, 0 of 20 isolated;
  - lead runs after integration: see the results table.

**Migration connection (`verifier`, harmless probe 13:07 UTC):**
- The session pooler drops startup parameters, so the migrator refuses
  there. A session `SET` holds on one pinned backend, but relying on it would
  need a code change.
- **The direct host** (IPv6-only DNS) was reachable from this workstation,
  with TLS verified and authentication working, and it honored all three
  startup parameters.
- **Recommendation:** migrate over the direct host from an IPv6-capable
  machine, with no code change (runbook gate 2, item 6).
- **Limits:** it was not checked from any other machine, and the pooler's
  backend pinning under a real migration transaction is unproven.

**Published frontend v2 (`map-perf`, lead browser observation):**
- **Source:** v2's source is Maypop's editor workspace, iteration 3 ("The
  approved synchronization", Oct 12). Of `cc44449`'s 73 `apps/web/src` files,
  71 are byte-identical; `src/config/env.ts` (plus its test) adds an "API mode
  requires a Verity service URL" guard.
- **Artifact:** 5 of 8 downloaded v2 files are byte-identical to a local
  `cc44449` build. `index.html` has Maypop's injected scripts, and the CSS has
  5 extra utilities.
- **Not established:** the published-version list or restore, what triggers
  sync or publish, and where the `VITE_*` values are stored.
- **The editor draft is preserved:** no Discard, Revert, Done, sync or
  Unlink.

**v2 × candidate backend (`layout`, local):** the unmodified v2 files were
served locally against PR A's API, with production-API requests intercepted.
Nothing reached production.
- **Works:** map, list, detail, a report without a schedule, field errors,
  and 500/502/network failures (input kept, no automatic resubmit).
- **New risk while v2 stays live after PR A:** after a lost response, v2 only
  says "temporarily unavailable", so a manual resubmit stores a second report
  from the same user. It attaches to the same event and doesn't raise the
  independent-source count. PR B fixes the messaging.
- **Not checked:** signals/follow writes, the worker's data, and v2 inside
  the Maypop page.

### Round 4 test results (lead runs on `team/integration`)

| Check | Result |
| --- | --- |
| `npm run check` | Pass. 934 tests: 58 contracts, 734 API (19 real-PostgreSQL skipped, run below), 142 web; typecheck, lint, builds, bundle secret scan |
| `npm run test:concurrency -w @verity/api`, files in parallel (throwaway local PostgreSQL 18, deleted afterwards) | 12 of 12 runs passed (19/19 tests each) |
| `test/worker/claim-limit.test.ts` with `cc44449`'s `jobs.ts` swapped in, then restored | Fails as expected ("expected length 2 but got 6"); passes with the fix. Confirms the deployed code over-claims |
| Backup plan rehearsal (local, no production data) | Dump, inventory, restore (after the `public` schema fix) and all checks passed; 0006 applied to the restored copy |
| Not run | Playwright and the service e2e suite (no `apps/web` change in round 4; last run in round 3: 57 passed / 21 skipped, service 2). Anything in production |

## Round 3: honest failure handling (2026-10-18)

Authorized: local corrections and tests, pushing `release/backend` and
`release/frontend`, opening their draft PRs and updating PR #7's description.
Not authorized: merging, any remote migration, deploying, production settings,
paid calls.

**What changed:**
- **Migrator failure classes** (`verifier`): the migrator no longer claims a rollback it can't prove. Exit 2 = refused (configuration, target guard, or the timeout safety check failed); 3 = not attempted (couldn't connect or authenticate); 4 = the server rejected a statement inside the migration transaction, which PostgreSQL rolled back; 5 = **outcome unknown** (the connection failed after migrations started): don't retry; confirm the session has ended, inspect history and schema, decide with the approver. It never retries by itself, and output never contains credentials, hosts or driver messages. Its session is named `verity-migrate`.
- **Runbook** (`map-perf`): per-gate approval phrases; the outcome table and the unknown-outcome procedure; the timeout mismatch is a failed safety check, not proof of a pooler mode; backups need **restore** validation (inventory-only only if the approver explicitly accepts the risk); PR B must be reconciled with `main` after PR A merges and re-checked to be `apps/web/**` only.
- **Report form** (`layout`): network errors, timeouts, any 5xx and unreadable responses now say "We couldn't confirm whether your report was received. Everything you entered is still here." A **Check whether it arrived** button searches the public event list near the reported point (inside the form, so the draft is kept). Definite rejections (the service's own 4xx) keep their specific messages. No automatic retry, one request per submit, the schedule is never dropped.

### Round 3 test results (`team/integration` @ `e748524` plus the lead docs commit; new runs only)

| Check | Result |
| --- | --- |
| `npm run check` | Pass. 933 tests: 58 contracts, 733 API (19 real-PostgreSQL skipped, run below), 142 web. Typecheck, lint, builds, bundle secret scan |
| `npm run test:concurrency -w @verity/api` (throwaway local PostgreSQL 18, deleted afterwards) | 19/19, five runs in a row. **Corrected 2026-10-18:** the two-worker end-to-end test failed in **4 of 16 parallel-suite runs** (verifier; including runs on the commit before round 3's change), and passed alone 6/6. The 5 lead passes don't resolve it. An earlier partial count, "3 of 11", appears in PR #8's description and in this file's published copy; it is superseded. Open; root cause under investigation (round 4) |
| Built `dist/migrate.js` | Exit 0 with the timeouts and `application_name=verity-migrate` lines; exit 3 for a missing database (`SQLSTATE 3D000`); exit 2 for `MIGRATE_LOCK_TIMEOUT_MS=0`. A placeholder password and the database name never appeared |
| `PW_CHANNEL=chrome npx playwright test` | 57 passed, 21 skipped |
| `PW_CHANNEL=chrome npm run test:e2e:service` | 2 passed |
| Not run | San Jose acceptance (no map change); a real network drop against a real service; the amber outcome box on a phone; anything in production |

## Round 2: release hardening (2026-10-17/18, local only)

Authorized: local development and testing only. Nothing was pushed, merged,
migrated or deployed; PR #7 is still a draft at `c0264c3`.

**What changed:**
- **Paid Nimble work is opt-in** (`verifier`): the daily search, extract and Agent budgets and the per-event Agent cap default to `0`. Missing, blank or whitespace values mean `0`; explicit positive values are kept. V2 stays deferred.
- **Migration 0006 regression tests** (`verifier`): populated 0005 → 0006 upgrade with every row unchanged, repeat run, constraints, RLS, client-role privileges, schedule-bearing report rollback before 0006, worker readiness before and after.
- **Bounded migrator** (`verifier`): `dist/migrate.js` runs on one connection with `lock_timeout` and `statement_timeout`, reads them back, and refuses if they didn't apply.
- **Release path** (`map-perf`): nothing in the repository can hold a Maypop publication. The verified hold is a two-PR split (backend first, frontend after the new API passes).
- **Report form** (`layout`): a schedule rejected by the running API used to fail with **no message**. Now every failure keeps all input (schedule included), explains itself, never resends automatically, and can't double-submit.
- **Runbook** (lead): [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md), seven separately approved gates; gates 2 and 3 rehearsed locally.

### Round 2 test results (`team/integration` with the lead commit)

| Check | Result |
| --- | --- |
| `npm run check` | Pass. 891 tests: 58 contracts, 701 API (17 real-PostgreSQL skipped, run below), 132 web. Typecheck, lint, builds, bundle secret scan (12 files). |
| `npm run test:concurrency -w @verity/api` (throwaway local PostgreSQL 18, deleted afterwards) | 17/17 pass, including the 4 new migrator-gate tests |
| Gates 2 and 3 rehearsal (built `dist/migrate.js`, Supabase-like roles) | Pass; details in the runbook |
| `PW_CHANNEL=chrome npx playwright test` | 57 passed, 21 skipped (viewport-specific) |
| `PW_CHANNEL=chrome npm run test:e2e:service` | 2 passed |
| PR A tree (`release/backend`, `apps/web` as at `cc44449`) | `npm run check` pass: 58 contracts, 701 API (17 skipped), 89 web (the `cc44449` web suite). Playwright 27 passed, 1 skipped. Service e2e 2 passed: the live frontend's code signs in, reports, signals and follows against the new API through a cross-site iframe |
| Not run | San Jose acceptance (no map or build change); real devices; the old API build; anything in production; any live Nimble call |

### Proposed PR changes (not pushed)

Superseded by round 3: `release/backend` (PR A, `apps/web` exactly as at
`cc44449`) and `release/frontend` (PR B, tree = `team/integration`) are
published as draft PRs. PR A targets `main`; PR B targets `release/backend`, so
its review shows only the frontend. After PR A merges, PR B is retargeted to
`main`, reconciled and re-checked (runbook, gate 6). PR #7 stays open as a
draft for the combined review and must not be merged.

## Pre-deployment review (2026-10-17)

### Final test results (the exact code in the draft PR)

| Check | Result |
| --- | --- |
| `npm run check` | Pass. 842 tests: 54 contracts, 665 API (13 real-PostgreSQL skipped here, run below), 123 web. Typecheck, lint, builds, bundle secret scan (12 files). |
| `npm run test:concurrency -w @verity/api` (`TEST_DATABASE_URL` → throwaway local PostgreSQL 18.6 on 127.0.0.1) | 13/13 pass, migrations 0000–0006 on real PostgreSQL. The suite's migration-count assertion was stale (expected 6) and is updated, plus an RLS check on `report_schedules`. |
| `PW_CHANNEL=chrome npx playwright test` (`apps/web`) | 57 passed, 21 skipped (viewport-specific tests skip on the other project). `layout.spec.ts` also passed 3 runs in a row (`--repeat-each=3`). |
| `PW_CHANNEL=chrome npm run test:e2e:service` | 2 passed: sign-in, report, signals and follow through a cross-site iframe against a real API (PGlite). |
| San Jose acceptance (`e2e/perf/acceptance-sanjose.perf.ts`, perf config, live OpenFreeMap tiles) | 2 passed (light, dark). Around Plaza de César Chávez: 15–16 landmarks and 215 green areas at z14; 53–56 POIs (food, shops, culture) at z16; buildings at both zooms. The event marker renders, and every detail layer sits below the event markers. |
| `npm audit --omit=dev` | 4 moderate: the esbuild dev-server advisories via `drizzle-kit`, unchanged from `main`. No dependency changes in the sprint. |
| Not run | Real iOS/Android devices; any live Nimble call; any production access |

New acceptance coverage added in this review:
- **Mobile Maypop-like iframe** (`layout.spec.ts`, 375×667 and 390×844, cross-site iframe on a scrollable host with a device-width viewport): full sheet, list scrolled and wheeled past its end, event detail opened and scrolled. The app document and the host page never scroll, and the map reaches the bottom of the frame.
- **Mobile document scroll:** the mobile map and `/report`, `/settings`, `/following` at 320 px (existing), plus the iframe cases above.
- The stand-in host page now has a device-width viewport like a real mobile page. Without it, mobile Chrome laid the host out 980 px wide and the iframe was 1,687 px tall, which hid the scroll path. Playwright's own `click()` scrolls the host to reach an animating control, so the iframe test resizes the sheet with DOM clicks; the keyboard and drag paths have their own tests.

### Migration 0006 audit

**What it does** (`apps/api/drizzle/0006_report_schedules.sql`):
- `CREATE TABLE report_schedules`:
  - `report_id uuid` primary key;
  - `scheduled_start_at timestamptz NOT NULL`, `scheduled_end_at timestamptz` NULL;
  - `created_at timestamptz DEFAULT now()`;
  - CHECK `report_schedules_order`: end is null or at least start.
- FK `report_id → reports(id) ON DELETE CASCADE`.
- `ENABLE ROW LEVEL SECURITY`, no policies.
- A `DO` block revokes all privileges from `anon` and `authenticated` when those roles exist.

**Data-loss risk:** none. The migration only adds a table; no existing table, column, row, trigger or index is touched. Rehearsal on real PostgreSQL 18.6 (2026-10-17):
- **Setup:** a database built from `cc44449`'s own migrations (0000–0005), with Supabase-like roles (non-superuser owner, `anon`, `authenticated`), demo data and a production-shaped report and pending job.
- **Data unchanged:** fingerprints (row count and md5 of every row) of all 15 existing tables are identical before and after 0006.
- **Security:** `report_schedules` has RLS on, 0 policies and 0 client-role grants.
- **Idempotent:** re-running the migrator is a no-op.
- **Readiness:** the new worker's readiness query is false before 0006 and true after.
- **Reversible:** the emergency reversal below returned the database to the 0005 fingerprint, and re-upgrading worked.

**Locking:** adding the FK takes a brief `SHARE ROW EXCLUSIVE` lock on `reports` (blocks report writes for milliseconds on a small table). Drizzle runs pending migrations in one transaction without an advisory lock: **run exactly one migrator**.

**Compatibility matrix:**

| Code ↓ / schema → | 0005 (production today) | 0006 |
| --- | --- | --- |
| Running API (`cc44449`) | ✓ (current) | ✓ Never references the new table |
| Running worker (`cc44449`) | ✓ (current) | ✓ Its readiness check covers 0003–0005 only |
| New API | Reports **without** a schedule ✓. A report **with** a schedule fails; the transaction rolls back with no partial writes (rehearsed) | ✓ |
| New worker | ✗ Refuses to start (readiness check names 0003–0006) | ✓ |
| New frontend → running API | Reports without a schedule ✓. A report **with** a schedule is rejected (400, strict schema) | Same until the new API is live |

**Verdict: compatible, if applied before the new API and worker deploy.** 0006 is additive and safe to apply while the current API and worker run. The new worker must not start before it. The new frontend must not be live before the new API, or schedule-bearing reports fail.

**Startup dependencies and triggers to check (user, in Railway; names only, no values needed):**
- **`MIGRATE_ON_START`:** if it is `true` on the API service, deploying the new API applies 0006 by itself, bypassing a separately approved migration step. Confirm it is unset or `false`.
- **Deploy branch:** Railway's GitHub deployments go only to `Verity / production`, and only for merge commits on `main` (`ea7058e`, `053eade`, `cc44449`). PR branch heads were never deployed. **Merging the PR deploys the API (and the worker, if it is a separate service on `main`) and lets Maypop rebuild the frontend, all at once.** Maypop's import settings can't be seen from the repository.

**Rollback / recovery for 0006:**
- **Preferred:** leave the table in place. Older code ignores it, so rolling back the API, worker or frontend never requires touching the schema.
- **Emergency reversal** (only after the new code is gone; loses reporter schedule claims):
  ```sql
  BEGIN;
  DROP TABLE report_schedules;
  DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792236058949; -- 0006's journal "when"
  COMMIT;
  ```
- Take a fresh `pg_dump` immediately before applying, as before 0003–0005.

### Security, CSP, RLS, billing and authentication review

- **Authentication and authorization:** no file under `apps/api/src/{auth,routes,security}`, `config.ts`, `app.ts`, `server.ts` or `apps/web/src/api/session-store.ts` changed.
- **CSP:** no directive changed. The only new tag is a `preconnect` hint to the existing basemap origin. Lazy route chunks are same-origin (`script-src 'self'`).
- **RLS:** `report_schedules` has RLS with no policies and client roles revoked (rehearsed on real PostgreSQL; covered by `database-access.test.ts` and the concurrency suite).
- **Billing:**
  - Ceilings are unchanged: ≤ 3 searches, ≤ 4 extracts and ≤ 1 Agent run per job, plus daily budgets.
  - A budget of `0` means **no paid call**: `reserveBudget` refuses any reservation above the cap. Tests prove zero calls at search budget 0, extract ceiling 0 and Agent budget 0.
  - **Round 2:** the four paid budgets now **default to `0`** (were 200 searches/day, 400 extracts/day, 20 Agent runs/day, 2 per event). Missing, blank or whitespace values mean `0`; explicit positive values still work. The running production worker (`cc44449`) still has the old defaults until PR A deploys, so its variables must be explicitly `0` (runbook gate 1).
- **Privacy:** Nimble queries carry the event name, venue, city and month/year. Contact-like text is stripped, and no reporter identity or coordinates are sent. Reporter links are never fetched or sent. Claimed schedules reach the Agent prompt only marked "unconfirmed".
- **Decision rules:** only stricter. Nothing new can produce VERIFIED.
- **Secrets:** no secret, production identifier or local path in any added line or tracked doc. Only `.env.example` templates are tracked.

### Deployment order and rollback

Superseded by [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) (round 2): seven
separately approved gates, the backend/frontend PR split that holds the
frontend, read-only SQL for the migration baseline and post-migration checks,
and a rollback that keeps 0006.

### Performance (measured by the teammates; method in `docs/handoffs/map.md` and `layout.md`)

| Scenario | Before | After |
| --- | --- | --- |
| Far move ("Near me"), simulated 4G, LA / Oakland / Mission | 2.48 / 2.73 / 3.61 s | 1.91 / 2.19 / 2.13 s |
| Tile requests for a far move | ~240 (97% cancelled) | 6 |
| Welcome page cold load, 4G | 2.0 s | 0.97 s (map cold load +150 ms) |
| Pan to new events, 500 in view, 4x CPU: longest task | 1,036–1,324 ms | 96–102 ms |
| Hover across 8 cards: card renders | 5,500 | 16 |
| Desktop document height at 1360x860 (blank-space bug) | 2,123 px (scrolls 1,263 px) | 860 px (can't scroll) |

### Remaining issues

- **Deployment:**
  - Merging `main` deploys the API and the worker, and may make Maypop rebuild the frontend. 0006 must be applied first, and the frontend must ship in a later PR (runbook: PR A / PR B). Merging PR #7 as one PR is a **release blocker** until the operator confirms and holds Maypop publication.
  - `MIGRATE_ON_START`, the budget variables, the worker start command, Railway watch paths, Maypop's trigger and its `VITE_*` build variables can only be checked by the operator (runbook gate 1).
  - A Maypop rebuild without its `VITE_*` build variables shows "not connected". Any merge to `main` can trigger one.
  - Railway's API deploy failed on 2 of the 3 earlier merges. Keep the `cc44449` redeploy ready.
  - A meta CSP doesn't govern the map's dedicated worker. If Maypop sends a CSP header on `.js` files, tile requests could be blocked. Check on first publish.
  - The worker readiness check is presence-only. Gate 3's SQL checks shape, constraints, RLS and privileges.
  - The `anon`/`authenticated` privilege matrix for `report_schedules` is proven on PGlite with Supabase-like roles. Real PostgreSQL checks the migrations and RLS only.
- **Report form:**
  - Recognizing "schedules not supported" depends on the old API's error body (`fields: { "_": "Unexpected field" }`). Anything else gets a generic message, with every field kept.
  - When a schedule was sent, the server-error message also suggests clearing it "if it keeps failing".
- **Verification:**
  - Regression fixtures for the live test are reconstructed; the real 10 sources were never read from production.
  - Records stored before this sprint have no identity verdict until re-observed.
  - Announcements can't count for real planned events until official schedule evidence exists (roadmap).
  - Place-conflict detection needs an explicit "City, Qualifier".
  - A descriptive title may be treated as a name (errs toward UNVERIFIED).
  - The sweep cursor resets on worker restart.
  - With every budget at 0 (now the default), verification jobs stay deferred and no external evidence is gathered (by decision). This is easy to mistake for an outage.
- **Map:**
  - The detail layer works only on OpenMapTiles-schema styles.
  - OpenFreeMap has no SLA (0.5–1 s per uncached area).
  - POI density is now checked in San Francisco and San Jose only.
  - Low-end phones were tested only with 4x CPU throttling.
- **Layout:**
  - Safe-area handling was checked only with Chrome emulation.
  - The feed shows 50 cards at first; later events are map-only until expanded.
  - MapLibre's compact attribution starts expanded at 320 px.
- **Pre-existing:**
  - Agent orphan window.
  - No CI.
  - The esbuild dev-server advisories.
  - Local `main` behind `origin/main`.
  - Earlier commit messages on the teammate branches mention the local worktree folder (the Windows user name only).

## Sprint goals

1. Verification relevance after the first live Nimble test (named planned events matched to unrelated festivals).
2. A faster map that shows more landmarks.
3. No blank space or document scrolling under the desktop map.
4. A persistent handoff system (this file plus `docs/handoffs/*.md`).
5. Stay compatible with future GPS navigation and 3D maps ([ROADMAP.md](ROADMAP.md)).

## File ownership

One owner per file during the sprint. Anyone may read anything. To change a
file you don't own, send the lead a focused change request.

| Area | Owner |
| --- | --- |
| `apps/api/**`, `packages/contracts/**` | `verifier` |
| `apps/web/src/features/report/ReportPage.tsx` (form fields, scheduled dates) | `verifier` |
| `apps/web/src/api/**` (adapters, mock fixtures) | `verifier` |
| `apps/web/src/features/map/` except `MapShell.tsx` and `BottomSheet.tsx` | `map-perf` |
| `apps/web/src/features/report/LocationPicker.tsx` | `map-perf` |
| `apps/web/src/app/router.tsx`, `apps/web/src/config/**`, `apps/web/build/**`, `apps/web/vite.config.ts`, CSP | `map-perf` |
| `apps/web/src/features/map/BottomSheet.tsx`, `apps/web/src/app/{TopBar,PageLayout,App}.tsx` | `layout` |
| `apps/web/src/features/{events,onboarding,settings,following}/**`, `apps/web/src/components/ui/**`, `apps/web/src/styles/**`, `apps/web/index.html` | `layout` |
| `apps/web/src/features/map/MapShell.tsx` | **lead only** |
| `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/WORKSTREAM_STATUS.md`, `docs/ROADMAP.md` | lead |
| `docs/handoffs/verification.md` / `map.md` / `layout.md` | `verifier` / `map-perf` / `layout` |
| Existing e2e specs | lead. Teammates add **new** spec files only. |

## Shared rules (all workstreams)

- Work only inside your own worktree. Commit on your own branch. Never push, open PRs, merge or deploy.
- Never read, copy or print `.env` values. The worktrees have no `.env` files; tests use PGlite and mocks.
- No live Nimble calls (`NIMBLE_LIVE_SMOKE` stays unset), no production database access, no migrations against any remote database.
- Never show confidence percentages or probabilities in the UI.
- Never weaken verification decision rules, auth, CORS, the origin guard or the CSP.
- Before committing: `npm run check` at the worktree root must pass. Report real results only.
- Playwright: `PW_CHANNEL=chrome`. Ports are fixed (4179, 4180, 4190, 8788), so e2e runs are serialized with the lock directory `<worktrees>/.e2e.lock` (create with `mkdir`, which fails if it exists; delete it when done).
- Don't put production identifiers (event UUIDs, hostnames) in tracked files. The repository is public.

## Production schema (corrected)

The local handoff said production was at migration 0002. The user reports that
0000–0005 were applied. Repository evidence supports this: the worker refuses
to start without 0003–0005 (`apps/api/src/worker/main.ts`), the worker
processed the first live verification job, and Railway's GitHub deployments
show `main` at `cc44449` running in `Verity / production`. **Not verified by a
database query**; nobody queried production. 0006 is not applied.

## Deferred decisions

- **V2, shared Extract/Agent ceiling:** deferred (user decision 2026-10-17). The problem and the recommendation are in `docs/handoffs/verification.md`; current behavior is pinned by `test/worker/agent-escalation.test.ts`. Paid budgets stay at zero.

## Integration order

1. `team/verification` (backend and report form; independent of the map work)
2. `team/map-performance`
3. `team/layout-fixes`, rebased onto the result
4. Lead-applied `MapShell.tsx` changes requested by `map-perf` and `layout`, with tests
