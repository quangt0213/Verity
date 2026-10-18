# Workstream status

The single status dashboard for the current multi-agent sprint. The lead
maintains this file on `team/integration`. Each workstream keeps its detailed
handoff in `docs/handoffs/<workstream>.md` on its own branch; the lead copies
the summary row here when it collects status.

Git, code and tests win over this file. If they disagree, fix this file.

| | |
| --- | --- |
| Last synchronized | 2026-10-17 (pre-deployment review) |
| Sprint baseline | `origin/main` = `cc44449` (merge of PR #6). All four worktrees start here. |
| Integration branch | `team/integration` (worktree `<worktrees>/integration`) |
| Worktrees | `<worktrees>` is a local folder outside the repository and outside OneDrive; the exact path is in the local, untracked `docs/HANDOFF.md`. |
| Production | Unchanged by this sprint. No deploys, migrations, live Nimble calls or pushes to `main`. |
| Baseline checks | 2026-10-17 on `cc44449`: `npm run check` passed: 691 tests (51 contracts + 551 API + 89 web; 13 real-PostgreSQL skipped), typecheck, lint, builds, bundle secret scan. Playwright not run at baseline. |

## Dashboard

Stage values: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`, `DONE`.

| Workstream | Agent | Stage | Branch | Tests | Blocker | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| Verification intelligence | `verifier` | DONE (merged) | `team/verification` @ `c29fe40` | check: contracts 54, API 665 + 13 skipped, web 90; e2e 29 + 1 skipped | None | None this sprint |
| Map performance, landmarks, 3D-ready | `map-perf` | DONE (merged) | `team/map-performance` @ `105093a` | check: web 108; e2e 27 + 1 skipped; service 2 | None | None this sprint |
| Layout and UX | `layout` | DONE (merged) | `team/layout-fixes` @ `0234abf` | check: web 123; e2e 55 + 19 skipped; service 2 | None | None this sprint |
| Integration and pre-deployment review | lead | REVIEW | `team/integration` (draft PR to `main`) | 2026-10-17, final code: check 842; real PostgreSQL 13/13; e2e 57 + 21 skipped; service 2; San Jose acceptance 2 | User approval | User: review the draft PR; approve each deployment step separately |

### Integration log

| Commit | Step |
| --- | --- |
| `379c118` | Merge `team/layout-fixes` |
| `b8a2333` | Lead: `layout-mapshell-2` (aside containment and width, mobile overlays); `evidence.spec` overflow measured inside `#root`; safe-area spec waits for animations (it failed in the full parallel run) |
| `a2dea65` | Merge `team/verification` |
| `cc0e74e` | Merge `team/map-performance` |
| `642836a` | Lead: `map-perf-mapshell-1-integration` (memoized shell context); SECURITY.md and ARCHITECTURE.md updates |
| `1f7507b` | Merge `team/layout-fixes` follow-up (memoized cards, 50-card pages, schedule fields) |
| next commit | Pre-deployment review: real-PostgreSQL test updated for 0006, mobile Maypop-like iframe regression, San Jose map acceptance, this review, local paths removed from tracked docs |

## User decisions (2026-10-17)

1. **Migration 0006:** reviewed (below); **not applied**. Applying it needs explicit approval.
2. **Scheduled vs occurring:** kept separate; verification standards not weakened. Future enhancement recorded in [ROADMAP.md](ROADMAP.md): official schedule evidence shown separately.
3. **Reporter links:** stay never fetched this sprint.
4. **V2 (Agent page reads):** deferred. **Every paid Nimble budget stays at zero.**
5. **Map and layout trade-offs:** provisionally accepted (POI density, preconnect, +150 ms cold `/map`, Report button hidden while a preview is open, sidebar `clamp(360px, 30vw, 440px)`, pull-to-refresh off when top-level on mobile). Padded query bbox: not built.

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
  - Ceilings are unchanged: ≤ 3 searches, ≤ 4 extracts and ≤ 1 Agent run per job, plus daily budgets. No budget default changed.
  - A budget of `0` means **no paid call**: `reserveBudget` refuses any reservation above the cap. Tests prove zero calls at search budget 0, extract ceiling 0 and Agent budget 0.
  - The **defaults are not zero** (searches 200/day, extracts 400/day, Agent 20/day, 2 per event). Production stays at zero only if the Railway variables are set explicitly.
- **Privacy:** Nimble queries carry the event name, venue, city and month/year. Contact-like text is stripped, and no reporter identity or coordinates are sent. Reporter links are never fetched or sent. Claimed schedules reach the Agent prompt only marked "unconfirmed".
- **Decision rules:** only stricter. Nothing new can produce VERIFIED.
- **Secrets:** no secret, production identifier or local path in any added line or tracked doc. Only `.env.example` templates are tracked.

### Exact deployment order (each step needs explicit approval)

0. **Before anything (user, Railway, read-only):**
   1. On the worker service, confirm that `NIMBLE_DAILY_SEARCH_BUDGET`, `NIMBLE_DAILY_EXTRACT_BUDGET`, `NIMBLE_DAILY_AGENT_BUDGET` and `NIMBLE_AGENT_MAX_PER_EVENT` are all explicitly `0`. Optionally also set `NIMBLE_MAX_EXTRACTS_PER_JOB` to `0`.
   2. On the API service, confirm that `MIGRATE_ON_START` is not `true`.
   3. Note how the worker is deployed (separate service, start command, branch).
1. **Review the draft PR.** Don't merge yet.
2. **Production database** (approval: "apply 0006"):
   1. Take a fresh `pg_dump`.
   2. Read-only: confirm `drizzle.__drizzle_migrations` has 6 rows, the newest from 0005.
   3. Apply with one migrator (`node dist/migrate.js` from the PR's build, with `DATABASE_URL`, `VERITY_DB_CA_PATH`, `VERITY_DATABASE_ACK`).
   4. Verify: 7 rows; `report_schedules` exists with RLS on, 0 policies and no `anon`/`authenticated` grants.
   5. The running API and worker keep working.
3. **Merge the PR to `main`** (approval: "merge"). This deploys the API and the worker on Railway and lets Maypop rebuild the frontend.
4. **Verify the API:**
   1. `GET /api/v1/health`.
   2. Create a test report with no schedule, then one with a schedule.
   3. Confirm one `report_schedules` row (count only).
5. **Verify the worker:**
   1. The logs show the readiness check passed.
   2. Jobs are deferred with `search_budget_exhausted` (budget 0, no paid calls).
   3. The aging sweep runs.
6. **Verify Maypop:**
   1. `/welcome`, `/map`, `/report` and an event detail inside Maypop.
   2. The lazy map chunk loads under Maypop's CSP.
   3. Scrolling the sidebar or sheet never scrolls the page or the host.
   4. Places show in San Jose.
7. Any live verification run is a separate approval (a paid Nimble call).

### Rollback procedure

| Layer | How | Schema impact |
| --- | --- | --- |
| Frontend | Maypop: republish the previous build, or revert the merge on `main` | None |
| API and worker | Railway: redeploy the previous deployment (`cc44449`) | None. The old code ignores `report_schedules` |
| Database | Keep 0006. Emergency reversal only after the new code is gone (SQL above), or restore the pre-migration dump | Loses reporter schedule claims |
| Open browser tabs | A tab built before a deploy may 404 on a lazy chunk; `RouteError` offers "Reload the map" | None |

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
  - Merging `main` deploys API, worker and frontend together, so 0006 must be applied first.
  - `MIGRATE_ON_START` and the budget variables can only be checked by the user.
  - Maypop's import behavior is unverified.
- **Verification:**
  - Regression fixtures for the live test are reconstructed; the real 10 sources were never read from production.
  - Records stored before this sprint have no identity verdict until re-observed.
  - Announcements can't count for real planned events until official schedule evidence exists (roadmap).
  - Place-conflict detection needs an explicit "City, Qualifier".
  - A descriptive title may be treated as a name (errs toward UNVERIFIED).
  - The sweep cursor resets on worker restart.
  - With every budget at 0, verification jobs stay deferred and no external evidence is gathered (by decision).
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
