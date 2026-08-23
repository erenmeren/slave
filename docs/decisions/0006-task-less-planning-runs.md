# ADR 0006 — Task-less Planning Runs

**Status:** Accepted
**Date:** 2026-08-23
**Context:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` §9 step 2 ("Plan"), §16 M8 row;
`docs/superpowers/specs/2026-08-23-m8b-planning-design.md`; `.superpowers/sdd/2026-08-23-m8b-planning/progress.md`.

## Decision

`AgentRun.taskId` becomes nullable. A planning run — the run that turns a workspace's `goal` into
a task graph — has no `Task` row at all, for as long as it runs: it works toward `Workspace.goal`,
not a task, so there is nothing yet to attach one to.

That one column change forces a scoping rule everywhere a run is looked up by workspace:
**a run's workspace must be derived through `agent.team.workspaceId`, never through
`task.workspaceId`.** `docs/domain-model.md` documents the nine sites the plan named — plus six
more compile-driven siblings the implementation surfaced (single-run lookups in
pause/resume/stop, the CLI's `mustGetRun`, the web control route), fifteen in all — carried
through (the orphan sweep, the per-tick sweep, `loadWorld`'s active-run and spend counts, the
resume-intent scan, `pauseActiveRuns`, the planning dispatch's own live-run and retry-cap queries,
and the CLI `status` command). Every one of them scoped through `Task` before this change, and
every one would have silently dropped a live planning run from an emergency stop's fan-out, the
global concurrency count, or the budget guardrail's spend total — exactly the places a run that is
still spending money and still occupying a concurrency slot most needs to be visible.

Three further decisions of record, all from the M8b design's user-decision table:

- **The planning pass fires only at a genuinely empty board** (zero `Task` rows, any status).
  There is no replanning: setting or editing a goal on a workspace that already has tasks succeeds
  and is recorded, but the pass stays dormant until the board empties by other means. Autonomy
  extends to starting the plan, not to re-deciding one already in motion.
- **Planned tasks are born immediately schedulable** (`ready`, with dependencies recorded), not
  gated behind a human release step. This is the parent spec's D5 (full autonomy) applied to the
  planner's own output: the `workspace.plan_created` event carries the whole plan into the
  activity feed, and the board shows it live, before the first planned task's run starts in
  practice — visibility is the safeguard, not a gate.
- **Task roles are free-form text**, not restricted to a role some agent in the workspace actually
  has. This overrode the design's own recommendation, on the user's explicit call. The mitigation
  is the same visibility principle: `loadWorld` already computes, and the tick report already
  carries, `skippedNoRole` every tick for a
  task no agent can pick up, and the board shows an unstarted task sitting there rather than the
  system silently discarding or rewriting a role the planner chose.

## Rationale

### Why nullable, not a placeholder task

A planning run could instead be given a synthetic "planning" task row to hang off of, keeping
`AgentRun.taskId` required. That was rejected because it manufactures a task that is not a unit of
work — it has no branch, no verify commands, no meaningful status transitions — purely to satisfy
a foreign key, and every consumer that reads `Task` as "a thing on the board" would need a special
case to filter the synthetic row back out. Nullability states the true shape directly: some runs
are about a task, and one new kind is not.

### Why the scoping invariant is the real cost of this decision, not a detail

The nullable column is one line in a Prisma schema. The invariant it forces is the actual
engineering cost, and it is the kind of cost that does not announce itself: every one of the
fifteen sites compiled and passed its existing tests before the fix, because `task: { workspaceId }` and
`agent: { team: { workspaceId } }` return identical results for every run that has a task. The gap
is invisible until the first task-less run exists, at which point every un-migrated site silently
loses it — no type error, no failing assertion, just a query that returns one fewer row than it
should. This is why the fix is treated here as a first-class decision rather than an
implementation detail buried in a migration commit: a future addition of another task-less run
kind must re-run this same audit, not assume the invariant self-enforces.

### The known, judged-benign self-race — and why the naive fix is a trap

M8b's own measured gate run surfaced a real race: a planning run can conclude and commit its task
graph in the same window a second planning-dispatch check is mid-flight, so a second planning run
gets started against a board that is *about* to stop being empty. Observed once in the wild during
Task 9's gate run, it is absorbed harmlessly by `concludePlanning`'s own guard — before creating
anything, it re-counts the workspace's tasks, and if the board is no longer empty (an operator, or
this exact race, got there first) it warns and drops the graph rather than creating a second board
on top of the first. The review that closed M8b judged the race **benign, bounded, and
once-per-plan**: it can happen at most once per goal (the instant the board transitions from empty
to non-empty), it destroys no data, and its only visible cost is one dropped graph and a console
warning.

The tempting fix — gate `dispatchPlanning` on a fresher "is the board still empty" check, or hold
some lock across the check-then-act window — was deliberately **not done**, and the reason is worth
recording precisely because it looks safe at first glance and is not. `concludePlanning`'s guard
works by dropping the *graph*, not by touching the *run* — the planning run whose graph got dropped
still concludes `succeeded`. A dispatch-side gate that instead refused to start the second run in
the first place would not, by itself, change what happens to a run that already started and lost
the race: that run still finishes, still produces a valid graph, and that graph would still need
to be dropped by the same guard `concludePlanning` already has. The actual trap is narrower and
sharper than "add a gate": if a *future* change ever tried to make the dropped-graph outcome look
like a failure (so it would not silently vanish, or so it would count toward a retry cap), it would
have to flip that run's status away from `succeeded` — and nothing in the system today treats
"succeeded but its graph was discarded" as a distinguishable terminal status. A naive attempt to
have `concludePlanning` mark the run `failed` when it drops a graph would be actively wrong: that
run's planner *did* produce a valid, judgeable task graph — the process worked. Recording it as a
failure would corrupt the run history and could exhaust an unlucky workspace's planning retry cap
on a run that was never at fault. The clean fix needs a status this system does not have —
something like a conclusion-owned terminal status distinct from both `succeeded` and `failed`,
representing "this run finished correctly but its output was superseded" — which is a small
product refactor of the run state machine, not a bug fix, and was deliberately left undone. It is
recorded here, rather than quietly fixed, so the next person who reaches for the obvious gate does
not rediscover this the hard way.

### Why the empty-board trigger has no replanning

Firing only at zero tasks means "add a task graph" and "revise an existing plan" are not the same
feature, and M8b builds only the first. Replanning against a board that already has in-flight,
possibly-merged work raises questions this milestone does not answer — does a revised plan cancel
tasks already running, does it leave orphaned dependencies against tasks it no longer mentions,
does an operator's manual edits to the board survive a replan — and answering them by omission
(silently doing nothing, or worse, silently doing something) would be worse than not having the
feature. The empty-board trigger is the boundary where those questions do not yet arise: a
workspace with a goal and no tasks has, by definition, no in-flight work a plan could conflict
with.

## Alternatives Rejected

- **A placeholder/synthetic task for the planning run.** Rejected above — manufactures a
  non-task to satisfy a schema constraint, pushing a special case onto every `Task` consumer
  instead of onto the fifteen run-scoping sites that actually needed it.
- **A dispatch-side gate against the self-race**, closing the window between "is the board empty"
  and "start the run." Rejected: as detailed above, it does not eliminate the need for
  `concludePlanning`'s own guard, and the version of the fix that looks complete — marking a
  dropped-graph run `failed` — actively corrupts the record of a planner that did its job
  correctly. The clean fix is a run-state-machine change, deliberately deferred.
- **Restricting planned task roles to roles an existing agent actually has.** The design's own
  recommendation; overridden by the user in favor of free-form roles plus the visibility mitigation
  `skippedNoRole` already provides, on the judgment that gating on role plausibility would refuse
  otherwise-good plans over a staffing gap the board already surfaces on its own.
- **Replanning support in this milestone.** Deferred rather than rejected outright — the
  empty-board trigger is the boundary this milestone could answer cleanly; revising a plan against
  live work is a different, harder feature left for later.

## Consequences

- Every future task-less run kind must re-run the run-scoping audit this decision established
  (the plan's nine named sites plus every compile-flagged sibling — fifteen the first time), not assume the invariant holds by default.
- `apps/orchestrator` and `packages/control` code that queries `AgentRun` by workspace now carries
  a standing convention — `agent: { team: { workspaceId } }` — that a reviewer must check by name,
  since `task: { workspaceId }` still compiles and still passes tests against task-bearing runs.
- The benign self-race and its documented trap are a known, accepted gap: a rare dropped task
  graph with a console warning, not a data-loss or correctness bug, and the fix that would close
  it is scoped as a deliberate product refactor (a conclusion-owned terminal status), not carried
  in this milestone.
- `Workspace.goal` and `workspace.goal_set`/`workspace.plan_created` are one-way schema and
  Zod-union additions (`docs/event-model.md`'s one-way-door rule); an event's `taskId` being absent
  is now a genuine, expected shape for a consumer to handle, not only a theoretical one the schema
  happened to allow.
