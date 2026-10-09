# Security

Verity is built to be publicly accessible. This document covers the protections
in place after Phase 2 (the Maypop-hosted frontend plus the Verity service), the
cross-origin authentication analysis, and the known remaining risks.

## Trust model

- **Untrusted:**
  - the browser and the Maypop iframe environment;
  - every client-supplied field, including user ids, usernames, roles, group
    ids, Maypop ids and counts;
  - user reports and any scraped content.
- **Trusted:** the Verity service, a separate deployment. It holds every
  credential and makes every security-sensitive decision: validation,
  authentication, authorization, rate limits and state transitions.

## Secret management

| Secret | Where it lives |
| --- | --- |
| `DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `INTERNAL_API_TOKEN` | `apps/api/.env` / service environment only |
| `NIMBLE_API_KEY` | The **verification worker's** environment only (Phase 3). The API never reads it. |
| `RAWTREE_API_KEY`, `RAWTREE_DATABASE` | Reserved for a later phase; accepted but unused |

- Templates hold placeholders only (`apps/api/.env.example`,
  `apps/web/.env.example`). Every other `.env*` file is git-ignored.
- **The service refuses to start in production** with an embedded database, a
  short or default session secret, missing or wildcard or non-https origins, a
  non-https public URL, or a non-SMTP email transport. Error messages name the
  variable, never its value (tested).
- **Frontend guards:**
  1. The build refuses secret-like `VITE_*` names.
  2. A post-build scan fails if `dist/` contains server secret names, credential
     shapes or literal secret values from the environment or local env files.
- The browser never calls Nimble or RawTree.
- **The verification worker refuses to start in production** without
  `NIMBLE_API_KEY`, and only ever sends the key to `https://sdk.nimbleway.com`
  (a local stand-in is allowed outside production). Its configuration
  serializes with the key and database URL redacted (tested).
- The repository is public and Maypop builds the frontend from it: nothing
  secret is ever committed, and only explicitly public `VITE_*` values reach
  the build.

## Authentication

**Finding (Phase 1):** Maypop offers only a pseudonymous, app-scoped identity
and **no verifiable assertion** an external backend can check (see
[docs/MAYPOP.md](docs/MAYPOP.md)). It is display-only and never linked to a
Verity account.

**Verity's own authentication (Phase 2):**

- **Passwordless email codes** using [Better Auth](https://better-auth.com)
  (v1.7.7, pinned), a maintained TypeScript auth library. No custom
  cryptography:
  - 6-digit codes, **stored hashed**, 10-minute expiry, 5 attempts, single use (tested);
  - the start endpoint answers the same way whether or not an account exists (tested);
  - code delivery is fire-and-forget, so response timing doesn't reveal it.
- **Sessions:**
  - opaque random tokens, 30-day sliding expiry, revocable through sign-out (tested);
  - the client receives a **signed** token (`token.signature`, HMAC with
    `SESSION_SECRET`), so a leaked database row alone can't be replayed;
  - session rows never store IP addresses or user agents (a hook forces null; tested).
- **Better Auth's HTTP router isn't exposed.** Verity calls the library
  server-side, behind its own validation and rate limits. Telemetry is
  disabled, and passwords and OAuth are off.
- `GET /me` returns a masked email only.

## Authorization

- Every write (`/reports`, `/signals`, `/follow`) and every "my" read requires
  a valid session. The user id is derived **only** from the session.
- Strict request schemas reject `user_id`, `created_by`, `reporter_user_id`,
  `role`, `maypop_user_id`, `status`, `count` and any other unexpected field.
  Maypop-style headers carry no meaning. All of this is tested, and the browser
  suite checks that no request ever carries Maypop identity or cookies.
- Community input cannot change status, at three levels:
  - the signal code never calls transitions;
  - the state machine gives community actors no edges;
  - a database trigger refuses status changes outside the transition service.
- Operator endpoints (`/internal/v1`):
  - disabled unless `INTERNAL_API_TOKEN` (32+ characters) is set;
  - the token is compared in constant time;
  - any request carrying an `Origin` header is refused, so browsers can't use them.

## Cross-origin design: cookies, CORS and CSRF

**Deployment shape.** The frontend is served from a Maypop app origin, framed
inside the Maypop site. The API lives on Verity's own domain. Every API call is
therefore **cross-site, from a third-party iframe**.

**Why not cookies:**

| Browser | Third-party cookies set by the API in this context |
| --- | --- |
| Safari (ITP) | Blocked |
| Firefox (Total Cookie Protection) | Partitioned |
| Chrome | Allowed only with `SameSite=None; Secure`, and users can block them |

Partitioned cookies (CHIPS) help in some browsers only. A cookie session would
silently fail for part of the audience.

**Chosen design: bearer tokens.**

- The session token goes in `Authorization: Bearer …`.
- It's stored in the app's own `localStorage`. In a third-party iframe this is
  partitioned per top-level site but persists across visits.
- Every request uses `credentials: "omit"`, and the API never enables
  `Access-Control-Allow-Credentials`.

**CSRF.** Browsers never attach `Authorization` headers automatically, so a
forged cross-site request has no credential. On top of that:

- **Origin guard.** Any POST or DELETE carrying an `Origin` header that isn't
  in `VERITY_ALLOWED_ORIGINS` is refused with 403, even with a valid token
  (tested).
- **No simple requests.** Mutations accept only `application/json`; form
  encodings get 415. Every write therefore needs a CORS preflight, which
  disallowed origins fail.

**CORS:**

- Exact-origin allowlist (`VERITY_ALLOWED_ORIGINS`), never `*`.
- `Origin: null` is never allowed.
- Methods: GET, POST, DELETE. Headers: `Content-Type`, `Authorization`,
  `X-Request-Id`.
- CORS is not treated as authentication.

**What was tested.** A Playwright run against the production bundle used three
different sites:

- a host page standing in for Maypop;
- the frontend in an iframe with Maypop's exact sandbox flags;
- the API.

It covered sign-in, report, confirm from a second account, follow, reload and
persistence. **Still to verify on real Maypop:** the app's real origin (to add
to the allowlist) and Maypop's own response headers. See remaining risks.

**Token-storage trade-off.** A token in `localStorage` is readable by script
running in the app's origin. Mitigations:

- a strict CSP with no inline or eval scripts;
- no raw-HTML rendering (lint-enforced);
- strict response validation;
- revocable, signed tokens with a 30-day expiry.

## Rate limiting

Limits are Postgres-backed fixed windows. They're shared across instances, and
their keys are HMACs, so no raw emails or IPs are stored. IP-based buckets are
short-lived and never treated as identities.

| Action | Limits |
| --- | --- |
| Request sign-in code | 5 / 15 min and 20 / day per email; 20 / 15 min per network |
| Verify code | 10 / 15 min per email; 40 / 15 min per network; plus 5 attempts per code |
| Create report | 10 / hour and 30 / day per account; 30 / hour per network |
| Community signal | 60 / hour per account; 300 / hour per network |
| Follow / unfollow | 120 / hour per account |

Exceeding a limit returns 429 with `Retry-After` (tested). Behind a load
balancer, set `TRUST_PROXY` so the client address is the real one.

**Phase 3 quota protection.** Verification is already behind an outbox:

- one open job per event;
- idempotency keys per trigger;
- clients can never trigger a job directly.

Phase 3 adds per-event cooldowns and a global daily Nimble budget.

## Input validation

All bodies and queries are validated by the **same Zod schemas** (shared
contract) in the browser and on the service. The service is authoritative.

| Input | Rule |
| --- | --- |
| Title | 4–120 characters after normalization |
| Description | ≤ 1,000 |
| Location label | ≤ 120 |
| Search | ≤ 100 |
| Coordinates | Finite, in range, numbers only |
| Viewport | Ordered, ≤ 8° per axis |
| Observed time | Within the last 7 days, not in the future |
| Enums | Allowlisted |
| Event ids | UUID, otherwise 404 |
| Query strings | Unknown or repeated parameters rejected |

- Request bodies are capped at **16 KB** (413), must be JSON, and
  prototype-poisoning payloads are refused.
- Text normalization strips control characters, zero-width characters and
  bidirectional overrides.
- **Database constraints back all of this up**: enum CHECKs, ranges, lengths,
  foreign keys, unique and partial-unique indexes, and triggers for append-only
  history and status changes (tested by direct inserts that bypass the app).

## Database access

Only the Verity service talks to Postgres. The browser and Maypop never get a
database connection, key or URL.

Hosted Postgres providers can add their own client APIs on top of the database.
Supabase, used here as hosted Postgres only, exposes the `public` schema through
its Data API (PostgREST and GraphQL) as the `anon` and `authenticated` roles, and
by default grants those roles every new table. Verity uses none of this, so
migration `0002_lock_down_supabase_data_api` closes it at two layers:

1. **Row-level security is on for every table, with no policies.** A role
   without `BYPASSRLS` that isn't the table owner sees no rows and can write
   none. The service connects as the owner, which RLS doesn't apply to.
2. **No privileges for client roles.** All table and function privileges are
   revoked from `anon` and `authenticated`. The migration role's default
   privileges in `public` no longer grant them future tables, sequences or
   functions.

The role statements run only when those roles exist, so plain Postgres and
PGlite apply the migration unchanged. `test/database-access.test.ts` builds a
Supabase-like database, with client roles and a table owner that is neither
superuser nor `BYPASSRLS`. It checks that every normal service operation still
works and that client roles can't read or write. It also fails if a later
migration adds a table without RLS.

Every later table gets the same treatment in its own migration: `0003` enables
RLS on `verification_runs` and revokes the client roles explicitly.
`test/migrations.test.ts` upgrades a populated `0002` database under
Supabase-like roles to the current schema and checks that no rows are lost and
the new table is protected.

### Database TLS

Every connection to a **non-local** database verifies the server's certificate
chain and host name, in every `NODE_ENV`: the API, the worker and the migration
runner alike (`apps/api/src/db/tls.ts`, `apps/api/src/db/client.ts`).

- `VERITY_DB_CA_PATH` names the PEM CA certificate (bundle) that signs the
  database's certificate. For Supabase, this is the project's
  `prod-ca-2021.crt`. It's public, not a secret, but stays outside the repo.
- Configuration validation reads it before anything connects. A missing,
  unreadable, non-PEM or unparsable file, or one that contains a private key,
  refuses to start. Errors name the variable, never the path, URL or
  credentials.
- postgres.js treats `sslmode=require` as "encrypt, don't verify". Verity
  passes an explicit `ssl: { ca, rejectUnauthorized: true }` option, which
  overrides any `sslmode` in the URL, including `disable`, so the URL can't
  weaken verification (tested against postgres.js itself).
- `createDatabase` refuses a non-local URL without a CA as a second line of
  defense, so no caller can open an unverified remote connection.
- The migration runner loads only the database settings (`loadDatabaseConfig`),
  so migrating in production mode doesn't push operators toward placeholder API
  secrets or a weaker mode.
- Local databases (PGlite, Postgres on a loopback address) need no CA.

## Database target guard

A developer's `apps/api/.env` can point at the production database, and
"remember not to run it" is not a safeguard. `apps/api/src/db/target-guard.ts`
classifies `DATABASE_URL` as local (PGlite, Postgres on a loopback address) or
remote, and for a remote database:

- **migrations** (`db:migrate`, `MIGRATE_ON_START=true`) require
  `VERITY_DATABASE_ACK` to equal the database host;
- **the verification worker** requires that acknowledgement **and**
  `NODE_ENV=production`, so a development worker can't process real jobs;
- **demo seeding** (which also migrates) is refused outright;
- **the API** in production mode requires the same acknowledgement, and a
  **development API** (`npm run dev:api`) refuses a remote database. The refusal
  only points to a local database. A deliberate one-session exception exists
  for debugging: `VERITY_DEV_REMOTE_DATABASE=<host>` passed on the command line.
  It is refused when saved in `.env`, never unlocks migrations or the worker,
  and the server warns for the whole session.

Refusals name the variables, never the URL or credentials (tested). The
real-PostgreSQL test suites accept only a local `TEST_DATABASE_URL`, refuse
Supabase hosts and never read `DATABASE_URL`.

## User-submitted URLs (SSRF)

**Phase 2: validate and store, never fetch.**

- The shared `checkPublicHttpUrl` accepts only http(s) with a domain name. It
  rejects credentials, non-standard ports, every IP literal (loopback, RFC 1918,
  link-local, metadata, IPv6, numeric encodings), localhost and internal
  suffixes.
- The database also requires `^https?://`.
- The link is stored on the report only. It isn't shown publicly and isn't
  fetched.

**Phase 3 (implemented in S5): user-submitted links are still never fetched.**
Verity reads pages (Nimble Extract) only for URLs a provider returned: Nimble
Search results and Agent citations. Report links, community records and URLs
found in report text are excluded.

- Pages are fetched by Nimble, never from Verity's network, so a page can't
  reach Verity's internal services.
- The candidate URL is screened (`canonicalizeUrl`, the same public-URL check)
  before the call, and the final URL and every redirect hop after it. Any
  unsafe hop rejects the page. A redirect to another site, or to another
  registry organization on the same domain, is not merged into the record.
- The request is fixed and minimal: no cookies, custom headers, request body,
  browser actions, network capture, parsers or callbacks, and nothing about the
  reporter or the event. Responses are capped (4 MB), parsed with bounded
  pattern matching only (never executed or rendered), and only the evidence
  fields leave the provider module (no raw HTML or full page bodies are
  stored).
- Each read is counted before the call, under a per-job ceiling (4) and a daily
  budget.

## Output, XSS and headers

**Frontend:**

- React escaping everywhere; `dangerouslySetInnerHTML`, `innerHTML` and
  `outerHTML` are banned by lint.
- Hostile titles, quotes and links are tested to render as text.
- Only http(s) links are rendered, with `noopener noreferrer`.
- Production CSP meta tag: no inline or eval scripts (Zod runs jitless).
  `connect-src` covers only the app itself, Maypop, the configured Verity API
  and the basemap. IPv6-literal API URLs are refused at build time because CSP
  can't express them.

**API responses (Helmet plus hooks):**

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
- `Permissions-Policy` denying geolocation, camera, microphone and payment
- `Cache-Control: no-store`
- HSTS in production; no `X-Powered-By`

**Errors:** the only shape is `{ error: { code, message, request_id } }`. Stack
traces, SQL and provider messages are logged server-side only. A forced
database failure returns a generic 500 (tested).

## Logging and privacy

- **The verification worker** logs only ids, counts, outcomes and short error
  codes: never provider messages or bodies, keys, emails or tokens. Its
  configuration serializes with secrets redacted.
- **The geocode cache** stores derived place names per provider and ~110 m
  cell, never an exact pin, and no user, reporter or event identifiers.

- **Structured JSON logs with a request id on every line.** A caller's
  `X-Request-Id` is accepted only if well-formed.
- **Never logged:**
  - `Authorization` headers and cookies;
  - tokens, sign-in codes and emails (redacted);
  - request bodies and query strings, which may contain coordinates;
  - raw IP addresses.
- **Security events** are logged with outcome codes only: code requested or
  rejected, origin rejected, manual transition, report created.
- **Development sign-in codes** go to files in `apps/api/.data/dev-outbox/`,
  never to logs. Production sends them by SMTP.

## Location privacy

- There is **no user-location table.** Browser geolocation is used only on the
  device to center the map. It's rounded, kept in memory, and never stored or
  sent.
- The service sees only the viewport bbox being browsed, plus the pin a
  reporter deliberately chooses (rounded to about 11 m).
- **Signals store no location.** "Nearby confirmations" aren't implemented
  until there is a privacy-preserving definition.
- Community counts are aggregates. No identities, distances or reporter details
  are ever returned publicly (tested).
- **Nimble requests carry only event wording and place names.** Search
  queries and the Agent prompt are built deterministically from the event's
  category, title and location text, plus derived place names. The text is
  sanitized of search operators, and email addresses and phone-like numbers a
  reporter may have typed are removed. They never include coordinates,
  reporter identity, email or account data (tested). Page reads send only the
  page URL.
- **Agent runs are unnamed and cleaned up.** Each investigation creates its own
  Nimble agent resource, with no memory shared between events. The worker
  deactivates it when the run is over, and a periodic sweep retries failed
  cleanups. One window remains: a crash between Nimble accepting a run and the
  worker saving its ids leaves that resource orphaned (it is never re-purchased). The reverse geocoder, when enabled, receives coordinates rounded
  to a ~110 m cell, never the exact pin.
- **Verification (Phase 3, in progress) uses third-party processors.** To find
  evidence, the verification worker sends an event's category, wording and
  location context to Nimble, and may resolve event coordinates to place names
  through a reverse geocoder. Only the minimum event information needed is
  sent: never reporter identity, email or account data. Reverse-geocoded place
  names are derived search metadata about the event, not data about a person.
  There is no continuous user-location tracking, and event-location
  verification stays separate from any future user-location feature.

## Demo data

- **Seeding** (`db:seed`) refuses production. Seeded events are `is_demo`
  and use `.example` sources.
- **Duplicate detection** never attaches real reports to demo events.
- **The frontend** labels demo data on every screen. A production build never
  falls back to demo data; when the service is down it says "Verity is
  temporarily unavailable." (tested).

## Remaining risks

1. **Real Maypop not yet tested.** The cross-site iframe design was verified
   locally with Maypop's sandbox flags, but not on real Maypop. After the first
   GitHub-imported Maypop build:
   - add the exact app origin to `VERITY_ALLOWED_ORIGINS`;
   - confirm Maypop's own response headers don't block calls to the API;
   - run the flow end to end (browse, sign in, report, confirm, follow, reload).
2. **Bearer token in `localStorage`** is exposed to any script that runs in
   the app's origin (see the trade-off above).
3. **Email delivery and abuse.** Sign-in depends on an SMTP provider: set up
   SPF, DKIM and DMARC for `AUTH_EMAIL_FROM`. Per-email and per-network limits
   reduce code spam, but there is no CAPTCHA. Disposable addresses can create
   accounts, so one person can hold several accounts.
4. **Moderation.** There are no moderator tools yet beyond operator
   transitions (for example to REJECTED). Abusive report text is stored and
   shown as plain text.
5. **No account deletion endpoint yet.** It's needed for data-protection
   requests. Reports reference users with `ON DELETE RESTRICT`.
6. **Better Auth** is a significant dependency. Its version is pinned, and only
   the email-OTP and bearer features are used.
7. **Unprocessed verification jobs.** `verification_jobs` aren't processed
   until Phase 3. Events honestly show "verification queued".
8. **Container image untested.** `apps/api/Dockerfile` has not been built here
   (no Docker daemon).
9. **ESLint 9 is end-of-life.** It's kept for `eslint-plugin-jsx-a11y`, and is
   dev-only.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
