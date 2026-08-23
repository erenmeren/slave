# M8b: The Planning Run — Design

- **Date:** 2026-08-23
- **Status:** Approved (design reviewed in session; user decisions of record recorded below)
- **Parent:** `2026-08-17-ai-team-os-design.md` §9 step 2 ("Plan"), §16 M8 row
- **Builds on:** M8a (execution closure) — the review pass, the merge pass, the pass idiom in
  `tick.ts`, the last-JSON-object parser, the fake CLI's synthetic modes, the measured-gate
  script skeleton. M7's dependency DAG and `decide()`'s `dependenciesDone` filter.

M8 was split in two: M8a closed execution (verify → review → merge → done, unattended). M8b adds
the front of the sentence: **a workspace with a goal and no tasks gets a planning run whose
validated output becomes the task graph** — completing the parent's full M8 gate, *"a goal →
merged branch, unattended."*

Out of M8b: replanning (the pass only fires at zero tasks — editing a goal on a workspace with
tasks does nothing until the board is empty), merge-queue visualization (parent §12.4, later),
notifications, planner-specific permission profiles.

## 1. Scope

Five pieces, in dependency order:

1. **The goal** — `Workspace.goal String?`, settable from the CLI and the web.
2. **The planning pass** — a tick pass that starts a planning run for the manager agent when a
   goal exists and the workspace has no tasks.
3. **The graph contract** — a Zod-validated task graph recovered from the run's output text;
   free-form text never reaches the database (parent §9 step 2).
4. **Conclusion** — a valid graph becomes tasks + dependencies in one transaction; an invalid
   one fails the run, bounded by the same retry discipline as review.
5. **The measured gate** — `gate-m8-plan.mjs` drives goal → merged branch with zero human
   writes after the goal is set.

## 2. Decisions of Record

| # | Decision | Why |
|---|---|---|
| 1 | Goal enters via **web + CLI** (`set-goal` verb, Overview form) | User decision; the gate script uses the CLI, a human uses the web |
| 2 | Planned tasks are born **immediately schedulable** (`ready`, dependencies recorded) — no human release gate | User decision; parent D5 (full autonomy). Visibility, not gating: the `workspace.plan_created` event carries the whole plan into the activity feed before the first run starts in practice, and the board shows it live |
| 3 | Task roles are **free-form text** — the planner writes any role; the schema does not restrict to existing agents | User decision (overriding the recommendation). Mitigation is visibility, not a gate: `decide()` already reports `skippedNoRole` every tick, and the board shows the unstarted tasks |
| 4 | The planner is the agent with role `manager`, exact lowercase match | The M8a `reviewer` convention; the seed renames Atlas's role from `AI Manager` to `manager` |
| 5 | The planning run executes in `workspace.repoPath`, not a worktree | There is no task yet, so there is no per-task worktree to reuse; the primary checkout gives the planner the codebase as context. Risk (recorded): a misbehaving real CLI could write into the primary checkout — the prompt forbids it, the fake CLI's plan fixture never writes, and the merge pass's porcelain guard would catch residue before any merge |
| 6 | Planning as a **tick pass** (after resume, before review), not a `decide()` command and not a manual CLI verb | The review/merge pass precedent: I/O-heavy dispatch stays out of the pure core; autonomy requires no operator action |
| 7 | The graph uses **plan-local string keys** for dependencies; the conclusion maps them to real task ids in one transaction | The planner cannot know database ids; a transaction keeps a half-created graph impossible |
| 8 | Retry cap: at most **2 planning runs per goal-set** (failed runs counted since the latest `workspace.goal_set` event), then the pass waits silently for a new goal | The review retry-cap discipline (M8a Erratum 2); two `run.failed` events are the escalation |

## 3. The Goal

`Workspace.goal String?` (migration `m8b_workspace_goal`). Control gains:

```ts
export async function setGoal(
  workspaceId: string,
  goal: string,
): Promise<Result<void, ControlRefusal>>
```

`workspace_not_found` on a missing workspace; a new `invalid_goal` refusal on an
empty/whitespace-only goal. On success it writes the column and emits `workspace.goal_set`
`{ goal }` (actor `human` — an operator did this). Setting a goal on a workspace that already
has tasks succeeds and emits — the pass simply will not fire until the board is empty (Decision
scope note above).

CLI: `set-goal --workspace <id> --goal "<text>"` (the `emergency-stop` idiom: mandatory flags,
one output line). Web: `POST /api/w/[workspaceId]/goal` with `{ goal }` through the M8a
`workspaceControlResponse` shell; a small form on the Overview page (visible when `goal` is
null, showing the goal text once set).

## 4. The Planning Pass

In `tick.ts`, after `resumeRequestedRuns`, before `dispatchReviews`:

```ts
export async function dispatchPlanning(deps: TickDeps): Promise<RunId | null>
```

Fires only when ALL hold: `workspace.goal !== null`, the workspace has **zero Task rows** (any
status), no live planning run exists (`kind: 'planning'`, non-terminal), and the retry cap
(Decision 8) is not spent. Staffing: the `manager`-role agent in the workspace; none → the
one-shot `guardrail.tripped` `{ guardrail: 'no_planner', detail }` escalation (the
`no_reviewer` dedup query shape). Dispatch mirrors `dispatchReview` minus the diff: run row
first (`kind: 'planning'`), `task`-less events carry `workspaceId`/`agentId`/`runId` only,
prompt from `buildPlanningPrompt(goal)`, adapter started with `worktreePath:
workspace.repoPath`, pump chained into the shared `pumps` set. `TickReport` gains
`readonly planningStarted: RunId | null`.

`buildPlanningPrompt` demands one JSON object on its own line in the final message and contains
the literal substring `"task graph"` — the fake CLI's mode selection keys on it (the M8a
`"verdict"` convention).

There is no `taskId` on a planning run: `AgentRun.taskId` must become nullable
(`String?`) with this milestone's migration — the one schema loosening M8b requires. That
loosening has a binding consequence: **every query that scopes runs to a workspace through
`task` must be widened to scope through the agent instead** (`agent: { team: { workspaceId } }`
— equivalent for task-bearing runs, and the only linkage a planning run has). The two that
matter are `pauseActiveRuns` (or emergency stop would never pause a live planning run) and
`loadRunStats`' per-workspace active count (a planning run occupies a concurrency slot like any
other). The audit for further `task:`-scoped run queries is a plan task, not left to chance.
The conclusion branch below never touches `advance()`.

## 5. The Graph Contract

Domain, beside `review/verdict.ts`:

```ts
export interface PlanTask {
  readonly key: string          // plan-local, unique
  readonly title: string
  readonly description: string
  readonly role: string         // free-form (Decision 3)
  readonly dependsOn: readonly string[]  // plan-local keys
}
export interface PlanGraph { readonly tasks: readonly PlanTask[] }

export function parsePlanGraph(text: string): Result<PlanGraph, string>
```

The last-JSON-object scan is extracted from `parseReviewVerdict` into a shared
`lastJsonObject(text, isCandidate)` helper both parsers use (behavior of the verdict parser
unchanged — its tests already pin it). Validation beyond Zod shape: 1–20 tasks, unique keys,
every `dependsOn` key exists, **no cycles** (Kahn's algorithm over the plan-local keys), no
self-dependency. Any violation is one `err` string naming the offense.

## 6. Conclusion

`verifyConcludedRun` gains a `kind === 'planning'` branch beside the review branch, calling
`concludePlanning(runId)` in the planning module:

- Read the run's `run_output` text (the review pattern), `parsePlanGraph`.
- **Invalid:** conditioned run flip `succeeded → failed` + `run.failed`
  `{ reason: 'planning run produced no valid task graph: …' }`. The workspace keeps its goal;
  the retry cap bounds redispatch.
- **Valid:** guard — if the workspace has ANY task by now (a race with an operator creating
  one), warn and conclude without creating (the `advance()` stale-result discipline). Otherwise
  one transaction: create every task (`status: 'ready'`, `requiredRole: role`, `title`,
  `description`, `createdBy: 'agent'`, `maxAttempts: workspace.maxAttempts`) and every
  `TaskDependency` row via the key→id map. After the transaction: `task.created` per task
  (actor `agent`) and one `workspace.plan_created`
  `{ goal, tasks: [{ id, title, role }] }` — the human-visible plan of record.

Tasks with unmet dependencies are `ready` but unstartable — `decide()`'s `dependenciesDone`
filter already refuses them; no new state is invented.

## 7. Web Visibility

Two new event types — `workspace.goal_set`, `workspace.plan_created` — through the M8a Task 1
pipeline: domain schema, DB enum + mapping, `TYPES_BY_KIND` (kind `workspace`), two activity
cards (the goal text; the plan's task list). The board and graph need nothing: planned tasks
are ordinary tasks.

## 8. Testing

The M8a testing shape, layer by layer: domain unit tests for `parsePlanGraph` (valid, fenced,
duplicate key, unknown dependency, cycle, self-dependency, empty, >20, last-object-wins) and
for the extracted `lastJsonObject` (verdict tests keep passing untouched); control integration
tests for `setGoal`; orchestrator integration tests for `dispatchPlanning` (fires only at
zero tasks, live-run skip, no-planner one-shot, retry cap) and `concludePlanning` (graph →
tasks+dependencies in one transaction, invalid → failed run, task-appeared race → no-op)
driven through the real fake CLI; web tests for the route, the form, and the two cards; CLI
test for `set-goal`. The fake CLI gains a `plan-graph.ndjson` fixture (a 3-task graph with one
dependency chain, roles `backend`/`backend`/`backend`) and the `m8-flow` mode: prompt contains
`"task graph"` → replay `plan-graph`; contains `"verdict"` → replay `review-approve`; else
work-commit + `complete` (the m8a-flow body).

## 9. Milestone Gate

`gate-m8-plan.mjs` (the M8a gate skeleton): seed a workspace with `autoMerge: true` and **no
tasks**, a `manager`, one `backend` worker, one `reviewer`; set the goal **via the CLI**
(`set-goal`); run the daemon with fixture mode `m8-flow`; poll write-free until every task the
plan created is `done`; assert ≥1 merge commit `merge(T-…)` on `main`, a
`workspace.plan_created` event exists, and `task.review_approved` appears (the pipeline, not a
shortcut, did it). PASS line: *"a goal became N tasks and M merged branches, unattended."*
README: the command beside the M8a gates, the `set-goal` verb, the M8b row.

The by-eyes half (the M3–M7 tradition): `npm run demo`, type a goal into the web form, watch
the plan appear in the activity feed and the board fill, watch tasks flow to merged, one STOP
mid-flight. Findings become gate-fix tasks.
