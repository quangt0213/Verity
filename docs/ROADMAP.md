# Roadmap

Planned work beyond the current sprint. Nothing here is implemented unless a
section says so. Current sprint status: [WORKSTREAM_STATUS.md](WORKSTREAM_STATUS.md).

## Current sprint (2026-10)

- Verification relevance: event-identity matching, named-event queries,
  scheduled dates for planned events, location matching, reporter-provided
  sources as untrusted candidates.
- Map: faster loading after pan and fly, more landmark detail, groundwork
  for 3D.
- Layout: no blank space under the desktop map, mobile and responsive fixes.

## Deferred verification work

User decisions (2026-10-17): keep "officially scheduled" separate from
"actually happening" and don't weaken verification standards; keep reporter
links never fetched; defer V2; keep every paid Nimble budget at zero.

- **Official schedule evidence, shown separately.** Today nothing in
  production sets an event's established schedule (`events.scheduled_*`), so
  announcements can't count as support (scheduled ≠ occurring). Future work:
  let an identified source (OFFICIAL or FIRST_PARTY, from the reviewed
  registry) establish the schedule through an audited step, and show it on
  the event as its own "Officially scheduled" evidence, separate from the
  status and from evidence that the event is happening. A reporter's claimed
  schedule never establishes it.
- **Reporter links** stay never fetched (A5). The hint-only option in
  `docs/handoffs/verification.md` is recorded but not planned.
- **Shared Extract/Agent ceiling (V2, deferred).** When pre-Agent extraction uses every Extract
  slot, the Agent's URL-only citations can't be read in that attempt, so a paid
  Agent run adds nothing. The behavior change is deferred. See
  `docs/handoffs/verification.md` for the recommendation.
- Agent output schema with verbatim quotes per source (needs one approved live run).

## Release safety (future)

- **API capability flags.** `GET /api/v1/health` could list what the API
  accepts (for example `features: ["report_schedule"]`), and the report form
  could show schedule fields only when the API supports them. A frontend and an
  API of any version could then be released or rolled back in any order. Today
  the release holds the frontend in a separate PR instead
  ([RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)). Proposed by `map-perf` in round 2;
  not built.
- **CI.** No workflow runs the checks on pull requests yet.
- A reviewed registry of news sources before news classes can support VERIFIED.

## Verity Smart Navigation (future, not this sprint)

- Destination search.
- Alternative routes: fastest, fewest traffic lights, estimated intersection delays.
- Incident-aware routing.
- Legal road restrictions.
- GPS tracking and rerouting.
- Later: 3D buildings and terrain, turn-by-turn guidance.

### Constraints

- **Unverified community reports never become authoritative routing
  restrictions automatically.** Routing may only treat an event as a hard
  restriction when its status comes from the deterministic verification engine
  and its evidence meets a routing-specific policy. Weaker states can only be
  advisory.
- Navigation stays a separate module that consumes the event and evidence APIs.
  It doesn't change verification, status transitions or auth.
- Location privacy: no continuous location tracking without explicit opt-in.
  Location stays on the device unless a feature requires sending it, and then
  only the minimum.
- The map layer must support pitch, bearing, 3D buildings, terrain, route line
  overlays and a navigation camera. The current sprint adds only lightweight
  groundwork for these (see `docs/handoffs/map.md`).
