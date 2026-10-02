# Maypop: what the platform actually provides

Verity's competition-facing app is a static frontend hosted on Maypop. This
document records what Maypop provides, based on primary sources, and the
security decisions that follow. It is deliberately limited to documented
behavior.

**Sources inspected (2026-10-01):**

- `@basilica-digital/maypop-sdk@1.3.0`: `src/v1.ts` (the SDK's typed public
  contract, described in its own header as "the SOURCE OF TRUTH for the SDK's
  public surface"), `src/runtime.ts`, the package README and `contracts/*.json`
- Maypop CLI README (`maypop-cli`): build adapters, publish flow, MCP
- `https://maypop.ai/llms.txt`

## Hosting model

- Maypop hosts **static** builds only: Vite/Rsbuild `dist/`, or a Next.js
  `output: "export"`. `maypop publish` builds locally, pushes Git `HEAD` and
  uploads the static output. There is **no server runtime** for app code.
- Apps run in a **sandboxed, cross-origin iframe**
  (`allow-scripts allow-same-origin allow-forms allow-popups allow-modals
  allow-popups-to-escape-sandbox allow-downloads`).
- The SDK warns that app code calling third-party HTTP APIs "almost always
  fail[s] in the sandboxed iframe (browser CORS, or a leaked/blocked API key)".
  Whether Maypop's production host adds a CSP that restricts `connect-src` for
  app origins is **not documented**. It must be verified after the first publish,
  together with the exact app origin (needed for the Verity service's CORS
  allowlist).

**Consequence:** nothing secret can live in the Maypop project. Postgres, the
Nimble and RawTree keys, the verification worker and rate limiting all belong to
a separately deployed Verity service.

## Identity

From `src/v1.ts`:

| Field | What Maypop says |
| --- | --- |
| `maypop.user.id` | "PSEUDONYMOUS, app-scoped viewer id … NOT the person's real Maypop user id, and differs across apps." |
| `maypop.user.role` | "A hint for labels and optional UI — never your own permission check. The server decides what a caller may actually do." |
| `maypop.user.isAnonymous` | True for a share-link visitor without an account. |
| `maypop.mode` / `signInRequired` / `signIn()` | Read-only vs read-write session, and a host-owned sign-in card. |

From `src/runtime.ts`: the host hands the SDK "a short-lived, scoped app token"
over a `MessagePort`. The SDK keeps it in a private variable and sends it only
to Maypop's own `/app-api`. The runtime header states: "The app never sees the
user's real session, real user UUIDs, or anything beyond its granted scopes."

**There is no documented, cryptographically verifiable identity assertion** that
an external backend could validate. No signed JWT is exposed to app code, and
no JWKS, token-introspection or "verify this viewer" endpoint is documented. The
internal app token is not part of the public contract, and using it would mean
relying on undocumented behavior.

### Decision: authenticated writes stop at the boundary

- Verity uses Maypop identity for **display only** (name, avatar, sign-in
  prompt). It is never sent to the Verity service and never authorizes anything.
- The HTTP client's write methods (report, confirm, dispute, resolved, still
  happening, update) return `auth_unavailable` **without contacting the
  network** (`apps/web/src/api/http-client.ts`). The UI explains that responses
  aren't recorded.
- Reads (events, details, evidence) are public and need no identity.
- A separate, verifiable authentication mechanism for the Verity service will be
  designed in a later phase. Options to evaluate then: a proven auth provider
  with bearer tokens obtained via a popup (the sandbox allows popups), or a
  Maypop-documented assertion if one becomes available.

### Why the MCP route doesn't solve identity

`maypop mcp connect` lets an app call an external MCP server through Maypop,
with auth headers stored in the developer's Maypop account (they never reach
the browser). That protects a **service credential**, but the Verity service
would still see one caller (the app integration). Per-user identity would come
from tool arguments, which any viewer can forge from devtools. It is therefore
not an authentication mechanism for per-user writes.

## Capabilities Verity uses (Phase 1)

| Capability | Use in Verity |
| --- | --- |
| `ready()`, `user`, `mode`, `signInRequired`, `signIn()` | Header identity chip and "Sign in" prompt. `ready()` is raced against a timeout, so Verity also runs standalone. |
| `theme` + `"themechange"` | The "System" theme follows the Maypop host. `index.html` sets `data-maypop-theme="manual"` so the SDK doesn't fight Verity's explicit Light/Dark choice. |
| `share({ path })` | Shares an event deep link (`/events/:id`). Maypop's user-facing errors (for example "must be published to a group") are shown as-is. |
| `launchPath` | Deep links from notifications or shares open the right screen, validated against Verity's routes. |

The SDK is loaded with a dynamic `import()` only when Verity is framed, so
standalone visits never load it.

## Capabilities for later phases

| Capability | Notes |
| --- | --- |
| `kv` + `.maypop/kv-policy.json` | Server-enforced shared storage with role/ownership rules (`owner_private` paths like `private/<memberId>/…`). Candidate for group-level saved areas. The manifest schema is only partly documented (test cases), so it is not used until it can be verified on a published app. |
| `notify({ to, title, body, path })` | Group notifications from a **member's browser** (30/hour per app, 5/hour per recipient). A background worker cannot call it, so server-side status transitions can't push through Maypop directly. |
| `members()` | Pseudonymous roster and presence, for "N people from your group are viewing". |
| `ai`, `agent`, `mcp`, `link.unfurl` | Billable or integration-backed. Not needed for evidence acquisition, which belongs to the Verity service (Nimble). |

## Local development

The Vite plugin (`@basilica-digital/maypop-sdk/vite`) wraps `vite dev` in a
local Maypop host with a local identity, KV and a notification inspector.
Machine-local state lives in `apps/web/.maypop/local/` (git-ignored). Set
`MAYPOP_DEV_HOST=off` to run standalone.
