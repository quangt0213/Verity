# Verification workstream handoff

Owner: `verifier`. Branch: `team/verification` (worktree `C:\Users\quang\verity-worktrees\verification`), based on `origin/main` = `cc44449`. Git, code and tests win over this file.

## Status

**IN_PROGRESS.** A1, A2 and A4 are implemented and tested (milestone 1). A3 (scheduled dates) is next.

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

## Technical decisions

- **Named event**: planned category, title has 1–5 distinctive words after removing stopwords, generic event/scene words, category words and years, and not all of them are place words. Disruptions are never "named" (incident titles are descriptions), so incident matching is unchanged.
- **Identity gating** happens at normalization (Search, Extract, Agent): a record that isn't `match`/`unchecked` is stored with stance `context`, so it is shown but never counts. The decision rule table is unchanged. A named event's name must appear in the record's title or quoted sentence (ordered words, up to two short words between: "Día de San José"); conflicts are looked for in all returned text.
- **Mismatch**: the city is explicitly qualified as elsewhere ("San José, Costa Rica", "San Jose, Ill."), explicit dates all outside the schedule window (±1 day), or the name written with another year ("Día San José 2025").
- **Location (A4)**: first comma segment of a label is precise; later segments are "near" qualifiers; city/state/country segments never count. Venue aliases keep the venue-type word (`César Chávez Plaza` = `Plaza de César Chávez`, but bare `César Chávez` doesn't match). A two-letter state code is read only when uppercase.
- **Queries (A1)**: named events: q1 `"name" venue [city] month/year`, q2 news (or official domains) `"name" city state month/year`, q3 the old category query as fallback. Quotes only around the sanitized name. Ceiling and budgets unchanged. `promising` excludes identity mismatches so the fallback still runs when only unrelated results came back.
- **Scheduled ≠ occurring** (in `judge()`, stricter only): an external, announcement-framed supporting record for a planned event qualifies only while the ESTABLISHED schedule (`events.scheduled_*`) says the event is underway; nothing whose time lies entirely in the future qualifies.

## Commits

See `git log origin/main..team/verification`.

## Tests actually run

- 2026-10-17 baseline `npm run check` (before changes): pass. Contracts 51, API 551 passed + 13 skipped, web 89.
- 2026-10-17 after milestone 1, `npm run check`: pass. Contracts 52, API 600 passed + 13 skipped, web 89, bundle secret scan passed.

## Remaining risks

- Descriptively titled planned events ("Live music and food at the plaza") may be treated as named, so coverage that doesn't repeat those words stays context. This errs toward UNVERIFIED, never toward a false VERIFIED.
- Place-conflict detection needs an explicit "City, Qualifier" pattern; a page about San José, Costa Rica that never writes the country next to the city is caught only by the name check.
- Stored records from before this change carry no identity verdict and keep their stored stance until re-observed.

## Requests to lead

None yet.

## V2 recommendation

Pending (end of workstream).

## Exact resumption steps

1. `cd C:/Users/quang/verity-worktrees/verification && git log --oneline origin/main..HEAD`.
2. Continue with A3 (scheduled dates): contracts → API persistence → worker hints → adapters → ReportPage.
3. Run `npm run check` at the worktree root before each commit.
