# Verity

**Know what's actually happening around you, and whether you can trust it.**

Verity is a community-powered local intelligence app. It tracks road closures,
crashes, flooding, outages, transit problems, protests, concerts and other
events that affect the physical world. Each event shows the evidence behind it
and when Verity last checked. Statuses describe the evidence (Unverified,
Developing, Likely, Verified, Conflicting, Stale, Resolved, Not supported),
never a fake confidence percentage.

The competition-facing app runs on **Maypop** as a static frontend. A separate
**Verity service** (built in later phases) will own Postgres, the Nimble and
RawTree credentials, verification and every security-sensitive decision.

| Doc | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, data contract, map, verification engine, Nimble/RawTree plans |
| [SECURITY.md](SECURITY.md) | Protections in place, auth boundary, SSRF, XSS, CSP, privacy, remaining risks |
| [docs/MAYPOP.md](docs/MAYPOP.md) | What Maypop actually provides, and why writes are disabled for now |

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Maypop frontend: map, feed, detail, evidence UI, report UI, themes, mobile, API client, demo adapter | **Done** |
| 2+ | Verity service: Postgres, auth, reports and confirmations, Nimble, verification engine, RawTree, notifications | Next |

## Requirements

- Node.js 22 or newer (developed on Node 24), npm 11
- Optional: the [Maypop CLI](https://github.com/basilica-digital/maypop-cli) to publish
- Optional: Chrome or Edge for the end-to-end tests (or `npx playwright install chromium`)

## Setup and run

```sh
npm install
npm run dev            # http://localhost:5173, inside a local Maypop host
```

`npm run dev` uses labeled **demo data** and wraps the app in the Maypop SDK's
local host (local identity, KV and notification inspector). To run standalone
instead:

```sh
MAYPOP_DEV_HOST=off npm run dev                   # bash
$env:MAYPOP_DEV_HOST="off"; npm run dev           # PowerShell
```

### Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local`. Every value is
**public**, because `VITE_*` variables are compiled into the bundle. The build
refuses secret-looking names.

| Variable | Purpose |
| --- | --- |
| `VITE_VERITY_DATA_SOURCE` | `api` or `mock`. Empty means demo data in dev, and "not connected" in builds. |
| `VITE_VERITY_API_URL` | Verity service base URL (https) |
| `VITE_MOCK_WRITES` | Demo only: `simulate` or `off` |
| `VITE_MAP_STYLE_URL_LIGHT` / `_DARK` | MapLibre style URLs. Default: OpenFreeMap (OSM-derived, no key). |
| `VITE_MAP_EXTRA_ORIGINS` | Extra basemap origins for the CSP |
| `VITE_DEFAULT_CENTER` / `VITE_DEFAULT_ZOOM` | Initial view (`lat,lng`) |

Server secrets (`NIMBLE_API_KEY`, `RAWTREE_API_KEY`, `RAWTREE_DATABASE`,
`DATABASE_URL`, `SESSION_SECRET`) are listed in the root `.env.example` for the
Verity service. They are **never** used by the frontend.

## Test

```sh
npm run typecheck       # all workspaces
npm run lint            # ESLint (incl. a11y and a ban on raw-HTML rendering)
npm test                # Vitest: contracts and frontend
npm run check           # all of the above plus a production build

# End-to-end, against the production bundle in demo mode:
cd apps/web
PW_CHANNEL=chrome npx playwright test     # or PW_CHANNEL=msedge, or install bundled Chromium
E2E_OFFLINE=1 npx playwright test         # skip map-render checks without network
```

The tests cover:

- **Validation:** coordinates, lengths, unknown fields, URLs.
- **SSRF:** loopback, RFC 1918, metadata, IPv6 and numeric-IP tricks.
- **XSS:** hostile titles, quotes and links render harmlessly.
- **Auth boundary:** writes are never sent; client-supplied identity fields are
  rejected.
- **Honesty:** demo reports never become verified, and nothing is fabricated
  when verification is unavailable.
- **Source lineage:** copied sources don't count as independent.
- **Duplicates:** near-identical reports merge.
- **Graceful degradation:** the list still works when the map can't load.
- **Browser (Playwright):** the production bundle shows no CSP violations, and
  the map really renders markers in light and dark, on desktop and mobile.

## Build and publish to Maypop

```sh
npm run build           # → apps/web/dist (relative asset paths, CSP meta, secret scan)
```

`maypop.toml` builds only the frontend. `maypop publish` builds locally, so
public build values come from `apps/web/.env.production.local`:

```sh
# Before the Verity service exists: an honestly labeled demo
echo VITE_VERITY_DATA_SOURCE=mock > apps/web/.env.production.local

maypop auth
maypop init             # once, in the repo root (reads maypop.toml)
git add -A && git commit -m "..."
maypop publish
```

After the first publish, check in the Maypop app that:

1. tiles and the map load (the meta CSP fits Maypop's host); and
2. you note the app's origin, which the Verity service's CORS allowlist needs.

See [SECURITY.md](SECURITY.md) under remaining risks.

## Repository layout

```
packages/contracts/   Shared Zod API contract and limits (frontend now, service later)
apps/web/             Maypop static app (Vite, React 19, Tailwind 4, MapLibre 6)
docs/                 Platform research notes
```
