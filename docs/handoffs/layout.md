# Layout and UX workstream handoff

| | |
| --- | --- |
| Owner | `layout` |
| Branch | `team/layout-r3` (worktree `<worktrees>/layout-fixes`), from `be0e16b` (team/integration). Earlier rounds: `team/layout-r2`, `team/layout-fixes` |
| Stage | REVIEW: round 3 (honest uncertain submit outcomes) done |
| Last updated | 2026-10-18 |

## Goal

The map always fills its space and the document never scrolls: each region
(sidebar, bottom sheet, a page's `<main>`) scrolls on its own, standalone and
inside Maypop's cross-site iframe. Mobile overlays never cover each other or
leave the screen, the sheet respects the safe area, and the desktop sidebar
width adapts from 1024 px up. Follow-up: the feed stays cheap to render with
500 events, and the report form's schedule fields match the rest of the form.

## Report submission across releases and failures (rounds 2–3)

**Release requirement.** Publish the new frontend only after the new API is
serving **and** migration 0006 is applied. Until then, a report that includes a
schedule fails: the running API rejects it (400, a definite rejection), and a
new API without 0006 fails it with a 5xx, which the form reports as an unknown
outcome. Reports without a schedule work in every combination.

**Compatibility matrix** ("old" = `cc44449`, "new" = current):

| Frontend → API | No schedule | With schedule | Verified by |
| --- | --- | --- | --- |
| New → old API | ✓ the keys are absent from the body | ✗ 400 `validation_failed`, `fields: { "_": "Unexpected field" }`. **Definite:** the form says the service doesn't accept scheduled times yet and keeps the schedule | `packages/contracts/src/report-compat.test.ts` (frozen v1 schema + the API's field mapping); `ReportPage.submit.test.tsx` (wire body, UI) |
| New → new API, 0006 applied | ✓ | ✓ | `report-compat.test.ts` (current schema); API suite `report-schedule.test.ts` |
| New → new API, no 0006 | ✓ (no `report_schedules` insert) | ✗ 5xx; the transaction rolls back. **Shown as unknown** (below): the form can't prove the rollback, says it couldn't confirm receipt, keeps everything and offers the arrival check, which will find nothing | Code reading (`apps/api/src/domain/reports.ts`) and the lead's earlier rehearsal; **not re-run here** |
| Old → new API (either schema) | ✓ | n/a (the old form has no schedule) | `report-compat.test.ts`: an old-frontend body passes the current schema |

The new frontend omits `scheduled_start_at`/`scheduled_end_at` when blank: the
payload spreads them in only when set, `JSON.stringify` drops `undefined`, and a
schedule typed for a planned category is dropped if the category changes to an
unplanned one. The old API would reject a `null` value too (tested).

**Definite vs unknown outcome.** The HTTP client sets `WriteError.outcomeUnknown`
whenever the request may have been carried out (`api/http-client.ts`,
`api/types.ts`). `report/submit-errors.ts` classifies on that flag.

| Response | Client code | Outcome | What the form says |
| --- | --- | --- | --- |
| 400 `_: "Unexpected field"` after sending a schedule | `validation_failed` | Definite | "The Verity service doesn't accept scheduled times yet, so this report wasn't sent. Your schedule is still filled in: …" Starts is marked; focus on Starts |
| 400 on a field the form shows | `validation_failed` | Definite | That field's message; focus on it |
| 400 on another key | `validation_failed` | Definite | "The service didn't accept this report (…). Everything you entered is still here." |
| 401 / 403 / 404 / 409 / 413 / 429 with the service's error body | that code | Definite | The service's message + "Your report wasn't accepted." (401 first opens sign-in) |
| Nothing sent (no session, demo writes off, unconfigured build) | `auth_required` / `auth_unavailable` / `unavailable` | Definite | As above |
| Network error (fetch rejected) | `network` | **Unknown** | Amber box: "We couldn't confirm whether your report was received. The connection failed before Verity answered. Everything you entered is still here. Before sending it again, check whether it arrived." + check button |
| Timeout (12 s client abort) | `unavailable` | **Unknown** | Same box, "Verity didn't send a usable answer." |
| Any 5xx, including Verity's own well-formed 500 and proxies' 502/503/504 | `unavailable` | **Unknown** | Same |
| A 4xx without the service's error body (proxy page, 408) | `validation_failed` / `rate_limited` | **Unknown** | Same |
| 2xx with an unreadable body | `unavailable` | **Unknown** | Same |

Why Verity's own 500 counts as unknown: `createReport` runs in one transaction
and the route only logs and sends 201 after it resolves, so almost every 500
means a rollback. But a failure while committing (the connection drops during
`COMMIT`) also surfaces as a 500 when the commit may have been applied, and the
client discards 5xx bodies anyway. Treating every 5xx as unknown is the honest
choice; the arrival check then quickly shows nothing arrived.

Definite failures are red with the existing text; unknown outcomes are amber
with a question icon. Both use `role="alert"` (remounted per attempt) and take
focus when no field is at fault.

**Check before retrying** (`report/ArrivalCheck.tsx`). It uses only the public
event list (`GET /api/v1/events`, `Cache-Control: no-store`) and runs inside the
form, so the draft is never lost:
- Query: a box of about ±550 m around the submitted point (the service
  attaches reports to events within 300 m, `domain/dedupe.ts`) with
  `updated_since` = attempt start − 10 min (client-clock margin), filtered again
  client-side.
- A new report creates an event with the report's exact title at the exact
  point; an attached report sets the existing event's `last_updated_at` to now.
  Both appear in that query.
- Exact title (case/space-insensitive) found: "It arrived: “…” near this
  location was updated at HH:MM. You don't need to send it again." plus an
  "Open the event" link. Leaving the form is fine then: the report exists.
- Other events changed nearby: lists up to 3 with times, "Your report may have
  been added to one of them", plus the resend note. No links, so the draft stays.
- Nothing changed: "… so your report most likely didn't arrive. You can send it
  again."
- The check fails: "Couldn't check right now. Try again in a moment."

Resend note, worded from `dedupe.ts`: "If you send it again and the first one
did arrive, Verity usually adds it to the same event instead of creating a new
one, but it may count as a second report from you." It isn't idempotent: an
identical resend usually attaches (same place, category and words), but an
ambiguous runner-up within 0.05 makes a new event, and each send adds a report
row. There is no auto-follow and no "my reports" endpoint, so Following can't
serve as the check.

Never: dropping the schedule, resending automatically, or sending a second
request on a double click (an in-flight guard backs up the disabled button).

**Suggested runbook text** (for `WORKSTREAM_STATUS.md` and the deployment
checklist):

> 1. Apply migration 0006 (approved separately; `MIGRATE_ON_START` unset or
>    false).
> 2. Deploy the new API and worker. Confirm the API serves and the worker
>    passes its readiness check (it requires 0003–0006).
> 3. Smoke-test a report with a schedule against the new API (201, and the
>    `report_schedules` row exists) and one without.
> 4. Only then publish the new frontend to Maypop.
> 5. Rollback: unpublishing the frontend first is always safe, because old
>    frontends never send a schedule. If the API must roll back while the new
>    frontend is live, schedule-bearing reports get the "doesn't accept
>    scheduled times yet" message and nothing else breaks.

**Files:** `apps/web/src/api/{types,http-client}.ts` (+ `http-client.test.ts`),
`apps/web/src/features/report/{ReportPage.tsx,submit-errors.ts,ArrivalCheck.tsx,ReportPage.submit.test.tsx}`,
`packages/contracts/src/report-compat.test.ts` (test only).

**Tests (round 3, 2026-10-18, branch `team/layout-r3` from `be0e16b`):**
- `npm run check`: pass (contracts 58; API 701 passed / 17 skipped; web 142).
- `ReportPage.submit.test.tsx`, 17 tests:
  - Wire body.
  - Definite: old-API schedule 400, field 400, other-key 400, 429.
  - Unknown: network, Verity 500, proxy 502, proxy 504, 2xx with an unreadable
    body. Each checks the wording, that the input is kept, focus, exactly one
    request and the check button.
  - The three check results.
  - The user's resend after "nothing changed" is the same body.
  - Double click.
- `http-client.test.ts`: the `outcomeUnknown` flag for network/500/502/504/
  408/unreadable-2xx (set) and 400/429/401 (absent); a client timeout sets it.
- `PW_CHANNEL=chrome npx playwright test`: 57 passed, 21 skipped
  (`layout.spec.ts`, `layout-overlays.spec.ts`, `report-schedule.spec.ts`,
  `smoke.spec.ts`, `evidence.spec.ts`). `npm run test:e2e:service`: 2 passed.
- Not run: the old API build; the new API without 0006; a real network drop
  against a real service; a visual check of the amber box on a phone (no e2e
  reproduces an unknown outcome; the demo adapter never fails).

## Diagnosis (L1: blank space under the desktop map)

Measured with Playwright + Chrome 155 against the demo production bundle,
standalone (`127.0.0.1`) and in a cross-site iframe (`localhost` host page).

**Root cause:** absolutely positioned descendants of the sidebar escaped the
sidebar's scroll container and extended the *document's* scrollable overflow.

- Tailwind `sr-only` is `position: absolute`. Every `EventCard` has
  `<span class="sr-only">Category: </span>`; the detail view has more
  (`EvidenceSection` "Source text: ").
- The sidebar `<aside class="overflow-y-auto">` isn't positioned, so those
  spans' containing block was the `relative` row wrapper in `MapShell`, outside
  the scroller. They sat at their static position deep in the list (the last at
  y=2123) unclipped by the aside, so their overflow reached the viewport.
- `html`, `body` and `#root` were `overflow: visible`, so the document became
  scrollable: scrollHeight 2123 vs clientHeight 860 at 1360×860 on load.
- When the sidebar reached its end, the wheel chained to the document, which
  scrolled by up to 1263 px: the top bar, sidebar and map all moved up, and the
  page background showed where the map had been.
- In an iframe the same happened in the frame's document; in a scrollable host
  page the scroll then chained into the host as well (host scrollTop 0 → 400).
- The same mechanism scrolled the document on the mobile map and on `/report`
  (sr-only text with no positioned ancestor at all, laid out against the
  viewport: +94 px at 320 px wide), and `/welcome` scrolled the document by
  design (`<main class="min-h-full overflow-y-auto">` never overflowed itself).

Proof: setting `position: relative` on the aside in devtools dropped the
document scrollHeight from 2123 to 860 (feed) and from 916 to 860 (detail).

Ruled out: viewport units (none used); `scrollIntoView`/`focus()` (the detail
heading already focuses with `preventScroll`, and focusing the last card
scrolled only the aside); map canvas resize (the canvas always matched its
container); iframe sizing.

## Fixes

| Fix | Where | Status |
| --- | --- | --- |
| `#root { position: relative; overflow: clip }`: the document can't scroll, not even through `focus()`/`scrollIntoView()` (`clip` isn't a scroll container, unlike `hidden`); `relative` makes `#root` the containing block for stray absolute elements so they can't escape the clip | `styles/index.css` | committed |
| `html { overscroll-behavior-y: none }`: no vertical chaining out of the iframe, no root bounce; horizontal stays default (trackpad back/forward swipes) | `styles/index.css` | committed |
| Feed and detail roots `relative`; page scrollers (`PageLayout` `<main>`, `Landing` `<main>`) `relative`; `Landing` `<main>` is `h-full` so it scrolls itself | `FeedPanel.tsx`, `detail/EventDetailView.tsx`, `app/PageLayout.tsx`, `onboarding/Landing.tsx` | committed |
| Bottom sheet: `padding-bottom: env(safe-area-inset-bottom)` included in every snap; peek measured from the header's bottom edge (min 148 px); a drag writes the height to the DOM once per animation frame (React commits only at drag start/end); `data-snap` attribute for tests. Handle stays a `<button>` with Enter/Space, `aria-expanded` and the same labels; snap points and the `onHeightChange` contract unchanged | `map/BottomSheet.tsx` | committed |
| CSS hook for the mobile attribution: with `[data-sheet-inset]` the bottom controls move above the sheet on the left; with `="with-report"` the attribution leaves room for the Report button. Inert until MapShell sets the attribute | `styles/index.css` | committed |
| Aside `relative overscroll-contain`; sidebar `w-[clamp(360px,30vw,440px)]`; FAB hidden while a preview is open or the sheet is full; preview hidden while the sheet is full; "Near me" icon-only below 390 px (`aria-label` keeps the name) so the "Zoom in" pill fits; map area sets `data-sheet-inset`/`--sheet-inset`; FAB and preview transition `bottom` with the sheet | `MapShell.tsx` | request 2, applied by the lead in `team/integration` |
| `EventCard` is `memo` with a by-value comparison (`sameEventSummary`): a pan or poll returns new objects for unchanged events. `FeedPanel` renders 50 cards, then a real "Show N more" button with a `role="status"` "Showing X of Y"; focus moves to the first new card; a filter change resets to 50, a pan keeps what the reader expanded. Order, heading count and the truncation notice (still last) are unchanged; the map still shows every event | `events/EventCard.tsx`, `events/FeedPanel.tsx` | committed |
| Schedule fieldset: help text names the reporter's time zone (the fields are local times); after a failed submit focus moves to the first field needing attention (category, then the first `aria-invalid`); `datetime-local` gets `min-width: 0`, and on iOS Safari `appearance: none`, `display: block` and a left-aligned value | `report/ReportPage.tsx`, `styles/index.css` | committed |

## Files changed (committed)

`apps/web/src/styles/index.css`, `apps/web/src/features/map/BottomSheet.tsx`,
`apps/web/src/features/map/BottomSheet.test.tsx` (new),
`apps/web/src/features/events/FeedPanel.tsx`,
`apps/web/src/features/events/detail/EventDetailView.tsx`,
`apps/web/src/app/PageLayout.tsx`, `apps/web/src/features/onboarding/Landing.tsx`,
`apps/web/e2e/layout.spec.ts` (new), this file. Follow-up:
`apps/web/src/features/events/EventCard.tsx`, `FeedPanel.tsx`,
`FeedPanel.test.tsx` (new), `apps/web/e2e/perf/feed.perf.ts` (new),
`apps/web/src/features/report/ReportPage.tsx`, `ReportPage.test.tsx` (new).

`BottomSheet.test.tsx` is a new file in `features/map/` (map-perf's folder); it
tests only `BottomSheet.tsx`, which this workstream owns.

## Technical decisions

- Containment at the source (positioned scroller roots) **and** a global guard
  (`#root` relative + clip). The e2e suite checks both: the document's metrics
  and the overflow of the app's top-level element, which the clip would hide.
- `clip` on `#root`, not `html`/`body`: on the root element `clip` behaves as
  `hidden`, which is still programmatically scrollable.
- No page may rely on document scrolling any more.
- Drag: height (not `transform`) keeps the sheet's layout and the
  `onHeightChange` contract simple; per-frame writes avoid React work. Before,
  each pointermove committed (22 commits for 22 moves, measured with React
  `Profiler`); now at most 1 per drag. The feed list itself wasn't re-rendered
  per frame before either (its element comes from MapShell, so React bailed
  out); the cost was the sheet's own render and commit.
- FAB vs preview: hide the FAB while a preview is open rather than stacking two
  floating cards; the preview has its own primary action, and closing it
  restores Report. Desktop is unaffected.
- Feed: a 50-card first page plus "Show more" rather than virtualization. It
  needs no row-height measurement, behaves the same in the sidebar, the bottom
  sheet and the iframe, keeps every rendered card in the accessibility tree and
  keeps find-in-page working on what's shown.
- Card memo compares props by value (shallow, JSON for the two small nested
  objects). `now` still ticks every 30 s and re-renders the visible cards, now
  at most 50 unless the reader expanded the list.
- Sidebar width `clamp(360px, 30vw, 440px)`: 360 at 1024 (map 664 px instead of
  624), 384 at 1280, 408 at 1360, 440 from about 1467. Event details fit at 360
  (Follow/Share stay on the header row, no sideways scroll).

## Commits

```
2f0a260 Keep the document from scrolling under the desktop map
534514f Bottom sheet: safe area, measured peek, drag without re-renders
03b027f Contain positioned content in page scrollers too
89c8267 Layout handoff: diagnosis, fixes, metrics and MapShell requests
(fast-forward to team/integration 642836a)
04b7ef7 Feed: memoized cards and a 50-card first page
070f0bb Report form: schedule time zone, error focus, date input hardening
```
plus the commit that updates this file.

## Tests actually run (2026-10-17)

Follow-up, at `070f0bb`:

- `npm run check`: pass. Contracts 54; API 665 passed, 13 skipped; web 123
  (incl. 6 new FeedPanel and 2 new ReportPage tests).
- `PW_CHANNEL=chrome npx playwright test`: 55 passed, 19 skipped.
  `npm run test:e2e:service`: 2 passed.
- `feed.perf.ts` before (feed files stashed) at 1x once and 4x twice, after at
  1x twice and 4x twice; numbers below.

Original sprint:

- `npm run check` (root), last run at `03b027f`: pass. Contracts 51 passed; API
  551 passed, 13 skipped; web 95 passed (11 files, incl. 6 new BottomSheet
  tests); typecheck, lint, builds and bundle secret check ok.
- `PW_CHANNEL=chrome npx playwright test` (apps/web) with the original
  MapShell at `03b027f`: 44 passed, 10 skipped (skips are project-specific).
- Same suite with request 2 applied locally (MapShell + `layout-overlays.spec.ts`):
  53 passed, 19 skipped.
- `layout-overlays.spec.ts` against the original MapShell: 7 failed, 2 passed
  (the 375/390 pill checks already passed; 375 had a 2 px gap).
- `layout.spec.ts` against `cc44449` (fix stashed): all 7 then-applicable tests
  failed. With only the first CSS guard, `/report` still failed (doc +94), which
  led to commit `03b027f`; the containment assertion fails with 1263 px without
  the `relative` roots, so the clip doesn't mask it.
- Preview test repeated 3× (`--repeat-each 3`): 3 passed.
- `PW_CHANNEL=chrome npm run test:e2e:service` (cross-site iframe + real
  service): 2 passed at `03b027f`, and 2 passed with request 2 applied.
- Ad hoc (scratch scripts, not tracked): responsive audit of `/welcome`, `/map`,
  `/events/:id`, `/report`, `/following`, `/settings` at 320, 375, 390, 768,
  1024, 1280, 1360 in light and dark: no element spilling off-screen, no
  sideways-scrolling region, document scroll 0 everywhere. Resize
  1280→900→390→1100→1280 and a 390 px mobile iframe: map and canvas fill, doc 0,
  host scrollTop 0.

## Before/after metrics

Desktop (860 px tall):

| Scenario | Before: doc scrollHeight / max scrollTop | After |
| --- | --- | --- |
| Standalone 1360, feed, wheel past end | 2123 / 1263 (map at -1170..-403) | 860 / 0 (map 93..860) |
| Standalone 1360, detail, wheel past end | 916 / 56 | 860 / 0 |
| Iframe 1360, feed | 2123 / 1263 | 860 / 0 |
| Scrollable host page: host scrollTop after wheel | 400 | 0 |
| 1024 and 1280, feed and detail | same failure | 860 / 0 |
| `/report` at 320×740 | doc +94 | 0 |

Mobile (740 px tall unless noted; "after" includes request 2):

| Check | Before | After |
| --- | --- | --- |
| Preview vs Report FAB (375/390/768) | overlap (preview 355..580, FAB 520..576 at 375) | FAB hidden while preview shows |
| Full sheet (375) | preview top -124 (off-screen), FAB 41..97 over the top bar | both hidden |
| "Zoom in" pill at 320 | overlaps Near me (88..232 vs 12..113) | Near me 12..53, no overlap at 320/375/390/768 |
| 34 px safe area (390×760) | "Show ended" bottom 748, inside the inset | 714, sheet 182 px |
| Peek at 20 px root font (360×700) | header bottom 732 vs sheet bottom 700 (clipped) | sheet 180, header bottom 700 |
| Map attribution | 686..730, under the sheet (592..740) | 538..582, above the sheet, clear of the FAB |
| Drag, 22 pointermoves | 22 React commits | ≤ 1 |
| Sidebar width at 1024 / 1280 / 1360 / 1600 | 400 / 400 / 400 / 400 | 360 / 384 / 408 / 440 |

## Feed render cost (500 events, desktop 1360×860, `e2e/perf/feed.perf.ts`)

| Scenario | Before | After |
| --- | --- | --- |
| Hover 8 cards: EventCard renders | 5500 (11 commits × 500) | 16 (2 per hover) |
| Hover 8, 1x: long tasks | 1 (53 ms) | 0 |
| Hover 8, 4x CPU: long tasks | 12–20, 2.4–3.3 s total, longest 232–319 ms | 0 |
| Pan to new events: EventCard renders | 500 | 31 |
| Pan, 1x: long tasks | 2, longest 187 ms, frame gap 140 ms | 0, frame gap 12–18 ms |
| Pan, 4x CPU: longest task / longest frame | 1036–1324 ms / 776–952 ms | 96–102 ms / 97–103 ms |
| Small pan, same events: EventCard renders | 500 | 2 |
| Small pan, 4x CPU: longest task / frame | 266–285 ms / 382–412 ms | none / 36 ms |
| Cards in the DOM | 500 | 50 |

Pan long tasks include MapLibre work, not only React.

## Requests to lead

Requests 1 and 2 were applied by the lead (`team/integration` `642836a`).
The follow-up needs no MapShell change.

1. `<worktrees>/requests/layout-mapshell-1.patch`
   (superseded by 2; kept for reference): aside `relative overscroll-contain`.
2. `<worktrees>/requests/layout-mapshell-2.patch`: apply
   on top of this branch (it relies on the committed `index.css` hooks). It
   changes `MapShell.tsx` and adds `apps/web/e2e/layout-overlays.spec.ts`.
   `git apply --check` passes against `03b027f`.
   - Aside `relative overscroll-contain` (root cause: the scroller should be the
     containing block of its content; scroll stops at the sidebar).
   - Aside `w-[clamp(360px,30vw,440px)]` (L3).
   - `showReport = !isDesktop && !routeEventId && !preview && sheet !== "full"`
     for the FAB; preview rendered only when `isDesktop || sheet !== "full"`
     (L2: preview covered the FAB; both left the screen with a full sheet).
   - "Near me" label `hidden min-[390px]:inline` plus `aria-label` (L2: top
     overlay overlap at 320 px).
   - Map area `data-sheet-inset` (`"with-report"` while the FAB shows) and
     `--sheet-inset: <sheetPx>px` on mobile (L2: the OSM attribution was hidden
     under the sheet).
   - FAB and preview `transition-[bottom] duration-200 ease-out
     motion-reduce:transition-none` so they move with the sheet.
   Verified: full main suite 53 passed / 19 skipped with the patch applied.
3. `evidence.spec.ts` "fits the screen without horizontal scrolling" checks
   `documentElement.scrollWidth - clientWidth`, which the `#root` clip now
   makes always 0. Its bounding-box half still works. Consider measuring the
   overflow of `#root > *` instead, as `layout.spec.ts` does.
4. Map-perf (`MapView.tsx`): the attribution is a `bottom-right` control that
   the CSS moves to the left on mobile. If map-perf adds other bottom-right
   controls, they move too. Making the attribution `bottom-left` in `MapView`
   would let the CSS stop overriding `left`/`right`.

## Remaining risks

- Reports: an unknown outcome can be a duplicate if the user resends without
  checking; the arrival check depends on the event list reflecting the write
  (same database, no cache) and on the client clock being within 10 min of the
  server.
- Round 2: detecting "schedules not supported" relies on the old API's error
  body (`fields._ === "Unexpected field"` for a report that carried a
  schedule). If a proxy or another API version answers differently, the user
  still gets the generic 400 message with every field kept.
- Round 2: the "new API without 0006 → 5xx" cell comes from code reading and
  the lead's earlier rehearsal, not from a run on this branch.

- `overscroll-behavior-y: none` turns off pull-to-refresh when Verity runs as a
  top-level page on mobile. That's intended for a map app, but the user decides.
- The empirical host-scroll check passes with or without the overscroll rule
  once the document can't scroll, so the rule is defense in depth (root bounce,
  other browsers), not proven necessary in Chrome.
- MapLibre shows the compact attribution expanded until the first map
  interaction; at 320 px and on `/events/:id` it can briefly cover the centred
  marker.
- The FAB is hidden while a preview is open. If product wants Report reachable
  from a preview, add it to the preview card.
- Safe-area behavior is verified with Chrome's
  `Emulation.setSafeAreaInsetsOverride`, not on a real iOS device.
- The iOS Safari `datetime-local` rules are standard fixes but unverified on a
  device.
- Past the first 50, events are only on the map until the reader expands the
  list; a marker preview still works, but there's no card to highlight.
- `layout-overlays.spec.ts` finds a marker by tapping a grid over the map, so
  it needs the basemap (skipped with `E2E_OFFLINE=1`).

## Resumption steps

1. `cd <worktrees>/layout-fixes && git log --oneline origin/main..`
2. Feed perf: take the e2e lock, then in `apps/web` run
   `PW_CHANNEL=chrome PERF_LABEL=x PERF_CPU_THROTTLE=4 npx playwright test -c e2e/perf/playwright.perf.config.ts feed.perf.ts`;
   results land in `node_modules/.cache/verity-perf/x-feed.json`.
3. Check a mobile preview and the schedule fields on a real iPhone.
4. Reports (rounds 2–3): on `team/layout-r3`, the compatibility tests are
   `npx vitest run src/report-compat.test.ts` in `packages/contracts` and
   `npx vitest run src/features/report` in `apps/web`.
