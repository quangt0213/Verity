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
| Layout and UX | `layout` | IN_PROGRESS (follow-up) | `team/layout-fixes` @ `89c8267` (merged) | check: web 95; e2e 53 + 19 skipped (with MapShell patch); service 2 | None | Feed render cost (memo EventCard, incremental list), schedule-field styling |
| Integration | lead | REVIEW | `team/integration` @ `642836a` | 2026-10-17: check 834 (54 + 665 + 115; 13 skipped), bundle scan; e2e 55 + 19 skipped; service 2 | Layout follow-up | Merge the layout follow-up, final checks, delivery report |

### Integration log

| Commit | Step |
| --- | --- |
| `379c118` | Merge `team/layout-fixes` |
| `b8a2333` | Lead: `layout-mapshell-2` (aside containment and width, mobile overlays); `evidence.spec` overflow measured inside `#root`; safe-area spec waits for animations (it failed in the full parallel run) |
| `a2dea65` | Merge `team/verification` |
| `cc0e74e` | Merge `team/map-performance` |
| `642836a` | Lead: `map-perf-mapshell-1-integration` (memoized shell context); SECURITY.md and ARCHITECTURE.md updates |

## Decisions waiting for the user

1. **Migration 0006** (`report_schedules`): must be applied in production before the new worker starts (readiness check). Reports without a schedule keep working before it.
2. **Scheduled ≠ occurring:** an announcement counts only while the event's *established* schedule says it is underway. Nothing in production sets `events.scheduled_*` (only the demo seed does), so for real planned events announcements never count today; verification needs coverage of the event actually happening. Errs toward UNVERIFIED.
3. **A5** (reporter links): keep "never fetched" (recommended) or a default-off hint-only option. **V2**: post-Agent Extract allowance (recommended), reserve slots, or hold the Agent.
4. **Map:** POI density (tuned only in San Francisco); keep the preconnect hint; accept +150 ms cold `/map` for −1.0 s on welcome; padded query bbox (product call; can hide events when the 500 cap truncates).
5. **Layout:** pull-to-refresh disabled when top-level on mobile; Report button hides while a preview is open; sidebar `clamp(360px, 30vw, 440px)`.

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
