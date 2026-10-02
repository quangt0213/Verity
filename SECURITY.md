# Security

Verity is built to be publicly accessible. This document covers the protections
in place now (Phase 1: the Maypop-hosted frontend), the controls designed for
the Verity service, and the known remaining risks.

## Trust model

- **Untrusted:** the browser, the Maypop iframe environment, every
  client-supplied field (including user ids, usernames, roles and group ids),
  scraped source content and user reports.
- **Trusted:** the Verity service, a separate deployment that holds every
  credential and makes every security-sensitive decision.

## Secret management

| Secret | Where it lives |
| --- | --- |
| `NIMBLE_API_KEY`, `NIMBLE_BASE_URL` | Verity service only |
| `RAWTREE_API_KEY`, `RAWTREE_DATABASE` | Verity service only |
| `DATABASE_URL` | Verity service only |
| `SESSION_SECRET` | Verity service only |

- The root `.env.example` lists placeholders only. Real values go in untracked
  env files: `.gitignore` ignores `.env` and `.env.*` and re-includes only
  `.env.example`.
- **Build guard 1** (`apps/web/build/plugins.ts`): `vite build` and `vite dev`
  refuse to start if any `VITE_*` variable has a credential-like name
  (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `DATABASE_URL`, …), and refuse to
  widen `envPrefix`.
- **Build guard 2** (`apps/web/scripts/check-bundle-secrets.mjs`): after every
  build, scans `dist/` for server secret names, credential shapes (database
  URLs with passwords, PEM keys, RawTree keys) and the literal values of any
  secrets present in the environment or local env files. The build fails on a
  match.
- The browser never calls Nimble or RawTree. Only the Verity service will.

## Authentication and authorization

**Finding:** Maypop provides only a pseudonymous, app-scoped viewer identity and
**no cryptographically verifiable assertion** an external backend can validate
(full analysis in [docs/MAYPOP.md](docs/MAYPOP.md)).

**Implemented:**

- Maypop identity is used for display only. It is never sent to the Verity
  service and never authorizes anything. The role is treated as a label hint, as
  Maypop instructs.
- The HTTP client refuses every write (report, confirm, dispute, resolved,
  still-happening, update) with `auth_unavailable`, **without making a request**.
  The UI says plainly that nothing was recorded. Tests cover this.
- Request schemas are strict objects: a payload carrying `user_id`, `role` or
  `status` is rejected outright. Tests cover this.

**Planned for the service:**

- A proven auth provider; no custom password cryptography.
- Identity derived only from a verified session or token.
- Authorization checked server-side on every write.
- Since the app runs in a third-party iframe, bearer tokens rather than
  third-party cookies, which removes ambient-credential CSRF. If cookies are
  used, they will be `SameSite` with strict `Origin` checks.

## Input validation

All inputs are validated with Zod schemas in `packages/contracts`. The frontend
uses them for instant feedback, and the service will re-validate with the same
schemas.

| Input | Rule |
| --- | --- |
| Title | 4–120 characters after normalization |
| Description | ≤ 1,000 characters |
| Dispute reason | ≤ 300 characters |
| Update text | ≤ 500 characters |
| Location label | ≤ 120 characters |
| Search query | ≤ 100 characters |
| Coordinates | Finite numbers in range; strings, NaN and Infinity rejected |
| Viewport | `[w, s, e, n]`, ordered, at most 8° per axis |
| Category, status, response kind | Allowlisted enums |
| All bodies | `strictObject`: unknown fields rejected; oversized raw input rejected before normalization |

- Text normalization strips control characters, zero-width characters and
  bidirectional overrides (which can disguise text) and collapses whitespace.
  Output is still plain text.
- Responses from the service are validated too: a malformed payload becomes an
  error and is never rendered.

## SSRF: user-submitted source URLs

**First gate (implemented, shared):** `checkPublicHttpUrl` in
`packages/contracts/src/url.ts` rejects:

- non-http(s) schemes (`file:`, `javascript:`, `data:`, `ftp:`)
- embedded credentials and non-standard ports
- **all IP-literal hosts**. This covers loopback (`127.0.0.0/8`), RFC 1918,
  link-local and metadata `169.254.169.254`, and IPv6 (`[::1]`, `fd00::/8`,
  mapped IPv4). It also covers numeric encodings such as `http://2130706433/`
  and `http://0x7f000001/`, which the WHATWG parser normalizes to dotted IPv4.
- `localhost`, `*.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`,
  `.arpa`, `metadata.google.internal` and single-label hosts

**Second gate (planned, service):**

- Resolve every A/AAAA record and reject private, reserved, loopback,
  link-local, CGNAT and multicast ranges.
- Re-check at fetch time (DNS-rebinding defense).
- Prefer handing the URL to **Nimble Extract** rather than fetching it from
  Verity's own network, so the service never makes arbitrary outbound requests.

## XSS

- React escapes all text. **`dangerouslySetInnerHTML`, `innerHTML` and
  `outerHTML` are banned by ESLint** in app code.
- Source quotes, agent notes, user reports and titles render as plain text.
  Tests render `<script>`, `<img onerror>` and inline HTML payloads and assert
  that no elements are created.
- Links from data render only if they are absolute `http(s)` URLs
  (`isSafeHttpUrl`), with `rel="noopener noreferrer nofollow ugc"` and
  `referrerPolicy="no-referrer"`. A `javascript:` source URL is never rendered
  as a link (tested). Demo sources are never clickable.
- Maypop avatar URLs are accepted only if they are http(s).
- Deep links from Maypop (`launchPath`) must match Verity's own route patterns.

## Content-Security-Policy and headers

Maypop serves the bundle, so Verity can't set HTTP response headers. The
production build injects a CSP `<meta>` tag built from the configured origins:

```
default-src 'self'; script-src 'self' https://*.maypop.ai;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;
font-src 'self' data:; connect-src 'self' https://*.maypop.ai <api-origin> <basemap-origins>;
worker-src 'self' blob:; child-src 'self' blob:; frame-src 'none';
object-src 'none'; base-uri 'self'; form-action 'none'
```

- **No `unsafe-eval` and no inline scripts.** The theme pre-paint script is an
  external file. Zod's JIT (which probes `new Function`) is disabled with
  `z.config({ jitless: true })`.
- The Playwright suite runs against the production bundle and **fails on any
  CSP violation or console error**.
- `Referrer-Policy: strict-origin-when-cross-origin` is set via `<meta>`.
- **Can't be set from a meta tag, so the host controls them:**
  `frame-ancestors` (the app must be framed by Maypop anyway),
  `X-Content-Type-Options` and `Permissions-Policy`. The Verity service will set
  all of these on its own responses, plus a strict API CSP, `nosniff`,
  `Referrer-Policy` and a CORS allowlist containing only the Maypop app origin.
- `VITE_META_CSP=off` exists only to diagnose a policy problem on a new host.

## Rate limiting and quota protection (planned, service)

- Per-identity and per-IP limits (Postgres-backed counters) on report creation,
  confirmations, disputes and updates.
- **Nimble can never be triggered directly by a client.** Investigations run
  only from server-created jobs:
  - deduplicated per event, with idempotency keys and cooldowns;
  - capped per event and per day, globally;
  - effort `low` by default.
- The internal verify endpoint requires a job secret and is not part of the
  public API.

## Location privacy (implemented)

- Location is never required. The app asks only when the user taps "Explore
  nearby", "Near me" or "Use my location".
- The position is low-accuracy, rounded to about 110 m, used only on the device
  to center the map, kept in memory, and **never stored or sent**.
- The service receives only the viewport bbox being viewed, not the user's
  position.
- Report pins are user-chosen and rounded to about 11 m.
- Community answers are shown only as counts. There is no "user X is 42 m away".
- `localStorage` holds only theme, onboarding flag, followed event ids and
  notification preferences. There is no location history.

## Error handling

- The client shows only user-safe messages. Unexpected error bodies (stack
  traces, provider messages) are discarded, not displayed (tested).
- The service will return `{ error: { code, message } }` only (the
  `apiErrorSchema` contract) and log diagnostics server-side.

## Demo data

- Demo events are flagged `is_demo`. Every screen shows a "not real current
  events" banner, and cards carry a Demo badge.
- Demo citations use the reserved `.example` domain (RFC 2606) and are never
  clickable, so no demo citation can pose as a real publication (tested).
- A production build with no service URL shows "not connected". It never
  silently shows demo data.

## Remaining risks (MVP)

1. **No authenticated writes yet.** This is by design, until a verifiable
   identity mechanism exists. Community features stay read-only in production
   until then.
2. **Maypop host headers are unverified.** Maypop's production CSP, framing
   headers and app origin aren't documented. They must be checked after the
   first publish (the meta CSP may need adjusting; the CORS allowlist needs the
   origin).
3. **Basemap provider trust.** MapLibre renders the style's attribution HTML,
   and the style origin is allowed in `connect-src`. Only configure trusted
   style URLs.
4. **`style-src 'unsafe-inline'`** is kept for library-injected styles. Script
   execution is still restricted.
5. **ESLint 9 is end-of-life.** It's kept because `eslint-plugin-jsx-a11y`
   doesn't support ESLint 10 yet. It's a dev-time tool only and doesn't ship.
6. **Service controls in this document are planned** and must be verified with
   tests in their phases: rate limits, SSRF DNS checks, CORS, CSRF strategy and
   server headers.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
