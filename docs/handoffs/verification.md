# Verification workstream handoff

Owner: `verifier`. Branch: `team/verification` (worktree `C:\Users\quang\verity-worktrees\verification`), based on `origin/main` = `cc44449`. Git, code and tests win over this file.

## Status

**REVIEW.** A1–A4, A6, V3 and V1 are implemented and tested. A5 is investigated with a recommendation (not implemented, by design). V2 is documented with a recommendation; its current behavior is already pinned by an existing test. Nothing was pushed, merged or deployed.

**Migration added: `apps/api/drizzle/0006_report_schedules.sql`** (new table `report_schedules`, RLS on, client roles revoked). Tested on PGlite only; never applied anywhere remote. Production must apply it before the new worker starts (the worker's readiness check requires it). The API keeps creating reports without it; only a report that includes a schedule would fail.

## Goal

Stop named planned events from being "supported" by unrelated material. The first live test, "Día San José 2026" at "Plaza de César Chávez, San Jose, CA", got 10 mostly unrelated festivals and several were tagged `supports`. The fix searches for the event itself, checks event identity deterministically, lets reporters give a schedule, and keeps every decision invariant.

## Files changed

- Identity and location: `apps/api/src/verification/identity.ts` (new), `place-names.ts` (new), `text-evidence.ts`, `stance.ts`, `evidence.ts` (optional `identity` in `extraction_metadata`), `extract-selection.ts`, `enrich.ts`, `agent-evidence.ts`; `packages/contracts/src/text.ts` (`foldDiacritics`, accent-folded `textTokens`).
- Queries: `apps/api/src/providers/nimble/query.ts`, `normalize.ts`, `retriever.ts`, `agent.ts` (prompt).
- Decision: `apps/api/src/verification/rules.ts` (`judge()` guard, `facts.announcedOnly`), `explain.ts` (one sentence).
- Schedules: `packages/contracts/src/api.ts`, `limits.ts`; `apps/api/src/db/schema.ts`, `drizzle/0006_report_schedules.sql` (+ snapshot, journal); `src/domain/reports.ts`; `src/worker/{process,ports,main,enrich,escalate}.ts`; `apps/web/src/features/report/ReportPage.tsx`.
- Sweep: `apps/api/src/worker/sweep.ts`, `loop.ts`.
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

`git log --oneline origin/main..team/verification`:

- `5628f41` Verification relevance: event identity, named-event queries, location matching
- `a5e53aa` Reported schedules for planned events (claims, not the event's schedule)
- `62f47b6` Aging sweep: visit every event with a round-robin cursor
- `7df1c8a` Decision-rule edge-case tests, name-aware excerpts, handoff
- (next) Handoff commit list

## Tests actually run (2026-10-17)

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

## Requests to lead

1. **SECURITY.md**: add "Reported schedules: stored per report in `report_schedules` (RLS on, client roles revoked); never copied to the event's schedule; can't change status; used only as search and identity hints." Keep "User-submitted URLs" as is (A5). If V2 option 1 is adopted, update the per-job Extract ceiling sentence.
2. **ARCHITECTURE.md**: add `report_schedules` to the table list; named-event query strategy (q1/q2/q3 above); the identity check; scheduled ≠ occurring; the sweep cursor; the worker readiness check now covers migrations 0003–0006.
3. **Layout**: ReportPage has a new plain "When is it scheduled?" fieldset (planned categories only) that may need styling. Field ids: `report-starts`, `report-ends`.
4. **Future UI (optional)**: show the reporter-claimed schedule on event detail as "Reporter says…". This needs a contract field, which `verifier` can add.
5. **WORKSTREAM_STATUS.md**: update the verification row (REVIEW, tests above).

## Needs the user's decision

- Apply migration 0006 in production before deploying this worker. Never applied by this workstream.
- Confirm the stricter product rule: an announcement no longer makes a scheduled event VERIFIED before it starts.
- A5 (keep the invariant, or adopt hint-only option b/c) and V2 (option 1, 2 or 3).

## Exact resumption steps

1. `cd C:/Users/quang/verity-worktrees/verification && git log --oneline origin/main..HEAD`.
2. `npm run check` at the worktree root. For UI changes, take the e2e lock and run `PW_CHANNEL=chrome npm run test:e2e` in `apps/web`.
3. Open items: A5 option (b/c) and V2 option 1 are both small and behind flags; implement only after the decisions above.
