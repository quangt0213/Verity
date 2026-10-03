# Verity

**Know what's actually happening around you, and whether you can trust it.**

Verity is a community-powered local intelligence app. It tracks road closures,
crashes, flooding, outages, transit problems, protests, concerts and other
events that affect the physical world. Each event shows the evidence behind it
and when Verity last checked. Statuses describe the evidence (Unverified,
Developing, Likely, Verified, Conflicting, Stale, Resolved, Not supported),
never a fake confidence percentage.

The app has two parts:

- **The frontend** runs on **Maypop** as a static app.
- **The Verity service** is deployed separately. It owns the canonical state in
  Postgres, Verity's own authentication, validation, rate limits and the
  verification outbox. Nimble and RawTree come in later phases.

| Doc | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, data model, API, auth model, state machine, Nimble/RawTree plans |
| [SECURITY.md](SECURITY.md) | Protections in place, cookie/CORS/CSRF analysis, privacy, remaining risks |
| [docs/MAYPOP.md](docs/MAYPOP.md) | What Maypop provides, and why its identity is display-only |

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Maypop frontend: map, feed, detail, evidence UI, report UI, themes, mobile, demo adapter | Done |
| 2 | Verity service: Postgres, passwordless auth, reports, community signals, follows, transitions, outbox | **Done** |
| 3+ | Nimble investigations, verification engine, RawTree history, notifications | Next |

## Requirements

- Node.js 22 or newer (developed on Node 24), npm 11
- **No database server needed for development:** the service uses embedded
  Postgres (PGlite). Production uses any Postgres 14+.
- Optional: the [Maypop CLI](https://github.com/basilica-digital/maypop-cli) to publish the frontend
- Optional: Chrome or Edge for end-to-end tests (or `npx playwright install chromium`)

## Run locally

```sh
npm install

# Demo frontend only (labeled demo data, inside a local Maypop host):
npm run dev                                  # http://localhost:5173

# Frontend against the real Verity service:
npm run db:seed -w @verity/api               # optional, before starting: load labeled demo events
npm run dev:api                              # service on http://localhost:8787 (embedded DB)
# then, in another terminal:
VITE_VERITY_DATA_SOURCE=api VITE_VERITY_API_URL=http://localhost:8787 npm run dev            # bash
$env:VITE_VERITY_DATA_SOURCE="api"; $env:VITE_VERITY_API_URL="http://localhost:8787"; npm run dev   # PowerShell
```

**Signing in locally:** nothing is emailed in development. Each sign-in code is
written as a file to `apps/api/.data/dev-outbox/` (git-ignored); open the
newest one. Codes are never written to logs.

To start the dev database over: `npm run db:reset -w @verity/api`. The embedded
database is single-process, so stop the dev service before seeding or resetting.

### Configuration

| File | What goes there |
| --- | --- |
| `apps/api/.env` (git-ignored; template `apps/api/.env.example`) | **Server-side secrets and settings.** Every value is optional in development. |
| `apps/web/.env.local` / `.env.production.local` (template `apps/web/.env.example`) | **Public** `VITE_*` values only. The build refuses secret-looking names and scans the bundle for secrets. |

## Test

```sh
npm run typecheck       # all workspaces
npm run lint            # ESLint (incl. a11y and a ban on raw-HTML rendering)
npm test                # Vitest: contracts, service (against embedded Postgres), frontend
npm run check           # all of the above plus production builds

cd apps/web
PW_CHANNEL=chrome npm run test:e2e           # demo-mode production bundle: map, themes, mobile, CSP
PW_CHANNEL=chrome npm run test:e2e:service   # Phase 2 completion flow against the real service
```

`test:e2e:service` runs the frontend inside a cross-site sandboxed iframe (like
Maypop) against the real service, using two separate accounts. It walks
through:

1. Browse without signing in.
2. Try to report, and get the sign-in prompt.
3. Sign in by email code.
4. The report is stored, the event shows as UNVERIFIED, and a verification job
   is queued.
5. A second account confirms; the count updates but the event stays UNVERIFIED.
6. Follow the event.
7. Reload: everything persisted.

It also checks that no request ever carried Maypop identity.

## Deploy

### Verity service (`apps/api`)

It's a provider-neutral Node 22+ service: run it on any container host or Node
platform, with any managed Postgres.

```sh
npm ci && npm run build -w @verity/api       # → apps/api/dist/{server,migrate}.js
node apps/api/dist/migrate.js                # apply migrations (or set MIGRATE_ON_START=true)
node apps/api/dist/server.js                 # cwd apps/api, so ./drizzle is found
```

A container build is in `apps/api/Dockerfile` (build from the repo root; not
yet exercised in CI).

**Required production settings:**

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Postgres URL |
| `SESSION_SECRET` | 32+ random characters |
| `VERITY_PUBLIC_URL` | The service's https URL |
| `VERITY_ALLOWED_ORIGINS` | The exact Maypop app origin |
| `SMTP_URL` and `AUTH_EMAIL_FROM` | For sign-in codes |

Set `TRUST_PROXY` when the service runs behind a load balancer. The service
refuses to start if production settings are insecure.

### Frontend (Maypop)

`maypop.toml` builds only `apps/web`. `maypop publish` builds locally, so set
the public values in `apps/web/.env.production.local`:

```sh
VITE_VERITY_DATA_SOURCE=api
VITE_VERITY_API_URL=https://<your-verity-service>
```

Then run `maypop auth`, `maypop init` (once, from the repo root), commit, and
`maypop publish`.

**After the first publish:**

1. Add the Maypop app's exact origin to `VERITY_ALLOWED_ORIGINS` on the service.
2. In the published app, test the full flow on real Maypop: browse, sign in,
   report, confirm and follow. See SECURITY.md under remaining risks.

## Repository layout

```
packages/contracts/   Shared Zod API contract, limits, demo fixtures (frontend + service)
apps/web/             Maypop static app (Vite, React 19, Tailwind 4, MapLibre 6)
apps/api/             Verity service (Fastify 5, Drizzle + Postgres/PGlite, Better Auth)
  drizzle/            SQL migrations (schema, integrity triggers, client-API lockdown)
docs/                 Platform research notes
```
