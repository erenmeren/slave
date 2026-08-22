# M6: Activity Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, filterable, infinitely scrollable Activity timeline page, backed by a
server-filtered SSE stream and seq-cursor history paging, with per-type rich cards and
tool-call sparklines (workspace header + per-agent Overview cards).

**Architecture:** The existing `packages/events` SSE machinery gains a per-connection filter
predicate (the M4 route is untouched — no predicate means today's behaviour). A new history
endpoint pages the event log by seq cursor with the same filter vocabulary. The client gets a
new stream-shaped hook (`useActivityStream` — append log, not snapshot+refetch), a virtualized
list with live-follow etiquette, and an exhaustive per-event-type card registry.

**Tech Stack:** TypeScript, Prisma/Postgres, Next.js 15 App Router, Tailwind v4, vitest +
testing-library, zod, `@tanstack/react-virtual` (the milestone's one new dependency).

**Spec:** `docs/superpowers/specs/2026-08-22-m6-activity-timeline-design.md`

## Global Constraints

- Every M6 surface is read-only: `apps/web` never writes through Prisma; no new mutation routes
  (spec §3.5, M5 §1 carried forward).
- The M4 `/events` SSE route and all its consumers keep byte-identical behaviour (spec §3.2).
- The M4-protected `apps/web/test/useOverview.test.tsx` original tests stay green with
  fixture-only edits — never new assertions inside existing tests (spec §5).
- Filter vocabulary: `agents`, `tasks`, `types` (dotted domain types), `kinds` (exactly
  `runs, tool_calls, tasks, interventions, guardrails`); `types` ∪ expanded `kinds`; AND across
  dimensions, OR within one; malformed filters are HTTP 400 (spec §3.1–3.2).
- The card registry is `Record<DomainEventType, …>` — exhaustive, a new event type is a compile
  error (spec §4.5). Same rule for the kind map (`Record<ActivityKind, readonly DomainEventType[]>`
  covering all 20 types).
- History page `limit` caps at 200; default page size 100 (spec §3.3).
- All new motion behind `motion-safe:`; no springs; no new colour tokens; status colours reuse
  `bg-status-*`/`text-status-*` (spec §4.6).
- Sparklines: `number[10]`, one bucket per minute over the last 10 minutes, tool calls only,
  zero-filled; ONE grouped query per surface — no N+1 (spec §3.5).
- Tests: TDD; unit under `apps/web/test/`, integration (real Postgres, port 5433) under
  `apps/web/test/integration/`; run one file with `npx vitest run <path>`.
- **Every task's full gate: `npm test && npm run typecheck && npm run web:build`** (the M5
  process lesson — the bundler runs per task).
- Commits: conventional prefixes as in the log (`feat(web): …`, `feat(events): …`).

---

### Task 1: Filter vocabulary — kinds map, parsing, matching

**Files:**
- Create: `apps/web/src/lib/activityFilters.ts`
- Test: `apps/web/test/activityFilters.test.ts`

**Interfaces:**
- Consumes: `DomainEventType` from `@ai-team-os/db` (`packages/db/src/enums.ts` — the dotted
  domain type union; also exports `EVENT_TYPE_BY_DOMAIN_TYPE` whose keys are all 20 types).
- Produces (all later tasks import these from `../lib/activityFilters` /
  `../../lib/activityFilters`):

```ts
export const ACTIVITY_KINDS = ['runs', 'tool_calls', 'tasks', 'interventions', 'guardrails'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const TYPES_BY_KIND: Record<ActivityKind, readonly DomainEventType[]>
export interface ActivityFilters {
  readonly agents: readonly string[]      // empty = all
  readonly tasks: readonly string[]
  readonly types: readonly DomainEventType[]  // ALREADY the union of ?types and expanded ?kinds
}
export const EMPTY_ACTIVITY_FILTERS: ActivityFilters
export function parseActivityFilters(params: URLSearchParams):
  { ok: true; filters: ActivityFilters } | { ok: false; error: string }
export function eventMatchesFilters(
  event: { readonly agentId: string | null; readonly taskId: string | null; readonly type: string },
  filters: ActivityFilters,
): boolean
```

This module is pure (no prisma, no React) — it is imported by server routes AND client hooks,
exactly like `feedSummary` (ruling R3 precedent).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/activityFilters.test.ts` — the load-bearing cases:

```ts
import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@ai-team-os/db'
import {
  ACTIVITY_KINDS, EMPTY_ACTIVITY_FILTERS, TYPES_BY_KIND,
  eventMatchesFilters, parseActivityFilters,
} from '../src/lib/activityFilters'

describe('TYPES_BY_KIND', () => {
  it('assigns every domain event type to exactly one kind', () => {
    const assigned = ACTIVITY_KINDS.flatMap((kind) => TYPES_BY_KIND[kind])
    const all = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE)
    expect([...assigned].sort()).toEqual([...all].sort())
  })
})

describe('parseActivityFilters', () => {
  it('parses lists and expands kinds into the types union', () => {
    const result = parseActivityFilters(new URLSearchParams('agents=a1,a2&kinds=guardrails&types=run.output'))
    if (!result.ok) throw new Error(result.error)
    expect(result.filters.agents).toEqual(['a1', 'a2'])
    expect([...result.filters.types].sort()).toEqual(['guardrail.tripped', 'run.output'])
  })
  it('returns EMPTY-shaped filters for no params', () => {
    const result = parseActivityFilters(new URLSearchParams())
    if (!result.ok) throw new Error(result.error)
    expect(result.filters).toEqual(EMPTY_ACTIVITY_FILTERS)
  })
  it('rejects an unknown kind and an unknown type', () => {
    expect(parseActivityFilters(new URLSearchParams('kinds=nonsense')).ok).toBe(false)
    expect(parseActivityFilters(new URLSearchParams('types=run.exploded')).ok).toBe(false)
  })
})

describe('eventMatchesFilters', () => {
  const event = { agentId: 'a1', taskId: 't1', type: 'run.tool_call' }
  it('matches everything on empty filters', () => {
    expect(eventMatchesFilters(event, EMPTY_ACTIVITY_FILTERS)).toBe(true)
  })
  it('ANDs across dimensions and ORs within one', () => {
    const f = { agents: ['a1', 'a9'], tasks: [], types: ['run.tool_call' as const] }
    expect(eventMatchesFilters(event, f)).toBe(true)
    expect(eventMatchesFilters({ ...event, agentId: 'a2' }, f)).toBe(false)
    expect(eventMatchesFilters({ ...event, type: 'run.output' }, f)).toBe(false)
  })
  it('an agent filter excludes events with no agentId', () => {
    expect(eventMatchesFilters({ ...event, agentId: null }, { agents: ['a1'], tasks: [], types: [] })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/web/test/activityFilters.test.ts`
  → FAIL (module not found).

- [ ] **Step 3: Implement.** `TYPES_BY_KIND` per spec §3.1 verbatim (runs: started/succeeded/
  failed/paused/resumed; tool_calls: tool_call/output; tasks: the 8 task.* types; interventions:
  pause_requested/resume_requested/stopped/agent.message_sent; guardrails: tripped). Use
  `as const satisfies Record<ActivityKind, readonly DomainEventType[]>`. Parsing: zod — comma
  lists via `.transform(s => s.split(',').filter(Boolean))`, types validated against
  `Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE)`, kinds against `ACTIVITY_KINDS`; expansion + union +
  dedupe in the transform. Matching: three guards, each `list.length === 0 || list.includes(…)`.

- [ ] **Step 4: Run to verify pass**, then the full gate:
  `npm test && npm run typecheck && npm run web:build`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): the activity filter vocabulary — kinds, parsing, matching"
```

---

### Task 2: History endpoint — indexes, `buildActivityHistory`, GET route

**Files:**
- Create: `apps/web/src/server/activity.ts`,
  `apps/web/src/app/api/w/[workspaceId]/activity/route.ts`,
  `packages/db/prisma/migrations/<timestamp>_m6_activity_indexes/migration.sql` (via
  `prisma migrate dev --name m6_activity_indexes` after editing the schema)
- Modify: `packages/db/prisma/schema.prisma` (two indexes on `ExecutionEvent`)
- Test: `apps/web/test/integration/activity-history.test.ts`

**Interfaces:**
- Consumes: Task 1's `ActivityFilters`, `parseActivityFilters`; `feedSummary` from
  `apps/web/src/lib/feedSummary.ts`; `DOMAIN_EVENT_TYPE_BY_DB_VALUE` /
  `EVENT_TYPE_BY_DOMAIN_TYPE` from `@ai-team-os/db` (the DB stores the enum; convert filter
  types to DB values for the `where`, and row types back to dotted domain form for the wire —
  copy how `packages/events`' read path does it).
- Produces:

```ts
// server/activity.ts
export interface ActivityEventRow {
  readonly seq: number
  readonly ts: string            // ISO
  readonly type: DomainEventType // dotted
  readonly actor: string
  readonly agentId: string | null
  readonly taskId: string | null
  readonly runId: string | null
  readonly payload: Record<string, unknown>
  readonly summary: string       // feedSummary(type, payload)
}
export interface ActivityHistoryPage {
  readonly events: readonly ActivityEventRow[]  // seq DESCENDING (newest first)
  readonly nextBefore: number | null            // null = history exhausted
}
export const ACTIVITY_PAGE_LIMIT_DEFAULT = 100
export const ACTIVITY_PAGE_LIMIT_MAX = 200
export async function buildActivityHistory(
  workspaceId: string,
  filters: ActivityFilters,
  options?: { readonly before?: number; readonly limit?: number },
): Promise<ActivityHistoryPage | null>   // null = unknown workspace
```

- Route: `GET /api/w/[workspaceId]/activity?agents=&tasks=&types=&kinds=&before=&limit=` —
  200 with `ActivityHistoryPage` JSON; 400 `{ error }` on bad filters/cursor; 404 unknown
  workspace (copy the shape of `overview/route.ts` + the 404 copy `no workspace with id …`).

- [ ] **Step 1: Add the indexes.** In `schema.prisma`'s `ExecutionEvent`, after the existing
  `@@index([workspaceId, seq])`:

```prisma
  @@index([workspaceId, agentId, seq])
  @@index([workspaceId, taskId, seq])
```

Run `npx prisma migrate dev --name m6_activity_indexes --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts`,
then `npm run db:migrate:test` so the test DB matches. `npm run db:generate`.

- [ ] **Step 2: Write the failing integration tests**

`apps/web/test/integration/activity-history.test.ts` — fixtures per
`apps/web/test/integration/overview.test.ts` (same TRUNCATE list + seeding helpers). Seed one
workspace, two agents, two tasks, and ~30 events across types (use `appendEvent` from
`@ai-team-os/events` so rows are real). Cases:

```ts
it('pages newest-first by seq cursor and reports nextBefore', async () => {
  const page1 = await buildActivityHistory(ws.id, EMPTY_ACTIVITY_FILTERS, { limit: 10 })
  expect(page1?.events).toHaveLength(10)
  expect(page1!.events[0]!.seq).toBeGreaterThan(page1!.events[9]!.seq)
  const page2 = await buildActivityHistory(ws.id, EMPTY_ACTIVITY_FILTERS, { before: page1!.nextBefore!, limit: 10 })
  expect(page2!.events[0]!.seq).toBeLessThan(page1!.events[9]!.seq)
})
it('reaches exhaustion with nextBefore null', /* page past the oldest row */)
it('applies the filter union — agent AND (types ∪ kinds)', /* seed distinguishable events */)
it('caps limit at 200 and defaults to 100', /* request limit=999, assert ≤200 */)
it('returns null for an unknown workspace', /* buildActivityHistory('0000…') === null */)
it('every row carries a non-empty summary and dotted type', /* summary !== '', type contains '.' */)
it('the route 400s malformed filters and 404s an unknown workspace', /* call GET directly */)
```

- [ ] **Step 3: Run to verify failure**, then implement. `buildActivityHistory`: workspace
  existence check (`findUnique` → null); one `prisma.executionEvent.findMany` with
  `where: { workspaceId, …(filters.agents.length ? { agentId: { in } } : {}), …tasks,
  …(filters.types.length ? { type: { in: filters.types.map(toDbType) } } : {}),
  …(before ? { seq: { lt: before } } : {}) }`, `orderBy: { seq: 'desc' }`,
  `take: min(limit ?? 100, 200)`. Map rows: `Number(seq)`, `ts.toISOString()`, DB type → dotted,
  `summary: feedSummary(...)`. `nextBefore`: last row's seq, or null when `rows.length < take`.
  The route: parse filters (400 on `ok: false`), parse `before`/`limit` as positive ints (400
  otherwise), `force-dynamic`, 404 copy verbatim from the overview route.

- [ ] **Step 4: Run the file, then the full gate** —
  `npm test && npm run typecheck && npm run web:build`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web,db): activity history paging with filter vocabulary and event-log indexes"
```

---

### Task 3: Filtered SSE stream — predicate in `createEventSse`, activity stream route

**Files:**
- Modify: `apps/web/src/server/sse.ts` (optional `filter` predicate)
- Create: `apps/web/src/app/api/w/[workspaceId]/activity/stream/route.ts`
- Test: `apps/web/test/integration/activity-stream.test.ts` (fixtures/reader helpers copied
  from `apps/web/test/integration/sse.test.ts` — it already reads SSE bodies incrementally)

**Interfaces:**
- Consumes: Task 1's `parseActivityFilters`/`eventMatchesFilters`; `createEventSse` and
  `parseFromSeq` (existing).
- Produces: `EventSseOptions` gains
  `readonly filter?: (event: ExecutionEvent) => boolean` — applied AFTER the workspace check;
  a rejected frame is not written but `lastSeen` still advances (it already does — the
  advance happens before the workspace check; keep that ordering). The M4 `/events` route
  passes no filter and is untouched.
- Route: `GET /api/w/[workspaceId]/activity/stream?agents=&tasks=&types=&kinds=&from=` — SSE;
  400 `{ error }` on malformed filters (before any stream is opened).

- [ ] **Step 1: Write the failing integration tests** — cases:

```ts
it('streams only events matching the filters, and heartbeats advance the watermark past filtered spans',
  /* open stream filtered to agents=a1; append events for a1 and a2; read frames: only a1's
     appear; the next id (heartbeat or frame) is > the filtered a2 event's seq */)
it('replays from Last-Event-ID across a filtered gap with no duplicate and no gap',
  /* same technique as sse.test.ts's replay case, with a filter active */)
it('400s malformed filters without opening a stream', /* kinds=nonsense → status 400 */)
it('the M4 events route still streams unfiltered', /* one smoke: existing route serves an event */)
```

- [ ] **Step 2: Run to verify failure**, then implement. In `sse.ts`'s `onEvent`, after the
  workspace check: `if (options.filter !== undefined && !options.filter(event)) return` —
  everything else untouched. The route mirrors `events/route.ts` (Last-Event-ID ?? `from`,
  DATABASE_URL guard) plus filter parsing → `createEventSse({ …, filter: (e) =>
  eventMatchesFilters(e, filters) })`. Note: `createEventStream` delivers dotted domain-typed
  events (its read path converts) — `eventMatchesFilters` compares dotted types; confirm
  against `packages/events/src/read.ts` and say so in the report.

- [ ] **Step 3: Run the file, then the full gate.**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): server-filtered activity SSE stream over the shared machinery"
```

---

### Task 4: Sparkline aggregation — `buildActivityPage` + per-agent buckets on the Overview

**Files:**
- Modify: `apps/web/src/server/activity.ts` (add `buildActivityPage` + `toolCallSparkline`),
  `apps/web/src/server/overview.ts` (`AgentCardData.sparkline`)
- Test: extend `apps/web/test/integration/activity-history.test.ts` (sparkline describe),
  extend `apps/web/test/integration/overview.test.ts` (additive tests only)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:

```ts
// server/activity.ts additions
export interface ActivityPage extends ActivityHistoryPage {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly sparkline: readonly number[]  // length 10, oldest minute first, run.tool_call counts
}
export async function buildActivityPage(workspaceId: string): Promise<ActivityPage | null>
// server/overview.ts: AgentCardData gains
readonly sparkline: readonly number[]   // length 10, same semantics, this agent's tool calls
```

- [ ] **Step 1: Failing tests.** Activity side: seed tool calls with controlled `ts` values
  (write `ExecutionEvent` rows directly with prisma in the fixture — reads are being tested, and
  `appendEvent` stamps now()); assert a 10-length zero-filled array with counts in the right
  minute buckets and non-tool-call types excluded. Overview side (additive): two agents with
  different tool-call minutes → each card's `sparkline` reflects only its own; an agent with no
  events → all zeros; and assert the implementation issues ONE grouped query (assert via
  `prisma.$queryRaw` usage or simply document the single-query shape in the test name and
  verify per-agent correctness — the review checks the query count in code).
- [ ] **Step 2: Run to verify failure**, then implement. One raw query per surface:

```ts
const rows = await prisma.$queryRaw<Array<{ agent_id: string | null; minute: Date; n: bigint }>>`
  SELECT "agentId" as agent_id, date_trunc('minute', ts) as minute, count(*) as n
  FROM "ExecutionEvent"
  WHERE "workspaceId" = ${workspaceId} AND type = 'run_tool_call'::"EventType"
    AND ts >= now() - interval '10 minutes'
  GROUP BY 1, 2`
```

(Check the real enum literal spelling against the schema — the M5 gate showed `type::text`
renders dotted; if the cast fails, filter via Prisma `groupBy` on the mapped enum instead and
note it.) Bucket into `number[10]` keyed by minutes-ago; workspace variant ignores `agent_id`,
overview variant maps by it. `buildActivityPage` = workspace row + first history page
(no filters) + sparkline.

- [ ] **Step 3: Run both files, then the full gate.** Confirm the M4-protected `useOverview`
  tests needed only fixture edits.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): tool-call sparkline buckets for the activity page and agent cards"
```

---

### Task 5: `useActivityStream` hook

**Files:**
- Create: `apps/web/src/hooks/useActivityStream.ts`
- Test: `apps/web/test/useActivityStream.test.tsx` (EventSource/fetch mocks per
  `useWorkspaceStream.test.tsx`)

**Interfaces:**
- Consumes: Task 1's `ActivityFilters` (+ a `filtersToQuery(filters): string` helper — add it
  to `activityFilters.ts` here, exported, with a unit test in the existing file), Task 2's
  `ActivityEventRow`/`ActivityHistoryPage` types, Task 4's `ActivityPage`.
- Produces:

```ts
export function useActivityStream(options: {
  readonly workspaceId: string
  readonly filters: ActivityFilters
  readonly initial: ActivityPage        // server-rendered page 1 (unfiltered)
}): {
  readonly events: readonly ActivityEventRow[]   // seq ASCENDING (oldest first, render order)
  readonly connection: 'connected' | 'reconnecting'
  readonly loadOlder: () => void
  readonly loadingOlder: boolean
  readonly exhausted: boolean
  readonly sparkline: readonly number[]          // live-rotated copy of initial.sparkline
  readonly error: string | null                  // loadOlder/refetch failures
}
```

Behaviour contract (each line is a test):
- Mounts with `initial.events` reversed to ascending; opens EventSource at
  `/api/w/<id>/activity/stream?<filtersToQuery>&from=<newest seq>`.
- Appends arriving events in seq order; deduplicates by seq.
- SSE events are raw `ExecutionEvent` envelopes — derive `summary` client-side with
  `feedSummary` (same import the panel feed uses).
- Filter change (deep inequality): close the source, reset the buffer to `[]`, fetch page 1
  from the history route with the new filters, reopen the stream from the new newest seq.
- `loadOlder()`: GET `before=<oldest seq>`; prepend; `exhausted` on `nextBefore: null`; one
  in-flight load at a time (`loadingOlder`).
- Reconnect: `onerror` → `reconnecting`; browser EventSource replays via Last-Event-ID (the
  route honours it) — on `onopen`, back to `connected`.
- Sparkline: `run.tool_call` arrival increments the current bucket; a minute-boundary timer
  rotates buckets left (test with fake timers).
- Unmount closes the source and clears the timer.

- [ ] **Step 1: Write the failing tests** (one per contract line above, mirroring
  `useWorkspaceStream.test.tsx`'s FakeEventSource pattern).
- [ ] **Step 2: Run to verify failure**, then implement (callbacks via refs where identity
  churn matters; effect deps `[workspaceId, filterKey]` where `filterKey` is a stable
  serialisation of filters).
- [ ] **Step 3: Run the file, then the full gate.**
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): useActivityStream — filtered live log with cursor history"
```

---

### Task 6: Card registry — shared primitives + all 20 cards

**Files:**
- Create: `apps/web/src/components/activity/ActivityCard.tsx` (shared shell: time, actor
  badge, agent/task links, collapsible raw-payload `<details>`),
  `apps/web/src/components/activity/cards.tsx` (the registry + the 20 card bodies)
- Test: `apps/web/test/activity-cards.test.tsx`

**Interfaces:**
- Consumes: Task 2's `ActivityEventRow`; existing status tokens; `feedSummary` only as
  fallback copy (each card renders its own body).
- Produces:

```ts
export interface ActivityCardProps {
  readonly event: ActivityEventRow
  readonly workspaceId: string
  readonly agentName: string | null   // resolved by the page from its roster; null = show id
  readonly taskTitle: string | null
}
export const ACTIVITY_CARDS: Record<DomainEventType, (props: ActivityCardProps) => ReactElement>
```

Card bodies (spec §4.5): `run.tool_call` tool + primary argument un-truncated on expand;
`run.output` text block; run lifecycle types as status-coloured transition lines (failures show
`payload.reason`, `run.paused` shows `atStep`); the 8 `task.*` types as status transitions with
title (rework/verify_failed show the reason); the 4 intervention types show actor and any
message text; `guardrail.tripped` shows limit name, bound, observed value (read the real
payload shape from `packages/domain/src/events/schema.ts` — copy field names exactly).

- [ ] **Step 1: Failing tests.** (a) A registry smoke loop driven off the map itself:

```ts
for (const type of Object.keys(ACTIVITY_CARDS) as DomainEventType[]) {
  it(`renders a ${type} card with a payload section`, () => {
    render(<Card event={fixtureFor(type)} … />)   // fixtureFor: minimal valid payload per type
    expect(screen.getByTestId('payload-toggle')).toBeInTheDocument()
  })
}
```

(b) Targeted body assertions for the load-bearing cards: tool_call shows the tool name;
run.failed shows the reason; guardrail.tripped shows limit+value; an intervention shows the
actor; task.rework shows the reason. (c) Payload expands to pretty-printed JSON on toggle.
- [ ] **Step 2: Run to verify failure**, then implement. The registry is
  `satisfies Record<DomainEventType, …>` so exhaustiveness is compile-checked.
- [ ] **Step 3: Run the file, then the full gate.**
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): the activity card registry — a component per event type"
```

---

### Task 7: Filter bar + URL state

**Files:**
- Create: `apps/web/src/hooks/useUrlFilters.ts`, `apps/web/src/components/activity/FilterBar.tsx`
- Test: `apps/web/test/activity-filterbar.test.tsx`

**Interfaces:**
- Consumes: Task 1's vocabulary (+ `filtersToQuery`), `useSelectedId`'s pattern
  (`useSearchParams` + shallow `router.replace` — copy the idiom, generalised to the three
  list params + kinds).
- Produces:

```ts
export function useUrlFilters(): {
  readonly filters: ActivityFilters
  readonly kinds: readonly ActivityKind[]      // the raw selected kinds, for chip state
  readonly rawTypes: readonly DomainEventType[] // the raw ?types, for the advanced popover
  readonly setKinds: (kinds: readonly ActivityKind[]) => void
  readonly setRawTypes: (types: readonly DomainEventType[]) => void
  readonly setAgents: (ids: readonly string[]) => void
  readonly setTasks: (ids: readonly string[]) => void
}
export function FilterBar(props: {
  readonly agents: readonly { id: string; name: string }[]
  readonly tasks: readonly { id: string; title: string }[]
  // …the useUrlFilters surface, passed down
}): ReactElement
```

- [ ] **Step 1: Failing tests:** chip toggle updates the URL (`router.replace` mock asserted);
  URL state round-trips through `useUrlFilters` (seed `useSearchParams` mock, assert parsed
  filters); the advanced popover lists all 20 types and toggling one lands in `?types=`;
  agent/task selects render the roster and write ids.
- [ ] **Step 2: Run to verify failure**, then implement. Five kind chips + "Advanced" popover
  (a `<details>`-based popover — no new dependency) + two multi-select dropdowns. Selected
  chips use the existing token language.
- [ ] **Step 3: Run the file, then the full gate.**
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): the activity filter bar with URL-carried state"
```

---

### Task 8: The Activity page — virtualized list, live-follow, Sidebar

**Files:**
- Create: `apps/web/src/app/w/[workspaceId]/activity/page.tsx`,
  `apps/web/src/components/activity/ActivityClient.tsx`,
  `apps/web/src/components/activity/Timeline.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (Activity goes live — drop it from `INERT`,
  Tasks precedent), `apps/web/package.json` (`@tanstack/react-virtual`), root lockfile
- Test: `apps/web/test/activity-page.test.tsx`; extend `apps/web/test/shell.test.tsx`
  (Activity link + aria-current, additive)

**Interfaces:**
- Consumes: Tasks 4 (`buildActivityPage`), 5 (`useActivityStream`), 6 (`ACTIVITY_CARDS`),
  7 (`FilterBar`, `useUrlFilters`); Sidebar/TopBar composition per `TasksClient`.
- Produces: `/w/[workspaceId]/activity`; `Timeline` renders rows through the registry inside a
  `useVirtualizer` viewport with `measureElement` dynamic heights.

- [ ] **Step 1: `npm install @tanstack/react-virtual` (workspace: `apps/web`).**
- [ ] **Step 2: Failing tests:** page renders seed events through their per-type cards
  (newest at the bottom); "↓ N new events" badge appears when events arrive while scrolled up
  (mock the virtualizer's scroll state or drive the container's scrollTop) and clicking it
  pins back to the bottom; pinned-at-bottom auto-follows (badge never appears); nearing the top
  calls `loadOlder` exactly once per approach; Sidebar shows Activity as a live link with
  aria-current on the activity route; unknown workspace 404 copy.

Note (jsdom): `@tanstack/react-virtual` needs element size mocks — set
`HTMLElement.prototype.getBoundingClientRect`/`offsetHeight` in the test setup the way the
virtualizer's own testing docs recommend; keep the helper local to this file.

- [ ] **Step 3: Run to verify failure**, then implement. `page.tsx` mirrors the tasks page
  (server `buildActivityPage`, 404 copy, `key={workspaceId}`). `ActivityClient`: TopBar
  (workspace name + connection from the hook) + FilterBar + workspace sparkline (placeholder
  slot — Task 9 fills the SVG; render the numbers' container now) + `Timeline`. Follow state:
  `pinned` boolean derived from scroll position (within one row-height of the bottom);
  `pendingCount` accumulates while unpinned.
- [ ] **Step 4: Run the file, then the full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): the activity page — virtualized timeline with live follow"
```

---

### Task 9: Sparkline components — header + agent-card mini

**Files:**
- Create: `apps/web/src/components/Sparkline.tsx` (one component, two sizes via props)
- Modify: `apps/web/src/components/activity/ActivityClient.tsx` (mount the header sparkline),
  `apps/web/src/components/AgentCard.tsx` (mini sparkline from `agent.sparkline`)
- Test: `apps/web/test/sparkline.test.tsx`; extend `apps/web/test/overview-components.test.tsx`
  (additive: card renders the svg when data present)

**Interfaces:**
- Consumes: Task 4's `number[10]` shape (overview + activity), Task 5's live-rotated copy.
- Produces:

```ts
export function Sparkline(props: {
  readonly buckets: readonly number[]
  readonly width: number      // header: 160, card: 60
  readonly height: number     // header: 24, card: 16
  readonly label: string      // aria-label, e.g. 'tool calls, last 10 minutes'
}): ReactElement
```

Pure SVG polyline: points scaled to max(buckets, 1); a flat zero line renders at the baseline
(the "stuck agent" cue); `role="img"` + aria-label; stroke uses `currentColor` so the parent's
text token colours it — no new tokens.

- [ ] **Step 1: Failing tests:** 10 points scale to the max; all-zero renders a baseline
  polyline (not an empty svg); aria-label present; AgentCard shows the mini svg.
- [ ] **Step 2: Run to verify failure**, then implement + wire both mounts.
- [ ] **Step 3: Run both files, then the full gate.** M4-protected file check again.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): tool-call sparklines on the activity header and agent cards"
```

---

### Task 10: Motion pass

**Files:**
- Modify: `apps/web/src/components/activity/Timeline.tsx` (row-entry cross-fade),
  `apps/web/src/components/activity/ActivityClient.tsx` (badge fade),
  `apps/web/src/app/globals.css` (reuse `action-line-in`; add a badge keyframe only if the
  existing one cannot serve)
- Test: extend `apps/web/test/activity-page.test.tsx` (mechanism assertions)

**Interfaces:** none new — closes spec §4.6.

- [ ] **Step 1: Failing tests (mechanism, jsdom):** a newly arrived row's wrapper carries
  `motion-safe:animate-[action-line-in_120ms_ease-out]` and a key by seq (remount = animation
  runs); rows loaded via `loadOlder` do NOT carry the entry animation class (history is not
  "new"); the badge carries its `motion-safe:` fade class.
- [ ] **Step 2: Run to verify failure**, then implement. Track the "live boundary" seq (newest
  seq at mount / after each loadOlder) — only rows above it animate.
- [ ] **Step 3: Run the file, then the full gate.**
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): the M6 motion pass — row entry cross-fade and badge fade"
```

---

### Task 11: Docs, latency measurement, and the gate rehearsal

**Files:**
- Modify: `README.md` (Web UI section: the Activity page, filters, sparklines),
  `docs/architecture.md` (the filtered-SSE addition to the transport story)
- Create: `scripts/measure-activity-latency.mjs` (the gate's measured half)
- Test: none new — the verification is the script run + the full suite

**Interfaces:** none.

- [ ] **Step 1: Docs.** README: the board/panel section gains the Activity page — URL, the five
  kind chips + advanced types, infinite scroll, the one-second liveness bar, both sparklines.
  architecture.md: one paragraph — the activity stream is the same `packages/events` machinery
  with a per-connection server-side predicate; watermark semantics unchanged.
- [ ] **Step 2: The measurement script.** `scripts/measure-activity-latency.mjs` (tools
  tsconfig covers `scripts/` — plain .mjs like `demo-live.mjs`): seeds a workspace (reuse
  `demo-live.mjs`'s seed shape with the fake adapter), opens the activity stream with plain
  `fetch`, then appends N=50 events via `appendEvent` at 100ms intervals, recording for each
  the gap between the event's `ts` and the frame's arrival. Prints min/p50/p95/max and exits
  non-zero if p95 ≥ 1000ms (spec §6's bar).
- [ ] **Step 3: Run the rehearsal.** `docker compose up -d` if needed; run the script; paste
  its output into the report. Fix what it finds before calling the task done.
- [ ] **Step 4: Full gate** — `npm test && npm run typecheck && npm run web:build`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(m6): activity page docs and the one-second latency measurement"
```

---

## Milestone Gate (after all tasks; not a plan task)

Spec §6, by eyes, against the real `claude` CLI (M3–M5 tradition): a real run streaming into
the timeline live; every filter dimension exercised under load; deep history scroll while
events land; both sparklines moving; a panel-initiated pause appearing as its intervention card
within the second. Findings become gate-fix tasks.

## Self-Review Notes

**Spec coverage:** §1 scope → Tasks 8 (page+Sidebar), 3 (stream), 2 (history), 6 (cards),
4+9 (sparklines); §2 decisions → honoured per task; §3.1 vocabulary → Task 1; §3.2 stream →
Task 3; §3.3 history → Task 2; §3.4 indexes → Task 2; §3.5 aggregation + read-only → Task 4;
§4.1 page → Task 8; §4.2 hook → Task 5; §4.3 virtualization → Task 8; §4.4 filter bar →
Task 7; §4.5 registry → Task 6; §4.6 motion → Task 10; §5 testing → distributed; §6 gate →
Task 11 (measured) + closing section (by eyes).

**Ordering:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasks 6 and 7 are independent of
5 and of each other; keep numbered order unless parallelizing.

**Known risks:** (1) The `EventType` enum's raw Postgres literal in Task 4's `$queryRaw` — the
schema uses `@map`ped values; if the cast form fails, fall back to Prisma `groupBy` and note
it. (2) `useSearchParams` under `next build` may demand a `<Suspense>` boundary (M5 Known Risk
2 — it did not bite in M5, but the activity page leans harder on search params); wrap at the
page level if the build complains. (3) jsdom + `@tanstack/react-virtual` needs measured-size
mocks; if `measureElement` proves untestable, assert through the item renderer instead and say
so. (4) Copy real fixture helpers from the named neighbouring test files — never invent new
seeding shapes.
