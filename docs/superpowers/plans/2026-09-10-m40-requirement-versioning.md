# M40 Requirement Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workspace goal becomes a versioned requirement (`GoalVersion` rows, `Workspace.goalVersion`, `Task.goalVersion`, task-content hashes in every run's recorded context), and a goal change on a non-empty board triggers a delta re-plan run whose additions apply at once and whose cancellations become Supervisor proposals a human approves.

**Architecture:** Domain gains `parsePlanDelta`/`applyCancelPolicy`/`REPLAN_INSTRUCTIONS`, a `replan` run-context section, the `stale_task` situation + `cancel_task` action, and goal hashing/diffing; control gains a versioned `setGoal`, `listGoalVersions`, `cancelTask`, the `cancel_task` carryOut arm; the orchestrator's planning dispatcher gains the re-plan trigger and `concludeReplan`; CLI/web expose history, the stale badge and cancellation proposals; a gate proves the chain with the fake CLI's new `"replan"` arm.

**Tech Stack:** TypeScript monorepo, Prisma 7 + Postgres (:5433), zod, vitest, Next.js, fake provider `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-10-m40-requirement-versioning-design.md` (rulings R1–R4; §8 errata). Plan-time errata: **E1** `validateStructure` in `graph.ts` is module-private — `delta.ts` gets its own `validateDelta(delta, existingTaskIds)` that reuses `findCycle` (export it) and allows `dependsOn` entries that are existing task ids. **E2** the trailer is chosen in `render.ts` by kind; for a re-plan the kind stays `planning` and `renderRunContext` appends `REPLAN_INSTRUCTIONS` instead of `PLANNING_GRAPH_INSTRUCTIONS` when the sections contain a `replan` section. **E3** the fake CLI has no placeholder mechanism; `replanArm` patches the `$CANCEL_ID` token in the fixture's assistant text by hand (the `m36-flow` ask-patch idiom) from `--replan-cancel <id>` in argv. **E4** `concludePlanning` decides re-plan vs first plan from the run's `RunContext` manifest (a `replan` section present), not from `run.kind`. **E5** `setGoal` refuses `goal_unchanged { workspaceId; version }` when the new text's sha256 equals the current version's (spec §6 stage 4).

## Global Constraints
- M38/M39 §1 invariants still bind (a decision is not work; model output never writes beyond creating backlog tasks; pure domain; single write gate; never a real model call; one open decision per key + cooldown).
- A goal version is immutable; `setGoal` inserts `GoalVersion { version = goalVersion + 1 }` under a workspace row lock and updates `goal`/`goalSetByUserId`/`goalVersion`; `goal_unchanged` when the sha matches.
- `Task.goalVersion` = the version the plan derived it from (null for hand-made tasks); every `task.created` carries it; the run context `task` source carries `sha256(title + '\n' + description)`; `planning_goal` carries `version`.
- Re-plan: a delta `{ add, cancel, keep }`; `cancel` may name only `backlog | ready | blocked` tasks (others dropped and recorded in `workspace.replanned.droppedCancellations`); additions created at once with `goalVersion = version`; each cancellable id → `SupervisorDecision` `stale_task`/`cancel_task` tier `proposed` (R1); one re-plan per goal version (dedup on `workspace.replan_started { version }`); retry cap `PLANNING_RETRY_CAP` counted since that version's `goal_set`.
- `cancelTask` only from `backlog | ready | blocked` (`task_not_cancellable`), never with an active run; a cancelled dependency stays unmet (R3 — no code change; the gate asserts the dependent stays blocked).
- R2 rides along in Task 2: `pruneDecisions` adds `modelCostUsd: null`; `roleHasHolder` excludes the asker (Task 1, domain).
- Migration `20260910120000_m40_requirement_versioning` with the backfill (every workspace with a goal → `GoalVersion v1` + `goalVersion 1`; every task in such a workspace → `goalVersion 1`); `db:migrate` + `db:migrate:test`; `migrate diff` empty; a hand-seeded pre-M40 workspace read back after migrating the dev DB, pasted in the Task 1 report.
- Refusals in a transaction throw; `refusalText` covers every new kind; `ALL_KINDS` extended; exhaustive web maps gain the three events. One vitest at a time; typecheck; vocabulary (`slave`); `web:build` last with no `next dev`. Known flake: cli.test.ts llm-decision row count.
- Commit trailers:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```

---
## File structure
```
packages/db/prisma/schema.prisma + migrations/20260910120000_m40_requirement_versioning (GoalVersion; Workspace.goalVersion; Task.goalVersion; 3 EventTypes; SupervisorSituationKind + stale_task; backfill)
packages/db/src/enums.ts, packages/domain/src/events/schema.ts   (+3 events; goal_set/plan_created/task.created payloads widened)
packages/domain/src/planning/{delta,graph}.ts                     (PlanDelta, parsePlanDelta, validateDelta, applyCancelPolicy, REPLAN_INSTRUCTIONS; export findCycle)
packages/domain/src/run-context/{sections,render}.ts             (task.sha256, planning_goal.version, replan section, trailer choice)
packages/domain/src/supervisor/{situations,actions,candidates,policy,observe,report,world}.ts  (stale_task, cancel_task, roleHasHolder asker exclusion, goalVersion on tasks/world, next.stale)
packages/domain/src/goal/{version,index}.ts                      (goalSha256, goalDiff)
packages/control/src/{goal,task,supervisor,supervisorWorld,refusal,index}.ts
apps/orchestrator/src/{planning,runContext,verify,cli}.ts
packages/providers/test/fake-claude.mjs + fixtures/replan-delta.ndjson
apps/web/src/server/{goal,overview}.ts, app/api/w/[workspaceId]/goal/history/route.ts, components/project/GoalPanel.tsx, TaskCard/TaskDetailPanel/SupervisorPanel, activity/cards.tsx, lib/activityFilters.ts
scripts/gate-m40-requirement-versioning.mjs, package.json, ci.yml, README.md
```

---
### Task 1: Data model with backfill, and the pure domain

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (spec §2 `GoalVersion` verbatim + `Workspace.goalVersion Int @default(0)` + relation `goalVersions GoalVersion[]`; `Task.goalVersion Int?`; `EventType` + `workspace_replan_started @map("workspace.replan_started")`, `workspace_replanned`, `task_cancelled`; `SupervisorSituationKind` + `stale_task`), create the migration (`CREATE TABLE "GoalVersion"` with the unique + FK cascade; `ALTER TABLE "Workspace" ADD COLUMN "goalVersion" INTEGER NOT NULL DEFAULT 0`; `ALTER TABLE "Task" ADD COLUMN "goalVersion" INTEGER`; three `ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS`; `ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'stale_task'`; backfill: `INSERT INTO "GoalVersion" (id, "workspaceId", version, text, sha256, "setByUserId", "createdAt") SELECT gen_random_uuid()::text, id, 1, goal, encode(sha256(convert_to(goal, 'UTF8')), 'hex'), "goalSetByUserId", now() FROM "Workspace" WHERE goal IS NOT NULL;` then `UPDATE "Workspace" SET "goalVersion" = 1 WHERE goal IS NOT NULL;` then `UPDATE "Task" t SET "goalVersion" = 1 FROM "Workspace" w WHERE w.id = t."workspaceId" AND w.goal IS NOT NULL;` — NOTE the enum values are added in the same migration but not USED by it, which Postgres permits), `packages/db/src/enums.ts` (+3), `packages/domain/src/events/schema.ts` (`workspace.goal_set` + `version: number, sha256: string`; `workspace.plan_created` + `goalVersion: number`; `task.created` + `goalVersion: number | null`; new `workspace.replan_started { version, runId }`, `workspace.replanned { version, runId, added: string[], proposedCancellations: string[], droppedCancellations: { taskId, status }[] }`, `task.cancelled { reason, goalVersion: number | null }`), `packages/domain/test/events/schema.test.ts`
- Create: `packages/domain/src/planning/delta.ts`, `packages/domain/src/goal/{version,index}.ts`; Modify: `packages/domain/src/planning/graph.ts` (export `findCycle`), `packages/domain/src/run-context/sections.ts` + `render.ts`, `packages/domain/src/supervisor/{situations,actions,candidates,policy,observe,report,world}.ts`, `packages/domain/src/index.ts`
- Tests: `packages/domain/test/planning/delta.test.ts`, `packages/domain/test/goal/version.test.ts`, run-context `sections`/`render` tests, supervisor `candidates`/`policy`/`observe`/`report` tests, db `enum-parity`

**Interfaces (produces):**
```ts
// planning/delta.ts
export interface PlanDelta { readonly add: readonly PlanTask[]; readonly cancel: readonly string[]; readonly keep: readonly string[] }
export function parsePlanDelta(text: string, existingTaskIds: readonly string[]): Result<PlanDelta, string>
  // last-to-first JSON object with { add: [], cancel: [], keep: [] } (each may be empty; add ≤ 20); validateDelta: unique keys, no key equal to an existing id, dependsOn ∈ keys ∪ existingTaskIds, no cycle among add (findCycle), cancel/keep ⊆ existingTaskIds, cancel ∩ keep = ∅
export const REPLAN_INSTRUCTIONS: readonly string[]   // contains the literal "replan"; asks for exactly one JSON object {"add":[...PlanTask],"cancel":["<task id>"],"keep":["<task id>"]}; "never cancel work that is running or done"
export interface BoardTask { readonly id: string; readonly title: string; readonly status: TaskStatus; readonly goalVersion: number | null }
export function applyCancelPolicy(delta: PlanDelta, board: readonly BoardTask[]): { readonly cancellable: readonly string[]; readonly dropped: readonly { taskId: string; status: TaskStatus }[] }  // cancellable iff the board task's status ∈ backlog|ready|blocked; every other id in `cancel` is dropped with its status (ids not on the board are impossible after parsePlanDelta, which validates cancel ⊆ existingTaskIds)
// goal/version.ts
export function goalSha256(text: string): string
export function goalDiff(previous: string, next: string): { readonly added: readonly string[]; readonly removed: readonly string[] }   // line-level set difference, trimmed lines, order preserved
// run-context
task source: { kind: 'task'; taskId: string; sha256: string }; planning_goal source: { kind: 'planning_goal'; sha256: string; version: number }
replan section: kind 'replan', source { kind: 'replan'; previousVersion: number; version: number; previousSha256: string; sha256: string; boardTaskIds: readonly string[] }; SECTION_ORDER.planning = ['profile', 'planning_goal', 'replan']
renderRunContext: trailer = REPLAN_INSTRUCTIONS when a replan section is present (kind still 'planning')
// supervisor
SITUATION_KINDS + 'stale_task'; Action + { kind: 'cancel_task'; taskId: string; reason: string }; tierOf(cancel_task) → 'proposed' (halted too); candidates(stale_task) → [cancel_task, escalate_to_human, no_action] with tiers; observe never emits stale_task (documented); SupervisorWorld.goalVersion: number, tasks[].goalVersion: number | null; summarise.next.stale = non-terminal tasks with goalVersion !== null && goalVersion < world.goalVersion
roleHasHolder(world, role, exceptSlaveId) excludes the asker for question situations (R2)
```
- [ ] Tests first: parsePlanDelta valid / empty arrays / dependsOn on an existing id / key colliding with an existing id / cycle in add / cancel of unknown id / cancel ∩ keep; applyCancelPolicy per status; goalSha256 stable; goalDiff added/removed/unchanged; sections zod round-trips incl. replan; render: trailer choice both ways and the replan text; supervisor: cancel_task tier always proposed, candidates order, next.stale counts, roleHasHolder asker exclusion (a role held only by the asker → unanswerable_question); events round-trips; enum parity for the new EventType/SituationKind values; migration applied to dev + test, `migrate diff` empty, backfill read-back (seed a pre-M40 workspace with a goal and one task on the dev DB before migrating — E2 idiom — paste both readings in the report).
- [ ] Commit `feat(db,domain): m40 t1 — GoalVersion with backfill, task goal stamps and content hashes, the plan delta, the replan section, stale_task/cancel_task`.

---
### Task 2: Control — versioned setGoal, goal history, cancelTask, the cancel_task arm, loader stamps, R2

**Files:**
- Modify: `packages/control/src/goal.ts` (`setGoal` transactional + versioned + `goal_unchanged`; new `listGoalVersions`), `packages/control/src/task.ts` (`cancelTask`), `packages/control/src/supervisor.ts` (`carryOut` `cancel_task` arm; `pruneDecisions` + `modelCostUsd: null`), `packages/control/src/supervisorWorld.ts` (`goalVersion` on world and tasks), `packages/control/src/refusal.ts` (+ `goal_unchanged { workspaceId; version }`, `task_not_cancellable { taskId; status }`), `packages/control/src/index.ts`, `apps/web/test/refusal-status.test.ts`
- Tests: `packages/control/test/integration/{goal,task,supervisor,supervisorWorld}.test.ts`

**Interfaces:**
```ts
export async function setGoal(workspaceId: string, goal: string, principal?: Principal): Promise<Result<{ version: number; sha256: string }, ControlRefusal>>
  // invalid_goal (blank) | workspace_not_found | goal_unchanged; tx: SELECT … FOR UPDATE on Workspace, version = goalVersion + 1, goalVersion.create, workspace.update({ goal, goalSetByUserId, goalVersion }); after commit: workspace.goal_set { goal, version, sha256 } (actor human, userId)
export interface GoalVersionView { version: number; text: string; sha256: string; setByUserId: string | null; createdAt: string; diff: { added: string[]; removed: string[] } | null }  // diff vs the previous version, null for v1
export async function listGoalVersions(workspaceId: string): Promise<Result<readonly GoalVersionView[], ControlRefusal>>   // newest first; workspace_not_found
export async function cancelTask(taskId: string, reason: string, origin: 'human' | 'system' = 'human', principal?: Principal): Promise<Result<void, ControlRefusal>>
  // task_not_found | task_run_active | task_not_cancellable { taskId, status } (status ∉ backlog|ready|blocked); row lock; update status 'cancelled', lastRejectionReason = reason; task.cancelled { reason, goalVersion } actor = origin
carryOut: 'cancel_task' → cancelTask(taskId, reason, origin, principal)
```
- [ ] Tests first: setGoal v1 then v2 (rows, cache, event payloads with version/sha), `goal_unchanged` on the same text (no row, no event), concurrent setGoal serialised (two awaited in `Promise.all` → versions 1 and 2, never a duplicate — the unique constraint would throw otherwise); listGoalVersions newest-first with diffs; cancelTask each refusal + event + `goalVersion` in the payload; carryOut cancel_task applied via approveDecision on a `stale_task` proposal; pruneDecisions ignores a `modelCalled: false` row that somehow carries a cost; loader carries goalVersion.
- [ ] Commit `feat(control): m40 t2 — versioned setGoal and goal history, cancelTask, the cancel_task arm, goal stamps in the Supervisor world`.

---
### Task 3: Orchestrator — the re-plan trigger, replan context, concludeReplan, the fake CLI arm

**Files:**
- Modify: `apps/orchestrator/src/planning.ts` (`dispatchPlanning`: after the goal-null check, compute `maxTaskVersion` over non-terminal tasks (`status ∉ done|failed|cancelled`); first-plan path unchanged when `taskCount === 0`; RE-PLAN path when `taskCount > 0 && workspace.goalVersion > (maxTaskVersion ?? 0)`: no live planning run; dedup = a `workspace.replan_started` event for this version exists whose `runId` names a run that is non-terminal or `succeeded` (a failed re-plan is retryable); retry cap = failed planning runs since the version's `goal_set` event (`payload.version`) ≥ `PLANNING_RETRY_CAP` → stop; staffing as today; `buildRunContext({ …, replan: { previousVersion: goalVersion - 1, version: goalVersion } })`; append `workspace.replan_started { version, runId }` after `adapter.start`; new `concludeReplan(runId)`; `concludePlanning` becomes the dispatcher per E4 (reads the run's `RunContext.sections`, `replan` present → `concludeReplan`)), `apps/orchestrator/src/runContext.ts` (`BuildRunContextInput.replan?`; `task` source sha256; `planning_goal` version from `workspace.goalVersion`; the `replan` section text: previous goal text from `GoalVersion` v-1, new goal, board lines `- <id> [<status>] <title> (goal v<n>)`), `apps/orchestrator/src/verify.ts` (no change if `concludePlanning` dispatches; confirm), `packages/providers/test/fake-claude.mjs` (`replanArm(prompt)`: `if (!prompt.includes('"replan"')) return false;` read `fixtures/replan-delta.ndjson`, replace the token `$CANCEL_ID` in every line with the value of `--replan-cancel <id>` from argv (if absent, replace with `""` so `cancel` is `[]`), write the lines, exit — placed BEFORE the `"task graph"` check in every mode that has one), `packages/providers/test/fixtures/replan-delta.ndjson` (assistant text `{"add":[{"key":"docs","title":"Document the new endpoint","description":"Write the API doc for the new endpoint the goal now asks for.","role":"backend","dependsOn":[]}],"cancel":["$CANCEL_ID"],"keep":[]}` + result line + Stop hook line)
- Tests: `apps/orchestrator/test/integration/planning.test.ts` (re-plan: goal v2 on a board with a `backlog` task → planning run with the replan section + `REPLAN_INSTRUCTIONS` trailer, `workspace.replan_started`; conclude with the fake delta → one new `backlog` task `goalVersion 2`, one pending `stale_task`/`cancel_task` decision, `workspace.replanned` with `added`/`proposedCancellations`; a cancel naming a `running` task → `droppedCancellations`; a second tick → no second re-plan (dedup); a failed re-plan → retried until the cap; first-plan path still works and stamps `goalVersion 1`), `runContext.test.ts` (task sha256; planning_goal version; replan section), `packages/providers/test/fake-claude.test.ts` (replan arm precedence + `--replan-cancel` substitution)
- [ ] Commit `feat(orchestrator,providers): m40 t3 — a changed goal re-plans as a delta; additions land, cancellations are proposed; every run records the task text it saw`.

---
### Task 4: CLI and web

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (`goal-history --workspace <id>`; `cancel-task --task <id> --reason <text> [--by <name>]`; `replan-status --workspace <id> [--prompt]`; `set-goal` prints the new version; USAGE), `apps/orchestrator/test/integration/cli.test.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/goal/history/route.ts` (GET → `GoalVersionView[]`, 404 unknown workspace), `apps/web/src/server/goal.ts` (view builder); Modify: `apps/web/src/components/project/GoalPanel.tsx` (version number, history list with line diffs, "a re-plan will run on the next tick" after an edit on a non-empty board), `apps/web/src/server/overview.ts` (workspace `goalVersion`; task cards `goalVersion`), `TaskCard.tsx`/`TaskDetailPanel.tsx` (`goal vN`; **stale** badge when `goalVersion !== null && goalVersion < workspace.goalVersion`; cancelled tasks greyed with `lastRejectionReason`), `SupervisorPanel.tsx` (`actionText` `cancel_task`: "cancel task <title>: <reason>"), `activity/cards.tsx` + `lib/activityFilters.ts` (`workspace.replan_started`/`workspace.replanned` under `workspace`, `task.cancelled` under `tasks`), `apps/web/test/activity-cards.test.tsx`
- Tests: `apps/web/test/integration/control-routes.test.ts` (history GET), `goal-panel.test.tsx` (history + diff render, the re-plan sentence), `overview.test.ts` (goalVersion + stale), `tasks-components.test.tsx` (badge + cancelled render), `supervisor-panel.test.tsx` (cancel_task row), `web:build`
- [ ] Commit `feat(cli,web): m40 t4 — goal history and diffs, the stale badge, cancel-task, replan-status`.

---
### Task 5: Gate, CI, README, full verification

**Files:** `scripts/gate-m40-requirement-versioning.mjs`, `package.json` (`"gate:m40-requirement-versioning": "tsc --build && node --env-file=.env scripts/gate-m40-requirement-versioning.mjs"`), `.github/workflows/ci.yml` (after `gate:m39-supervisor-mailbox`), `README.md` (`## Requirements have versions` after "What a slave is told"; "Tests and CI" roster +1)

Gate (real daemon, fake CLI `m8-flow`; borrow gate-m39's helpers): workspace with a `manager` slave (`Atlas`, `runtimeRoles: ['manager']`) and NO slave holding `backend`, so the planned tasks stay `ready`/`backlog` untouched by dispatch (the fake plan's tasks are all `backend`). Stages exactly spec §6 (1)–(5): first plan stamps `goalVersion 1`; `set-goal` v2 (CLI) → `GoalVersion` 1 and 2, `goal_set` v2 with sha; the re-plan run's `RunContext` manifest has the `replan` section and the prompt contains `"replan"`; the daemon is spawned with `--replan-cancel <id of a backlog task>` → one new task `goalVersion 2`, one pending `cancel_task` proposal, `workspace.replanned`; `approve-decision --id` → `cancelled` + `task.cancelled`; a dependent stays `dependenciesDone: false` (query the world or the graph read model); `set-goal` with the same text → `goal_unchanged` (non-zero exit), no v3; a backfill proof: a hand-seeded pre-M40 shape cannot be re-created after the migration ran, so the gate asserts instead that a task created by the FIRST plan carries `goalVersion 1` and the v1 `GoalVersion` row matches `Workspace.goal` at that moment.
- [ ] Full verification in order: `npm run --silent typecheck`; `npm run gate:m26-vocabulary`; `npx vitest run` (no daemon; cli flake → alone); `npm run web:build` (no `next dev`); gates m40, m39, m38, m37, m36, m35, m33, m11.
- [ ] Commit `test(gates),docs: m40 t5 — gate:m40-requirement-versioning; README`.
