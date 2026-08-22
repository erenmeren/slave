# M7: Graph — Design

**Date:** 2026-08-22
**Parent:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` §12.4 ("Graph — two modes
only: Organization and Task Dependency DAG. React Flow + ELK.js, live status colours, node
context menus") and the M7 gate row ("live status reflected in nodes"). §12.1's motion rule
binds throughout: **every movement must carry information**.
**Builds on:** M4's hybrid liveness rule (`useWorkspaceStream`), M5's control plane and refusal
taxonomy, M6's Activity filters (deep links) and exhaustive event maps.

## 1. Scope

- **Graph page** — `/w/[workspaceId]/graph`, two mode tabs carried in the URL (`?mode=org` |
  `?mode=deps`, default `org`). The Sidebar's last inert item goes live.
- **Organization mode** — workspace → team → agent hierarchy with live status, active-task
  edges, and the flow visualization (§6).
- **Dependencies mode** — the task DAG from `TaskDependency`, status-coloured, with
  `dependenciesDone` surfaced ("waiting on N"), and **edge editing**: dependencies are created
  and removed from the graph.
- **Control operations** — `addTaskDependency`/`removeTaskDependency` in `packages/control`
  with a cycle-refusing claim, two web routes, and two new domain event types.
- **Node context menus** — navigation only: open the agent panel, open the task on the board,
  show either in Activity (M6 filter deep links). Interventions stay in the panel (M5's
  "one place to watch the outcome" decision).

Out of M7: the other three graph modes (execution / skill-execution / communication), the ⌘K
palette, task creation/editing from the UI (edges are the one deliberate exception — see §2),
minimap/export, server-computed layout.

## 2. Decisions of Record

| Decision | Choice | Rejected alternative |
|---|---|---|
| Context menus | Navigation + panel deep links only | Direct pause/resume/stop from the menu; no menus at all |
| DAG data | **Edge editing from the UI** (create/remove dependencies) | Read-only over seeded rows; deferring the DAG to M8 |
| Org pulse | **Full flow visualization** (event-driven particles + status flashes + completion waves) | Status colours only; status + assignment edges without particles |
| Data plane | House pattern: snapshot + SSE-wake refetch + raw frames for effects | Graph-specific SSE with server diffs; no layout engine |

On the parent spec's "task mutation from the UI is out of MVP": edge editing is a deliberate,
narrow exception — it mutates the wiring between tasks, never a task's own fields, it flows
through `packages/control` like every other mutation, and the scheduler already honours it
(`dependenciesDone` gates `decide()` via the `NOT EXISTS` computation in `world.ts`). A drawn
edge has real operational effect immediately, which is exactly why the DAG is "operationally
required": it answers *and now also controls* "why is nothing progressing?".

## 3. Data Plane

### 3.1 Read model

`apps/web/src/server/graph.ts`:

```ts
export interface GraphAgent {
  readonly id: string; readonly name: string; readonly role: string
  readonly teamId: string
  readonly status: AgentDerivedStatus            // the M4 derivation
  readonly activeTaskId: string | null
  readonly activeTaskTitle: string | null
  readonly activeRunId: string | null
  readonly costUsd: number                       // active run's cost, 0 when idle
}
export interface GraphTask {
  readonly id: string; readonly title: string
  readonly status: TaskStatus
  readonly priority: number
  readonly attempt: number; readonly maxAttempts: number
  readonly dependenciesDone: boolean
}
export interface GraphSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly teams: readonly { readonly id: string; readonly name: string }[]
  readonly agents: readonly GraphAgent[]
  readonly tasks: readonly GraphTask[]
  readonly dependencies: readonly { readonly taskId: string; readonly dependsOnTaskId: string }[]
}
export async function buildGraphSnapshot(workspaceId: string): Promise<GraphSnapshot | null>
```

One payload serves both modes. `dependenciesDone` reuses the `world.ts` `NOT EXISTS` semantics
(computed in the same query shape, not re-derived in JS). `GET /api/w/[workspaceId]/graph`
follows the house route pattern (404 copy, `force-dynamic`).

### 3.2 Liveness

`useGraph(workspaceId, initial)` — a thin composition over `useWorkspaceStream` (the `useTasks`
precedent): every event wakes the debounced snapshot refetch; `onEvent` passes raw frames
through for the flow effects (§6), which never wait for a refetch. No new transport.

### 3.3 Write path — dependency operations

`packages/control/src/dependency.ts`:

```ts
export async function addTaskDependency(
  taskId: string, dependsOnTaskId: string, requestedBy: string,
): Promise<Result<void, ControlRefusal>>
export async function removeTaskDependency(
  taskId: string, dependsOnTaskId: string, requestedBy: string,
): Promise<Result<void, ControlRefusal>>
```

New refusal kinds joining the taxonomy: `task_not_found`, `self_dependency`,
`duplicate_dependency`, `cross_workspace`, `dependency_not_found` (removal of an edge that
does not exist), and **`dependency_cycle`**. The cycle check runs
inside the same transaction as the insert: a recursive CTE walks from `dependsOnTaskId` along
existing `TaskDependency` rows; if `taskId` is reachable, the insert is refused — the DAG can
never acquire a cycle, so the scheduler can never deadlock on one. A dependency on a `done`
task is allowed (vacuously satisfied — consistent with the scheduler's definition). Both
operations append events (§3.4). Removal of a non-existent edge refuses with
`dependency_not_found` rather than succeeding silently.

### 3.4 New event types

`task.dependency_added` and `task.dependency_removed` (actor `human`; payload
`{ dependsOnTaskId, dependsOnTitle, requestedBy }`) join the domain schema and the DB enum
(one migration). M6's exhaustive maps make the rest compile-enforced: both types must be
assigned to the `tasks` kind and given activity cards in the same task that adds them.

### 3.5 Routes

- `POST /api/w/[workspaceId]/tasks/[taskId]/dependencies` — body `{ dependsOnTaskId }`;
  200 `{ ok: true }`, 409 `{ error: refusalText }`, 404 unknown task/workspace, 400 bad body.
- `DELETE /api/w/[workspaceId]/tasks/[taskId]/dependencies/[dependsOnTaskId]` — same contract.

Both are three-liners over a shared shell in the M5 `controlRoute.ts` mould (task-scoped rather
than run-scoped — a sibling helper, not a rewrite).

## 4. The Page

### 4.1 Composition

`/w/[workspaceId]/graph` mirrors the house page pattern (server `buildGraphSnapshot`, 404 copy,
`key={workspaceId}`, Sidebar/TopBar). Mode tabs write `?mode=` via the shallow-replace idiom;
refresh restores the mode. `INERT` in the Sidebar empties.

### 4.2 Canvas

`reactflow` hosts both modes through one `GraphCanvas` (pan/zoom, `fitView`, custom node
types). Layout is client-side async `elkjs`: `mrtree` for org, `layered` with `RIGHT` direction
for deps (edges drawn `dependsOn → task`: "this finishes first" reads left to right). Layout
recomputes only when the node/edge SET changes — a status change repaints, never re-layouts.
ELK runs as a plain async call (MVP graphs are tens of nodes); a scale note, not a worker.

### 4.3 Nodes

- **Org:** workspace root card (halt banner colour when halted), team cards, agent cards in
  the Overview card's mini language — name, role, status dot (`bg-status-*`), the M4 pulse
  while working, one-line active task title.
- **Deps:** task nodes — title, status-coloured border, `attempt/maxAttempts`, and a
  "waiting on N" badge when `ready` with `dependenciesDone === false` (the visual answer to
  "why is nothing progressing?").

### 4.4 Context menus

Right-click (and a keyboard-accessible affordance): agent node → "Open panel"
(`/w/<ws>?agent=<id>`), task node → "Open in board" (`/w/<ws>/tasks?task=<id>`), both →
"Show in Activity" (`/w/<ws>/activity?agents=<id>` / `?tasks=<id>`). No interventions.

### 4.5 Edge editing (deps mode only)

React Flow `onConnect` fires the POST; selecting an edge and pressing Delete (or the edge
menu's "Remove") fires the DELETE. **No optimistic UI** (M5 rule): after any 2xx/409 the
event-driven refetch is the truth — the provisional edge disappears unless the server kept it;
a 409 (`dependency_cycle`, …) renders verbatim in the page's error band.

## 5. Simplifications

- One snapshot payload for both modes; no per-mode endpoints.
- No edge editing in org mode; org topology is configuration, not operator wiring.
- Layout on the client, plain async; no worker, no server layout.
- The error band, tokens, 404 copy, route shells — all reused from M5/M6, nothing re-invented.

## 6. Flow Visualization

Three signals, each fired by a real event (§12.1's rule — no decorative loops):

1. **Tool-call particles (org):** each `run.tool_call` frame from the existing SSE stream fires
   ONE particle along the agent → active-task edge (~600ms, hand-rolled SVG circle on an
   `offset-path` animation — no library). Density under load is the information: overlapping
   particles read as traffic. Caps: at most ~5 concurrent particles per edge (flood guard);
   production pauses while `document.visibilityState !== 'visible'`.
2. **Status flashes:** a node whose status changes flashes its border in the M5 `border-flash`
   language (the existing keyframe, reused) and decays back.
3. **Completion waves (deps):** when a task turns `done`, its outgoing edges flash once —
   "the way is clear" — and the dependents' "waiting on N" badges drop on the same refetch.

All of it behind `motion-safe:`. Under `prefers-reduced-motion`: no particles at all (the same
information lives in status colours and the Activity page), flashes collapse to instant colour
swaps. No springs, no new colour tokens.

## 7. Testing

TDD throughout; every task's gate is `npm test && npm run typecheck && npm run web:build`.

- **Integration (real Postgres):** control operations — cycle refusal (A→B→C standing, C→A
  refused), self/duplicate/cross-workspace/not-found refusals, both event types appended with
  the right payloads; route contracts (200/409/404/400); `buildGraphSnapshot` shape including
  `dependenciesDone` parity with the scheduler's definition.
- **Domain:** the two new event types join the schema tests; the M6 exhaustive maps
  (`TYPES_BY_KIND`, `ACTIVITY_CARDS`) fail compile until extended — extended in the same task.
- **Component (jsdom, ELK mocked, size-mock helper per the M6 pattern):** node/edge rendering
  per mode, mode tab ↔ URL round-trip, context-menu hrefs, `onConnect` → POST and 409 → error
  band with the provisional edge gone, particle mechanism (frame → particle element, per-edge
  cap, `motion-safe:` class, visibility pause).
- Real-browser behaviours (pan/zoom feel, ELK layout quality, particle motion) are gate
  material, explicitly.

## 8. Milestone Gate

Parent gate row: **live status reflected in nodes.**

- **Measured half (fake adapter):** a status-transition script in the
  `measure-activity-latency.mjs` mould — drive a run through `starting → working → paused`,
  sample the graph snapshot endpoint after each transition's event, assert the node's status
  reflects it within the one-second budget end to end.
- **By-eyes half (real CLI, M3–M6 tradition):** particle traffic on the org graph during a real
  run; status transitions flashing live; in deps mode: draw an edge → watch the scheduler
  actually hold the dependent task → complete the dependency → the wave fires and the task
  starts; context-menu navigation to all four surfaces. Findings become gate-fix tasks.
