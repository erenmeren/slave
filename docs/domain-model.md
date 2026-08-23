# Domain Model — `packages/domain`

This document describes what exists in `@ai-team-os/domain` at the end of Milestone 1 (Tasks
8-17): the Agent/Task/AgentRun split, both state machines, the guardrail and scheduler decision
functions, the merge queue, and the event envelope. `packages/domain` is pure — it has no
runtime side effects, no persistence, and no framework dependency. It defines the contract that
M2 (Prisma, events, `LISTEN/NOTIFY`) and M3 (the Claude Code adapter) build on without changing
its exported shapes.

All names below are read directly from `packages/domain/src`; every function, type, and file
path referenced here exists in the code as written.

## Package layout

```
packages/domain/src/
  result.ts              Result<T, E> — the shared success/error convention
  ids.ts                 Branded id types: AgentId, TaskId, RunId, WorkspaceId
  task/state.ts           TaskStatus, TaskState, TaskEvent, applyTaskEvent, initialTaskState
  run/state.ts             RunStatus, RunState, RunEvent, applyRunEvent, initialRunState
  agent/derived.ts         AgentStatus, deriveAgentStatus
  guardrails/evaluate.ts   GuardrailLimits, WorkspaceStats, GuardrailBreach, evaluateGuardrails,
                           DEFAULT_GUARDRAIL_LIMITS
  scheduler/decide.ts      SchedulableTask, SchedulableAgent, World, Command, decide
  merge/queue.ts           MergeCandidate, nextMergeCandidate
  review/verdict.ts        ReviewVerdict, reviewVerdictSchema, parseReviewVerdict
  planning/graph.ts        PlanTask, PlanGraph, planGraphSchema, parsePlanGraph
  json/last-object.ts      jsonObjectsLastToFirst — the last-JSON-object scan shared by both parsers above
  events/schema.ts         executionEventSchema, ExecutionEvent, parseExecutionEvent
  index.ts                DOMAIN_VERSION, re-exports everything above
```

`index.ts` is the package's only public entry point (`export * from ...` for each module above),
so anything importable from `@ai-team-os/domain` is importable from that one file.

## The Agent / Task / AgentRun split, and why Agent status is derived

Three concepts, three files, three purposes:

- **`Task`** (`task/state.ts`) is the unit of work. Its status (`TaskState.status`) tracks
  progress through review and merge — `backlog`, `ready`, `blocked`, `assigned`, `running`,
  `verifying`, `reviewing`, `merging`, `rework`, `done`, `failed`, `cancelled`.
- **`AgentRun`** (`run/state.ts`, exported as `RunState`) is one execution attempt by an agent
  process. Its status (`RunState.status`) tracks the mechanics of a live process —
  `starting`, `working`, `pause_requested`, `paused`, `resuming`, `stopping`, `stopped`,
  `succeeded`, `failed`.
- **`Agent`** has no persisted status field at all. `agent/derived.ts` computes
  `AgentStatus` — `idle`, `starting`, `working`, `pausing`, `paused`, `resuming`, `stopping` —
  by calling `deriveAgentStatus(activeRun: RunState | null)`, a pure mapping from the agent's
  active run's status (or `idle` when there is no active run).

This is ADR 0002 (`docs/decisions/0002-derived-agent-status.md`): three independently writable
status fields for one underlying truth drift apart under concurrency, and the observable failure
is an agent shown "working" on a task that is actually blocked. Collapsing agent status to a pure
function of run status removes the drift by removing the second writable copy. Statuses that
belong to the work itself (`blocked`, `reviewing`, `done`, ...) live on `Task`; statuses that
belong to the mechanics of execution (`paused`, `stopping`, ...) live on `AgentRun`. Adding a new
run status requires updating exactly one mapping function, `deriveAgentStatus`.

### Why exhaustiveness here is load-bearing, not a style rule

`deriveAgentStatus`, `applyTaskEvent`, and `applyRunEvent` each `switch` over a closed status
union with no `default` case. That relies on TypeScript's control-flow exhaustiveness check
(TS2366, "function lacks ending return statement") to catch an unhandled case at compile time —
but **`tsconfig.base.json` does not set `noImplicitReturns`.** The exhaustiveness guarantee holds
only because each of these three functions carries an **explicit return-type annotation that
excludes `undefined`** (`AgentStatus`, `Result<TaskState, IllegalTransition>`,
`Result<RunState, IllegalRunTransition>`). That explicit annotation is what makes TS2366 fire for
a missing case. If someone drops the explicit return type from one of these functions "for
brevity," exhaustiveness checking silently stops working: TypeScript infers a return type that
happily includes `undefined`, the compiler no longer complains about a missing switch arm, and an
unhandled status starts returning `undefined` at runtime instead of failing to compile. Do not
relax or "clean up" the return-type annotations on these three functions — the type annotation
*is* the exhaustiveness check.

## Task state machine

`applyTaskEvent(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition>`
(`task/state.ts`). Never throws; an event that is not valid for the current status returns
`err({ kind: 'illegal_transition', from, event })` rather than mutating `state`, and never
mutates the caller's input either way.

`cancelled` is handled once, ahead of the per-status switch: it is legal from any non-terminal
status and illegal once the task is already `done`, `failed`, or `cancelled`.

A rejection (`run_failed`, `verify_failed`, `review_rejected`, `merge_failed`) is routed by the
shared `reject()` helper: it goes to `rework` while `attempt < maxAttempts`, and to `failed` once
attempts are exhausted, always clearing `activeRunId` and setting `lastRejectionReason`.

`TaskState.maxAttempts` (seeded per task by `initialTaskState(maxAttempts)`) and
`GuardrailLimits.maxAttempts` (`DEFAULT_GUARDRAIL_LIMITS`, currently `3`) are independent numbers
today — nothing in the code links them. Task creation must seed the former from the latter; until
a caller does so, a task can legally be created with a `maxAttempts` that disagrees with the
workspace's guardrail limit.

| From status | Event | To status | Notes |
|---|---|---|---|
| `backlog`, `blocked` | `dependencies_satisfied` | `ready` | |
| `backlog`, `blocked` | `dependencies_unmet` | `blocked` | |
| `ready`, `rework` | `assigned` | `assigned` | sets `assigneeId` |
| `ready`, `rework` | `dependencies_unmet` | `blocked` | |
| `assigned` | `run_started` | `running` | sets `activeRunId`, `attempt += 1` |
| `running` | `run_succeeded` | `verifying` | clears `activeRunId` |
| `running` | `run_failed` | `rework` or `failed` | via `reject()` |
| `verifying` | `verify_passed` | `reviewing` | |
| `verifying` | `verify_failed` | `rework` or `failed` | via `reject()` |
| `reviewing` | `review_approved` | `merging` | |
| `reviewing` | `review_rejected` | `rework` or `failed` | via `reject()` |
| `merging` | `merged` | `done` | clears `lastRejectionReason` |
| `merging` | `merge_failed` | `rework` or `failed` | via `reject()` |
| any non-terminal | `cancelled` | `cancelled` | clears `activeRunId`; handled before the switch |
| `done`, `failed`, `cancelled` | any | — | illegal (terminal) |

Any event not listed for a given status (e.g. `run_started` while `running`) is illegal.

## Run state machine

`applyRunEvent(state: RunState, event: RunEvent): Result<RunState, IllegalRunTransition>`
(`run/state.ts`). Same `Result`, non-throwing, non-mutating convention as the task machine.

`failed` is handled once, ahead of the per-status switch: it is legal from any status in the
`ACTIVE` set (`starting`, `working`, `pause_requested`, `paused`, `resuming`, `stopping`) — a run
can die at any moment while it is active — and illegal once the run has already reached
`stopped`, `succeeded`, or `failed`.

| From status | Event | To status | Notes |
|---|---|---|---|
| `starting` | `started` | `working` | sets `sessionId` |
| `working` | `tool_call` | `working` | `toolCalls += 1` |
| `working` | `pause_requested` | `pause_requested` | |
| `working` | `stop_requested` | `stopping` | |
| `working` | `succeeded` | `succeeded` | |
| `pause_requested` | `paused` | `paused` | sets `pausedAtStep` |
| `pause_requested` | `tool_call` | `pause_requested` | `toolCalls += 1` (a call already in flight when pause was requested can still land) |
| `pause_requested` | `succeeded` | `succeeded` | |
| `pause_requested` | `stop_requested` | `stopping` | |
| `paused` | `resume_requested` | `resuming` | |
| `paused` | `stop_requested` | `stopping` | |
| `resuming` | `resumed` | `working` | sets `sessionId`, clears `pausedAtStep` |
| `stopping` | `stopped` | `stopped` | |
| any ACTIVE status | `failed` | `failed` | handled ahead of the switch |
| `stopped`, `succeeded`, `failed` | any | — | illegal (terminal) |

Any event not listed for a given status is illegal.

## The `Result` convention

`result.ts` defines the single error-handling convention used across every domain decision
function:

```ts
type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }
```

with `ok(value)` and `err(error)` constructors. `applyTaskEvent`, `applyRunEvent`, and
`parseExecutionEvent` all return `Result` rather than throwing. This is a hard project
constraint, not a convenience: decision functions in `packages/domain` are deterministic, never
throw, and never mutate caller-owned input — callers pattern-match on `.ok` instead of wrapping
calls in `try/catch`, which keeps control flow through an illegal transition or a bad event
payload exactly as visible and testable as the success path.

## Guardrails — fail-closed by design

`guardrails/evaluate.ts` defines `GuardrailLimits`, `WorkspaceStats`, `GuardrailBreach`, the
seeded defaults `DEFAULT_GUARDRAIL_LIMITS` (spec §9.2), and
`evaluateGuardrails(limits, stats): readonly GuardrailBreach[]`, which checks emergency-stop,
concurrency, budget (with an 80%-of-budget warning breach that does not halt scheduling), and a
consecutive-failure circuit breaker.

This is a **fail-closed safety property, not a convenience**: `evaluateGuardrails` only ever adds
breaches to the returned list from known, enumerated conditions — there is no path through the
function that suppresses or downgrades a breach it has already detected, and a breach with
`haltsScheduling: true` is unconditional once its condition is met. `scheduler/decide.ts`'s
`decide()` consumes this by refusing to schedule anything the moment any breach in the list has
`haltsScheduling: true`, returning `[{ kind: 'halt', reason }]` in place of any `start_run`
commands. The system is designed to stop scheduling work on ambiguity or breach, never to keep
scheduling by default.

## Scheduler decision

`scheduler/decide.ts` defines `SchedulableTask`, `SchedulableAgent`, `World`, `Command`
(`start_run` | `halt`), and `decide(world: World): readonly Command[]`. It is a pure function:
no I/O, no side effects, and the same `World` always produces the same `Command[]`. After the
guardrail halt check above, it filters tasks to `STARTABLE` statuses (`ready`, `rework`) with
`dependenciesDone`, sorts by priority (ties broken by task id for determinism), and greedily
assigns the highest-priority startable task to an available agent matching `requiredRole`, up to
the remaining concurrency slots (`limits.maxConcurrentRuns - stats.activeRuns`).

## Merge queue — serialized by design

`merge/queue.ts` defines `MergeCandidate` and
`nextMergeCandidate(queue, mergeInProgress): MergeCandidate | null`. Merges are strictly
serialized (spec §10): the function returns `null` immediately whenever `mergeInProgress` is
true, regardless of what is queued. This is a **serialization guarantee, not an optimization** —
concurrent merges are exactly the case where two independently green branches can break `main`
together, so the short-circuit exists to make that impossible at the domain-function level, not
merely unlikely. When no merge is in progress, eligible candidates (`!blockedUntilRebase`) are
sorted by `enqueuedAt`, with `taskId` as a deterministic tiebreaker, and the earliest is returned.

The orchestrator's own `mergeInProgress` (M8a) is not a flag in memory — it is `Task.mergeClaimedAt`,
a nullable timestamp set by a conditioned `updateMany` (`status: 'merging', mergeClaimedAt: null`
→ set) the same first-writer-wins claim shape M5's resume intent uses. A non-null claim with no
live daemon behind it — the process crashed mid-merge — is released back to `rework` by the
startup reconcile pass, not by the merge pass itself, exactly the way an orphaned run is
reconciled only at startup (§3.4 in `docs/architecture.md`).

## The review verdict and the planning graph contract

Two parsers, both Zod-validated and both built on one shared scan:

- `review/verdict.ts`'s `parseReviewVerdict(text): Result<ReviewVerdict, string>` recovers
  `{ verdict: 'approve' | 'reject', reason: string }` from a review run's accumulated output.
- `planning/graph.ts`'s `parsePlanGraph(text): Result<PlanGraph, string>` recovers
  `{ tasks: PlanTask[] }`, `PlanTask` being `{ key, title, description, role, dependsOn }`, from a
  planning run's output. Beyond the Zod shape (1–20 tasks), `parsePlanGraph` checks structure a
  schema alone cannot: unique keys, every `dependsOn` naming a key that exists, no
  self-dependency, and no cycle (Kahn's algorithm over the plan-local keys). `role` is free-form
  text — the schema does not restrict it to a role any agent in the workspace actually has.

Both scan `jsonObjectsLastToFirst` (`json/last-object.ts`) — a shared helper extracted from the
verdict parser's original last-object-wins scan — for the **last** JSON object in the text that
satisfies the relevant schema, because agents wrap their JSON answer in prose and code fences.
Once a candidate passes the shape check it is taken as final: a structural violation (e.g. a
graph's dangling dependency) rejects that candidate outright rather than falling back to an
earlier one, since silently executing an earlier draft nobody signed off on would be worse than
failing loudly.

## Event envelope

`events/schema.ts` defines a shared envelope (`seq`, `ts`, `workspaceId`, optional `taskId` /
`agentId` / `runId`, `actor: 'human' | 'agent' | 'system'`) and `executionEventSchema`, a Zod
`discriminatedUnion('type', [...])` binding each event type to its own payload shape by
construction. The current representative subset (Task 14; spec §6.2's full catalogue is
completed in M2 as the orchestrator starts emitting more types) is:

| `type` | payload |
|---|---|
| `task.created` | `{ title: string }` |
| `task.started` | `{ title: string }` |
| `task.done` | `{ branch: string }` |
| `task.rework` | `{ reason: string, attempt: number (positive int) }` |
| `run.started` | `{ sessionId: string }` |
| `run.tool_call` | `{ name: string, summary: string }` |
| `run.paused` | `{ atStep: number (int) }` |
| `run.resumed` | `{ sessionId: string }` |
| `agent.message_sent` | `{ category: 'instruction' \| 'feedback' \| 'context' \| 'priority_change' \| 'question_response', body: string (min 1) }` |
| `guardrail.tripped` | `{ guardrail: string, detail: string }` |

`ExecutionEvent = z.infer<typeof executionEventSchema>` is the exported type.
`parseExecutionEvent(input: unknown): Result<ExecutionEvent, string>` wraps `safeParse` in the
package's own `Result` convention rather than throwing on invalid input, returning
`err(parsed.error.message)` on failure.

## Ids

`ids.ts` defines four branded string types — `AgentId`, `TaskId`, `RunId`, `WorkspaceId` — via a
shared `Brand<T, B>` helper, with one constructor each (`agentId`, `taskId`, `runId`,
`workspaceId`) that casts a plain `string` into the branded type. These prevent, at the type
level, passing e.g. a `TaskId` where a `RunId` is expected, without adding any runtime
representation beyond a string.

Branding stops at the event boundary: `events/schema.ts` types `taskId`/`agentId`/`runId`/
`workspaceId` as plain `string` (so, for example, `ExecutionEvent['taskId']` is
`string | undefined`, not `TaskId | undefined`), meaning M2 consumers reading events back out
will need to re-brand these fields before passing them to functions that expect the branded
types.

## Persistence (M2)

These domain types are now backed by real tables in `packages/db`. `TaskState` maps to the `Task`
table via `toTaskState`, and `RunState` maps to the `AgentRun` table via `toRunState` — both in
`packages/db/src/mappers.ts`. Branded ids, which stop at the event boundary per the section above,
are restored at this same layer: `toTaskState` re-brands `row.assigneeId` and `row.activeRunId`
with `agentId()` / `runId()`, and the event-log mapper (`toExecutionEvent`, same file) re-brands
`taskId` / `agentId` / `runId` on the way out of the `ExecutionEvent` table.

The event log itself — its envelope, the single write gate, the single-writer assumption the read
path depends on, and the notification model — is documented separately in
`docs/event-model.md`, since it is a system in its own right rather than a straightforward table
mapping.

### M8 schema additions, and the scoping invariant they force

- **`Workspace.goal String?`** — the operator's standing instruction a planning run decomposes
  (M8b). An unset goal is ordinary, not an error state; the planning pass simply never fires.
- **`Task.mergeClaimedAt DateTime?`** — the merge queue's claim column, described above.
- **`AgentRun.taskId` is now nullable** (`String?`). A `kind: 'planning'` run has no `Task` row at
  all: it works toward `Workspace.goal`, not a task, so there is nothing to attach one to.

That nullability is a one-way door with a binding consequence, stated plainly because it is easy
to get wrong by habit: **a run's workspace must be derived through `agent.team.workspaceId`, never
through `task.workspaceId`.** A query scoped through `task` silently drops every planning run —
exactly the run an emergency stop, the global concurrency count, or the budget guardrail most
needs to reach, since it is still spending money and still occupying a concurrency slot. M8b's own
implementation carries this through nine call sites across `apps/orchestrator` and
`packages/control` (the orphan sweep, the per-tick sweep, `loadWorld`'s active-run and spend
counts, the resume-intent scan, `pauseActiveRuns`, the planning dispatch's own live-run and
retry-cap queries, and the CLI `status` command's active-run listing) — every one of them
re-scoped from `task: { workspaceId }` to `agent: { team: { workspaceId } }` in the same change
that made `taskId` nullable.

### The retry-cap convention: escalation by `run.failed`, not a new guardrail type

Both the review pass and the planning pass bound their own retries the same way, and neither adds
a new guardrail kind to do it:

- **Review retry cap:** at most 2 review runs per implementation attempt (`review.ts`'s
  `REVIEW_RETRY_CAP`). Counted from the task's latest implementation run's `startedAt` forward, so
  a rework's fresh implementation attempt gets its own fresh count.
- **Planning retry cap:** at most 2 planning runs per goal-set (`planning.ts`'s
  `PLANNING_RETRY_CAP`). Counted since the workspace's latest `workspace.goal_set` event, so
  re-setting the goal resets the count.

At the cap, dispatch goes silent rather than emitting a third escalation event: the two
`run.failed` events each failed attempt already wrote **are** the escalation an operator sees, the
same way a task's ordinary `attempt`/`maxAttempts` exhaustion is read from the run history rather
than from a dedicated "gave up" event.

## Environment note: `npm test` / `npm run typecheck` and `allow-scripts`

An esbuild postinstall step was observed running during setup in this environment. It traces to
`allow-scripts = [""]` in this environment's *effective* npm configuration — external to this
repository, not anything committed here. It is harmless in this environment because the esbuild
binary it installs is pre-bundled, but every task in this milestone depends on `npm test` and
`npm run typecheck` continuing to work, and a different machine's npm policy could block a
postinstall script for some future dependency whose binary is *not* pre-bundled, breaking install
in a way that has nothing to do with this package's own code. Noted here so the next person
debugging a broken `npm install` on another machine does not have to rediscover this from
scratch.

## What is deliberately not here yet

Carried forward from the task-18 plan so this document does not imply more than M1 built:

- **`Checkpoint`** (spec §8) is defined in M2, where it is first persisted.
  `RunState.sessionId` and `RunState.pausedAtStep` already carry the in-memory half.
- **The full event catalogue** (spec §6.2) — the table above is a representative subset; the
  discriminated union is the designed extension point for the remaining types.
- **Skill and permission models** enter in M2 with the schema; M1's decision functions exercise
  only `SchedulableTask.requiredRole`.

`packages/domain` has no other consumer yet. `docs/superpowers/plans/<date>-m2-persistence-and-events.md`
is the next plan: Prisma schema, migrations, seed data, event writes, and `LISTEN/NOTIFY`,
consuming these exported types unchanged — this package is the contract M2 builds on.
