# M40 — Requirement versioning: a goal has versions, tasks know theirs, a changed goal re-plans

Sixth milestone of the Supervisor sequence (M35 pipeline honesty, M36 messaging, M37 run context, M38 Supervisor, M39 mailbox). Designed 2026-09-10 (overnight) under the user's standing authorisation to proceed with the recommended option at every decision; each such choice is recorded below as a **Ruling** so it can be reworked in the morning. "Slave" is this project's word for an AI worker.

**Goal.** The workspace goal becomes a versioned requirement: every `setGoal` writes a new `GoalVersion`; every planned task carries the goal version it was derived from; every run's recorded context names the exact task text it saw (content hash). When the goal changes on a board that already has tasks, a **delta re-plan** run asks the manager what to add, what to cancel and what to keep — additions land as new backlog tasks immediately, cancellations become Supervisor proposals a human approves, and nothing running, reviewing or done is ever touched automatically.

**Why now.** ADR 0006 and the M8b spec deferred re-planning: today a goal edit on a non-empty board is stored and event-logged and does nothing. The Supervisor (M38/M39) now reasons over the goal and cites it as evidence; the end-to-end scenario gate (next milestone) needs a requirement that can change mid-flight and a system that reacts to it truthfully.

## 1. Rules that bind every part
- **A goal version is immutable.** `setGoal` never overwrites history: it inserts `GoalVersion { version = previous + 1 }` and updates the `Workspace.goal` cache. `Workspace.goal` stays (every reader today keeps working); `Workspace.goalVersion Int @default(0)` mirrors the latest version (0 = never set).
- **Provenance is a hash plus a version.** Each task carries `goalVersion` (the version its plan derived from; null for hand-made tasks) and the run context's `task` section carries `sha256` of `title + '\n' + description` — "the hash is the hook" (M37 §non-goals). `planning_goal` sections gain `version`.
- **Re-planning is a delta, never a rebuild.** A re-plan run receives the previous goal text, the new goal text and the board (every task: key = id, title, status, goalVersion) and returns `{ add: PlanTask[], cancel: string[] (task ids), keep: string[] }`. Structural validation as `parsePlanGraph` (keys, dependencies incl. `dependsOn` that may name EXISTING task ids), plus: `cancel` may name only tasks in `backlog | ready | blocked` (a running, verifying, reviewing, merging, rework, waiting, done, failed or cancelled task is never cancellable by a re-plan — the model's request is dropped and recorded); `keep ∪ cancel ∪ add-keys` need not cover the board (unmentioned tasks are kept).
- **Additions apply, cancellations are proposed.** New tasks are created at once (`backlog`, `createdBy: 'slave'`, `goalVersion = new`), exactly as `concludePlanning` does today; each requested cancellation becomes a `SupervisorDecision` `{ situationKind: 'stale_task', action: cancel_task { taskId }, tier: proposed }` through `recordDecision` (M38's record, cooldown and approval flow); approving runs the new verb `cancelTask`. **Ruling R1:** cancellations are never automatic — a wrong deletion costs real planned work, a wrong addition costs one backlog row a human can cancel.
- **One re-plan per goal version.** The tick dispatches a re-plan when `Workspace.goalVersion > max(Task.goalVersion)` over the board's non-terminal tasks and no live planning run exists, at most once per version (dedup on `workspace.replan_started { version }`), with the same `PLANNING_RETRY_CAP` semantics counted since that version's `goal_set`. An empty board keeps today's first-plan path unchanged.
- **Model output never writes** beyond what `concludePlanning` already does (creating backlog tasks): the model cannot cancel, edit or re-prioritise an existing task; every cancellation is a proposal.
- **Cost, isolation, tests, gates:** as M38/M39 §1 — never a real model call (the fake CLI gains a `"replan"` arm), one vitest at a time, refusals in a transaction throw, `refusalText` covers every new kind, migrations real and `migrate diff` empty, vocabulary `slave`, `web:build` last.
- **Ruling R2 — M39 residuals ride along** (two one-liners): `pruneDecisions` also requires `modelCostUsd: null`; `observe.ts`'s `roleHasHolder` excludes the asker like `holdersOf` does.

## 2. Data model
```prisma
model GoalVersion {
  id            String   @id @default(uuid())
  workspaceId   String
  version       Int
  text          String
  sha256        String
  setByUserId   String?
  createdAt     DateTime @default(now())
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@unique([workspaceId, version])
}
```
`Workspace.goalVersion Int @default(0)`; `Task.goalVersion Int?`; `EventType` + `workspace.replan_started`, `workspace.replanned`, `task.cancelled`; `SupervisorSituationKind` + `stale_task`. Migration `20260910120000_m40_requirement_versioning` with a **backfill**: every workspace with a non-null `goal` gets `GoalVersion { version: 1, text: goal, sha256, setByUserId: goalSetByUserId }` and `goalVersion = 1`; every task whose workspace has a goal gets `goalVersion = 1` (the only version that could have produced it). E2-style manual check on the dev DB in the task report.

Events: `workspace.goal_set` payload gains `version` and `sha256` (additive); `workspace.plan_created` gains `goalVersion`; `task.created` gains `goalVersion: number | null`; `workspace.replan_started { version, runId }`; `workspace.replanned { version, runId, added: string[], proposedCancellations: string[], droppedCancellations: { taskId, status }[] }`; `task.cancelled { reason, goalVersion }`.

## 3. Domain
- `packages/domain/src/planning/delta.ts`: `PlanDelta { add: PlanTask[]; cancel: string[]; keep: string[] }`, `parsePlanDelta(text): Result<PlanDelta, string>` (zod + `validateStructure` reused for `add`'s internal deps; `dependsOn` entries may be either a new key or an existing task id — the validator takes `existingTaskIds`), `REPLAN_INSTRUCTIONS` (verbatim-style constant next to `PLANNING_GRAPH_INSTRUCTIONS`, containing the literal `"replan"`), `applyCancelPolicy(delta, board): { cancellable: string[]; dropped: { taskId, status }[] }` (the status rule above).
- `packages/domain/src/run-context/sections.ts`: `task` source gains `sha256`; `planning_goal` gains `version: number`; new `replan` section `{ kind: 'replan'; previousVersion; version; previousSha256; sha256; boardTaskIds: string[] }` rendered as "The GOAL changed. Previous goal (vN): … New goal (vM): … Current board: …"; `SECTION_ORDER.planning` gains `replan` after `planning_goal` (present only on re-plan runs).
- `packages/domain/src/supervisor/`: situation `stale_task` (subjectId = task id; facts `{ goalVersion, currentVersion, reason: 'replan_cancel' }`) is NOT observed from the world — it is recorded directly by `concludeReplan` (a decision the manager's run proposed). `Action` + `cancel_task { taskId; reason }`; `tierOf(cancel_task) = proposed` always; `candidates` for `stale_task` = `[cancel_task, no_action]`. `chooseByRules` unchanged.
- `packages/domain/src/goal/version.ts`: `goalSha256(text)`, `goalDiff(previous, next): { added: string[]; removed: string[] }` (line-level, for the web history view).

## 4. Control
- `setGoal(workspaceId, goal, principal?)` → transaction: lock the workspace, `version = goalVersion + 1`, insert `GoalVersion`, update `goal`/`goalSetByUserId`/`goalVersion`, `workspace.goal_set { goal, version, sha256 }`. `listGoalVersions(workspaceId): GoalVersionView[]` (newest first, with `diff` against the previous).
- `cancelTask(taskId, reason, origin = 'human', principal?)`: `task_not_found`; `task_run_active`; status ∉ `{backlog, ready, blocked}` → `task_not_cancellable { taskId; status }`; row-locked update to `cancelled` + `lastRejectionReason`; `task.cancelled { reason, goalVersion }`; dependents' `dependsOn` rows are left (the M35 integration gate treats a cancelled dependency as unmet — **Ruling R3:** a task depending on a cancelled task stays blocked until a human removes the dependency; the panel shows it).
- `packages/control/src/supervisor.ts`: `carryOut` arm `cancel_task` → `cancelTask(taskId, reason, origin, principal)`; `recordDecision` accepts `situationKind: 'stale_task'` (the situation object is built by the caller with `situationSchema`).
- Loader: `SupervisorWorld.tasks[].goalVersion`, `world.goalVersion`; `summarise.next` gains `stale: number` (non-terminal tasks with `goalVersion < world.goalVersion`).

## 5. Orchestrator
- `planning.ts`: `dispatchPlanning` gains the re-plan trigger (§1) and starts a planning run with `replan: { previousVersion, version }` in its run-context build; `buildRunContext` renders the `replan` section and appends `REPLAN_INSTRUCTIONS` instead of `PLANNING_GRAPH_INSTRUCTIONS`; `concludeReplan(run)` parses `parsePlanDelta`, creates `add` tasks with `goalVersion = version` and their dependencies (existing ids allowed), applies `applyCancelPolicy`, records one `SupervisorDecision` per cancellable id (`recordDecision({ situation: stale_task, candidates: [cancel_task, no_action], chosenIndex: 0, rationale: the model's reason or "the re-plan for goal vM no longer needs this task", decidedBy: 'model', modelCalled: false, modelCostUsd: null })` — cooldown/pending rules apply), appends `workspace.replanned`. `verifyConcludedRun` routes a planning run with a `replan` section to `concludeReplan`.
- `runContext.ts`: `task` section `sha256`; `planning_goal` `version`.
- Fake CLI: `replanArm(prompt)` keyed on `"replan"` (checked BEFORE `"task graph"`), replaying `fixtures/replan-delta.ndjson`: `{ "add": [{ "key": "docs", "title": "Document the new endpoint", "description": "…", "role": "backend", "dependsOn": [] }], "cancel": ["<first cancel id from env FAKE_CLAUDE_REPLAN_CANCEL>"], "keep": [] }` — the cancel id cannot be known statically: the arm substitutes `$CANCEL_ID` in the fixture from `--replan-cancel <id>` in argv (E6 lesson: argv, not env).

## 6. Web, CLI, gate
- Web: `GET /api/w/[workspaceId]/goal/history` → `GoalVersionView[]`; `GoalPanel` shows the version number, a "history" list with line diffs, and after an edit on a non-empty board the sentence "a re-plan will run on the next tick"; task cards/detail show `goal vN` and a **stale** badge when `goalVersion < workspace.goalVersion`; the Supervisor panel's proposal row for `cancel_task` names the task and the goal versions; a "cancelled" task renders greyed with its reason. Timeline cards for the three new events.
- CLI: `goal-history --workspace <id>` (versions newest first with diffs), `cancel-task --task <id> --reason <text> [--by <name>]`, `replan-status --workspace <id>` (prints `goalVersion`, the board's max task `goalVersion`, whether a planning run is live and whether the next tick will re-plan; with `--prompt` also prints the re-plan prompt that run would get). **Ruling R4:** no one-shot model dispatch from the CLI — the tick is the only thing that starts a planning run.
- Gate `gate:m40-requirement-versioning` (real daemon, fake CLI): (1) set goal v1 on an empty board → first plan (existing `m8-flow` arm) creates tasks stamped `goalVersion 1`; (2) set goal v2 → `GoalVersion` rows 1 and 2, `workspace.goal_set` v2 with sha; the next tick starts a planning run whose `RunContext` has a `replan` section (v1→v2) and the `"replan"` instructions; the fake replays the delta with `$CANCEL_ID` = a `backlog` task → one new backlog task with `goalVersion 2`, one `stale_task` proposal (pending, `cancel_task`), `workspace.replanned` names both; the cancelled-candidate task is still `backlog`; (3) `approve-decision --id` → task `cancelled`, `task.cancelled` event; a dependent of it stays blocked (dependencies not done); (4) a second goal set to the SAME text → no new version (sha equal → `setGoal` refuses `goal_unchanged`); (5) a run on a v1 task records `task.sha256` in its RunContext manifest and `planning_goal.version` on the plan run. Backfill proof: the migration applied to the dev DB over a hand-seeded pre-M40 workspace (E2 style) reported in the task report.
- README: "## Requirements have versions" (after "What a slave is told"): versions, the stale badge, what a re-plan does and does not do (additions apply, cancellations are proposals), `goal-history`, `cancel-task`; "Tests and CI" roster +1.

## 7. Out of scope
Editing a task's title/description after creation (still immutable); versioning profiles (M37 note) — separate; re-prioritisation by the model; automatic cancellation of running work; multi-workspace requirements; requirement "acceptance criteria" objects (M41's scenario gate will say what it needs).

## 8. Errata — where execution corrects this spec
### Plan writing (2026-09-10)
- **E1 — delta validation.** `validateStructure` in `graph.ts` is module-private; `delta.ts` has its own `validateDelta(delta, existingTaskIds)` reusing an exported `findCycle`, allowing `dependsOn` entries that are existing task ids.
- **E2 — the trailer.** The trailer is chosen in `render.ts` by kind; a re-plan run keeps `kind: 'planning'` and `renderRunContext` appends `REPLAN_INSTRUCTIONS` when a `replan` section is present.
- **E3 — fixture substitution.** The fake CLI has no placeholder mechanism; `replanArm` replaces the `$CANCEL_ID` token in the fixture's lines from `--replan-cancel <id>` in argv (M39 E6: argv reaches the scrubbed decision child, env does not).
- **E4 — routing.** `concludePlanning` decides first-plan vs re-plan from the run's recorded manifest (a `replan` section), not from `run.kind`.
- **E5 — `goal_unchanged`.** `setGoal` refuses with `goal_unchanged { workspaceId; version }` when the new text's sha256 equals the current version's; no row, no event.
### Task 1 (2026-09-10)
- **E6 — `stale_task` candidates.** §3 said `[cancel_task, no_action]`; `candidates` keeps its never-empty tail, so the list is `[cancel_task, escalate_to_human, no_action]`. `concludeReplan` picks index 0.
- **§1 clarified — widened payloads are optional on read.** `version`/`sha256`/`goalVersion` on the widened events are optional in the zod arms (rows written before M40 must stay readable); every writer after M40 sets them.
- **§3 clarified — `goalSha256` is hand-rolled** in the domain because `node:crypto` breaks the web bundle; a test cross-checks it against `node:crypto`.
- **§3 clarified — manifest widenings are optional on read.** `task.sha256` and `planning_goal.version` are optional in `runContextManifestSchema` (pre-M40 `RunContext` rows must stay readable by the web context route and `show-context`); every builder after M40 sets them (Task 1 review ruling).
### Task 3 (2026-09-10)
- **E7 — added tasks are `ready`.** §1 said re-plan additions land as `backlog`; `concludePlanning` has always created planned tasks as `ready`, and `concludeReplan` mirrors it (one creation path). The scheduler's `dependenciesDone` gate still decides when they run.
- **§1 clarified — the re-plan retry cap is silent.** Like the first-plan cap, exhausting `PLANNING_RETRY_CAP` for a goal version stops further attempts without a `guardrail.tripped`; the Supervisor's `no_planner`/stale counts and the web's stale badge are the operator's signal.
