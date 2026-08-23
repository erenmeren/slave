# M8b: The Planning Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace with a goal and no tasks gets a planning run whose Zod-validated output
becomes the task graph — completing M8's sentence, "a goal → merged branch, unattended."

**Architecture:** The M8a pass idiom throughout: planning is a tick pass (after resume, before
review) that dispatches a `manager`-role agent's run in the primary checkout; conclusion parses
the last JSON object out of the run's output, validates graph shape and acyclicity in the
domain, and creates tasks + dependencies in one transaction. `AgentRun.taskId` goes nullable,
and every query that scoped runs to a workspace through `task` re-scopes through
`agent.team` so planning runs stay visible to emergency stop, concurrency, budget, sweeps and
resume.

**Tech Stack:** TypeScript monorepo — zod, Prisma/Postgres, Next.js, vitest; the fake Claude
CLI for integration tests and the measured gate.

**Spec:** `docs/superpowers/specs/2026-08-23-m8b-planning-design.md`

## Global Constraints

- Full gate per task: `npm test && npm run typecheck && npm run web:build` (web:build catches
  bundler-only breakage tsc/vitest miss).
- TDD per task: failing tests first, run to verify failure, implement, run green, commit.
- Domain imports use `.js` extensions; domain tests are node-environment vitest.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Line numbers cited below drift as tasks land — locate by content.
- Role conventions are exact lowercase matches: `manager` (this milestone), `reviewer` (M8a).
- The planning prompt must contain the literal substring `"task graph"` (quotes included) —
  the fake CLI's `m8-flow` mode keys on it, as m8a-flow keys on `"verdict"`.
- No optimistic UI anywhere: the snapshot refetch owns truth.

---

### Task 1: The shared last-JSON-object scanner and `parsePlanGraph` — domain

**Files:**
- Create: `packages/domain/src/json/last-object.ts`, `packages/domain/src/planning/graph.ts`
- Modify: `packages/domain/src/review/verdict.ts` (consume the shared scanner; behavior
  unchanged), `packages/domain/src/index.ts` (`export * from './planning/graph.js'`)
- Test: `packages/domain/test/planning/graph.test.ts`; `packages/domain/test/review/verdict.test.ts`
  runs UNTOUCHED and stays green — it is the refactor's safety net

**Interfaces:**
- Produces (Task 7 consumes `parsePlanGraph`; verdict.ts consumes the generator):

```ts
// json/last-object.ts
/** Yields every parseable balanced-brace JSON object in `text`, LAST to FIRST. */
export function* jsonObjectsLastToFirst(text: string): Generator<unknown>
```

```ts
// planning/graph.ts
export interface PlanTask {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly role: string
  readonly dependsOn: readonly string[]
}
export interface PlanGraph { readonly tasks: readonly PlanTask[] }
export function parsePlanGraph(text: string): Result<PlanGraph, string>
```

`jsonObjectsLastToFirst` is `verdict.ts`'s scan loop lifted verbatim — the string-aware
balanced-brace `extractObject` and the `start > 0 ? lastIndexOf('{', start - 1) : -1`
termination guard (commit 35adf71's fix) move with it:

```ts
export function* jsonObjectsLastToFirst(text: string): Generator<unknown> {
  for (let start = text.lastIndexOf('{'); start !== -1; start = start > 0 ? text.lastIndexOf('{', start - 1) : -1) {
    const candidate = extractObject(text, start)
    if (candidate !== null) yield candidate
  }
}
```

(`extractObject` moves here unchanged, private.) `verdict.ts` becomes a consumer:

```ts
for (const candidate of jsonObjectsLastToFirst(text)) {
  const parsed = reviewVerdictSchema.safeParse(candidate)
  if (parsed.success) return ok(parsed.data)
}
return err('no JSON object with { "verdict": "approve" | "reject", "reason": string } found in the review output')
```

`parsePlanGraph`: zod shape first, then structural checks, each failure one `err` string:

```ts
const planTaskSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
})
export const planGraphSchema = z.object({ tasks: z.array(planTaskSchema).min(1).max(20) })
```

Structural validation on the first candidate that passes the zod shape (last-object-wins, the
verdict convention): unique keys; every `dependsOn` entry names an existing key; no
self-dependency; acyclic by Kahn's algorithm (count in-degrees over plan-local keys, repeatedly
remove zero-in-degree nodes; leftovers → `err('the task graph has a dependency cycle through: <keys>')`).
A zod-valid candidate with a structural violation is REJECTED as the verdict (return the err) —
do not keep scanning earlier candidates: the planner's final graph is wrong, and silently
merging an earlier draft would execute a plan nobody saw. Nothing parseable at all →
`err('no JSON object with { "tasks": [...] } found in the planning output')`.

- [ ] **Step 1: Failing tests** (`graph.test.ts`): (a) bare valid 3-task graph with a chain
  parses, `dependsOn` defaulted for the root; (b) graph wrapped in prose + ```json fence
  parses; (c) two objects — the LAST zod-valid one wins; (d) duplicate keys rejected, error
  names the key; (e) `dependsOn` referencing an unknown key rejected; (f) self-dependency
  rejected; (g) a 3-node cycle rejected, error contains 'cycle'; (h) empty tasks array
  rejected; (i) 21 tasks rejected; (j) no JSON at all → the exact fallback string; (k) a
  zod-valid graph with a cycle followed by nothing else → err (structural violations are
  verdicts, not skips).
- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/domain/test/planning --project unit` (module not found), and `npx vitest run packages/domain/test/review --project unit` green BEFORE the refactor.
- [ ] **Step 3: Implement** the scanner module, the verdict refactor, the graph module, the index export.
- [ ] **Step 4: Focused green** — both files above — **then full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): the plan-graph contract and the shared last-JSON-object scanner"
```

---

### Task 2: The two workspace event types — domain, DB enum, kind map, activity cards

The M8a Task 1 twin (commit b65037a is the file-by-file precedent — read its diff).

**Files:**
- Modify: `packages/domain/src/events/schema.ts` (two payload schemas),
  `packages/db/src/enums.ts` (both maps), `packages/db/prisma/schema.prisma` (`EventType` gains
  `workspace_goal_set @map("workspace.goal_set")`, `workspace_plan_created @map("workspace.plan_created")`),
  migration via `npx prisma migrate dev --name m8b_workspace_events --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts`
  then `npm run db:migrate:test` and `npm run db:generate`,
  `apps/web/src/lib/activityFilters.ts` (both types added to `TYPES_BY_KIND`, in the SAME kind
  group `guardrail.tripped` lives in — workspace-scoped, task-less events),
  `apps/web/src/components/activity/cards.tsx` (two cards)
- Test: extend `packages/domain/test/events/schema.test.ts` and
  `apps/web/test/activity-cards.test.tsx` (the M8a Task 1 test shapes)

**Interfaces:**
- Produces (Tasks 4 and 7 emit these):

```ts
'workspace.goal_set': z.object({ goal: z.string().min(1) })
'workspace.plan_created': z.object({
  goal: z.string().min(1),
  tasks: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), role: z.string().min(1) })).min(1),
})
```

Cards: `workspace.goal_set` renders "goal set" with the goal text; `workspace.plan_created`
renders "planned N tasks" with the title+role list. Follow the M8a card component style
exactly (same wrappers, same class idioms as the four cards commit b65037a added).

- [ ] **Step 1: Failing tests** — schema round-trips for both payloads (valid parses; empty
  goal rejected; empty tasks array rejected); a render test per card asserting the goal text /
  the task titles appear. Typecheck RED: the exhaustive maps flag the missing members.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** schema, enums, prisma migration, kind map, cards.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain,db,web): the workspace goal and plan event types"
```

---

### Task 3: `Workspace.goal`, nullable `AgentRun.taskId`, and the run-scoping audit

One task, deliberately: dropping `taskId`'s NOT NULL breaks compilation wherever `run.task` was
non-null, and the re-scoping must land in the same gate or planning runs become invisible to
emergency stop and concurrency the moment Task 6 creates one.

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`model Workspace` gains `goal String?`;
  `model AgentRun`: `taskId String?`, `task Task? @relation(...)` — keep the index),
  migration `m8b_goal_and_planning_runs`
  (`ALTER TABLE "Workspace" ADD COLUMN "goal" TEXT; ALTER TABLE "AgentRun" ALTER COLUMN "taskId" DROP NOT NULL;`)
  then `npm run db:migrate:test` and `npm run db:generate`
- Modify — the audit, every `task: { workspaceId }` run-scope becomes
  `agent: { team: { workspaceId } }` (equivalent for task-bearing runs; the only linkage a
  planning run has):
  - `packages/control/src/pause.ts:80` (`pauseActiveRuns` — emergency stop must pause a live planning run)
  - `apps/orchestrator/src/world.ts:154` (`activeRuns` — a planning run occupies a concurrency slot)
  - `apps/orchestrator/src/world.ts:160` (spend aggregate — planning cost counts toward the budget)
  - `apps/orchestrator/src/world.ts` consecutive-failures raw SQL — replace the
    `JOIN "Task" t … WHERE t."workspaceId"` with
    `JOIN "Agent" a ON a.id = r."agentId" JOIN "Team" tm ON tm.id = a."teamId" WHERE tm."workspaceId" = ${workspaceId}`
    (a garbage planner feeds the circuit breaker, deliberately — the M8a review-run precedent)
  - `apps/orchestrator/src/tick.ts:277` (`resumeRequestedRuns` — a paused planning run must resume)
  - `apps/orchestrator/src/sweep.ts:113` and `:211` (orphan + guardrail sweeps see planning runs)
  - `apps/orchestrator/src/cli.ts:182` (status counts)
  - `apps/web/src/server/overview.ts:148` (spend shown in the UI)
- Modify — compile-driven null-handling where `run.task` is dereferenced (the compiler flags
  each): kind-guarded paths (`review`, `implementation`) assert with a thrown
  `Error(\`run ${id} of kind ${kind} has no task\`)` rather than `!` — a task-bearing kind with
  a null task is data corruption worth failing loudly on.
- Test: extend `apps/orchestrator/test/integration/world.test.ts` (a `working` planning run
  with `taskId: null` — seeded directly — counts in `activeRuns`, its `costUsd` counts in
  `spentUsd`); extend `packages/control/test/integration/pause.test.ts` (`pauseActiveRuns`
  requests pause on a task-less planning run); existing suites are the audit's regression net.

**Interfaces:**
- Produces: `AgentRun.taskId: string | null` (Task 6 creates task-less rows); `Workspace.goal`
  (Tasks 4 and 6 read/write it).

- [ ] **Step 1: Failing tests** — the two extensions above (they fail on the FK/NOT NULL before
  the migration, then on the query scope until the audit lands).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — schema + migration, the nine audit sites, the compile-driven fixes.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db,control,orchestrator,web): the workspace goal column and workspace-scoped task-less runs"
```

---

### Task 4: `setGoal` in control + the CLI verb

**Files:**
- Create: `packages/control/src/goal.ts`
- Modify: `packages/control/src/refusal.ts` (`{ kind: 'invalid_goal' }` union member +
  `refusalText` case `'a goal must be a non-empty text'` — the exhaustive switch forces it),
  `packages/control/src/index.ts` (`export * from './goal.js'`),
  `apps/orchestrator/src/cli.ts` (verb + USAGE)
- Test: `packages/control/test/integration/goal.test.ts`, extend
  `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
- Consumes: Task 2's `workspace.goal_set`, Task 3's `Workspace.goal`.
- Produces (Task 8's route calls this):

```ts
export async function setGoal(
  workspaceId: string,
  goal: string,
): Promise<Result<void, ControlRefusal>>
```

Body:

```ts
export async function setGoal(workspaceId, goal) {
  if (goal.trim() === '') return err({ kind: 'invalid_goal' })
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  await prisma.workspace.update({ where: { id: workspaceId }, data: { goal } })
  await appendEvent({ type: 'workspace.goal_set', workspaceId, actor: 'human', payload: { goal } })
  return ok(undefined)
}
```

Setting a goal on a workspace that already has tasks SUCCEEDS and emits — the pass simply never
fires until the board is empty (spec scope note). CLI, the `emergency-stop` idiom:

```ts
case 'set-goal': {
  const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
  const goal = requireFlag(flags, 'goal')
  const result = await setGoal(workspaceId, goal)
  if (!result.ok) throw new Error(refusalText(result.error))
  process.stdout.write(`goal set on ${workspaceId}\n`)
  return 0
}
```

USAGE gains `  set-goal --workspace <id> --goal "<text>"` without touching existing help lines.

- [ ] **Step 1: Failing tests.** Control: (a) sets the column and emits exactly one
  `workspace.goal_set` with the goal in the payload; (b) `'   '` → `invalid_goal`, column
  untouched, no event; (c) unknown workspace → `workspace_not_found`; (d) a workspace with an
  existing task still succeeds. CLI: `set-goal --workspace <id> --goal x` exits 0 and the row
  carries the goal; missing `--goal` exits 1 with `--goal is required`; USAGE test still green.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(control,orchestrator): setGoal and the set-goal CLI verb"
```

---

### Task 5: The plan fixture and the `m8-flow` fake CLI mode

**Files:**
- Create: `packages/providers/test/fixtures/plan-graph.ndjson`
- Modify: `packages/providers/test/fake-claude.mjs` (one mode)
- Test: extend `packages/providers/test/fake-claude.test.ts`

**Interfaces:**
- Produces: fixture `plan-graph` and mode `m8-flow` (Task 6's tests and Task 9's gate run
  the daemon against it).

`plan-graph.ndjson` is a copy of `fixtures/complete.ndjson` with the assistant text (and, per
the M8a Task 4 precedent, the result line's `result` field with it) replaced by:

```
Here is the plan. {"tasks":[{"key":"core","title":"Write the feature core","description":"Implement the core module the goal asks for.","role":"backend","dependsOn":[]},{"key":"api","title":"Expose the API","description":"Wire the core into the public surface.","role":"backend","dependsOn":["core"]},{"key":"polish","title":"Document and polish","description":"README and cleanup on top of the API.","role":"backend","dependsOn":["api"]}]}
```

The `m8-flow` mode extends `m8a-flow`'s selection with a planning arm — a new branch in
`main()` before the replay fallback:

```js
if (fixtureName === 'm8-flow') {
  const promptIndex = args.indexOf('-p')
  const prompt = promptIndex === -1 ? '' : (args[promptIndex + 1] ?? '')
  if (prompt.includes('"task graph"')) {
    await replayFixture('plan-graph')
    return
  }
  if (prompt.includes('"verdict"')) {
    await replayFixture('review-approve')
    return
  }
  // A work run: the m8a-flow work body verbatim (m8a-work.txt + commit + replay 'complete').
}
```

The work-run body is copied from the existing `m8a-flow` branch (do not refactor `m8a-flow`
itself — its gate and tests stand). The planning arm makes NO commit and writes NO file.

- [ ] **Step 1: Failing tests.** Spawn `--fixture plan-graph` → stdout's parsed result carries
  `"key":"core"`; spawn `m8-flow` with `-p 'produce the "task graph" now'` in a fresh git repo →
  plan-graph replayed, NO new commit, no file written; with `-p 'respond with "verdict" json'` →
  review-approve replayed; with `-p 'work on it'` → a commit exists (the m8a-flow work test shape).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(providers): the plan-graph fixture and the m8-flow fake CLI mode"
```

---

### Task 6: `dispatchPlanning` — the pass, the pump widening, the tick wiring, the seed

**Files:**
- Create: `apps/orchestrator/src/planning.ts` (`buildPlanningPrompt`, `dispatchPlanning`)
- Modify: `apps/orchestrator/src/tick.ts` (call after `resumeRequestedRuns`, before
  `dispatchReviews`; `TickReport` gains `readonly planningStarted: RunId | null`, the halt
  branch returns `planningStarted: null`), `apps/orchestrator/src/pump.ts` (`taskId` in its
  input becomes `TaskId | null`; every event append spreads `...(taskId === null ? {} : { taskId })`),
  `apps/orchestrator/src/daemon.ts` (log line includes `planningStarted !== null`),
  `packages/db/src/seed.ts` (Atlas's role `'AI Manager'` → `'manager'`),
  `packages/db/test/integration/seed.test.ts` (the role assertion follows),
  `scripts/demo-live.mjs` (its manager agent's role likewise `manager`)
- Test: `apps/orchestrator/test/integration/planning.test.ts`

**Interfaces:**
- Consumes: Task 3's nullable `taskId` + `Workspace.goal`, Task 5's fixtures, `TickDeps`,
  `pumps`/`pumpRun`/`verifyConcludedRun`, `writeSettingsFile`/`runFilePaths`, `emailLocalPart`.
- Produces (Task 7 concludes these runs):

```ts
/** The prompt contains the literal substring `"task graph"` — the fake CLI's m8-flow keys on it. */
export function buildPlanningPrompt(goal: string): string

/** One pass: start the planning run when the workspace has a goal and no tasks. */
export async function dispatchPlanning(deps: TickDeps): Promise<RunId | null>
```

```ts
export function buildPlanningPrompt(goal: string): string {
  return [
    'You are the engineering manager. Decompose the GOAL below into a "task graph" for your team.',
    'Read the repository for context, but do NOT modify, create, or commit any file.',
    '',
    `GOAL: ${goal}`,
    '',
    'Your final message must contain exactly one JSON object and nothing else on its line:',
    '{"tasks":[{"key":"short-unique-key","title":"...","description":"...","role":"backend","dependsOn":["other-key"]}]}',
    'Between 1 and 20 tasks. Keys are plan-local. dependsOn lists keys, no cycles.',
  ].join('\n')
}
```

`dispatchPlanning` gates, in order (each a return `null`):

1. `workspace.goal === null` → null.
2. `prisma.task.count({ where: { workspaceId } }) > 0` → null (any status — spec Decision:
   planning fires only at an empty board).
3. A live planning run exists (`kind: 'planning'`, status in `NON_TERMINAL_RUN_STATUSES`,
   `agent: { team: { workspaceId } }`) → null.
4. Retry cap (spec Decision 8): the latest `workspace_goal_set` event's `ts` (or the epoch when
   none — a hand-seeded goal); count `kind: 'planning'`, `status: 'failed'`,
   `startedAt > ts`, workspace-scoped via agent; `>= 2` → null, silently — the two `run.failed`
   events are the escalation.
5. Staffing: the `role === 'manager'` agent in the workspace (`orderBy: { id: 'asc' }`, first
   idle by the busy-set check — the `dispatchReview` staffing shape). None AT ALL → the
   one-shot `guardrail.tripped` `{ guardrail: 'no_planner', detail: 'workspace has a goal and no tasks: no manager-role agent to plan it' }`
   (the `no_reviewer` dedup query with `payload: { path: ['guardrail'], equals: 'no_planner' }`,
   scoped by workspaceId, taskId absent), then null. Busy → null silently.

Dispatch — the `dispatchReview` shape minus diff and minus task: run row first
(`{ agentId, kind: 'planning', status: 'starting' }`, NO taskId), then inside the try:
`runFilePaths(workspace.repoPath, runId)` + `writeSettingsFile`, `adapter.start` with
`worktreePath: workspace.repoPath` (spec Decision 5 — the primary checkout IS the context),
the manager's git identity, `prompt: buildPlanningPrompt(workspace.goal)`; record
pid + worktreePath; chain `pumpRun({ runId, taskId: null, agentId, workspaceId, … }).then(() => verifyConcludedRun(runId))`
into the shared `pumps` set. Spawn failure: the `dispatchReview` catch verbatim (cancel if
spawned, conclude `failed`, `run.failed` without taskId).

In `tick.ts`:

```ts
const planningStarted = await dispatchPlanning(deps)
const reviewsStarted = await dispatchReviews(deps)
return { started, halted: null, skippedNoRole, planningStarted, reviewsStarted }
```

- [ ] **Step 1: Failing tests** (`planning.test.ts`, the review.test.ts harness — real repo,
  TRUNCATE, drainPumps; adapter fixture `m8-flow`): (a) goal set + zero tasks + a `manager`
  agent → one run with `kind: 'planning'`, `taskId: null`, and its events eventually include
  `run.output` (no `taskId` on them); (b) with one existing task, nothing starts; (c) with no
  goal, nothing starts; (d) a second call while the run is live starts nothing; (e) no manager
  → no run and exactly one `no_planner` guardrail event across two passes; (f) two failed
  planning runs newer than the goal_set event → nothing starts; (g) `buildPlanningPrompt`
  contains `"task graph"` and the goal text (unit-style, same file).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** planning.ts, the pump widening, the tick/daemon wiring, the seed +
  demo role rename.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator,db): the planning dispatch pass and the manager role"
```

---

### Task 7: `concludePlanning` — graph to tasks, one transaction

**Files:**
- Modify: `apps/orchestrator/src/planning.ts` (add `concludePlanning`),
  `apps/orchestrator/src/verify.ts` (`verifyConcludedRun` branches on `kind === 'planning'`
  immediately after the `status !== 'succeeded'` early return and BEFORE any `run.task`
  dereference, beside the review branch: `await concludePlanning(brandRunId(run.id)); return`)
- Test: extend `apps/orchestrator/test/integration/planning.test.ts`

**Interfaces:**
- Consumes: Task 1's `parsePlanGraph`, Task 2's `workspace.plan_created`, Task 6's runs.
- Produces: the tasks the M8a pipeline executes.

`concludePlanning(runId)`:

1. Load the run (with agent → team for the workspaceId). Read the text back: the
   `concludeReview` pattern — `run_output` events for the run, `orderBy: { seq: 'asc' }`,
   payloads' `.text` joined with `'\n'`; `parsePlanGraph`.
2. **Invalid** (`!parsed.ok`): conditioned
   `agentRun.updateMany({ where: { id: runId, status: 'succeeded' }, data: { status: 'failed' } })`
   + `run.failed` `{ reason: \`planning run produced no valid task graph: ${parsed.error}\` }`
   (actor `system`, runId + agentId, no taskId). The goal stays; Task 6's cap bounds redispatch.
3. **Valid, but the workspace now has tasks** (an operator raced the plan):
   `console.warn` and return — the `advance()` stale-result discipline; do NOT create a second
   board.
4. **Valid:** one transaction — for each `PlanTask` in graph order, `tx.task.create({ data: {
   workspaceId, title, description, status: 'ready', requiredRole: task.role, createdBy:
   'agent', maxAttempts: workspace.maxAttempts } })`, collecting `key → id`; then for each
   dependency `tx.taskDependency.create({ data: { taskId: idOf(key), dependsOnTaskId: idOf(dep) } })`.
   After the transaction commits: one `task.created` event per task (actor `agent`, taskId set,
   payload exactly per the domain schema's `task.created` definition — read
   `packages/domain/src/events/schema.ts` and mirror the existing emitter of that event), then
   one `workspace.plan_created` `{ goal: workspace.goal, tasks: [{ id, title, role }] }`
   (actor `agent`, runId set).

Tasks with unmet dependencies sit `ready` and unstartable — `decide()`'s `dependenciesDone`
filter already refuses them (decide.ts:47). No new state.

- [ ] **Step 1: Failing tests**: (a) drive the full pass with fixture `m8-flow` through
  `dispatchPlanning` + `drainPumps` → three tasks exist with `requiredRole: 'backend'`,
  `createdBy: 'agent'`, two `TaskDependency` rows matching the chain, three `task.created`
  events, one `workspace.plan_created` whose payload lists all three titles, the run
  `succeeded`; (b) subsequent `dispatchPlanning` starts nothing (tasks exist); (c) fixture
  `review-invalid` (no JSON) as the planning adapter → run `failed`, `run.failed` names the
  missing graph, zero tasks created; (d) seed a task between run success and conclusion (call
  `concludePlanning` directly after creating a task) → warn, zero NEW tasks, no
  `workspace.plan_created`; (e) after (a), the daemon-shape follow-through: a further tick
  starts an implementation run for the root task (the graph is live — `decide` picks it up).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): planning conclusion — a validated graph becomes the board"
```

---

### Task 8: The goal web route and the Overview form

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/goal/route.ts`,
  `apps/web/src/components/GoalCard.tsx`
- Modify: `apps/web/src/components/OverviewClient.tsx` (render the card; pass
  `view.workspace.goal`), `apps/web/src/server/overview.ts` (the snapshot's workspace
  selection carries `goal`)
- Test: extend `apps/web/test/integration/control-routes.test.ts` (a new describe),
  `apps/web/test/goal-card.test.tsx`

**Interfaces:**
- Consumes: Task 4's `setGoal`, Task 11 (M8a)'s `workspaceControlResponse`.
- Produces: `POST /api/w/[workspaceId]/goal` `{ goal: string }` → 200 `{ ok: true }` / 404 / 409.

Route (the emergency-stop route shape plus a body):

```ts
import { setGoal } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const goal = typeof body === 'object' && body !== null && 'goal' in body ? (body as { goal: unknown }).goal : null
  if (typeof goal !== 'string') {
    return Response.json({ error: 'the body must be { "goal": string }' }, { status: 400 })
  }
  return workspaceControlResponse(workspaceId, () => setGoal(workspaceId, goal))
}
```

`GoalCard` (`'use client'`, the AgentPanel `postControl`/`errorMessage` idiom): when
`goal !== null` renders the goal text read-only (`data-testid="workspace-goal"`); when null, a
one-line form — `<input data-testid="goal-input">` + submit `data-testid="goal-submit"`
(`set goal`), disabled while in flight, non-OK error in a `role="alert"` span, success clears
nothing locally — NO optimistic goal: the snapshot refetch shows it (the standing rule).

- [ ] **Step 1: Failing tests.** Route: (a) 200 sets the column and one `workspace.goal_set`
  event exists; (b) 400 on `{ goal: 5 }` and on an unparseable body; (c) 409 with the
  `invalid_goal` text on `{ goal: "  " }`; (d) 404 on an unknown workspace. Card: renders the
  form when goal is null; POSTs `/api/w/w1/goal` with the typed text; renders the goal
  read-only when set; a 409 lands in the alert span.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (remember the snapshot selection: `goal` must reach the client or
  the card can never leave form mode after a refetch).
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): the workspace goal route and the Overview goal card"
```

---

### Task 9: The measured gate — `gate-m8-plan.mjs` — and the docs

**Files:**
- Create: `scripts/gate-m8-plan.mjs`
- Modify: `package.json`
  (`"gate:m8-plan": "tsc --build && node --env-file=.env scripts/gate-m8-plan.mjs"`),
  `README.md` (the command beside the two M8a gates, the `set-goal` verb in the CLI section,
  the M8b row in the Commands table: "a goal → task graph → merged branches, unattended")
- Test: the script IS the test — run it against the dev DB until PASS.

**Interfaces:** consumes everything. The `gate-m8a-merge.mjs` skeleton verbatim (dist imports,
all-in-`try`, `finally` kills the daemon then deletes events before the workspace, `exitCode`
initialized 1, bounded polls).

Script:

1. `makeRepo()`; workspace (`autoMerge: true`, `verifyCommands: ['true']`, `setupCommands: []`,
   NO tasks); one team; agents `manager`, `backend`, `reviewer`.
2. Set the goal **via the CLI** — `execFileSync('node', [ORCHESTRATOR_CLI, 'set-goal',
   '--workspace', id, '--goal', 'Ship the demo feature end to end'])` (the human's path, and it
   emits the `goal_set` event the retry cap keys on).
3. Spawn the daemon (`--period 500`) with `AITEAMOS_CLAUDE_BIN: 'node'`,
   `AITEAMOS_CLAUDE_ARGS: \`${FAKE_CLAUDE} --fixture m8-flow\``.
4. Poll write-free (15 ms / 180 s): first until `task.count > 0` (the plan landed — record N),
   then until every task is `done`.
5. Assert: N >= 2; a `workspace_plan_created` event exists; a `task_review_approved` event
   exists (the pipeline, not a shortcut); `git log --merges --format=%s main` in the repo
   contains at least one `merge(T-`.
6. `PASS: a goal became ${N} tasks and ${merges} merged branches, unattended` — else the
   FAIL-path throw with the run/task dump (the m8a-estop diagnostic style).

- [ ] **Step 1: Write the script complete** (no RED phase — the script is the assertion).
- [ ] **Step 2: Run `npm run gate:m8-plan` to PASS** (fix forward; daemon stderr is piped).
  If the failure looks like a PRODUCT defect, stop and report it — never paper over it in the script.
- [ ] **Step 3: README + package.json edits.**
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(m8b): the goal-to-merged-branch measured gate and README coverage"
```

---

## After the plan: the by-eyes half

`npm run demo` with the real CLI: type a goal into the Overview form, watch the plan appear in
the activity feed and the board fill, watch tasks flow work → verify → review → merge → done,
press STOP mid-flight, clear and resume. Findings become gate-fix tasks.
