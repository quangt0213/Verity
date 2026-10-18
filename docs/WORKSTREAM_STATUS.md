# Workstream status

The single status dashboard for the current multi-agent sprint. The lead
maintains this file on `team/integration`. Each workstream keeps its detailed
handoff in `docs/handoffs/<workstream>.md` on its own branch; the lead copies
the summary row here when it collects status.

Git, code and tests win over this file. If they disagree, fix this file.

| | |
| --- | --- |
| Last synchronized | 2026-10-17 |
| Sprint baseline | `origin/main` = `cc44449` (merge of PR #6). All four worktrees start here. |
| Integration branch | `team/integration` (worktree `C:\Users\quang\verity-worktrees\integration`) |
| Production | Unchanged by this sprint. No deploys, migrations, live Nimble calls or pushes to `main`. |
| Baseline checks | 2026-10-17 on `cc44449`: `npm run check` passed: 691 tests (51 contracts + 551 API + 89 web; 13 real-PostgreSQL skipped), typecheck, lint, builds, bundle secret scan. Playwright not run at baseline. |

## Dashboard

Stage values: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`, `DONE`.

| Workstream | Agent | Stage | Branch | Tests | Blocker | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| Verification intelligence | `verifier` | DONE (merged) | `team/verification` @ `c29fe40` | check: contracts 54, API 665 + 13 skipped, web 90; e2e 29 + 1 skipped | User decisions (see below) | User: approve 0006 for production, the announcement rule, A5 and V2 options |
| Map performance, landmarks, 3D-ready | `map-perf` | DONE (merged) | `team/map-performance` @ `105093a` | check: web 108; e2e 27 + 1 skipped; service 2 | None | User: POI density, cold-map +150 ms trade-off, padded bbox |
| Layout and UX | `layout` | DONE (merged) | `team/layout-fixes` @ `0234abf` | check: web 123; e2e 55 + 19 skipped; service 2 | None | User: pull-to-refresh, Report button vs preview, sidebar width |
| Integration | lead | REVIEW | `team/integration` (release candidate, see the header) | 2026-10-17 at `1f7507b`: check 842 (54 + 665 + 123; 13 skipped), bundle scan; e2e 55 + 19 skipped; service 2 | User decisions | User: review the candidate, then decide on a PR to `main` |

### Integration log

| Commit | Step |
| --- | --- |
| `379c118` | Merge `team/layout-fixes` |
| `b8a2333` | Lead: `layout-mapshell-2` (aside containment and width, mobile overlays); `evidence.spec` overflow measured inside `#root`; safe-area spec waits for animations (it failed in the full parallel run) |
| `a2dea65` | Merge `team/verification` |
| `cc0e74e` | Merge `team/map-performance` |
| `642836a` | Lead: `map-perf-mapshell-1-integration` (memoized shell context); SECURITY.md and ARCHITECTURE.md updates |
| `1f7507b` | Merge `team/layout-fixes` follow-up (memoized cards, 50-card pages, schedule fields) |

## Decisions waiting for the user

1. **Migration 0006** (`report_schedules`): must be applied in production before the new worker starts (readiness check). Reports without a schedule keep working before it.
2. **Scheduled ≠ occurring:** an announcement counts only while the event's *established* schedule says it is underway. Nothing in production sets `events.scheduled_*` (only the demo seed does), so for real planned events announcements never count today; verification needs coverage of the event actually happening. Errs toward UNVERIFIED.
3. **A5** (reporter links): keep "never fetched" (recommended) or a default-off hint-only option. **V2**: post-Agent Extract allowance (recommended), reserve slots, or hold the Agent.
4. **Map:** POI density (tuned only in San Francisco); keep the preconnect hint; accept +150 ms cold `/map` for −1.0 s on welcome; padded query bbox (product call; can hide events when the 500 cap truncates).
5. **Layout:** pull-to-refresh disabled when top-level on mobile; Report button hides while a preview is open; sidebar `clamp(360px, 30vw, 440px)`.

## Delivery readiness (2026-10-17)

### Final verification of the candidate (`1f7507b`)

| Check | Result |
| --- | --- |
| `npm run check` | Pass. 842 tests: 54 contracts, 665 API (13 real-PostgreSQL skipped), 123 web. Typecheck, lint, builds, bundle secret scan (12 files). |
| `PW_CHANNEL=chrome npx playwright test` (`apps/web`) | 55 passed, 19 skipped (viewport-specific tests skip on the other project) |
| `PW_CHANNEL=chrome npm run test:e2e:service` | 2 passed (cross-site iframe, real API on PGlite) |
| `npm audit --omit=dev` | 4 moderate: the esbuild dev-server advisories via `drizzle-kit`, unchanged from `main`. The sprint changed no dependencies. |
| Not run | `test:concurrency` (needs a local PostgreSQL); real-device iOS/Android; any live Nimble call; any production access |

### Performance (measured by the teammates; method in `docs/handoffs/map.md` and `layout.md`)

| Scenario | Before | After |
| --- | --- | --- |
| Far move ("Near me"), simulated 4G, LA / Oakland / Mission | 2.48 / 2.73 / 3.61 s | 1.91 / 2.19 / 2.13 s |
| Tile requests for a far move | ~240 (97% cancelled) | 6 |
| Welcome page cold load, 4G | 2.0 s | 0.97 s (map cold load +150 ms) |
| Pan to new events, 500 in view, 4x CPU: longest task | 1,036–1,324 ms | 96–102 ms |
| Hover across 8 cards: card renders | 5,500 | 16 |
| Desktop document height at 1360x860 (blank-space bug) | 2,123 px (scrolls 1,263 px) | 860 px (can't scroll) |

### Security review

- No secrets or production identifiers in any added line (diff `cc44449..1f7507b` scanned); only `.env.example` templates are tracked.
- CSP: no directive changes. The only new tag is a `preconnect` hint to the existing basemap origin.
- New table `report_schedules` (0006): RLS on with no policies, `anon`/`authenticated` revoked; `database-access.test.ts` covers it.
- Reporter schedules are claims only: never copied to `events.scheduled_*`, can't change status.
- Reporter links stay unfetched and are never sent to a provider (A5 not implemented).
- Nimble queries carry the event name, venue, city and month/year. Contact-like text is stripped; no reporter identity or coordinates. The Agent prompt marks claimed schedules "unconfirmed".
- Decision rules: only stricter. Event-identity and scheduled-vs-occurring checks can turn support into context; nothing new can produce VERIFIED.

### Deployment checklist (each step needs explicit approval)

1. Decide the items under "Decisions waiting for the user" (above all 1 and 2).
2. Open a PR `team/integration` → `main` from the GitHub compare page (no `gh` CLI). Merging `main` triggers the Maypop build, so treat that merge as a frontend deploy.
3. Production database:
   1. Take a fresh `pg_dump`.
   2. Read-only: confirm `drizzle.__drizzle_migrations` ends at 0005.
   3. Apply 0006 with one migrator only (`VERITY_DATABASE_ACK`, `VERITY_DB_CA_PATH`).
   4. Verify `report_schedules` has RLS on, 0 policies and no client-role grants.
4. Deploy the API. Without 0006 only schedule-bearing reports fail, so migrate first.
5. Deploy the worker. It refuses to start without 0006. Leave Nimble budgets unchanged.
6. Maypop:
   1. Confirm the build picked up the merge.
   2. Check `/welcome`, `/map`, `/report` and an event detail inside Maypop.
   3. Check that the lazy map chunk loads under Maypop's CSP and that the sidebar can't scroll the page.
7. Smoke test, without paid calls:
   1. Submit a planned report with a schedule.
   2. Confirm a `report_schedules` row is written (count only) and that a verification job is queued.
   3. One live verification run is a paid Nimble call and needs separate approval.
8. Rollback:
   - Redeploy the previous Railway build and Maypop build.
   - Keep the `report_schedules` table; older code ignores it.
   - Open tabs may hit a missing lazy chunk; `RouteError` then offers "Reload the map".

### Remaining issues

- Regression fixtures for the live test are **reconstructed**; the real 10 sources were never read from production.
- Records stored before this sprint have no identity verdict until they are re-observed.
- Planned events: see decision 2. Announcements can't count until something establishes `events.scheduled_*` (for example an official source).
- Place-conflict detection needs an explicit "City, Qualifier" in the text.
- A descriptive event title may be treated as a name, so coverage without those words stays context (errs toward UNVERIFIED).
- The sweep cursor is in memory and resets when the worker restarts (still reaches every event over time).
- Map: the detail layer works only on OpenMapTiles-schema styles. OpenFreeMap has no SLA (0.5–1 s per uncached area). Low-end phones were tested only with 4x CPU throttling.
- Layout: safe-area handling was checked only with Chrome emulation. The feed shows 50 cards at first, so later events are map-only until expanded. MapLibre's compact attribution starts expanded at 320 px.
- Pre-existing: shared Extract/Agent ceiling (V2), Agent orphan window, no CI, the esbuild dev-server advisories, local `main` behind `origin/main`.

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
- Playwright: `PW_CHANNEL=chrome`. Ports are fixed (4179, 4180, 4190, 8788), so e2e runs are serialized with the lock directory `C:\Users\quang\verity-worktrees\.e2e.lock` (create with `mkdir`, which fails if it exists; delete it when done).
- Don't put production identifiers (event UUIDs, hostnames) in tracked files. The repository is public.

## Production schema (corrected)

The local handoff said production was at migration 0002. The user reports that
0000–0005 were applied. Repository evidence supports this indirectly: the
worker refuses to start without 0003–0005 (`apps/api/src/worker/main.ts`), and
the worker processed the first live verification job. **Not verified in this
session**; nobody queried production.

## Deferred decisions

- **V2, shared Extract/Agent ceiling:** the behavior change is deferred (user decision 2026-10-17). `verifier` documents the problem, adds mocked regression tests if practical and recommends a fix. Production behavior is unchanged.

## Integration order

1. `team/verification` (backend and report form; independent of the map work)
2. `team/map-performance`
3. `team/layout-fixes`, rebased onto the result
4. Lead-applied `MapShell.tsx` changes requested by `map-perf` and `layout`, with tests
