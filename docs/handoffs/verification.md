# Verification workstream handoff

Owner: `verifier`. Current branch: `team/verification-r2` (worktree `<worktrees>/verification`), based on `team/integration` = `c0264c3` (the draft PR #7 head). Round 1 lives on `team/verification` (`c29fe40`, already integrated). Git, code and tests win over this file.

## Status

**REVIEW (round 2).** Paid Nimble work is now opt-in (all four budgets default to 0), and migration 0006 has regression coverage. Round 1 (A1–A6, V1, V3) is integrated. A5 and V2 remain recommendations; V2 stays deferred and its behavior is unchanged. Nothing was pushed, merged or deployed. No live Nimble, no production database.

**Migration `apps/api/drizzle/0006_report_schedules.sql`** (new table `report_schedules`, RLS on, client roles revoked) is unchanged in round 2. It has been tested on PGlite and on a throwaway local PostgreSQL 18, and never applied anywhere remote. Production must apply it before the new worker starts (the worker's readiness check requires it). The API keeps creating reports without it; only a report that includes a schedule fails, with a clean rollback and a generic 500.

## Round 2: paid work is opt-in, and 0006 regression tests

**Budgets.** `apps/api/src/worker/config.ts` now defaults these to `0`. Their ranges are unchanged, so explicit positive values still work:

| Variable | Range | Old default |
| --- | --- | --- |
| `NIMBLE_DAILY_SEARCH_BUDGET` | 0..10000 | 200 |
| `NIMBLE_DAILY_EXTRACT_BUDGET` | 0..20000 | 400 |
| `NIMBLE_DAILY_AGENT_BUDGET` | 0..500 | 20 |
| `NIMBLE_AGENT_MAX_PER_EVENT` | 0..10 | 2 |

How a budget of 0 behaves:
- **Missing or blank.** A missing, empty or whitespace-only value is dropped by `presentEnv`, so it falls to the default of 0. Tests prove "", "  " and "\t\n".
- **Search at 0.** The job is deferred (`search_budget_exhausted`, retried at the next UTC day) and never treated as "no evidence".
- **Extract at 0.** Enrichment is disabled.
- **Agent budget or per-event cap at 0.** The Agent gate never starts a run.
- **Unchanged.** `NIMBLE_MAX_EXTRACTS_PER_JOB` and V2 are untouched.
- **Tests opt in explicitly.** Worker tests set the budgets through `TEST_BUDGET_ENV` in `test/worker/harness.ts`; no assertion was weakened.
- **Smoke scripts.** `src/scripts/nimble-*-smoke.ts` call provider clients directly and never consult these budgets. They are manual, live, and gated by their own opt-in.

**0006 coverage** (`test/migration-0006.test.ts`, PGlite with Supabase-like roles):
- **Upgrade.** A populated 0005 database is migrated to 0006. It holds demo events with URL evidence, a community report (event, report, evidence, timeline, audit, job), a run, a signal, a follow, a geocode entry and a budget counter. Every existing row stays byte-identical (`row_to_json` snapshot of every table), and the history goes from 6 to 7 rows.
- **Repeat migrate.** Running migrations again is a no-op: still 7 history rows, same columns, same data.
- **Constraints.** Start is required; end must not be before start (equal is allowed); the report must exist; deleting a report cascades to its schedule.
- **Security.** RLS is on, there are 0 policies, and `verity_service` owns the table. `has_table_privilege` (effective privileges, not the grants table) is false for anon and authenticated on SELECT/INSERT/UPDATE/DELETE. Query-time select, insert and delete as those roles fail with 42501. A control proves the probe is not vacuous: a mistaken grant (rolled back) is detected, and RLS still hides every row.
- **Partial deploy.** On an app running against a 0005 database, a schedule-bearing report returns a generic `{error:{code:"internal",...}}` 500 that names no table or SQL. Counts of events, reports, evidence, jobs, timeline and audit are unchanged (no orphans). A report without a schedule still returns 201.
- **Readiness.** `verificationSchemaReady` (extracted from `worker/main.ts` into `src/worker/schema-ready.ts`, same SQL) is false at 0005 and true after 0006.

**What the readiness check does NOT prove.** It checks that `verification_runs`, `geocode_cache` and `report_schedules` exist, plus one marker column (`verification_runs.extract_count`). It does not check other columns, types, constraints, foreign keys, grants, RLS or policies. A table created by hand, or a half-applied migration, could pass it. Correctness rests on applying the migrations through the migrator, and on the tests above.

### Migration gate: bounded timeouts for `db:migrate` (round 2 addendum)

`apps/api/src/scripts/migrate.ts` now goes through `src/db/migrate-runner.ts`:
- **One connection, bounded timeouts.** It uses one connection (`max: 1`), with `lock_timeout` and `statement_timeout` set as postgres.js startup parameters (`connection: {...}`). The server applies them to the session, and again on a reconnect.
- **Settings.** `MIGRATE_LOCK_TIMEOUT_MS` (100..600000, default 5000) and `MIGRATE_STATEMENT_TIMEOUT_MS` (1000..3600000, default 60000). Blank means the default. 0 ("no limit") and out-of-range or non-integer values are refused, naming the variable, never the value.
- **Read-back.** The effective values are read back with `SHOW` on the same connection and logged as values only (never the URL). If either differs from what was requested, the run is refused (`MigrationGateError`).
- **On failure.** The script prints only the SQLSTATE and exits 1.
- **Embedded databases.** PGlite (development) migrates without timeouts; there are no other sessions.
- **Unchanged.** The API and worker pools, `createDatabase().migrate()` and `MIGRATE_ON_START` are untouched. The only shared change is that `migrationsFolder()` is now exported.

**Do the session settings survive the drizzle migrator's transaction?** Yes, proven on real PostgreSQL 18.6 (`test/concurrency/migrate-gate.pg.test.ts`). Session-level settings persist across transactions on one connection, and drizzle runs the pending migrations in one transaction on that connection:
- **Lock timeout.** Another session held `reports` in ACCESS EXCLUSIVE mode, and the migrator ran with a 500 ms lock timeout. 0006 failed with 55P03 (lock_not_available) within the bound, and afterwards there was no `report_schedules` table and still 6 history rows.
- **Statement timeout.** A probe migration (create a table, then `pg_sleep(5)`) under a 1000 ms statement timeout failed with 57014, leaving no probe table and still 7 history rows.
- **Read-back.** SHOW reported `5s/1min` for the defaults and `2s/30s` for explicit values.

**Operator-confirm item (not guessed).** Supabase's transaction-mode pooler (port 6543) does not reliably keep session settings or startup parameters, because a transaction may run on a different server connection. The SHOW check catches a pooler that drops them, but it can't prove that every later transaction lands on the same backend. Run `db:migrate` over a direct connection, or a session-mode pooler (port 5432). The production URL wasn't inspected, and `.env` wasn't read.

### Suggested wording for files the lead owns

- **SECURITY.md** (billing / Nimble section): "Paid Nimble work is opt-in. `NIMBLE_DAILY_SEARCH_BUDGET`, `NIMBLE_DAILY_EXTRACT_BUDGET`, `NIMBLE_DAILY_AGENT_BUDGET` and `NIMBLE_AGENT_MAX_PER_EVENT` default to 0; a missing, blank or whitespace-only value means 0, which means no paid calls of that kind. Each paid call is reserved against its budget before it is made (`reserveBudget` refuses any amount above the cap). With search at 0, jobs are deferred to the next UTC day and never concluded. The manual smoke scripts are separate and need their own explicit opt-in."
- **ARCHITECTURE.md** (worker configuration): "Budgets default to 0 (paid work off). Operators opt in per kind, e.g. `NIMBLE_DAILY_SEARCH_BUDGET=200`, `NIMBLE_DAILY_EXTRACT_BUDGET=400`, `NIMBLE_DAILY_AGENT_BUDGET=20`, `NIMBLE_AGENT_MAX_PER_EVENT=2`. The worker's readiness check (`src/worker/schema-ready.ts`) proves only that the 0003–0006 tables exist, not that their constraints, grants or RLS are correct."
- **WORKSTREAM_STATUS.md**: the deployment step "confirm all four budgets are explicitly 0" can become "confirm the four budget variables are unset, blank or 0 (all mean no paid calls)". The verification row should read: "round 2: zero-default budgets plus 0006 regression tests; REVIEW". Under "No budget default changed", note that the defaults are now 0.
- **README.md** (line ~168, "defaults (`apps/api/.env.example` lists the budgets and limits)"): add "paid budgets default to 0 (off)".
- **Runbook / WORKSTREAM_STATUS migration gate**: "`npm run db:migrate -w @verity/api` (or `node dist/migrate.js`) applies migrations on one connection with `lock_timeout` 5 s and `statement_timeout` 60 s by default (`MIGRATE_LOCK_TIMEOUT_MS`, `MIGRATE_STATEMENT_TIMEOUT_MS`). It logs the effective values and refuses to migrate if they don't match. Use a direct or session-mode connection (not Supabase's transaction-mode pooler on 6543). A timeout rolls the whole migration back; retry when the blocking session is gone."

## Goal

Stop named planned events from being "supported" by unrelated material. The first live test, "Día San José 2026" at "Plaza de César Chávez, San Jose, CA", got 10 mostly unrelated festivals and several were tagged `supports`. The fix searches for the event itself, checks event identity deterministically, lets reporters give a schedule, and keeps every decision invariant.

## Files changed

- Identity and location: `apps/api/src/verification/identity.ts` (new), `place-names.ts` (new), `text-evidence.ts`, `stance.ts`, `evidence.ts` (optional `identity` in `extraction_metadata`), `extract-selection.ts`, `enrich.ts`, `agent-evidence.ts`; `packages/contracts/src/text.ts` (`foldDiacritics`, accent-folded `textTokens`).
- Queries: `apps/api/src/providers/nimble/query.ts`, `normalize.ts`, `retriever.ts`, `agent.ts` (prompt).
- Decision: `apps/api/src/verification/rules.ts` (`judge()` guard, `facts.announcedOnly`), `explain.ts` (one sentence).
- Schedules: `packages/contracts/src/api.ts`, `limits.ts`; `apps/api/src/db/schema.ts`, `drizzle/0006_report_schedules.sql` (+ snapshot, journal); `src/domain/reports.ts`; `src/worker/{process,ports,main,enrich,escalate}.ts`; `apps/web/src/features/report/ReportPage.tsx`.
- Sweep: `apps/api/src/worker/sweep.ts`, `loop.ts`.
- Round 2:
  - `apps/api/src/worker/config.ts` (zero budget defaults);
  - `src/worker/schema-ready.ts` (new) and `src/worker/main.ts`;
  - `apps/api/.env.example`;
  - migration gate: `src/db/migrate-runner.ts` (new), `src/scripts/migrate.ts`, `src/db/client.ts` (`migrationsFolder` exported), `test/migrate-runner.test.ts` (new), `test/concurrency/migrate-gate.pg.test.ts` (new);
  - tests: `test/worker-config.test.ts`, `test/worker/harness.ts` (`TEST_BUDGET_ENV`, `defaultBudgetConfig`), `test/worker/zero-budgets.test.ts` (new), `test/migration-0006.test.ts` (new), `test/migration-helpers.ts` (new), `test/helpers.ts` (a `migrate` override for partial-schema contexts).
- Tests: `apps/api/test/fixtures/dia-san-jose.ts` (RECONSTRUCTED, labelled in its header), `test/verification/identity.test.ts`, `test/verification/rules-edge.test.ts`, `test/providers/nimble-query-named.test.ts`, `test/worker/named-event.test.ts`, `test/worker/sweep-starvation.test.ts`, `test/report-schedule.test.ts`; updated `test/migrations.test.ts`, `test/database-access.test.ts`, `test/worker/harness.ts`, contracts tests, `apps/web/src/api/mock/mock-client.test.ts`; new spec `apps/web/e2e/report-schedule.spec.ts`.

## Technical decisions

- **Named event (A2).** A planned category whose title keeps 1–5 distinctive words after removing stopwords, generic event and scene words, category words and years, and not all of them place words. Disruptions are never "named": incident titles are descriptions, so incident matching is unchanged.
- **Identity gating** happens where evidence is built (Search, Extract, Agent): a record whose verdict isn't `match`/`unchecked` is stored with stance `context`. It's kept and shown but never counts. A named event's name must appear in the record's title or quoted sentence, as ordered words with up to two short words between ("Día de San José"). Conflicts are looked for in all returned text. `mismatch` means the city is explicitly qualified as elsewhere ("San José, Costa Rica", "San Jose, Ill."), every explicit date falls outside the schedule window (±1 day), or the name is written with another year ("Día San José 2025"). Extract skips mismatches, and skips unnamed results unless they are located, identified or Agent-cited. The rule table itself is unchanged.
- **Location (A4).** Accents are folded. The first comma segment of a label is precise; later segments are "near" qualifiers. City, state and country segments never count, so a city-only match is never exact. Venue aliases keep the venue-type word: "César Chávez Plaza" matches "Plaza de César Chávez", but a bare "César Chávez" (a street or a holiday) doesn't. A two-letter state code is read only when written in uppercase.
- **Queries (A1).** Named events: q1 `"name" venue [city] month/year`; q2 news (or official domains) `"name" city state month/year`; q3 the old category query as a bounded fallback. Quotes go only around the sanitized name. The ≤3 search ceiling and all budgets are unchanged. Identity mismatches aren't "promising", so the fallback still runs when only unrelated results came back.
- **Scheduled ≠ occurring (A3, in `judge()`, stricter only).** An external, announcement-framed supporting record for a planned event qualifies only while the ESTABLISHED schedule (`events.scheduled_*`) says the event is underway. Nothing whose time lies entirely in the future qualifies.
- **A reported schedule is a claim, not the event's schedule.** `events.scheduled_*` drives freshness and the system rule `resolved_schedule_ended`. Copying a reporter's end time there would let community input resolve an event, and on attach one reporter could set another's schedule. So claims live in `report_schedules`, and `events.scheduled_*` stays seed/trusted-only. Claims are used for the search window and query month, for identity date checks, and in the Agent prompt (marked unconfirmed). They never unlock announcements and never resolve anything. It's a separate table rather than `reports` columns because Drizzle names every column in an insert: new columns would break all report creation if code deployed before the migration (the migrations test caught this).
- **Sweep (V1).** The loop keeps an in-memory id cursor: each sweep continues after the last id seen and wraps around, so every event is visited within ceil(N / batchSize) sweeps. No schema change. One-off calls without a cursor behave as before.

## A5: reporter-provided source URL (investigated, not implemented)

The current invariant holds: `reports.source_url` is screened and stored and never read (SECURITY.md "User-submitted URLs"). Extracting it, even via Nimble and behind a flag, isn't clean:

1. **Confused deputy.** Any reporter could make Verity's paid Nimble account GET an arbitrary public URL. That includes one-time, unsubscribe or other GET-triggered links, and it's rate-limited only by report limits. Search-returned URLs come from an index, not from a user.
2. **Privacy.** Share links often carry the sharer's identity (social `?s=`/`?igsh=` ids, document share tokens). Tracking-parameter stripping doesn't cover them, and sending the link to a provider would send reporter-identifying data.
3. **Lineage paradox.** "Never qualifying on its own, lineage tied to the community report" means the read can never change a decision: the community lineage never counts as external support. Paying for it buys only display text. If it instead got its own external lineage, a reporter could choose evidence for their own report.
4. **Budget steering.** Reporter links would compete with Search candidates for the 4-per-job Extract ceiling.

Recommendation, in order of preference:

- (a) Keep the invariant.
- (b) If wanted: a **hint-only** use behind a default-OFF policy flag. When Search *independently* returns the same canonical URL, rank it first for Extract. Nothing reporter-supplied leaves Verity; the record's provenance stays Search.
- (c) If the link's registrable domain is in the official registry (public, reviewed), add that domain to the q2 `includeDomains` (only registry domains are ever sent).

Proposed SECURITY.md wording for (b)/(c), under "User-submitted URLs": "Report links are never fetched and never sent to a provider. With `policy.reporterLinkHints` on (default off), a report link only (1) raises the Extract priority of an identical URL that Search returned independently, and (2) if its domain is in the reviewed official registry, adds that registry domain to the official-domain search. The link's evidence, lineage and source class come only from the Search result."

## V2: shared Extract/Agent ceiling (deferred; behavior unchanged)

**Problem.** `useAgentResult` (`apps/api/src/worker/escalate.ts`) reads URL-only Agent citations only within `min(4, NIMBLE_MAX_EXTRACTS_PER_JOB) − extracts already used`. When pre-Agent extraction used all 4 slots, the paid Agent run's URL-only citations go unread (`agent_citations_unread_ceiling`) and add nothing. **Pinned by** `test/worker/agent-escalation.test.ts`, "does not read URL-only Agent citations when pre-Agent extraction used all 4 slots, and records why": Agent started once, 4 extracts, citation unread, note recorded, citation not stored.

Options (costs in provider calls; no prices assumed):

1. **Post-Agent allowance (recommended).** A separate small ceiling for cited pages after a completed Agent run, e.g. `NIMBLE_MAX_EXTRACTS_AFTER_AGENT=2` (0 = today's behavior). It still counts in `extract_count` and the daily Extract budget. Cost: at most +2 Extract calls per Agent run, and Agent runs are already capped (daily budget, per-event cap, cooldown). Limitation: the per-job ceiling in SECURITY.md/ARCHITECTURE.md ("4") becomes "4, plus up to 2 for Agent citations". The DB check (`extract_count` 0..50) already allows it.
2. **Reserve slots.** When the preliminary decision would escalate and the Agent is enabled, stop pre-Agent extraction at 4 − R. Cost: no extra calls. Limitation: fewer Search pages read, which may escalate to the (more expensive) Agent more often.
3. **Hold the Agent** when no Extract slot is left. Cost: saves the Agent call. Limitation: it also loses citations that carry excerpts, which need no Extract.

Option 1 is the only one that makes the paid run useful without weakening the deterministic pre-Agent stage.

## Commits

- Round 1 (`team/verification`): `5628f41`, `a5e53aa`, `62f47b6`, `7df1c8a`, `c29fe40`.
- Round 2 (`team/verification-r2`): one commit on top of `c0264c3`; see `git log --oneline c0264c3..team/verification-r2`.

## Tests actually run

Round 2 (2026-10-17, on `team/verification-r2`):
- `npm run check` at the root: pass. Contracts 54; API 687 passed + 13 skipped (47 files, 2 skipped: the real-PostgreSQL suites); web 123; bundle secret scan passed.
- `TEST_DATABASE_URL=postgres://verity_test@127.0.0.1:55432/postgres npm run test:concurrency -w @verity/api`: 13/13 passed (2 files). It ran against a throwaway PostgreSQL 18.6 cluster (trust auth, 127.0.0.1 only) created in the scratchpad, which was stopped and deleted afterwards.
- Addendum, the same command on a fresh throwaway cluster: 17/17 passed (3 files, including the 4 migration-gate tests). The cluster was stopped and deleted afterwards. `test/migrate-runner.test.ts`: 14 passed.
- Addendum `npm run check`: pass. Contracts 54; API 701 passed + 17 skipped (49 files, 3 skipped: the real-PG suites); web 123; bundle secret scan passed.
- Not run: Playwright (no web change in round 2) and `test:e2e:service`. No live Nimble, no production database.

Round 1 (2026-10-17):

- Baseline `npm run check` before changes: pass. Contracts 51, API 551 passed + 13 skipped, web 89.
- After milestone 1: pass. Contracts 52, API 600 + 13 skipped, web 89.
- After A3: pass. Contracts 54, API 608 + 13 skipped, web 90.
- `PW_CHANNEL=chrome npm run test:e2e` in `apps/web` (lock taken and released): 29 passed, 1 skipped (the mobile-only test on desktop), including `report-schedule.spec.ts` on desktop and mobile.
- V1: the starvation test was run against the ORIGINAL `sweep.ts`/`loop.ts`. The starvation case passed there, demonstrating the bug, and the cursor/loop cases failed. With the fix, all 4 pass.
- After V1: pass. Contracts 54, API 612 + 13 skipped, web 90.
- Final `npm run check` (before the last commit): pass. Contracts 54, API 665 passed + 13 skipped (45 files, 2 skipped), web 90, bundle secret scan passed.
- Not run: `npm run test:e2e:service` (needs the service setup; the report UI change is covered by the mock e2e and API tests), `npm run test:concurrency` (needs a local Postgres). No live Nimble, no production database.

## Remaining risks

- Descriptively titled planned events ("Live music and food at the plaza") may be treated as named, so coverage that doesn't repeat those words stays context. This errs toward UNVERIFIED, never toward a false VERIFIED.
- Place-conflict detection needs an explicit "City, Qualifier". A page about San José, Costa Rica that never writes the country next to the city is caught only by the name check.
- Stored records from before this change have no identity verdict and keep their stored stance until re-observed. A page-read record isn't overwritten by a later search snippet.
- A reporter can give a wrong schedule; the only effect is that sources stating only other dates become context. Planned-only is enforced by the request schema, not a DB constraint.
- The query month comes from the UTC date of the claimed start (only month and year are sent).
- Behavior change: the existing test "verifies a scheduled event before it starts on a current announcement" still passes only because its record has no excerpt. Real announcement text ("will be held…") no longer verifies before the start (`rules-edge.test.ts` pins both sides). **Needs user confirmation** (see below).
- The sweep cursor resets on worker restart; each restart starts a new pass.
- With the zero defaults, a deployment that forgets to opt in gathers no external evidence: jobs stay deferred and events stay UNVERIFIED. This is by design, but it is easy to mistake for an outage. Watch for `search_budget_exhausted` in the run notes.
- Turning the budgets on is a cost decision for the user. Opting in to search alone gives search only (no page reads, no Agent).
- The readiness check is presence-only (see round 2 above).
- The migration gate's mismatch refusal is unit-tested (`timeoutsInEffect`), not exercised against a real pooler. Whether production's migration URL is direct or session-mode is for the operator to confirm.
- The 60 s statement default bounds each statement, not the whole run. A large future data migration may need an explicit higher `MIGRATE_STATEMENT_TIMEOUT_MS`.
- The 0006 privilege and RLS checks run on PGlite with Supabase-like roles. The real-PostgreSQL suite checks that 0000–0006 apply and that RLS is on for `report_schedules`, but it does not repeat the client-role privilege matrix.

## Requests to lead

1. **SECURITY.md**: add "Reported schedules: stored per report in `report_schedules` (RLS on, client roles revoked); never copied to the event's schedule; can't change status; used only as search and identity hints." Keep "User-submitted URLs" as is (A5). If V2 option 1 is adopted, update the per-job Extract ceiling sentence.
2. **ARCHITECTURE.md**: add `report_schedules` to the table list; named-event query strategy (q1/q2/q3 above); the identity check; scheduled ≠ occurring; the sweep cursor; the worker readiness check now covers migrations 0003–0006.
3. **Layout**: ReportPage has a new plain "When is it scheduled?" fieldset (planned categories only) that may need styling. Field ids: `report-starts`, `report-ends`.
4. **Future UI (optional)**: show the reporter-claimed schedule on event detail as "Reporter says…". This needs a contract field, which `verifier` can add.
5. **WORKSTREAM_STATUS.md**: update the verification row (REVIEW, tests above).

## Needs the user's decision

- Apply migration 0006 in production before deploying this worker. Never applied by this workstream.
- Whether, when and how much to opt in to paid Nimble work (all four budgets default to 0).
- Confirm the stricter product rule: an announcement no longer makes a scheduled event VERIFIED before it starts.
- A5 (keep the invariant, or adopt hint-only option b/c) and V2 (option 1, 2 or 3).

## Exact resumption steps

1. `cd <worktrees>/verification && git switch team/verification-r2 && git log --oneline c0264c3..HEAD`.
2. `npm run check` at the worktree root. For UI changes, take the e2e lock and run `PW_CHANNEL=chrome npm run test:e2e` in `apps/web`.
3. Open items: A5 option (b/c) and V2 option 1 are both small and behind flags; implement only after the decisions above.
