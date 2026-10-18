# Handoff: map performance, landmarks, 3D-ready

Workstream `map-perf`, branch `team/map-performance` (base `origin/main` = `cc44449`).
Git, code and tests win over this file.

## Status

**REVIEW.** M0–M5 are done. Two requests for other owners are open (see
"Requests to lead"). Nothing is pushed, merged or deployed.

**Round 2 (branch `team/map-build-r2`, from PR #7 head `c0264c3`):** release
path and publication hold. Investigation only, so this is a docs-only commit.
See "Round 2: release path and publication hold" at the end.

**Round 3 (branch `team/map-build-r3`, from `be0e16b`, with `team/verification-r3`
`b0502e3` merged):** corrections to `docs/RELEASE_RUNBOOK.md`. Docs only. See
"Round 3: runbook corrections" at the end.

**Round 4 (branch `team/map-build-r4`, from `d63c448`):** provenance of the
published Maypop v2 frontend, and rollback options. Read-only evidence, docs
only. See "Round 4: Maypop v2 provenance and rollback" at the end.

**Round 5 (branch `team/map-build-r5`, from `1534ae2`):** the secure local
backup destination and evidence template for the production `pg_dump` (outside
Git), plus frontend recovery wording. See "Round 5" at the end.

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

## Round 3: runbook corrections (2026-10-18)

Branch `team/map-build-r3`, from `be0e16b`, with the verifier's
`team/verification-r3` (`b0502e3`, migrator outcome classes) merged by fast
forward. Only `docs/RELEASE_RUNBOOK.md` and this file changed. Nothing was
pushed, and no hosting, Railway, Maypop or GitHub setting changed.

### Runbook changes

- **Approvals.** A new "Approvals" section near the top:
  - one distinct phrase per gate, "Approve gate N: …", plus phrases for
    rollback, restore and emergency reversal;
  - a bare "go ahead" or "merge" approves nothing;
  - approving one gate never implies the next;
  - preparing, reviewing, marking ready or approving the draft PRs grants no
    production authorization;
  - retries are covered only where gate 2's outcome table says so.

  Each gate's **Approval:** line now uses its phrase. Gate 3 has its own phrase
  (it used to be "part of gate 2"). Gates 4 and 6 name the PR head SHA, and the
  approval lapses if the head changes. Gate 1 stays read-only, and changing a
  setting needs its own approval. Rollback actions need a rollback approval.
- **PR A / PR B hold kept.** After PR A merges, PR B must be reconciled with
  the current `main` (merged or rebased) and re-checked before gate 6 is
  requested: `git diff --name-only origin/main...<PR B head>` may list only
  `apps/web/**`. Stop otherwise.
- **Backups (gate 2, item 1).** Inventory validation (`pg_restore --list`
  proves the file is readable, not restorable) is now separate from restore
  validation:
  - a full restore into a throwaway database;
  - all 15 tables present;
  - key-table row counts equal production's read-only counts;
  - the migration history is 6 rows with the expected hashes.

  Restore validation is required for approval unless the approver explicitly
  accepts inventory-only and the risk is recorded. The evidence list: dump
  timestamps, tool and server versions, size, SHA-256, storage location
  (outside the repo and OneDrive), the list result, the restore result and the
  counts. Never dump contents or connection strings.
- **Timeouts (gate 2, item 6).** The statement timeout bounds each statement,
  not the whole run. An effective-timeout mismatch is a **failed safety
  check** with nothing applied. A transaction-mode pooler is one possible
  cause, so the connection must be confirmed. This replaces "means the wrong
  kind of connection".
- **Migrator outcomes (new "If the migrator doesn't finish cleanly").** The
  exact messages from `b0502e3`, grouped in three classes:
  - configuration refusal, nothing attempted (exit 2: configuration, target
    guard or timeout safety check; exit 3: not attempted, connect, auth or TLS);
  - confirmed server-side failure, rolled back (exit 4);
  - uncertain outcome (exit 5).

  It also notes that old checks for exit `1` must change, and never to retry
  automatically.
- **Uncertain outcome procedure:**
  1. Don't retry.
  2. Confirm the previous migration session has ended. The primary check is
     `pg_stat_activity` with `application_name = 'verity-migrate'` (the
     verifier's `55377f0`, merged as `e59cf86`; logged as `Migration session
     application_name=verity-migrate`). The fallback, for when a pooler
     doesn't pass the name through, is the query-text, open-transaction and
     strong-lock query. `pg_terminate_backend` needs its own approval.
  3. Inspect the history count, newest `created_at` and hash, and
     `to_regclass('public.report_schedules')`.
  4. Decide with the approver:
     - 6 rows and no table: retry under the same approval;
     - 7 rows (with the table): go to gate 3;
     - anything else: stop.
- **Gate 3 recovery** now follows the outcome class instead of assuming a
  rollback.

### Tests

None run; the change is docs only. The merged migrator code is the
verifier's, already tested on `team/verification-r3`.

## Round 4: Maypop v2 provenance and rollback (2026-10-18)

Read-only round. Nothing was published, built on Maypop, logged in, pushed or
changed.

- The published v2 files were downloaded with the user's approval (lead,
  09:04:55 UTC) and treated as data. Nothing in them was executed; the analysis
  scripts only read them.
- `cc44449` was rebuilt in a throwaway worktree, which was then deleted:
  `npm ci`, then `npm run build:web` with only `VITE_VERITY_DATA_SOURCE=api`
  and `VITE_VERITY_API_URL=<the published origin>`.
- The API origin isn't recorded in this file.

Labels: **VERIFIED** = observed directly; **INFERRED** = follows from the
evidence but isn't proven; **UNVERIFIED** = needs the Maypop UI or an
authenticated tool.

### 1. Artifact identity

| # | Finding | Status |
| --- | --- | --- |
| 1 | The 8 downloaded files match the lead's sizes and SHA-256 prefixes. | VERIFIED |
| 2 | 5 of 8 files are byte-identical to the local `cc44449` build: `theme-init.js`, `favicon.svg`, `maplibre-e7niSQfE.js`, `maplibre-worker-DRFeyNJw.js`, `maplibre-B8-mEBLf.css`. So the dependency versions are the lockfile's (a no-lockfile build changes all three MapLibre files). | VERIFIED |
| 3 | `index.html` is Verity's template **rewritten by Maypop**, with these additions: an inline `<style>` (`overscroll-behavior: none`) and two inline scripts (activity ping, ambient palette for the host) placed **before** Verity's CSP `<meta>`; `?v=<uuid>` on every asset URL; and a `modulepreload` for the MapLibre chunk. Apart from those and the two hashed names, the file equals the local build. Because the inline scripts precede the CSP meta, the policy doesn't apply to them (meta CSP covers only later content). | VERIFIED (contents); INFERRED (CSP ordering effect) |
| 4 | `index-DlJ20-aH.css` vs local `index-iIGF2htJ.css`: 552 vs 547 rules. **5 extra utilities** (`.invisible`, `.contents`, `.table`, `.lowercase`, `.transition`) and different last digits in the generated `lab()` colour fallbacks. Nothing removed. Tailwind generates classes from words in scanned files, so v2 scanned extra content. A build with the working directory at the repository root does not reproduce it (tested). | VERIFIED (diff); INFERRED (cause: extra files in the Maypop workspace, possibly leftovers from the iteration-1 scaffold, which a lead check couldn't list; plus Maypop's pnpm/Linux toolchain) |
| 5 | `index-vxnSeROL.js` vs local `index-CQrri2b3.js`: same embedded library versions (zod 4.6.5, React 19.3.0). Same baked environment keys (`BASE_URL, DEV, MODE, PROD, SSR, VITE_VERITY_API_URL, VITE_VERITY_DATA_SOURCE`), mode `production`. The API URL is identical to the origin used locally. Exactly **one new literal string**, from an extra branch in the config resolver: `"API mode requires a Verity service URL; demo data is disabled."` (data source `api` without a URL shows "not connected"). Every other string difference is minifier renaming. The Maypop SDK lazy chunk is referenced as `./dist-Bnt1kR_e.js`; locally it is `./dist--uvTvYID.js`. | VERIFIED |
| 6 | That string exists in **no Git object of this repository**: all branches and remotes, reflogs, stashes, and unreachable blobs were searched. | VERIFIED |
| 7 | **v2's source family is Maypop's editor workspace (iteration 3, "The approved synchronization", Oct 12).** It is `cc44449`'s `apps/web` (71 of 73 `src` files, plus `index.html` and `public`, SHA-256-identical) with **2 files changed**: `src/config/env.ts`, which adds a branch in `resolveConfig`, `else if (explicit === "api") { dataSource = { kind: "unconfigured", reason: "API mode requires a Verity service URL; demo data is disabled." } }`, between the API-URL branch and the dev-mock fallback; and `src/config/env.test.ts`. No round-1+ files exist there. The workspace was built on Maypop with pnpm (vite 8.3.2 under `node_modules/.pnpm`), not on this machine. See section 6. *Corrects the earlier INFERRED "uncommitted local edit".* | VERIFIED (workspace content, lead 09:07–09:12 UTC); INFERRED (that v2 was built from exactly this iteration) |
| 8 | User's OneDrive checkout (read-only: `git status`, ignored names, file names and mtimes): branch `fix/api-dockerfile` at `877f211`, clean. No dist contains `index-vxnSeROL.js`. `apps/web/dist` (2026-10-10 12:01 -07:00) has `index-BDZKbHtc.js` and `index-iIGF2htJ.css`, a no-environment build; `dist-e2e` and `dist-e2e-service` date from 2026-10-04. Its only Git remote is `origin` (github.com); there is no Maypop remote. Its `.maypop/` holds dev-server state only (`local/config.json`, `drive/`, `.lock`). | VERIFIED |
| 9 | The second repo copy under Documents (a review clone, path from the verifier; it is nested deeper than my first searches reached). Read-only `git` and file names only: detached `HEAD` at **`c0264c3`** (PR #7 head, committed 2026-10-17 20:30 -07:00), clean. The only ignored entries are `node_modules`. Its only remote is `origin` (github.com). It has **no `apps/web/dist*` folders** and no `index-vxnSeROL.js`. It is a review copy of PR #7, unrelated to v2. | VERIFIED |

### 2. Publication method and rebuild triggers

- **Maypop CLI 0.5.1 help** (no auth). VERIFIED that the help says:
  - `init`: "Create an app and configure its Git remote and framework adapter";
  - `publish`: "Build the app and publish it with the current Git HEAD" (option `--changelog`: "release note for this version");
  - `reference import`: "Import the released source under `.maypop/local/references`";
  - `app apply`: "Apply the [app] table from maypop.toml";
  - `status` here reports "Authenticated: no".

  INFERRED from that wording: Maypop keeps a Git remote per app and publishes numbered versions with their source, so v2's source may be retrievable from Maypop. UNVERIFIED: whether it is retrievable, and by whom.
- **SDK README** (VERIFIED): `.maypop/kv-policy.json` is "applied with each published version"; "`maypop init` records the matching build adapter in `maypop.toml`, and `maypop publish` builds and uploads its static output".
- **Public docs** (VERIFIED, 2026-10-18; `maypop.ai/llms.txt`, `/`, `/landing/challenge/`, `sitemap.xml`): they say only "It's live the moment you make it. No servers to deploy." and "Every change shows up for everyone at once." There is nothing about GitHub connections, studio or editor sync, versions, rollback, drafts, or "your changes are not live".
- **Resolved by the UI (section 6):**
  - the GitHub integration is connected as the repo owner (VERIFIED);
  - the editor workspace was imported from GitHub, then synchronized (iterations 2 and 3) (VERIFIED);
  - v2's source is that workspace, not a plain GitHub commit (VERIFIED for the content; INFERRED for the exact iteration).
- **Still UNVERIFIED, don't infer "manual only":**
  - whether a push to GitHub starts a sync or a publish by itself, or the user must start the "synchronization" (iteration 3 is labelled "approved", which suggests a user step);
  - what exactly "Done →" does;
  - whether "v2 is live — your changes are not" means iteration 3 differs from v2 or is a generic editing label.

### 3. Rollback options

| Candidate | What it is | Status | Notes |
| --- | --- | --- | --- |
| Maypop published-version history (v1, v2) | Maypop's record of published versions | **UNVERIFIED: not found in the UI** (lead 09:07–09:12 UTC) | The app panel shows only "Version v2, Updated 5d ago". No version list or restore was seen. |
| Editor iteration history | The editor workspace's iterations (scaffold, GitHub import, approved synchronization) | VERIFIED: it exists; older iterations show "Revert" | "Revert" changes the **editor workspace**, not the published version. Whether it plus "Done →" would republish an older state is UNVERIFIED. Iteration 3 is v2's source family. |
| Downloaded v2 files | Byte-exact copy of 8 served files | VERIFIED, but **incomplete** | It lacks the SDK chunk `assets/dist-Bnt1kR_e.js` (loaded only inside the Maypop frame). Its `index.html` is Maypop's rewritten copy (injected scripts, `?v=`). Its source is now identified (row 7). Keep it as forensic evidence, not as an upload. |
| Rebuild of `cc44449` + the workspace `env.ts` guard | Reproduces v2's source family | INFERRED | Not byte-identical (Maypop's pnpm toolchain and extra scanned files). Functionally v2. |
| Rebuild of `cc44449` | A different artifact | VERIFIED buildable | Functionally v2 without the "API mode requires a URL" guard. Different hashes. |

**Recommendation (revised after the UI evidence):**

1. **Preserve the current state.** Don't press Discard, Revert or Done in the
   editor, and don't Unlink GitHub, until a release step needs it. Iteration 3
   is the only Maypop-side source of v2, and v2 itself is the live rollback
   target.
2. Before any v3, record what's known: v2 (published about Oct 13), iteration 3
   (Oct 12), and the two changed files. With the user's approval, download
   `assets/dist-Bnt1kR_e.js`, so the preserved artifact is complete.
3. **No exact one-click rollback has been verified.** The practical rollback for
   a bad v3 is to republish a known source through the same path v3 used:
   Verity's `apps/web` from `cc44449` (or PR B's previous head), synchronized
   into the editor and published. Record that it isn't byte-identical to v2.
   Find out (read-only, in the UI or Maypop support) whether published versions
   can be restored **before** gate 6, not after a failure.
4. Never re-upload the downloaded `index.html`.

### 4. Build variables in the artifact

- VERIFIED: the baked environment contains `VITE_VERITY_DATA_SOURCE` with mode
  `api`. `VITE_VERITY_API_URL` is present, non-empty, https and has no trailing
  slash.
- VERIFIED: the CSP `connect-src` has 4 sources, including a non-empty API
  origin. No `VITE_MOCK_WRITES`, `VITE_META_CSP` or any other `VITE_*` key is
  baked in.
- UNVERIFIED: how Maypop stores these values. The "Edit app details" dialog has
  no build settings or environment variables (VERIFIED, lead). The editor's dev
  preview runs without them: its CSP has no API origin (VERIFIED, lead). So the
  production values come from somewhere not yet seen, and whether a rebuild
  gets the same ones is unknown. **This is a gate 6 risk.** If the values come
  from a workspace file that a GitHub sync could overwrite, the new frontend
  could publish as "not connected".

### 5. What the lead should look at in the Maypop UI

The rule for the whole visit: read only. Don't click Publish, Save, Discard,
Restore, Revert, Connect or Sync, and close any dialog with Cancel or Escape.

1. **Versions or history:**
   - list every version (v1, v2): number, timestamp, changelog or note, author,
     and any commit or source reference;
   - whether a restore or republish action exists (note it, don't use it);
   - whether "view source" or "download" is offered for a version.
2. **Editor or studio ("your changes are not live"):**
   - what the banner refers to: a draft newer than v2, and its age;
   - whether a read-only diff or preview of the draft exists;
   - use the editor's file search (read-only) for `API mode requires a Verity
     service URL` in `apps/web/src/config/env.ts`. A match identifies the
     workspace v2 was built from;
   - note whether the editor tree has files that the GitHub repository doesn't.
     Those would explain the extra CSS classes.
3. **Settings:**
   - the GitHub connection: repository, branch, sync direction (import only, or
     two-way), last sync time;
   - build settings: command, output directory, Node version;
   - environment variable **names** (`VITE_VERITY_DATA_SOURCE`,
     `VITE_VERITY_API_URL`);
   - the app origin.
4. **Publish dialog:** don't open it if opening could publish. If the UI shows a
   preview of what "Publish" would ship (source or commit), record it without
   confirming.

Items 1–3 were done by the lead (section 6). Still open:
- where the published-version list and restore live, if they exist;
- where the `VITE_*` production values are stored;
- what "Done →" and "synchronization" do.

### 6. Maypop UI evidence (lead, signed in, 2026-10-18 09:07–09:12 UTC, read-only)

Nothing was saved, discarded, reverted, published or unlinked.

1. **App panel** (VERIFIED):
   - Verity, creator `quangt0213`, sharing "Public on Explore", version **v2**,
     updated "5d ago", remixing off;
   - Integrations: GitHub "Connected as quangt0213", with an Unlink button
     (untouched);
   - the "Edit app details" dialog has only icon, title, category and
     description: no build settings and no environment variables (cancelled).
2. **Editor** (VERIFIED; entered with "Edit app"; neither Discard nor Done was
   clicked):
   - title "Untitled App (editing)";
   - **Iteration history** (local time):
     1. "Scaffold React and Vite app" (Oct 3, 3:51 am);
     2. "Imported Verity from your GitHub" (Oct 3, 4:07 am);
     3. "The approved synchronization" (LATEST, Oct 12, 2:24 pm). The older two
        offer "Revert" (untouched);
   - buttons "Discard" and "Done →";
   - an AI prompt ("Fix something…");
   - the tooltip "v2 is live — your changes are not".
3. **Editor preview** (VERIFIED): served from a per-session origin under
   `apps.app.maypop.ai`. It is a **Vite dev server** (`/@vite/client`,
   `/src/main.tsx`, `node_modules/.pnpm/vite@8.3.2…`), so the workspace uses
   pnpm. Its meta CSP has no API origin.
4. **Workspace source vs `cc44449`** (VERIFIED). The lead fetched `?raw` for all
   73 `apps/web/src` files, plus `index.html` and `public`, and compared
   SHA-256:
   - 71 identical;
   - 2 differ, `src/config/env.ts` (the v2-only guard in row 7) and
     `src/config/env.test.ts`;
   - 0 missing.

   Round-1+ files (`basemap-detail.ts`, `ArrivalCheck.tsx`, `submit-errors.ts`)
   don't exist. Files outside `cc44449`'s list couldn't be listed (`.git` and
   `package.json` return 403).
5. **Consistency** (INFERRED): v2 was updated "5d ago" (about Oct 13), the day
   after iteration 3 (Oct 12). That fits v2 being published from iteration 3
   via "Done →".
6. **Not seen** (UNVERIFIED): a published-versions list or restore, how v2 was
   published, and where the `VITE_*` values live.

**Release implications** (INFERRED; to confirm before gate 6):

- Maypop doesn't build GitHub `main` directly. GitHub content enters an
  **editor workspace** through an import or synchronization, and is then made
  live. The new frontend (PR B) would reach Maypop the same way, after its
  merge.
- The workspace holds a change that exists only on Maypop (the `env.ts` guard
  and its test). A synchronization from GitHub may overwrite it or conflict
  with it.
- Losing the guard is harmless **in production builds**. Without it, `api` with
  no URL still shows "not connected" through the production branch ("No Verity
  service URL was configured…"). In a **dev** build, such as the editor's Vite
  dev preview, `cc44449`'s code falls back to demo data instead. That is
  plausibly why the guard was added in the workspace. Record it anyway, so a
  conflict prompt isn't a surprise. Whether Verity's own `env.ts` should adopt
  the guard is a separate decision for the owners.
- Until the gate 6 path is known, treat **"Done →", "Revert", "Discard" and any
  synchronization as publish-adjacent actions that need explicit approval.**

## Round 5: backup destination, evidence, frontend recovery wording (2026-10-18)

Scope: the verifier is the only operator touching production (read-only
`pg_dump` of `public` and `drizzle`, then a local restore validation). This
workstream didn't connect to production, didn't use a browser and didn't push
anything.

### Backup destination (outside Git; nothing in this repository)

All local, checked 2026-10-18 19:41 UTC.

| Check | Result | Status |
| --- | --- | --- |
| Folders | `C:\VerityBackups\2026-10-18\` with `archive\` (the dump), `restore\` (the disposable PostgreSQL 17 cluster's data directory and logs, which hold production rows) and `evidence\` | VERIFIED |
| Outside Git | No `.git` at `C:\` or `C:\VerityBackups` | VERIFIED |
| Outside OneDrive | The only sync root is the user's OneDrive folder (one business account, no tenant libraries). Desktop, Documents and Pictures are redirected into it; Downloads isn't. `C:\VerityBackups` is under none of them. `C:` is a local fixed NTFS volume | VERIFIED |
| Access | Inheritance removed. Only the operator account has `(OI)(CI)(F)`, and it owns the folder. Removed: the inherited Administrators, SYSTEM, Users and Authenticated Users entries. SYSTEM isn't needed (the restore cluster runs as the operator), and leaving it out also keeps the search indexer out. Administrators can still take ownership; that's accepted | VERIFIED (icacls) |
| Disk encryption | `Get-BitLockerVolume` and `manage-bde` need admin. The unelevated shell property gives an uninterpretable `0`. The OS is Windows 11 Home | **UNKNOWN** |
| Windows Search | Indexed scope covers `C:\Users\`, the Start Menu and Office content only; the indexer account has no access | VERIFIED |
| File History | Not configured (no configuration folder; service stopped) | VERIFIED |
| Handling rule | The archive and the restore cluster contain authentication and personal data. Never put them, or any row contents, in screenshots, chat messages or attachments, commits, PRs, docs, build artifacts, the scratchpad or OneDrive. This was sent to the verifier and written at the top of the evidence README | — |

The evidence template is `evidence\README.txt` (outside Git), facts only:
archive name and format, size, SHA-256 and sidecar; versions from the
`pg_restore --list` header; the archive creation time; dump start and end
(UTC); inventory counts by entry type; the restore result per mode; the checks
(15 tables, key-table counts, 6 migration rows and hashes, `report_schedules`
absent); and disposal. After the dump, this workstream computes the size and
SHA-256 and writes `<archive>.sha256`. It reads the archive only by hashing it
and running `pg_restore --list`, and never extracts data.

### Frontend recovery wording

This supersedes round 4, section 3, step 3. `docs/RELEASE_RUNBOOK.md` gets a
new "Frontend recovery (Maypop)" section, and its rollback row now points
there:

- A rebuild of known source (`cc44449`'s `apps/web` plus v2's `env.ts` guard,
  or PR B's previous head) is a **replacement artifact**, **not a byte-identical
  restoration of v2**. Building it is verified; publishing it through Maypop is
  **unverified**.
- The downloaded v2 copy is **forensic evidence only**. It is incomplete and its
  `index.html` contains Maypop's injections, so it is **never uploaded or
  published**. It stays untouched in the scratchpad.
- A published-version restore and "Revert, then publish" both stay
  **unverified**.
- Preserve the editor draft: no Done, Discard, Revert, sync or Unlink without
  an approval that names the action.

