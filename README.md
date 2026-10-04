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
| 3 | Evidence verification: worker, Nimble search plus bounded agent escalation, deterministic rules engine, reverification | **In progress** |
| Later | RawTree history, notifications, standalone web/mobile clients | Planned |

## Requirements

- Node.js 22 or newer (developed on Node 24), npm 11
- **No database server needed for development:** the service uses embedded
  Postgres (PGlite). Production uses any Postgres 14+.
- Optional: the [Maypop CLI](https://github.com/basilica-digital/maypop-cli). It is **not** needed to
  deploy: Maypop builds the frontend from this GitHub repository.
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
| `apps/web/.env.local` (template `apps/web/.env.example`) | **Public** `VITE_*` values for local builds only. The build refuses secret-looking names and scans the bundle for secrets. Deployed builds get these values from the build environment (see Deploy). |

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
VERITY_DATABASE_ACK=<db host> node apps/api/dist/migrate.js   # apply migrations (or MIGRATE_ON_START=true)
node apps/api/dist/server.js                 # cwd apps/api, so ./drizzle is found
```

**Remote-database acknowledgement.** Commands that write schema or process
jobs refuse a non-local `DATABASE_URL` unless `VERITY_DATABASE_ACK` equals that
database's host name (copying the host on purpose; a stale `.env` can't do it):
`migrate` (and `MIGRATE_ON_START=true`) needs the acknowledgement; the API and
the worker need it **and** `NODE_ENV=production`; demo seeding never touches a
remote database. A development API (`npm run dev:api`) refuses a remote
database. Local databases (PGlite, Postgres on a loopback address) need
nothing. See `apps/api/src/db/target-guard.ts`.

A container build is in `apps/api/Dockerfile` (build from the repo root; not
yet exercised in CI).

**Required production settings:**

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Postgres URL (with `sslmode=require` for hosted Postgres) |
| `VERITY_DATABASE_ACK` | The host name of `DATABASE_URL` (not a secret): confirms the remote database on purpose |
| `SESSION_SECRET` | 32+ random characters |
| `VERITY_PUBLIC_URL` | The service's https URL |
| `VERITY_ALLOWED_ORIGINS` | Exact origins of the Verity clients (today: the Maypop app origin) |
| `SMTP_URL` and `AUTH_EMAIL_FROM` | For sign-in codes |

Set `TRUST_PROXY` when the service runs behind a load balancer. The service
refuses to start if production settings are insecure.

### Verification worker (Phase 3, in progress)

A separate process from the same codebase that processes the
`verification_jobs` outbox. It is the **only** component that holds
`NIMBLE_API_KEY`; the API never needs it. It needs only `NODE_ENV`,
`DATABASE_URL` and `NIMBLE_API_KEY`; everything else has conservative
defaults (`apps/api/.env.example` lists the budgets and limits). It refuses to
start in production without a key, or with a Nimble URL other than
`https://sdk.nimbleway.com`.

```sh
npm run build -w @verity/api                 # → apps/api/dist/worker.js alongside server.js
node apps/api/dist/worker.js                 # cwd apps/api; same image as the API, different command
npm run dev:worker                           # development: a LOCAL postgres:// DATABASE_URL only
```

Production runs need `NODE_ENV=production` and `VERITY_DATABASE_ACK=<db host>`
(see above).

**Real-PostgreSQL tests** (worker concurrency, leases, fencing, atomic
transitions, end-to-end flows with mocked providers): point
`TEST_DATABASE_URL` at a local, disposable server, never a hosted one. Each
suite creates, migrates and drops its own database.

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:concurrency -w @verity/api
```

- The API never starts verification work. Scale the API and the worker
  independently; any number of workers can run, because job claiming is safe
  across processes.
- The worker needs Postgres. PGlite is single-process and belongs to the API
  in development.
- With `NIMBLE_API_KEY` set, the worker searches through **Nimble Search**
  (standard depth, at most 3 searches per job; see
  `apps/api/src/providers/nimble/`). Without it, retrieval reports
  "unavailable" rather than inventing evidence. The agent arrives in a later
  stage.
- Official and first-party sources are recognized from a reviewed, public
  registry (`apps/api/src/verification/official-sources.ts`): change it by
  pull request.
- Reverse geocoding (Nominatim) is off unless `GEOCODER_PROVIDER=nominatim`.
- `NIMBLE_LIVE_SMOKE=1 npm run smoke:nimble -w @verity/api` makes ONE live
  search request, as an opt-in check. It never runs in `npm test`.
- Apply migrations (through `0004`) before starting it.

### Frontend (Maypop, built from GitHub)

Maypop is the frontend's host for the challenge, and one Verity client among
possible future ones (web, PWA, mobile). The deployment path is:

```
local development → tests → commit → push to GitHub → Maypop imports and builds the repo → apps/web runs on Maypop
```

- `maypop.toml` declares the build: `npm run build:web`, output `apps/web/dist`.
  Keep it even though the CLI isn't used, until it is confirmed whether
  Maypop's GitHub import reads it.
- The build needs two **public** values, compiled into the bundle (and into
  its Content-Security-Policy, so they must be present at build time):

  ```sh
  VITE_VERITY_DATA_SOURCE=api
  VITE_VERITY_API_URL=https://<your-verity-service>
  ```

  Set them as build environment variables in Maypop if it offers them; Vite
  reads `VITE_*` from the build environment. Whether Maypop's GitHub build
  supports this is **not yet verified**. If it doesn't, the fallback is a
  committed `apps/web/.env.production` containing only these public values.
  Without them, the app shows an honest "not connected" state, never demo data.
- **Never** give a secret to the frontend build. Server secrets
  (`DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `INTERNAL_API_TOKEN`,
  `NIMBLE_API_KEY`) belong to the Verity service and worker only.

**After the first Maypop build:**

1. Add the Maypop app's exact origin to `VERITY_ALLOWED_ORIGINS` on the service.
2. In the published app, test the full flow on real Maypop: browse, sign in,
   report, confirm and follow. See SECURITY.md under remaining risks.

**Optional: Maypop CLI.** `maypop publish` builds locally (reading
`apps/web/.env.production.local`), pushes Git `HEAD` and uploads the output.
It still works but is not the challenge deployment path.

## Repository layout

```
packages/contracts/   Shared Zod API contract, limits, demo fixtures (frontend + service)
apps/web/             Maypop static app (Vite, React 19, Tailwind 4, MapLibre 6)
apps/api/             Verity service (Fastify 5, Drizzle + Postgres/PGlite, Better Auth)
  drizzle/            SQL migrations (schema, integrity triggers, client-API lockdown)
docs/                 Platform research notes
```
