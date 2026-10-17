# Layout and UX workstream handoff

| | |
| --- | --- |
| Owner | `layout` |
| Branch | `team/layout-fixes` (worktree `C:\Users\quang\verity-worktrees\layout-fixes`), based on `cc44449` |
| Stage | IN_PROGRESS: L1 fixed and tested; L2–L4 next |
| Last updated | 2026-10-17 |

## Goal

The map always fills its space, the document never scrolls, each region
(sidebar, bottom sheet, page `<main>`) scrolls on its own, standalone and inside
Maypop's cross-site iframe. Then mobile sheet/overlay fixes (L2), a responsive
desktop sidebar (L3) and regression tests for every fix (L4).

## Diagnosis (L1: blank space under the desktop map)

Measured with Playwright + Chrome against the demo production bundle,
standalone (`127.0.0.1`) and in a cross-site iframe (`localhost` host page).

**Root cause:** absolutely positioned descendants of the sidebar escape the
sidebar's scroll container and extend the *document's* scrollable overflow.

- Tailwind `sr-only` is `position: absolute`. Every `EventCard` has
  `<span class="sr-only">Category: </span>`; the detail view has more
  (`EvidenceSection` "Source text: ").
- The sidebar `<aside class="overflow-y-auto">` is not positioned, so those
  spans' containing block is the `relative` row wrapper in `MapShell`, outside
  the scroller. They're laid out at their static position deep in the list (the
  last one at y=2123) but not clipped by the aside, so their overflow propagates
  to the viewport.
- `html`, `body` and `#root` were `overflow: visible`, so the document became
  scrollable: `scrollHeight 2123` vs `clientHeight 860` at 1360×860 on load.
- When the sidebar reaches its end, the wheel chains to the document, which
  scrolls by up to 1263 px: the whole app (top bar, sidebar, map) moves up and
  the page background shows where the map was.
- Inside an iframe the same happens in the frame's document, and if the host
  page is scrollable the scroll then chains into the host too (host `scrollTop`
  0 → 400 in a scrollable host page).

Evidence (1360×860, before):

| Step | `document` scrollHeight / scrollTop | map rect (top..bottom) |
| --- | --- | --- |
| load `/map` | 2123 / 0 | 93..860 |
| wheel the sidebar down | 2123 / **1263** | **-1170..-403** |
| open a detail, wheel down | 916 / **56** | 37..804 |

Proof of cause: setting `position: relative` on the aside in devtools drops the
document `scrollHeight` from 2123 to 860 (feed) and 916 to 860 (detail).

Ruled out: viewport units (none used), `scrollIntoView`/`focus()` (the detail
heading focus already uses `preventScroll`; focusing the last card scrolled only
the aside), map canvas resize (canvas always matched its container), iframe
sizing.

## Fixes

| Fix | Where | Status |
| --- | --- | --- |
| `#root { overflow: clip }`: the document can never scroll, not even via `focus()`/`scrollIntoView()` (`clip` isn't a scroll container, unlike `hidden`) | `src/styles/index.css` | committed |
| `html { overscroll-behavior-y: none }`: no vertical chaining out of the iframe and no root bounce; horizontal left default so trackpad back/forward swipes still work | `src/styles/index.css` | committed |
| Feed and detail roots are `relative`, so their positioned descendants stay inside whichever region scrolls them | `FeedPanel.tsx`, `detail/EventDetailView.tsx` | committed |
| Welcome page scrolled the document (`<main class="min-h-full overflow-y-auto">` never overflowed itself); now `h-full`, so `<main>` scrolls | `onboarding/Landing.tsx` | committed |
| Aside `relative overscroll-contain` (the scroller is the containing block; scroll stops at the sidebar) | `MapShell.tsx` | request 1 |

## Files changed

`apps/web/src/styles/index.css`, `apps/web/src/features/events/FeedPanel.tsx`,
`apps/web/src/features/events/detail/EventDetailView.tsx`,
`apps/web/src/features/onboarding/Landing.tsx`, `apps/web/e2e/layout.spec.ts`
(new), this file.

## Technical decisions

- Fix the containment at the source (positioned roots) **and** keep a global
  guard (`#root` clip), so a future absolutely positioned element anywhere can't
  bring the bug back. The test checks both levels separately (below).
- `overflow: clip` on `#root`, not on `html`/`body`: on the root element `clip`
  is treated as `hidden`, which is still programmatically scrollable.
- No page may rely on document scrolling any more. All current pages scroll in
  their own `<main>` or panel.

## Commits

See `git log origin/main..team/layout-fixes`.

## Tests actually run (2026-10-17)

- `npm run check` (root): pass. Web unit tests 551 passed, 13 skipped; API 89
  passed; contracts 51 passed; typecheck, lint, builds, bundle secret check ok.
- `PW_CHANNEL=chrome npx playwright test` (apps/web): 34 passed, 6 skipped
  (skips are project-specific tests).
- `e2e/layout.spec.ts` on the **old** code (fix stashed): 7 of 7 applicable
  tests failed (document scrollable on desktop map, iframe, 1024/1280, mobile
  map and welcome page).
- `e2e/layout.spec.ts` with the CSS guard but without the `relative` roots:
  fails with "content escaping its scroller (vertical) 1263", so the
  containment assertion isn't masked by the `#root` clip.
- `e2e/layout.spec.ts` with MapShell request 1 applied locally: 7 passed.

## Before/after metrics (desktop, 860 px tall)

| Scenario | Before: doc scrollHeight / max scrollTop | After |
| --- | --- | --- |
| Standalone 1360, feed, wheel past end | 2123 / 1263 | 860 / 0 |
| Standalone 1360, detail, wheel past end | 916 / 56 | 860 / 0 |
| Iframe (fill) 1360, feed | 2123 / 1263 | 860 / 0 |
| Iframe in scrollable host, feed: host scrollTop | 400 | 0 |
| 1024 and 1280, feed and detail | same failure | 860 / 0, map 93..860 |

## Requests to lead

1. `C:\Users\quang\verity-worktrees\requests\layout-mapshell-1.patch`:
   `<aside>` gets `relative overscroll-contain`. Why: the aside is the scroll
   container, so it should be the containing block of its positioned content
   (root cause above); `overscroll-contain` stops scroll chaining at the
   sidebar. Committed code already passes without it; with it applied the
   layout suite passes 7/7.

## Remaining risks

- `#root` clip hides horizontal document overflow too, so the existing
  `evidence.spec.ts` check `documentElement.scrollWidth - clientWidth <= 1` is
  now always true. `layout.spec.ts` measures overflow on the app's top-level
  element instead; the lead may want to switch that assertion likewise.
- `overscroll-behavior-y: none` disables pull-to-refresh when Verity runs as a
  top-level page on mobile. Intended for a map app; a user decision if not.

## Resumption steps

1. `cd C:/Users/quang/verity-worktrees/layout-fixes && git log --oneline origin/main..`
2. Diagnosis scripts are not tracked; `e2e/layout.spec.ts` reproduces the
   measurements.
3. Next: L2 mobile (preview vs FAB, safe area, peek height, drag re-renders,
   top overlay overlap), then L3 sidebar width.
