# Verification workstream handoff

Owner: `verifier`. Branch: `team/verification` (worktree `C:\Users\quang\verity-worktrees\verification`), based on `origin/main` = `cc44449`. Git, code and tests win over this file.

## Status

**IN_PROGRESS.** A1, A2, A4 (milestone 1) and A3 (milestone 2) are implemented and tested. Next: A5 investigation, A6 gaps, V3, V1, V2.

**Migration added: `apps/api/drizzle/0006_report_schedules.sql` (new table `report_schedules`, RLS on, client roles revoked). Tested on PGlite only, never applied anywhere remote.** Production needs it applied before the new worker starts (the worker's readiness check now requires it). The API keeps creating reports without it; only reports that include a schedule would fail.

## Goal

Stop named planned events from being "supported" by unrelated material (the first live test: "Día San José 2026" at "Plaza de César Chávez, San Jose, CA" got 10 mostly unrelated festivals, several tagged `supports`). Search for the event itself, check event identity deterministically, let reporters give a schedule, and keep every decision invariant.

## Files changed (milestone 1)

- `apps/api/src/verification/identity.ts` (new): event name extraction, identity verdicts (`match`, `uncertain`, `mismatch`, `unchecked`), stated-date and edition checks.
- `apps/api/src/verification/place-names.ts` (new): US states (names, USPS, AP abbreviations) and a short country list.
- `apps/api/src/verification/text-evidence.ts`: accent folding, compound labels, venue aliases, city-only never exact, `placeConflict`, name-aware excerpt choice.
- `apps/api/src/verification/stance.ts`: event-name mentions count as event mentions; `announcementFraming`.
- `apps/api/src/verification/rules.ts`, `explain.ts`: scheduled ≠ occurring guard in `judge()`, `facts.announcedOnly`, one explanation sentence.
- `apps/api/src/providers/nimble/query.ts`, `normalize.ts`, `retriever.ts`: named-event queries; identity applied to Search results.
- `apps/api/src/verification/enrich.ts`, `agent-evidence.ts`, `extract-selection.ts`, `evidence.ts`; `apps/api/src/worker/{enrich,escalate,ports}.ts`: identity applied to Extract and Agent evidence; no page reads for mismatches; `identity` stored in `extraction_metadata` (optional field, no migration).
- `packages/contracts/src/text.ts`: `foldDiacritics`; `textTokens` folds accents (dedupe and near-duplicate lineage).
- Tests: `apps/api/test/fixtures/dia-san-jose.ts` (RECONSTRUCTED, labelled in its header), `test/verification/identity.test.ts`, `test/providers/nimble-query-named.test.ts`, `test/worker/named-event.test.ts`.

## Files changed (milestone 2, A3 scheduled dates)

- `packages/contracts/src/api.ts`, `limits.ts`: optional `scheduled_start_at` / `scheduled_end_at` on `reportEventInputSchema` (planned categories only, start required for an end, end ≥ start, start within −30/+366 days, duration ≤ 366 days, ISO with offset).
- `apps/api/src/db/schema.ts`, `drizzle/0006_report_schedules.sql`: `report_schedules` (one row per report, only when given).
- `apps/api/src/domain/reports.ts`: stores the claim; never touches `events.scheduled_*` (new or attached event).
- `apps/api/src/worker/process.ts`, `ports.ts`, `main.ts`: claims load as `EventForRetrieval.reportedSchedules` (planned events only, oldest first, max 5); readiness check requires 0006.
- `apps/api/src/providers/nimble/agent.ts`: the Agent prompt passes a claimed start as "unconfirmed" and asks for sources about this specific event only.
- `apps/web/src/features/report/ReportPage.tsx`: optional "When is it scheduled?" fieldset (two `datetime-local` inputs) shown only for planned categories; local time sent as an ISO instant; field errors wired with `aria-invalid`/`aria-describedby`. Plain styling (layout teammate may restyle).
- `apps/web/src/api/mock/mock-client.test.ts`: the demo adapter validates the new fields through the shared schema (no adapter code change was needed; HTTP adapter forwards the payload as-is).
- Tests: `apps/api/test/report-schedule.test.ts`, `test/migrations.test.ts` (0006), `test/database-access.test.ts` (table list), contracts tests, `apps/web/e2e/report-schedule.spec.ts` (new spec).

## Technical decisions

- **Named event**: planned category, title has 1–5 distinctive words after removing stopwords, generic event/scene words, category words and years, and not all of them are place words. Disruptions are never "named" (incident titles are descriptions), so incident matching is unchanged.
- **Identity gating** happens at normalization (Search, Extract, Agent): a record that isn't `match`/`unchecked` is stored with stance `context`, so it is shown but never counts. The decision rule table is unchanged. A named event's name must appear in the record's title or quoted sentence (ordered words, up to two short words between: "Día de San José"); conflicts are looked for in all returned text.
- **Mismatch**: the city is explicitly qualified as elsewhere ("San José, Costa Rica", "San Jose, Ill."), explicit dates all outside the schedule window (±1 day), or the name written with another year ("Día San José 2025").
- **Location (A4)**: first comma segment of a label is precise; later segments are "near" qualifiers; city/state/country segments never count. Venue aliases keep the venue-type word (`César Chávez Plaza` = `Plaza de César Chávez`, but bare `César Chávez` doesn't match). A two-letter state code is read only when uppercase.
- **Queries (A1)**: named events: q1 `"name" venue [city] month/year`, q2 news (or official domains) `"name" city state month/year`, q3 the old category query as fallback. Quotes only around the sanitized name. Ceiling and budgets unchanged. `promising` excludes identity mismatches so the fallback still runs when only unrelated results came back.
- **Scheduled ≠ occurring** (in `judge()`, stricter only): an external, announcement-framed supporting record for a planned event qualifies only while the ESTABLISHED schedule (`events.scheduled_*`) says the event is underway; nothing whose time lies entirely in the future qualifies.
- **Reported schedule is a claim, not the event's schedule (A3).** `events.scheduled_*` drives freshness windows and the system rule `resolved_schedule_ended`. Copying a reporter's end time there would let community input resolve an event (an invariant violation), and on attach would let one reporter set another's schedule. So claims live in `report_schedules`; `events.scheduled_*` stays seed/trusted-only. Claims are used for: the search time window and month in queries; identity date checks (a source stating only dates outside every claimed window is another occurrence); the Agent prompt (as unconfirmed). They never unlock announcements and never resolve anything.
- **Separate table instead of `reports` columns**: Drizzle names every table column in an insert, so new `reports` columns would break all report creation if the API were deployed before the migration (the migrations test caught this).

## Commits

See `git log origin/main..team/verification`.

## Tests actually run

- 2026-10-17 baseline `npm run check` (before changes): pass. Contracts 51, API 551 passed + 13 skipped, web 89.
- 2026-10-17 after milestone 1, `npm run check`: pass. Contracts 52, API 600 passed + 13 skipped, web 89, bundle secret scan passed.
- 2026-10-17 after milestone 2, `npm run check`: pass. Contracts 54, API 608 passed + 13 skipped, web 90, bundle secret scan passed.
- 2026-10-17 `PW_CHANNEL=chrome npm run test:e2e` in `apps/web` (lock held by `verifier`, released): 29 passed, 1 skipped (the mobile-only test on desktop), including the new `report-schedule.spec.ts` on desktop and mobile.

## Remaining risks

- Descriptively titled planned events ("Live music and food at the plaza") may be treated as named, so coverage that doesn't repeat those words stays context. This errs toward UNVERIFIED, never toward a false VERIFIED.
- Place-conflict detection needs an explicit "City, Qualifier" pattern; a page about San José, Costa Rica that never writes the country next to the city is caught only by the name check.
- Stored records from before this change carry no identity verdict and keep their stored stance until re-observed.
- A reporter can give a wrong schedule; the only effect is that sources stating only other dates become context (fewer verifications, never a false one). Planned-only is enforced by the request schema, not by a database constraint (the category lives on `reports`).
- Query month/year uses the UTC date of the claimed start; an evening event in a US zone can show the next UTC day, but only month and year are sent.
- The event detail API doesn't expose reported schedules yet (no UI shows them).

## Requests to lead

None yet.

## V2 recommendation

Pending (end of workstream).

## Exact resumption steps

1. `cd C:/Users/quang/verity-worktrees/verification && git log --oneline origin/main..HEAD`.
2. Continue with A5 (reporter source URL investigation), then V3, V1, V2.
3. Run `npm run check` at the worktree root before each commit.
