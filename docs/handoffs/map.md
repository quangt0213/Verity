# Handoff: map performance, landmarks, 3D-ready

Workstream `map-perf`, branch `team/map-performance` (base `origin/main` = `cc44449`).
Git, code and tests win over this file.

## Status

**REVIEW.** M0–M5 are done. Two requests for other owners are open (see
"Requests to lead"). Nothing is pushed, merged or deployed.

**Round 2 (branch `team/map-build-r2`, from PR #7 head `c0264c3`):** release
path and publication hold. Investigation only, so this is a docs-only commit.
See "Round 2: release path and publication hold" at the end.

## Goal

The user's complaints: new places load slowly after a pan or fly-to; parks,
restaurants, buildings and landmarks are hard to see; the map is less
informative than Google Maps or Waze. A 3D mode comes later. The constraints:
MapLibre, no new paid dependency, no tile scraping or caching proxy, and no
broad CSP changes.

## Method

The harness is in `apps/web/e2e/perf/` (`*.perf.ts`, with its own config, so the
pass/fail suites never run it). It builds the production bundle with
`vite build --mode perf` on port 4281. A perf build differs from production in
one way only: it exposes `window.__verityMap` and accepts option overrides. The
code for this checks `import.meta.env.MODE === "perf"`, so other builds drop it.
The Verity service is faked with `page.route`, which serves deterministic
synthetic events (`synthetic-events.ts`, at most 500 per query, as in the
contract) with 150 ms latency. Event API latency is therefore known and kept
separate from basemap latency.

What the harness measures:

- Map marks: `load`, first `idle`, and the time from `movestart` to `moveend`
  to `idle`. "Visually complete" means the next `idle` after a move: every tile
  loaded and every fade finished.
- Network: Playwright request events, which include MapLibre's worker fetches.
- React commits: a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` that counts renders
  of MapShell, MapView, FeedPanel and EventCard in each commit.
- Main thread: long tasks and a CDP CPU profile, grouped by script.
- Slow-network A/B: a FIFO link model that replays tiles held in memory, so
  every variant gets identical data. Profiles: "4G" (150 ms RTT, 9 Mbps) and
  "edge-miss" (700 ms RTT, 20 Mbps).
- Mobile-like CPU: `PERF_CPU_THROTTLE=4`. Mobile viewport: `PERF_DEVICE=mobile`.

The test machine is a Ryzen 9 9900X with Chrome. Desktop numbers flatter phones,
so use the 4x CPU rows for mobile.

OpenFreeMap latency depends on the CDN cache state. An edge miss (the first
request anyone makes for a tile) took 500–950 ms per tile. Once the edge was
warm, the same tile took about 50–300 ms. Tiles are immutable (versioned URL,
`max-age=315360000`), so the browser cache works without help.

## Baseline (before, `cc44449`)

| Metric | Value |
| --- | --- |
| Bundle (uncompressed) | index 609 KB, maplibre 1,023 KB, worker 510 KB |
| JS + CSS downloaded on **every** route (gzip, incl. welcome/settings) | 456 KB JS + 20 KB CSS |
| Cold load, CDN-cold: style / first tile / `load` / first `idle` | 566 ms / 694 ms p50 / 2,186 ms / 2,193 ms (from navigation) |
| Cold load: long tasks | 4, total 535 ms, max 162 ms |
| Warm reload: `load` / `idle` | 417 / 423 ms |
| Pan with new tiles, CDN-cold → warm (time to visually complete) | 1.2–1.7 s → 0.63–0.66 s |
| "Near me" across 600 km (easeTo 700 ms) | 2.3 s cold / 1.75 s warm; **225 tile requests, 219 cancelled** |
| Theme switch | full style reload (not measured before; see after) |
| React, 500 events in view, per data change | 1 commit renders MapView + FeedPanel + **500 EventCards** (~3,500 function renders) |
| useNow 30 s tick | 1 commit, 500 EventCards, MapView |
| Hovering 8 feed cards | 11 commits, 5,500 EventCard renders, MapView 11× |
| Main thread after a pan | 100–490 ms long tasks, frame gaps up to 270 ms; profile: React DOM churn + layout of the 500-card feed, not MapLibre |
| `setData` + clustering, 500 / 2,000 points | sync ~0 ms, worker done in 5–19 ms; queryRenderedFeatures diagnostic 0.4–0.9 ms |
| Worker count 1 / 2 / 4 | no measurable difference (warm load 230 ± 20 ms, all moves within noise) |

Style findings: OpenFreeMap **Positron and Dark have no POI layers at all**.
Positron's parks and buildings are nearly the same grey as the background.
Dark is almost black on black.

## After (this branch)

| Metric | Before | After |
| --- | --- | --- |
| Welcome/settings/following JS + CSS (gzip) | 456 + 20 KB | **174 + 10 KB** |
| Welcome content, cold, simulated 4G | 2.0 s | **0.97 s** |
| Map first idle, cold, simulated 4G | 3.72 s | 3.87 s (+150 ms: map chunk now loads after index) |
| Warm reload `load` / `idle` | 417 / 423 ms | 404 / 421 ms |
| Far programmatic move (4G sim): LA / Oakland / Mission | 2.48 / 2.73 / 3.61 s | **1.91 / 2.19 / 2.13 s** |
| Same, edge-miss sim | 2.49 / 2.39 / 2.59 s | **1.62 / 1.89 / 1.89 s** |
| Tile requests for "Near me" to LA | 225–240 (≈97% cancelled) | **6** |
| Animated flyTo (1.2 s) for comparison, 4G sim | n/a | 3.3–5.7 s (worst; not used) |
| Detail layer cost, cached tiles, desktop | n/a | MapLibre CPU +12–22%, time to idle +4–15 ms |
| Detail layer cost, 4x CPU | n/a | warm load +60–80 ms, fly-to idle +60–180 ms |
| MapView renders on clock tick | 1 | **0** (memo) |
| Feed renders per pan, with MapShell request #1 | 2 | **1**; pan long tasks 120→75 ms, "Near me" 395→0 ms |
| Theme switch | — | 0.8 s to idle; 6 tiles re-read from the HTTP cache |

The pan-with-new-tiles numbers are unchanged, because they're network-bound.
The remaining main-thread stall after a pan is the 500-card feed (see Requests).

## Style comparison

All candidates were measured with the same viewpoints (SF z12, Golden Gate Park
z14, Union Square z15, Mission z16.5) and the same harness (`styles.perf.ts`).

| Style | Parks | Buildings | POIs / restaurants | Roads / names | Dark variant | Style load | Origins | Cost / licence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OFM Positron (old light) | barely visible | barely visible | **none** | grey hierarchy, names OK | Dark | 100 ms | tiles.openfreemap.org | free, no key; © OpenMapTiles, © OSM |
| OFM Dark (old dark) | none | near black | **none** | very low contrast | — | 280 ms | same | same |
| OFM Liberty | green | 3D extrusions | z15+ by rank, bus stops dominate | colourful | **none** | 620 ms | same | same |
| OFM Bright | green | yes | as Liberty | colourful | none | 670 ms | same | same |
| OFM Fiord | some | dim | none | low contrast | (is dark) | 1,280 ms | same | same |
| VersaTiles Colorful / Colorful-dark | green | yes | many, small | good | **yes** | 790 ms, 156 KB style JSON | tiles.versatiles.org (CSP change) | free, no SLA; tiles `max-age=6h`, unversioned |
| **Positron/Dark + Verity detail (chosen)** | green | clear footprints | landmarks z13+, food z15+, shops z16+, stops z17+ | major roads tinted; dark labels readable | **tuned dark** | 100–145 ms | tiles.openfreemap.org only | same as OFM |

Every OpenFreeMap style shares the same tiles, so tile bytes are identical
across them. Protomaps, MapTiler, Stadia and Carto need keys or commercial
licences, so they were excluded.

**Choice:** keep OpenFreeMap Positron/Dark and add Verity's detail layer
(`basemap-detail.ts`, applied through MapLibre `transformStyle`). The reasons:

- One provider and one CSP origin, the best cache headers, and no extra requests
  (it uses the same tiles, glyphs and fonts).
- The light and dark themes are consistent.
- Event markers stay dominant: POI icons are 18 px, muted, have no shadow, and
  never use the status colours. The markers now also reserve label space.
- No dependency on provider sprites: POI icons are lucide glyphs drawn locally.

The detail layer applies to any OpenMapTiles-schema style and leaves other
schemas unchanged. `VITE_MAP_DETAIL=off` disables it.

## Files changed

- `apps/web/src/features/map/basemap-detail.ts` (new): detail layer, POI
  rules, dark tuning, `setBasemap`, `setBuildings3d`.
- `apps/web/src/features/map/camera.ts` (new): `moveCamera`, which jumps when
  the target is more than 1.5 viewports away and eases otherwise.
- `MapView.tsx`: the style is set after construction (with a transform); camera
  config; shared image resolver; `setData` is skipped when the event signature
  is unchanged; `memo` that ignores `initialView`; perf seams.
- `map-layers.ts`: `eventsSignature`; event symbols reserve collision space;
  `LAYER_OVERLAY_ANCHOR`.
- `marker-images.ts`: `createPoiImage`, `vp:` ids, `resolveVerityImage`.
- `maplibre-setup.ts`: perf-only worker-count override.
- `shell-context.ts`: `list.isFetching` is now optional. No outlet reads it.
- `report/LocationPicker.tsx`: same basemap, detail layer and theme.
- `app/router.tsx`: MapShell and ReportPage are lazy routes, with a
  `hydrateFallbackElement`.
- `config/defaults.ts`, `config/env.ts`: `MapCameraConfig`/`DEFAULT_CAMERA`,
  `map.detail` (`VITE_MAP_DETAIL`).
- `build/plugins.ts`, `vite.config.ts`: `mapPreconnectPlugin`.
- Tests: `map-detail.test.ts` (style-spec validation of the transformed style,
  POI tables, layer order, signature, moveCamera), `env.test.ts`,
  `plugins.test.ts`.
- `apps/web/e2e/perf/**` (new): harness, `map-baseline`, `experiments`, `fly`,
  `styles`, `startup`, `preconnect`, `poi-census`.

## Technical decisions

- **Far targets jump.** Easing 600 km at z14 requested about 240 tiles and
  cancelled 97% of them, and finished 0.5–1.5 s later than a jump (4G and
  edge-miss simulations). An animated flyTo was worse still. Near targets keep
  the 700 ms ease. MapLibre honours reduced motion.
- **Worker count, fadeDuration, tile cache size:** unchanged. Measurement showed
  no benefit: revisits hit the cache with 0 requests, and worker counts of 1, 2
  and 4 were within noise.
- **Diagnostic `idle` handler:** kept as it is. It measured 0.4–0.9 ms per idle
  with up to 2,000 points, which isn't worth a test-only build flag. The e2e
  suites still depend on `data-visible-markers`.
- **Theme switch:** kept `setStyle(..., { diff: false })`. It measured 0.8 s,
  and tiles came from the HTTP cache. A diff would have to carry Verity's
  sources and layers through `transformStyle`. Revisit if theme changes become
  frequent (auto night mode).
- **Lazy routes:** a −1.0 s cold welcome on 4G against +150 ms on a cold map
  load. A warm cache has no penalty because the hashed chunks are cached.
- **Preconnect:** its benefit couldn't be measured here (fast network, and
  Chrome reused connections between contexts). It's kept as a zero-risk hint
  that saves one TLS handshake on a cold mobile start. It's easy to drop if the
  lead prefers measured-only changes.
- **POI visibility** is decided by class and zoom, not OpenMapTiles `rank`.
  Rank is per grid cell and favours bus stops and clinics over restaurants (see
  `poi-census.perf.ts`). POIs sit below road and place labels, so street names
  win collisions.
- **`useDeferredValue` for the feed** was tried and rejected: it added a commit
  and didn't reduce long tasks, because the cost is in the DOM commit and
  layout.

## CSP changes

None. The default style origin `https://tiles.openfreemap.org` was already in
`connect-src`. The detail layer adds no origins. The preconnect hint isn't
subject to CSP. The bundle secret scan passes.

## Commits

- `3a691e6` Map performance harness (e2e/perf)
- `fe15d5b` Map: detail layer, far-target jumps, fewer marker updates, 3D seam
- `771370f` Lazy-load the map and report routes; preconnect to the basemap host
- (this commit) Harness extras, optional `isFetching`, this handoff

## Tests run (2026-10-17)

- `npm run check` (root): passed (web 108 tests, api 551 passed / 13 skipped,
  contracts 51; typecheck, lint, builds, secret scan).
- `PW_CHANNEL=chrome npm run test:e2e`: 27 passed, 1 skipped (desktop-only skip
  of the mobile sheet test).
- `PW_CHANNEL=chrome npm run test:e2e:service`: 2 passed (cross-site iframe).
- The perf suites were run as described above. They're measurements, not
  pass/fail.

## Requests to lead

1. **MapShell context memo**
   (`<worktrees>/requests/map-perf-mapshell-1-integration.patch`).
   - Written against the integrated MapShell on `team/integration`; it applies
     cleanly with `patch -p1`. The older `map-perf-mapshell-1.patch` targets
     `cc44449`.
   - Depends on this branch's `shell-context.ts`, where `list.isFetching` is
     optional.
   - What: build `ShellContext` with `useMemo`, and stop passing
     `list.isFetching`. No outlet reads it, and every fetch start re-rendered
     the whole feed.
   - Measured, 500 events, desktop:
     - feed renders per pan go from 2 to 1;
     - EventCard renders on a small pan go from 1,000 to 500;
     - pan-east long tasks go from 120 to 75 ms;
     - "Near me" long tasks go from 395 to 0 ms, and its time to idle from
       1,313 to 977 ms;
     - zoom-out long tasks go from 76 to 0 ms.
   - Tests: typecheck and lint passed with the patch applied. Run the e2e suites
     after applying it.
2. **For `layout` (FeedPanel/EventCard), via the lead.** The biggest remaining
   main-thread cost is rendering all 500 cards on every data change: 190–490 ms
   long tasks after pans, and at 4x CPU, 240–555 ms with 250 ms+ frame freezes.
   Suggestions: render the first ~50 cards with "Show more" (or virtualize), and
   `memo(EventCard)`, so that hovering re-renders 2 cards instead of 500.
3. **Optional, for product.** A padded or snapped query bbox would make small
   pans fetch nothing. It risks hiding events that are in view when the
   500-event cap truncates the response, so it needs a decision before anyone
   builds it.

## Compatibility with integrated layout work

- The AttributionControl stays at `"bottom-right"`, so the layout CSS that lifts
  `.maplibregl-ctrl-bottom-right` above the sheet (`[data-sheet-inset]`,
  `--sheet-inset`) still applies. No request to move it.
- `data-visible-markers` on `[data-map-status]` is set in every build (the
  diagnostic isn't gated), so `e2e/layout-overlays.spec.ts` keeps working. Event
  markers now reserve label space but still always draw (`icon-allow-overlap`),
  so tapping a marker works as before.

## Remaining risks

- The detail layer uses OpenMapTiles class names. A provider using another
  schema gets its own style unchanged, which is safe but has no detail.
- OSM data quality varies, so POI density and names differ between cities.
  The rank thresholds were tuned in San Francisco only.
- Dense downtowns at z14–15 cost about 15% more MapLibre CPU. Low-end phones
  weren't tested on real hardware (4x throttle only).
- OpenFreeMap is free with no SLA. An edge miss costs about 0.5–1 s per new
  area. It can be swapped with `VITE_MAP_STYLE_URL_*` (the detail layer works
  with any OpenMapTiles host).
- After a deploy, a lazy chunk can 404 for a tab that's still open. RouteError
  then shows "Reload the map".

## 3D / navigation groundwork

- `DEFAULT_CAMERA` (`config/defaults.ts`): pitch 0, bearing 0,
  `allowRotateAndPitch: false`, `buildings3d: false`. MapView sets
  `maxPitch: 0` and disables rotate gestures unless the 3D flag is enabled.
- `LAYER_BUILDINGS_3D`: a hidden fill-extrusion layer (z15+,
  `render_height`). Toggle it with `setBuildings3d(map, true)` or the camera
  config.
- `LAYER_OVERLAY_ANCHOR`: add a route line with
  `map.addLayer(route, LAYER_OVERLAY_ANCHOR)`. It then sits above the basemap
  and below the event markers.

Plan for a 3D mode:

1. Make the camera config user-selectable.
2. Enable pitch up to 60° and show the compass.
3. Turn on `buildings3d`.
4. Use `moveCamera` with bearing for navigation follow mode.
5. Measure fill-extrusion cost at 4x CPU before shipping.

## Exact resumption steps

1. `cd <worktrees>/map-performance && git log --oneline -5`.
2. To re-measure (port 4281), from `apps/web`, run
   `PW_CHANNEL=chrome PERF_LABEL=x npx playwright test -c e2e/perf/playwright.perf.config.ts e2e/perf/map-baseline.perf.ts`.
   Results go to `apps/web/node_modules/.cache/verity-perf/`. For A/B runs use
   `-g variant` with `PERF_VARIANT='{"mapOptions":{"detail":false}}'` and
   optionally `PERF_CPU_THROTTLE=4`. For styles use `-g "style "` with
   `PERF_STYLES`, `PERF_SHOTS_DIR` and `PERF_DEVICE=mobile`.
3. Once the lead applies request 1, re-run `-g "overhead|pans"` and compare it
   with the "after" row above.

## Round 2: release path and publication hold (2026-10-17)

The question: merging PR #7 to `main` deploys the new API and worker and may
also rebuild Maypop. How do we keep the new frontend unpublished until the new
API is serving? Every check below was local or a read-only `gh api` GET. Nothing
was pushed, and no Railway, Maypop or GitHub setting was changed.

### Why it matters: the hazard is narrow

- Between `cc44449` and `c0264c3`, the only contract change the frontend relies
  on is `reportEventInputSchema`. It gains optional `scheduled_start_at` and
  `scheduled_end_at`, accepted only for planned categories. Response schemas are
  unchanged, and `apps/web/src/api/http-client.ts` is unchanged.
- New frontend with the old API: browsing, detail, sign-in and reports without
  a schedule all work. A planned-event report **with** a schedule is rejected,
  because the old API's strict schema returns 400. The error is visible, and
  nothing is lost silently.
- The window lasts from the Maypop publish until the new API is healthy. If the
  Railway deploy fails, the window lasts until it is fixed. `ea7058e` and
  `053eade` both ended in `failure` for the API service.

### Evidence

| # | Fact | Source | Status |
| --- | --- | --- | --- |
| 1 | No Railway config-as-code exists: no `railway.json`, `railway.toml`, nixpacks or Procfile. No `.github/workflows` either (`actions/workflows` total_count 0). | `git ls-files`; `gh api .../actions/workflows` | Verified |
| 2 | The only Dockerfile is `apps/api/Dockerfile`, not at the repository root. It builds from the root and its `CMD` is `node dist/server.js` (the API only). | `apps/api/Dockerfile` | Verified |
| 3 | The worker has no `CMD`. The repository defines it only as `start:worker` = `node dist/worker.js` (`apps/api/package.json`). The README says "same image as the API, different command". The worker service's actual start command, Dockerfile path and root directory are Railway service settings. | `apps/api/package.json`, README "Verification worker" | Repo: verified. Railway settings: **operator-confirm** |
| 4 | Railway created GitHub deployments only for `main` merge commits `ea7058e`, `053eade` and `cc44449`, all to the environment `Verity / production`, created by `railway-app[bot]`. PR branch heads (`877f211`, `1c9ecd9`, `06fd9a0`, `7e98183`) have no statuses. | `gh api .../deployments`, `.../commits/<sha>/status` | Verified |
| 5 | Two Railway services report commit statuses on `main`: `Verity - verity-api` (on all three merges; `failure` on `ea7058e` and `053eade`) and `Verity - verity-worker` (first on `cc44449`, `success`). So a merge to `main` deploys both. The `cc44449` deployment record was updated again on 10-13 and 10-17, which looks like redeploys of the same commit. | `.../commits/<sha>/status`, `.../deployments/<id>/statuses` | Verified (that both services deploy from `main`) |
| 6 | Railway watch paths and "wait for CI" settings are not visible. It's unknown whether a docs-only or frontend-only merge also redeploys the API and worker. History is consistent with "every `main` merge". | none in repo | **Operator-confirm** |
| 7 | `main` has no branch protection; there are no environment protection rules and no auto-merge. PR #7 is an open draft with base `main` and mergeable state `clean`. | `.../branches/main/protection` (404), `.../environments`, `.../pulls/7` | Verified |
| 8 | Maypop leaves **no trace in GitHub**: no repository webhooks (`/hooks` returns `[]`), no deployments, no commit statuses and no check runs on any `main` commit. If it imports through a GitHub App, that installation isn't visible to the repository API. | `gh api .../hooks`, statuses and check runs | Verified (absence) |
| 9 | `maypop.toml` declares only `[app]` metadata and `[build]` (`framework = "vite"`, `command = ["npm","run","build:web"]`, `output = "apps/web/dist"`, `entry = "index.html"`). It has no branch, publish, auto-deploy or base-path key. None is documented in the SDK README, `docs/MAYPOP.md` or `maypop.ai/llms.txt`. Whether the GitHub importer reads `maypop.toml` at all is unverified (`docs/MAYPOP.md`). | `maypop.toml`, SDK README, llms.txt | Verified (repo); importer behaviour **operator-confirm** |
| 10 | Whether Maypop auto-rebuilds or auto-publishes on push to `main`, and from which branch, is a Maypop project setting. | none | **Operator-confirm** |
| 11 | `VITE_VERITY_DATA_SOURCE` and `VITE_VERITY_API_URL` are baked in at build time and also feed the CSP's `connect-src`. No `.env.production` is committed. A production build without them shows "not connected" and never demo data (`config/env.ts`, `env.test.ts`). **Every Maypop rebuild therefore depends on those build variables still being set in Maypop.** | `apps/web/src/config/env.ts`, `git ls-files` | Repo: verified. Maypop build variables: **operator-confirm** |
| 12 | The deployed frontend (`apps/web` exactly as at `cc44449`) builds and tests green against PR #7's contracts and API. Trial: `apps/web` restored to `cc44449` (added files removed) on top of `c0264c3`; root `npm run check` exit 0 (contracts 54, api 665 passed / 13 skipped, web 89). The trial was reverted afterwards. | local trial | Verified |
| 13 | The production build's chunk and asset URLs are all relative to `import.meta.url` (`base: "./"`). In 9 files there are 18 hashed references, all resolving to files in `dist`, and no absolute `/assets/` path. The MapLibre worker is loaded through `new URL("maplibre-worker-....js", import.meta.url)`, which is same-origin. | `npm run build -w @verity/web` plus a reference scan | Verified |
| 14 | The CSP is the `<meta>` in `index.html`, not in `maypop.toml`. With an API URL set: `script-src 'self' https://*.maypop.ai`, `worker-src 'self' blob:`, `connect-src 'self' https://*.maypop.ai <api origin> https://tiles.openfreemap.org`. These cover lazy chunks, the worker, tiles, glyphs and sprites, and the API. No chunk uses `WebAssembly`. MapLibre's worker `eval` path is `importScriptInWorkers`, which Verity never calls. | `dist/index.html`, grep of `dist/assets` | Verified |
| 15 | A `<meta>` CSP doesn't govern dedicated workers: a worker uses its own response's CSP header. If Maypop's host sends a CSP header on `.js` files that restricts `connect-src`, the worker's tile fetches could be blocked. Neither vite preview nor the e2e host sends one. | platform behaviour; `docs/MAYPOP.md` (host CSP undocumented) | **Operator-confirm** on the first publish (release step 6.2) |

### Hold mechanisms evaluated

| Option | How | Verified? | Risks |
| --- | --- | --- | --- |
| (a) Operator holds Maypop publication | Disable auto-publish or rebuild (or don't import) before the merge. Publish after step 4 of the deployment order. | **No.** It's unknown whether the setting exists or how it behaves (facts 8–10). | Depends on an invisible setting. If Maypop never auto-publishes, no hold is needed. If it does and the setting is missed, the hazard window opens. |
| (b) `maypop.toml` points at a release branch | Add a branch key. | **No.** No such key is documented, and the importer may not read `maypop.toml` at all. | An unknown key may be ignored or may break the import. **Not recommended.** |
| (c) Two-PR split | PR A: PR #7 with `apps/web` exactly as at `cc44449` (contracts, API, worker, migration, docs). PR B: the frontend (`apps/web` from `c0264c3`), merged after the new API is verified. | **Yes.** Fact 12: PR A's tree passes `npm run check`, and its frontend equals the live one, so a Maypop rebuild after PR A only republishes today's frontend. | It's process overhead. PR B's merge also triggers Railway (same API code; worker restarts, which leases make safe), unless watch paths say otherwise (fact 6). Every rebuild still depends on Maypop's build variables (fact 11). |
| (d) Frontend feature-detects schedule support | The new API reports a capability (for example `features: ["report_schedule"]` on `/api/v1/health`). The report form shows schedule fields only when it's present. | Not implemented. It would touch verifier-owned `routes/public.ts`, `ReportPage.tsx` and the http client. | It is safe in any deploy order **and on rollback** (an API rolled back to `cc44449` hides the fields automatically). The cost is a code change in another owner's files plus tests. Proposal only. |

**Recommendation:**

1. Use **(c), the two-PR split.** It is the only hold that can be verified from
   the repository, and it needs no code change.
2. Have the operator also do the read-only checks (a), 6, 10, 11 and 15 before
   merging PR A.
3. Treat (d) as optional hardening for a later release; it also makes rollback
   of the API alone safe.

**If PR #7 is merged as one PR:** that's a **RELEASE BLOCKER** until the
operator confirms (with evidence) how Maypop publishes after a push to `main`,
and holds publication.

### Suggested runbook text for WORKSTREAM_STATUS (lead-owned)

> **Release path (verified 2026-10-17):**
> - Railway deploys **both** `verity-api` and `verity-worker` on every merge to
>   `main`. PR branches never deploy. There is no config-as-code: the worker's
>   start command (`node dist/worker.js`, i.e. `npm run start:worker -w @verity/api`)
>   and the Dockerfile path are Railway service settings.
> - Maypop leaves no trace in GitHub. Whether and when it rebuilds is unknown
>   until the operator confirms it.
>
> **Hold:** split PR #7 into
> - **PR A:** backend, contracts, migration and docs, with `apps/web` unchanged
>   from `cc44449`;
> - **PR B:** the frontend.
>
> **Order:**
> 1. Apply 0006.
> 2. Merge PR A. Railway deploys the API and worker; any Maypop rebuild
>    republishes the current frontend.
> 3. Verify the API and worker (steps 4–5).
> 4. Merge PR B. Maypop publishes the new frontend.
> 5. Verify Maypop (step 6), including the lazy map chunk and tile loads from
>    the worker under Maypop's own response headers.
>
> **Before step 2 (operator, read-only):**
> - Maypop's auto-publish or rebuild setting and its branch.
> - Maypop's build variables `VITE_VERITY_DATA_SOURCE` and `VITE_VERITY_API_URL`
>   are present. Names only: a rebuild without them shows "not connected".
> - Railway watch paths.
> - `MIGRATE_ON_START` is not `true`.
> - The Nimble budgets are `0`.

### Tests

Run:

- `npm run build -w @verity/web`, with an example API URL, plus the dist
  reference and CSP scan: passed.
- The split trial: root `npm run check`, exit 0.

Not run:

- The service e2e suite and the San Jose acceptance. Neither the build nor the
  release changed.
- Nothing on Railway or Maypop.

### Remaining risks

- Facts 3, 6, 10, 11 and 15 can only be checked by the operator.
- A Maypop rebuild without its `VITE_*` build variables silently becomes "not
  connected". This can happen with any merge to `main`, including PR A.
- Railway API deploys failed on 2 of 3 merges historically. Keep the rollback
  (redeploy `cc44449`) ready.
- Open tabs from an older build can 404 on lazy chunks after a publish;
  `RouteError` offers a reload.
