# Architecture

## Topology

```
packages/domain     pure core: state machines, the event union, decide(). No I/O, no imports.
packages/db         Prisma schema, the generated client, and the row <-> domain mappers.
packages/events     appendEvent (the only write path), the read/stream/subscribe side.
packages/providers  the runtime adapter: spawns `claude`, parses its stream, pauses and resumes it.
packages/control    the intervention claim semantics: requestPause, requestStop, requestResume,
                    updateQueuedMessage, the refusal taxonomy. Sits between the packages and both
                    apps — the CLI and apps/web both call it; it never imports packages/providers
                    and never spawns a process itself.
apps/orchestrator   the part that reacts: loadWorld, tick, pump, worktree, verify, sweep, CLI.
apps/web            the part that watches: reads Postgres through a snapshot read model, listens
                    for new events through its own SSE routes, and mutates only through
                    packages/control.
```

## The dependency rule that matters

**`packages/providers` never imports `packages/db`** (spec §2.1).

The adapter's vocabulary is `RuntimeEvent` — a normalized shape with no provider-specific fields and
no rows in it. The orchestrator is what turns a `RuntimeEvent` into an `ExecutionEvent` and an
`SlaveRun` update. That boundary is what makes a second provider possible without touching the
schema, and what keeps the adapter testable against a fake CLI with no database anywhere.

The consequence is visible in `Checkpoint`: the adapter defines its own interface for it, and
`packages/db` defines a model with the same fields, because the adapter cannot import the model. The
duplication is deliberate and recorded in the adapter's own doc comment.

**`apps/web` never imports `apps/orchestrator` or `packages/providers`** (spec §2, extended by
M4). The web app is a reader for its GET routes: the Overview, Tasks and Graph snapshots and the
SSE stream build straight from `packages/db` and `packages/events`, and it never spawns a process
itself. For its POST routes (M5), the rule is narrower rather than gone: **`apps/web` mutates
only through `packages/control`** — direct Prisma writes from `apps/web` remain forbidden, matching
the CLI equivalence bar the M3/M4 gates already set. `packages/control` holds the intervention
claim semantics (`requestPause`, `requestStop`, `requestResume`, `updateQueuedMessage`) that both
the CLI and the web's POST routes call; it is itself bound by the same rule the adapter follows —
it never imports `packages/providers` and never spawns a slave process. `resume` makes this
concrete: a web POST only ever records an intent (`SlaveRun.resumeRequestedAt`/`queuedMessage`,
still `paused`) — it is the daemon's tick, in the same process that will own the child, that
claims `paused → resuming` and spawns. The web is never in the business of holding a claim across
a request boundary with no process behind it, because that shape is exactly what the orphan sweep
(§3.4) would fail. M7's `addTaskDependency`/`removeTaskDependency` join the same package and the
same rule — the Graph page's edge editing is a control claim like any other, not a Prisma write
from a route handler — and they are the one pair of operations here with no process on the other
end to race: adding an edge takes out a `SELECT ... FOR UPDATE` on the workspace row for the width
of its own transaction, so two operators drawing edges that would each complete a cycle in the
other's presence serialise on that lock rather than each observing a graph the other's uncommitted
row hasn't touched yet.

## Where a run's state actually lives

| Fact | Home | Written by |
|---|---|---|
| what should happen next | nowhere — it is derived | `decide()`, every tick |
| the scheduling decision's inputs | `World` | `loadWorld`, every tick |
| the run's process | `SlaveRun.pid` | the tick, at spawn |
| the run's progress | `SlaveRun.sessionId`/`toolCalls`/`status` | the pump, from the stream |
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

Past `decide()`'s own `start_run`/`halt` commands, `tick()` (`tick.ts`) runs a fixed sequence of
passes every call, each reacting to state `decide()` never sees. Execution order within one tick
is schedule first, then resume, then plan, review, merge (tick.ts:239-257):

1. **Schedule** (`decide()`'s `start_run` commands, executed by `startRun`) — provisions a
   worktree, spawns the implementation run, unchanged since M3/M7.
2. **Reconcile/resume** (`resumeRequestedRuns`) — claims and spawns any run a control-layer
   `resume` left as an intent (`paused`, `resumeRequestedAt` set), the same claim-then-spawn split
   §3.4's orphan pass depends on.
3. **Plan** (`dispatchPlanning`, `planning.ts`) — when the workspace has a `goal` and an empty
   board, starts a planning run for the `manager`-role slave **in the primary checkout**
   (`workspace.repoPath`), not a worktree: there is no task yet, so there is nothing to provision.
   The run has no `Task` row at all (M8b's task-less run, `SlaveRun.taskId: null`); its prompt asks
   for a JSON task graph, and a valid one becomes tasks + dependencies in one transaction
   (`concludePlanning`). Bounded by a 2-failed-runs-per-goal-set retry cap; a goal with no `manager`
   slave escalates once via `guardrail.tripped` (`no_planner`).
4. **Verify** — chained onto each run's pump (`verifyConcludedRun`, not a separate tick pass): on
   green, the task moves to `reviewing` and stops there; it no longer advances straight to `done`.
5. **Review** (`dispatchReviews`, `review.ts`) — starts a QA review run for every `reviewing` task
   that needs one, staffed by a `reviewer`-role slave, in the **preserved implementation
   worktree** (judging the diff, not rebuilding). The run's final output must be a Zod-validated
   `{ verdict: "approve" | "reject", reason }`; `approve` moves the task to `merging` in every
   case, `reject` reuses the ordinary rework path. `autoMerge` is **not** consulted here — see the
   merge pass below. Capped at 2 review attempts per implementation attempt; no `reviewer` slave
   escalates once via `guardrail.tripped` (`no_reviewer`).
6. **Merge** (`runMergePass`, `merge.ts`) — serialized: claims at most one `merging` task per tick
   via a conditioned `updateMany` on a claim column (`Task.mergeClaimedAt`, null → set), so
   overlapping ticks cannot double-execute. FIFO by the task's latest `task.review_approved` event.
   Rebases the task's branch onto the workspace's `baseBranch` in its preserved worktree,
   **re-verifies the rebased result** (the real gate — two independently green branches can still
   break the base together), then merges with a task-keyed `--no-ff` commit. Conflict or a red
   re-verify releases the claim and sends the task back through `rejectTask` — `rework`, or
   `failed` when the attempt cap is exhausted; a second failure on the same task escalates to a
   workspace halt. This is where `Workspace.autoMerge` is actually read (Decision 5 of the M8a
   design): when it is `false`, an approved task is marked `done` here without merging, its branch
   left for a human. A claim left behind by a crashed process is released back to `rework` by the
   startup reconcile pass, exactly like the orphan-run pattern it mirrors.

M8a and M8b added passes 2, 5 and 6 above; the rest of the sequence (reconcile/resume, schedule,
verify) predates them.

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

**Emergency stop** (M8a) is a fourth way the workspace-halt column gets set, alongside a
pause-gate failure, an unverifiable workspace, and a repeated merge failure (`merge.ts`): `packages/control`'s `emergencyStop(workspaceId,
requestedBy)` sets `haltedReason` first-writer-wins, then fans `requestPause` out to every active
run in the workspace (scoped through `slave -> team`, so a task-less planning run is reached too;
partial refusal is tolerated, the halt stands regardless). It is reachable from two callers over
the one control operation: the orchestrator's `emergency-stop --workspace` CLI command, and
`POST /api/w/[workspaceId]/emergency-stop`, wired to a confirm-dialog STOP button in the web
TopBar. Cleared by the same `clear-halt` an ordinary halt uses — emergency stop adds no new
clearing path.

## Concurrency

- **Ticks** may overlap. The task is claimed with a status-filtered update, so exactly one tick wins
  — in the database rather than in process memory, because a CLI `tick` can run against a live
  daemon.
- **Pumps** run one per active run, concurrently. `appendEvent` serialises appends process-wide,
  because `seq` is assigned at INSERT and rows become visible at COMMIT: two overlapping appends can
  commit out of order, and a reader tracking `seq > lastSeq` would skip one forever.
- **Startup reconciliation** runs before the first tick and refuses to run afterwards. A run that is
  mid-spawn — row created, pid not yet recorded — is indistinguishable from one the pass should fail.
- **Two concurrency limits, not one.** `evaluateGuardrails` checks a per-workspace cap
  (`activeRuns >= maxConcurrentRuns`, default 3) and a cross-workspace cap
  (`globalActiveRuns >= maxGlobalConcurrentRuns`, default 6) as independent breaches, either of
  which halts scheduling. `loadWorld` computes both every tick — the global count is a plain
  workspace-unscoped `SlaveRun` count, the per-workspace one scoped through `slave -> team` so a
  planning run occupies a slot in each exactly like an implementation or review run does.

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

## The activity stream is the same transport, filtered

M6's `/api/w/<workspaceId>/activity/stream` is not a second SSE implementation: it calls the same
`createEventSse` (`packages/events`' `createEventStream` underneath) as `/api/w/<workspaceId>/events`,
with one addition — an optional per-connection `filter` predicate built from the request's parsed
`ActivityFilters` (`?kinds=`/`?types=`/`?slaves=`/`?tasks=`). A rejected event is simply never
written to the response body; the watermark (`lastSeen`, the id the next heartbeat and any
`Last-Event-ID` reconnect carries) still advances past it exactly as it advances past another
workspace's events on the unfiltered route, so a client that narrows its filters mid-connection
loses nothing on reconnect — it resumes from the same `seq` a filtered gap would have left it at
regardless. Unlike the Overview page's SSE connection, the activity stream's frames *are* the
delivered state (each frame is one `ExecutionEvent`, appended to the client's own buffer) rather
than a wake-up for a snapshot refetch — the hybrid liveness rule above still holds for structural
state (task/slave rosters, filter options), which the Activity page still reads from a server-side
snapshot on load and on history paging, never from the stream.
