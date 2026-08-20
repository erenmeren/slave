# Architecture

## Topology

```
packages/domain     pure core: state machines, the event union, decide(). No I/O, no imports.
packages/db         Prisma schema, the generated client, and the row <-> domain mappers.
packages/events     appendEvent (the only write path), the read/stream/subscribe side.
packages/providers  the runtime adapter: spawns `claude`, parses its stream, pauses and resumes it.
apps/orchestrator   the part that reacts: loadWorld, tick, pump, worktree, verify, sweep, CLI.
apps/web            the part that watches: reads Postgres through a snapshot read model, listens
                    for new events through its own SSE routes, writes nothing.
```

## The dependency rule that matters

**`packages/providers` never imports `packages/db`** (spec §2.1).

The adapter's vocabulary is `RuntimeEvent` — a normalized shape with no provider-specific fields and
no rows in it. The orchestrator is what turns a `RuntimeEvent` into an `ExecutionEvent` and an
`AgentRun` update. That boundary is what makes a second provider possible without touching the
schema, and what keeps the adapter testable against a fake CLI with no database anywhere.

The consequence is visible in `Checkpoint`: the adapter defines its own interface for it, and
`packages/db` defines a model with the same fields, because the adapter cannot import the model. The
duplication is deliberate and recorded in the adapter's own doc comment.

**`apps/web` never imports `apps/orchestrator` or `packages/providers`** (spec §2, extended by M4).
The web app is a reader: it builds its own snapshot from `packages/db` and `packages/events`, and
its two route handlers (the Overview page's data and the SSE stream) are the only places that
touch either. It never spawns a process, never writes a row, and never imports the scheduling or
adapter code that does — `pause`, `resume`, `cancel` and the rest of the write path stay CLI-only
until M5 gives the web app buttons that are more than disabled chrome.

## Where a run's state actually lives

| Fact | Home | Written by |
|---|---|---|
| what should happen next | nowhere — it is derived | `decide()`, every tick |
| the scheduling decision's inputs | `World` | `loadWorld`, every tick |
| the run's process | `AgentRun.pid` | the tick, at spawn |
| the run's progress | `AgentRun.sessionId`/`toolCalls`/`status` | the pump, from the stream |
| what the run did | the event log | `appendEvent`, serialised process-wide |
| what a resumed run needs | `Checkpoint` | the pump, when it records a pause |
| the workspace being stopped | `Workspace.haltedReason` | the pump on a gate failure; verify on a misconfiguration |

Nothing important lives only in memory. A daemon that dies loses its timers, its halt-announcement
flag and its in-flight pumps — and nothing else. That is what makes startup reconciliation (§3.4) a
recovery rather than a guess.

## The tick

```
loadWorld  ->  decide  ->  execute  ->  sweep
```

The tick executes `decide()`'s command list rather than iterating tasks itself. That is what makes
the concurrency limit, the budget and the failure breaker hold: they are enforced in one pure
function with its own tests, and the tick cannot start a run the scheduler did not ask for.

Reconciliation of a run's output is **not** in the tick. Each run gets its own pump, concurrent with
the tick (§5.6), because binding event delivery to the tick period would forfeit M6's one-second
requirement by construction.

## Two things called "halt"

- The **`halt` command** is `decide()`'s per-tick output. It is derived, never stored, and it expires
  with the tick that produced it.
- A **workspace halt** is `Workspace.haltedReason`: persistent, raised by a pause gate failure or an
  unverifiable workspace, and cleared only by an operator.

They compose without either changing: while the column is set, every `loadWorld` produces
`stats.emergencyStopped: true`, so `decide()` returns the command every tick. The scheduling stop
persists because its *input* persists, not because the command does.

## Concurrency

- **Ticks** may overlap. The task is claimed with a status-filtered update, so exactly one tick wins
  — in the database rather than in process memory, because a CLI `tick` can run against a live
  daemon.
- **Pumps** run one per active run, concurrently. `appendEvent` serialises appends process-wide,
  because `seq` is assigned at INSERT and rows become visible at COMMIT: two overlapping appends can
  commit out of order, and a reader tracking `seq > lastSeq` would skip one forever.
- **Startup reconciliation** runs before the first tick and refuses to run afterwards. A run that is
  mid-spawn — row created, pid not yet recorded — is indistinguishable from one the pass should fail.

## The web app's hybrid liveness rule

`apps/web` never derives state from the event stream. Structural state — statuses, task counts,
budget, the halt banner — always comes from a fresh server-side snapshot query. The SSE stream
(`/api/w/<workspaceId>/events`) is a **wake-up, not a delivery**: M2's rule (the event log is a
notification channel, not a queue a consumer replays into local state) extended to the browser. Any
event the client receives schedules a debounced snapshot refetch; it never mutates client state
directly.

**The action line is the one exception**, and it is deliberately display-only. A `run.tool_call`
event updates the matching card's action line straight from the event payload, with no round trip
through the snapshot. If that update is ever wrong — a duplicate, a stale line, one delivered out of
order — the next snapshot refetch overwrites it, because it never became state to begin with.

This is why M3's measured carry (one `pause` can emit several `run.paused` events, because the real
CLI retries a denied tool call) needed no special handling here: a client whose state is always a
fresh snapshot absorbs repeats and reordering by construction, the same way a `seq`-tracking reader
does on the orchestrator side.
