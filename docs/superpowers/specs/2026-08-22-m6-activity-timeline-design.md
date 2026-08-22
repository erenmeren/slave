# M6: Activity Timeline — Design

**Date:** 2026-08-22
**Parent:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` §12.4 ("Activity — live
timeline over SSE, filterable by workspace/agent/task/event type") and the M6 gate row ("events
appear within one second of occurrence").
**Builds on:** M4's SSE transport and hybrid liveness rule, M5's control plane, `feedSummary`,
and the Mission Control UI language.

## 1. Scope

- **Activity page** — `/w/[workspaceId]/activity`: a live, filterable, infinitely scrollable
  timeline of every `ExecutionEvent` in the workspace. The Sidebar's inert Activity item goes
  live (Tasks precedent).
- **Server-filtered stream** — a new SSE route that applies the timeline's filters on the
  server, sharing the `packages/events` machinery (id frames, heartbeats, `Last-Event-ID`
  replay). The M4 `/events` route and its consumers are untouched.
- **History pagination** — seq-cursor paging over the full event history with the same filter
  vocabulary, feeding upward infinite scroll.
- **Rich cards** — every event type renders through its own card component, from an exhaustive
  registry; every card carries a collapsible raw-payload view.
- **Sparklines** — tool-call density over the last 10 minutes: one workspace-level sparkline in
  the Activity header, one mini sparkline per agent card on the Overview.

Out of M6: Graph (M7), the ⌘K palette, analytics, event retention/pruning policy (the timeline
scrolls the full history; how long that history is kept is a separate pre-M8 decision), any new
mutation surface (M6 is read-only end to end).

## 2. Decisions of Record

These were chosen explicitly during design review; later sections assume them.

| Decision | Choice | Rejected alternative |
|---|---|---|
| History depth | Full infinite scroll, virtualized | Fixed window with "load older"; live-tail only |
| Type filter | Curated groups + expandable raw-type multi-select | Groups only; raw list only |
| Row content | A custom card per event type (all 20), each with collapsible payload | Summary-only rows; selected types + generic fallback |
| Live transport | **Server-filtered SSE route** | Client-side filtering over the existing stream |
| Sparklines | Workspace header **and** per-agent Overview cards | Header only; defer entirely |

## 3. Backend

### 3.1 Filter vocabulary (shared by both endpoints)

Query parameters, all optional, combined with AND across dimensions and OR within one:

- `agents=<id,id,…>` — agent ids.
- `tasks=<id,id,…>` — task ids.
- `types=<domain-type,…>` — raw domain event types (`run.tool_call`, `task.rework`, …).
- `kinds=<kind,…>` — curated groups, expanded server-side through one exhaustive map
  (`Record<ActivityKind, DomainEventType[]>` — adding an event type without assigning it a kind
  fails the build):

| Kind | Domain types |
|---|---|
| `runs` | `run.started`, `run.succeeded`, `run.failed`, `run.paused`, `run.resumed` |
| `tool_calls` | `run.tool_call`, `run.output` |
| `tasks` | `task.created`, `task.started`, `task.verifying`, `task.verify_passed`, `task.verify_failed`, `task.done`, `task.rework`, `task.failed` |
| `interventions` | `run.pause_requested`, `run.resume_requested`, `run.stopped`, `agent.message_sent` |
| `guardrails` | `guardrail.tripped` |

`types` and `kinds` together take the union. No filter means everything in the workspace.

### 3.2 The filtered stream

`GET /api/w/[workspaceId]/activity/stream?<filters>&from=<seq>`

- Reuses `createEventStream`/`subscribeEvents` exactly as the M4 SSE route does: id-carrying
  frames, id-only heartbeats while quiet, `Last-Event-ID` (or `from`) replay with no gap and no
  duplicate.
- The only new behaviour is a server-side predicate: a frame that fails the filter (wrong
  workspace, unselected agent/task/type) is **not written, but the watermark still advances** —
  the M4 rule ("filters another workspace's events but advances the watermark past them")
  generalised to the whole filter vocabulary.
- Filter parameters are validated with zod; an unknown kind or malformed id list is a 400, not a
  silently empty stream.

### 3.3 History pagination

`GET /api/w/[workspaceId]/activity?<filters>&before=<seq>&limit=<n≤200>`

- One Prisma query: `where` from the filter vocabulary plus `seq < before`, `orderBy seq desc`,
  `take limit`. Returns rows shaped for the client: `{ seq, ts, type, actor, agentId, taskId,
  runId, payload, summary }` with `summary = feedSummary(type, payload)`.
- Without `before`, the newest page. The response includes `nextBefore` (the oldest seq
  returned) or `null` when the history is exhausted.
- 404 for an unknown workspace, per the house route shell.

### 3.4 Indexes

One migration adds `@@index([workspaceId, agentId, seq])` and `@@index([workspaceId, taskId,
seq])` to `ExecutionEvent`. The existing `(workspaceId, seq)` index carries the unfiltered and
type-only paths (type selectivity is low; Postgres filters the scan).

### 3.5 Sparkline aggregation

`buildActivityPage(workspaceId, filters)` (server module, `apps/web/src/server/activity.ts`)
returns the first history page **plus** `sparkline: number[10]` — tool-call counts per minute
over the last 10 minutes, one `GROUP BY date_trunc('minute', ts)` query, zero-filled.

`buildOverviewSnapshot` gains the same shape per agent: `AgentCardData.sparkline: number[10]`,
from **one** query grouped by agent and minute (no N+1 — M5 `recentEvents` precedent).

Constraint carried forward: `apps/web` reads freely, writes never (spec M5 §1); every M6 surface
is read-only.

## 4. Frontend

### 4.1 Page and data flow

`/w/[workspaceId]/activity` mirrors the overview/tasks pages: server component calls
`buildActivityPage` (no filters server-side beyond the workspace — the client applies URL filters
on mount by refetching page one when filters are present), 404 copy identical, client component
under `key={workspaceId}`.

### 4.2 `useActivityStream`

A new stream-shaped hook (`apps/web/src/hooks/useActivityStream.ts`). `useWorkspaceStream` is
snapshot+refetch-shaped and is deliberately **not** reused — wrong tool for an append log.

Responsibilities:

- Opens an `EventSource` to the filtered stream route with `from = <newest seq held>`;
  reconnects with `Last-Event-ID`; exposes `connection: 'connected' | 'reconnecting'`.
- Appends arriving events to the buffer, deduplicating by `seq` (globally unique, monotonic).
- `loadOlder()`: fetches `before = <oldest seq held>` through the history route and prepends;
  exposes `exhausted` when the server returns `nextBefore: null`.
- Filter changes (from the URL) tear down the EventSource and open a new one; the buffer is
  reset (a different filter is a different timeline, not a patch on the old one).
- Feeds the header sparkline live: increments the current minute bucket on each `run.tool_call`
  arrival and rotates buckets on minute boundaries, so the pulse moves without waiting for a
  refetch.

### 4.3 Virtualized list

`@tanstack/react-virtual` (the milestone's one new dependency), dynamic row heights via
`measureElement` (cards expand/collapse). Live-follow etiquette:

- Pinned to the bottom → new events auto-scroll.
- Scrolled up → follow stops; a "↓ N new events" badge accumulates; clicking it returns to the
  bottom and re-pins.
- Nearing the top triggers `loadOlder()` (one in-flight page at a time).

### 4.4 Filter bar

Top of the page: five kind chips (multi-select), an "Advanced" popover with the raw type
multi-select, and agent/task selectors populated from the page's own data. All filter state
lives in URL query params via shallow `router.replace` (the `useSelectedId` pattern generalised
to a small `useUrlFilters` helper) — links are shareable and refresh restores state.

### 4.5 Card registry

`Record<DomainEventType, ActivityCardComponent>` — exhaustive; a new event type is a compile
error, never a silently generic row. Shared primitives (timestamp, actor badge, agent/task links,
the collapsible raw-JSON payload section — present on every card) live in one module; each type's
body specialises:

- `run.tool_call` — tool name + primary argument (the `feedSummary` derivation, un-truncated on
  expand); `run.output` — the text block.
- `run.started/succeeded/failed/paused/resumed` — status-coloured transition line; failures show
  the reason; pauses show `pausedAtStep`.
- `task.*` — status transition with the task title; `task.rework`/`task.verify_failed` show the
  rejection/failure reason.
- `run.pause_requested`/`run.resume_requested`/`run.stopped`/`agent.message_sent` — the
  intervention cards: actor ("web operator", CLI operator name), queued message text where the
  payload carries one.
- `guardrail.tripped` — limit name, configured bound, observed value.

Status colours reuse the existing tokens; the only saturation on screen stays status.

### 4.6 Motion

New-row entry uses the M5 action-line cross-fade language (~120ms opacity, no layout shift);
the "new events" badge fades in/out; everything behind `motion-safe:`, instant under
`prefers-reduced-motion`. No springs, no new tokens.

## 5. Testing

TDD throughout; every task's gate is `npm test && npm run typecheck && npm run web:build`
(the M5 process lesson — the bundler runs per task now).

- **Integration (real Postgres):** filtered stream route — wrong-workspace frames filtered with
  the watermark advancing, agent/type/kind filters, `Last-Event-ID` replay across a filter set,
  400 on malformed filters; history route — cursor paging, filter union, exhaustion,
  `limit` cap, 404; sparkline bucketing — zero-fill, minute boundaries, per-agent grouping in
  one query.
- **Hook tests (jsdom):** `useActivityStream` — append+dedup, reconnect resume, filter change
  teardown/reset, `loadOlder` prepend and exhaustion, live sparkline rotation; patterned on the
  `useWorkspaceStream` tests.
- **Component tests:** card registry — a render smoke test per type driven off the exhaustive
  map (a type without a card fails compile; a card that throws fails the loop); payload
  expand/collapse; live-follow pinning and the badge; filter chips ↔ URL round-trip.
- **The M4 protected files stay untouched:** `useOverview.test.tsx`'s original tests survive the
  `AgentCardData.sparkline` addition with fixture-only edits.

## 6. Milestone Gate

Spec §12.4's bar: **events appear within one second of occurrence.**

- **Measured half (fake adapter):** demo up, Activity open; for each of a run's events, compare
  the event's `ts` against the client's arrival time over the SSE stream; assert the p95 gap
  under one second (expectation: ~100ms — NOTIFY-driven, no polling in the loop).
- **By-eyes half (real CLI, M3–M5 tradition):** watch a real run stream into the timeline;
  exercise every filter dimension under live load; scroll deep into history while events land;
  watch both sparklines move; confirm an intervention (pause from the panel) appears in the
  timeline as its intervention card within the second. Findings become gate-fix tasks.
