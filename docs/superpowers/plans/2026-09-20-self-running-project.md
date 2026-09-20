# Self-Running Project (E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With one project switch on, the Supervisor applies its own decisions, diagnoses why a task is stuck before choosing a remedy, retries failed tasks with the permission they were missing, clears a circuit-breaker halt whose cause it fixed, honours per-task needs (network, commands) at dispatch, and merges approved work without a person — while everything stays a proposal when the switch is off.

**Architecture:** Four columns (`Workspace.supervisorAutonomy`, `Task.requiredPermissions`, `Task.retries`, `Task.reviewWindowFrom`); the world the Supervisor sees gains the autonomy flag and three failure facts per task; `tierOf` gains one rule; three actions (`retry_task`, `retry_review`, `clear_halt`) and a pure diagnosis join the existing candidate machinery and `carryOut`; the plan graph gains `needs`, which flows into the permission snapshot at dispatch; auto-merge and autonomy become settings with verbs, routes, CLI flags and intake defaults; the Home feed shows what the Supervisor did.

**Tech Stack:** TypeScript (ESM, `noUncheckedIndexedAccess`), Prisma + Postgres, zod, vitest, Next.js (apps/web), the fake Claude CLI (`packages/providers/test/fake-claude.mjs`) for daemon-level tests.

**Spec:** `docs/superpowers/specs/2026-09-20-self-running-project-design.md` — read it first; tasks cite its rulings R1–R9 and §2/§3 tables.

## Global Constraints

- Never write the word "agent" (any case, as a word) in tracked source, tests, README or `docs/ia.md`; `scripts/gate-m26-vocabulary.mjs` fails on it. Say "worker", "persona", "Supervisor".
- No prettier; match surrounding style (2-space, single quotes, no semicolons, trailing commas).
- Autonomy values are exactly `'propose' | 'act'`; Prisma enum `SupervisorAutonomy { propose act }`; column default `propose`; intake draft default `'act'`.
- Task needs are exactly the closed list `['network_fetch', 'run_commands']` (a subset of `PermissionKind`); stored in `Task.requiredPermissions String[] @default([])`; honoured for `implementation` runs only; an explicit `deny` row still wins.
- `retry_task` moves a `failed` task to `rework` with `attempt: 0`, `activeRunId: null`, `retries + 1`; at `retries >= 2` the only candidate is `escalate_to_human`.
- `retry_review` moves a `blocked` task to `reviewing` and stamps `reviewWindowFrom = now`; `dispatchReview` counts review attempts since `max(latestImpl.startedAt, reviewWindowFrom)`.
- `clear_halt` applies only for halt reason `circuit_breaker`, never for a budget halt, at most once per workspace per hour under `act`.
- Under `act`, every action except `escalate_to_human` is `applied`, unless the world is halted (then only `clear_halt` may apply; all else stays proposed).
- New event types: none. New tables: none.
- Tests run against the shared test database: ONE vitest process at a time; `set -a; . ./.env; set +a` first; `npx tsc --build` before orchestrator/web tests (they import built packages).
- Commit per task with `git -c core.hooksPath=/dev/null commit`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Schema — four columns and the enum (spec R1, R3, R5)

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`model Workspace` beside `supervisorProfile` ~line 114; `model Task` beside `requiredCapabilities` ~line 1060-1122; new enum beside `enum MessageKind` ~line 1052)
- Create: `packages/db/prisma/migrations/20260920150000_self_running_project/migration.sql`

**Interfaces:**
- Produces on the Prisma client: `Workspace.supervisorAutonomy: 'propose' | 'act'`, `Task.requiredPermissions: string[]`, `Task.retries: number`, `Task.reviewWindowFrom: Date | null`; `SupervisorAutonomy` enum export.

- [ ] **Step 1: Schema**

```prisma
/// E R1: whether the Supervisor applies its own decisions (`act`) or proposes them for a person
/// (`propose`, today's behaviour). One switch per project; `tierOf` reads it.
enum SupervisorAutonomy {
  propose
  act
}
```
In `model Workspace` after `supervisorProfile`:
```prisma
  supervisorAutonomy SupervisorAutonomy @default(propose)
```
In `model Task` after `requiredCapabilities`:
```prisma
  /// E R5: what the planner said this task needs beyond the run kind's baseline -- a closed list
  /// (`network_fetch`, `run_commands`) added to the implementation run's permission snapshot.
  requiredPermissions String[] @default([])
  /// E R3: how many times the Supervisor put this task back from `failed`; two is the ceiling.
  retries             Int      @default(0)
  /// E R3: when set, review attempts are counted from here rather than from the implementation
  /// run -- `retry_review`'s stamp after an infrastructure failure spent the review budget.
  reviewWindowFrom    DateTime?
```

- [ ] **Step 2: Migration** (hand-written, comment first as the repo does):

```sql
-- E, the self-running project (2026-09-20): one switch, three task facts.
-- No backfill: every existing project keeps proposing (the default), no task has needs, retries
-- or a review window until the Supervisor or the planner writes them.
CREATE TYPE "SupervisorAutonomy" AS ENUM ('propose', 'act');
ALTER TABLE "Workspace" ADD COLUMN "supervisorAutonomy" "SupervisorAutonomy" NOT NULL DEFAULT 'propose';
ALTER TABLE "Task" ADD COLUMN "requiredPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Task" ADD COLUMN "retries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "reviewWindowFrom" TIMESTAMP(3);
```

- [ ] **Step 3:** `set -a; . ./.env; set +a; npm run db:migrate:test && npm run db:generate && npx tsc --build` — green. Run `npx vitest run packages/control/test/integration/supervisor.test.ts` (or the nearest supervisor control test) to prove the client agrees.
- [ ] **Step 4: Commit** `feat(db): supervisorAutonomy, Task.requiredPermissions/retries/reviewWindowFrom`.

---

### Task 2: Domain world and tier (spec R1, R2, §2)

**Files:**
- Modify: `packages/domain/src/supervisor/world.ts` (`SupervisorWorld` gains `autonomy`; `SupervisorTask` gains three fields)
- Modify: `packages/domain/src/supervisor/policy.ts` (`tierOf`)
- Modify: `packages/domain/test/supervisor/fixtures.ts` (`world()` default `autonomy: 'propose'`; `task()` defaults `latestFailure: null, deniedKinds: [], failureCount: 0`)
- Test: `packages/domain/test/supervisor/policy.test.ts`

**Interfaces:**
```ts
export interface TaskFailure { readonly runKind: 'implementation' | 'review' | 'planning'; readonly reason: string; readonly at: number }
// SupervisorTask +=
readonly latestFailure: TaskFailure | null
readonly deniedKinds: readonly string[]
readonly failureCount: number
readonly retries: number
// SupervisorWorld +=
readonly autonomy: 'propose' | 'act'
```

- [ ] **Step 1: Failing tests** in `policy.test.ts`, a table over every `ActionKind` (import `ACTION_KINDS` or enumerate): under `world({ autonomy: 'act' })` and a non-halted world, `tierOf(action, situation, world)` is `'applied'` for every kind except `escalate_to_human` (`'escalated'`) and `no_action` (`'noop'`); under `act` + `halted: { reason: 'circuit_breaker' }` every kind is `'proposed'` except `clear_halt` (`'applied'`) — build `clear_halt` as `{ kind: 'clear_halt', workspaceId: 'ws-1', reason: 'circuit_breaker' }` (the action shape Task 3 defines; declare it in the test via `as Action` until Task 3 lands, or land Task 3's `actions.ts` change in this task if the compiler refuses — say which in the report); under `propose` the existing expectations are unchanged (run the whole file).
- [ ] **Step 2:** RED.
- [ ] **Step 3: Implement** — in `tierOf`, after the `escalate_to_human`/`no_action` returns and BEFORE the halted rule: nothing; after the halted rule add:
```ts
  // E R1: the switch. A person who turned autonomy on gets every routine and non-routine action
  // applied; only the escalation stays a question. The halted rule above still wins, except for
  // the one action that exists to end a halt (Task 3 adds it; `clear_halt` is applied under `act`).
  if (world.autonomy === 'act') return 'applied'
```
and, inside the halted rule, `if (world.halted !== null) return action.kind === 'clear_halt' && world.autonomy === 'act' ? 'applied' : 'proposed'`. Add the three fields + `retries` to `SupervisorTask`, `autonomy` to `SupervisorWorld`, defaults in `fixtures.ts`. Fix every compile error the new required fields cause in domain tests by relying on the fixture defaults (grep for object literals typed as `SupervisorTask` outside the fixtures — there should be none).
- [ ] **Step 4:** `npx tsc --build && npx vitest run packages/domain/test/supervisor` — GREEN.
- [ ] **Step 5: Commit** `feat(domain): autonomy on the Supervisor world; act applies every action but the escalation`.

---

### Task 3: Domain — diagnosis, three actions, situations and candidates (spec R3, R4, §3)

**Files:**
- Create: `packages/domain/src/supervisor/diagnosis.ts`
- Modify: `packages/domain/src/supervisor/actions.ts` (three kinds + `actionSchema` branches + `ACTION_KINDS` list)
- Modify: `packages/domain/src/supervisor/observe.ts` (`taskFacts` gains `latestFailure`, `deniedKinds`, `failureCount`, `retries`; `task_failed` only when `dependents > 0` OR always? — keep the existing predicate, add the facts)
- Modify: `packages/domain/src/supervisor/candidates.ts` (`task_failed`, `review_cap_blocked`, `workspace_halted`, `run_looping` arms)
- Modify: `packages/domain/src/supervisor/index.ts` (export diagnosis)
- Tests: `packages/domain/test/supervisor/diagnosis.test.ts` (new), `observe.test.ts`, `candidates.test.ts`

**Interfaces:**
```ts
// actions.ts
| { readonly kind: 'retry_task'; readonly taskId: string; readonly title: string; readonly reason: string; readonly grant?: { readonly slaveId: string; readonly permissionKind: string } }
| { readonly kind: 'retry_review'; readonly taskId: string; readonly title: string; readonly reason: string }
| { readonly kind: 'clear_halt'; readonly workspaceId: string; readonly reason: string }
// diagnosis.ts
export type FailureReading = 'infrastructure' | 'denied_tool' | 'lost' | 'rejected' | 'unknown'
export function readFailure(input: { readonly reason: string | null; readonly deniedKinds: readonly string[]; readonly requiredPermissions: readonly string[]; readonly requiredRole: string }): { readonly reading: FailureReading; readonly deniedKind: string | null }
```
Rules (pure, table-driven, tested): `reason` matching `/maxBuffer|could not be read|spawn|ENOENT|EACCES|adapter|provider|no valid verdict/iu` → `infrastructure`; `deniedKinds` containing a kind in `requiredPermissions`, or containing `network_fetch` when `requiredRole` ∈ {`research`, `marketing`, `sales`, `paid-media`, `support`, `academic`} → `denied_tool` with that kind; `reason` matching `/behavioural_loop|run_timeout|going in circles|output stream ended/iu` with no denied kind → `lost`; `reason` matching `/review.*rejected|rejected/iu` → `rejected`; else `unknown`.

Candidates:
- `task_failed`: if `task.retries >= 2` → only the last-resorts (`escalate_to_human` summary carries `latestFailure.reason`). Else `readFailure(...)`: `denied_tool` → `retry_task` with `grant: { slaveId: <the worker whose run was denied: world.denials or the latest run's slaveId>, permissionKind }`; `infrastructure` → `retry_task` (no grant); `lost` → `retry_task` with `reason` "steer: …" (the run context reads it); `rejected`/`unknown` → `retry_task` when `retries === 0`, else last-resorts. Always then `escalate_to_human`, `no_action`.
- `review_cap_blocked`: `infrastructure` → `retry_review` first; otherwise the existing `unblock_task`/`raise_max_attempts`/`mark_task_failed` order; last-resorts.
- `workspace_halted`: when `facts.reason === 'circuit_breaker'` and some task in the world has `retries > 0` with `status` in `rework|running|reviewing` (the cause was addressed) → `clear_halt`; else last-resorts. (The once-per-hour rule is enforced in control, Task 4.)
- `run_looping`: steer text gains ", and you are being denied <kinds>: do not call them again" when `deniedKinds` is non-empty.

- [ ] **Step 1:** Failing tests: `diagnosis.test.ts` one `it` per row of the table above (+ `unknown`); `observe.test.ts` — `task_failed` facts carry the four new fields; `candidates.test.ts` — one `it` per candidate rule above (retry with grant, retry without, retries ceiling, retry_review on infrastructure, clear_halt only after an addressed cause, steer text with denied kinds); `actionSchema` round-trips the three new kinds.
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** `npx vitest run packages/domain/test/supervisor` GREEN. **Step 5: Commit** `feat(domain): diagnosed remedies — retry_task, retry_review, clear_halt`.

---

### Task 4: Control — loader facts, settings, verbs, carryOut (spec R2, R3, R4)

**Files:**
- Modify: `packages/control/src/supervisorWorld.ts` (`loadSupervisorWorld`: autonomy; two new bounded queries; map into `SupervisorTask`)
- Modify: `packages/control/src/supervisor.ts` (`setSupervisorSettings({ autonomy })` + event field `supervisorAutonomy`; `carryOut` cases for the three kinds; the once-per-hour rule for `clear_halt`)
- Modify: `packages/control/src/unblock.ts` (`unblockTask(taskId, { retryReview: true })` → `reviewing` + stamp; new `retryTask(taskId, { grant? }, principal, origin)`)
- Modify: `packages/control/src/permission.ts` only if `setSlavePermission` needs a `by: 'supervisor'` label (check its signature; the approver principal is what it records today — keep that).
- Tests: `packages/control/test/integration/supervisorWorld.test.ts` (or the loader's existing test file — find it by grepping `loadSupervisorWorld` under `packages/control/test`), `unblock.test.ts`, `supervisor.test.ts` (carryOut)

**Interfaces:**
- Loader queries (raw SQL beside `loadLatestGuardrails`): `loadLatestFailures(tx, workspaceId)` → `Map<taskId, { runKind, reason, at }>` via `SELECT DISTINCT ON (e."taskId") e."taskId", e.payload->>'reason' AS reason, r.kind, e.ts FROM "ExecutionEvent" e JOIN "SlaveRun" r ON r.id = e."runId" WHERE e."workspaceId" = $1 AND e.type = 'run_failed' AND e."taskId" IS NOT NULL ORDER BY e."taskId", e.seq DESC`; `loadDeniedKinds(tx, workspaceId)` → `Map<taskId, string[]>` via `SELECT "taskId", array_agg(DISTINCT payload->>'capability') FROM "ExecutionEvent" WHERE "workspaceId" = $1 AND type = 'run_tool_denied' AND "taskId" IS NOT NULL GROUP BY "taskId"`; `failureCount` from `SELECT "taskId", COUNT(*)::int FROM "SlaveRun" WHERE kind = 'implementation' AND status = 'failed' AND "taskId" IN (...) GROUP BY "taskId"`. `retries` and `supervisorAutonomy` come from the existing task/workspace reads (add to the raw task select and the workspace select).
- `retryTask(taskId, input: { readonly grant?: { slaveId, permissionKind } }, principal?, origin?)`: refuses unless `status === 'failed'`; refuses `retry_ceiling_reached` at `retries >= 2`; in one transaction: `status: 'rework', attempt: 0, activeRunId: null, retries: { increment: 1 }`; when `grant` given, `setSlavePermission(grant.slaveId, grant.permissionKind, 'allow', principal)` FIRST (so a failing grant leaves the task failed); emits `task.unblocked` with payload `{ status: 'rework', attempt: 0, retries, reason: 'retry_task', grant? }` (existing event type).
- `unblockTask(taskId, { retryReview: true })`: refuses unless `blocked`; sets `status: 'reviewing', reviewWindowFrom: now`; emits `task.unblocked` with `{ status: 'reviewing', reason: 'retry_review' }`.
- `clear_halt` in `carryOut`: `if (workspace.haltClearedAt !== null && now - haltClearedAt < 60 * 60 * 1000) return refused({ kind: 'halt_recently_cleared' })` then `clearHalt(workspaceId)`; a refusal becomes `supervisor.failed` as today and the candidate rule (Task 3) will offer `escalate_to_human` next pass because `clear_halt` failed (add a `recentlyClearedAt` fact to `workspace_halted`: `world.haltClearedAt` — loaded from the workspace row — and let candidates skip `clear_halt` within the hour, so the model is never offered a refusable action).

- [ ] **Step 1:** failing tests: loader maps the three facts from seeded events (a `run.failed` with reason, two `run.tool_denied` rows, two failed runs); `autonomy` read; `setSupervisorSettings({ autonomy: 'act' })` writes and emits `{ field: 'supervisorAutonomy', from: 'propose', to: 'act' }`; `retryTask` happy path with grant (permission row allowed, task rework/attempt 0/retries 1, event); refusals (not failed; ceiling); `unblockTask({ retryReview })`; `carryOut` for the three kinds (mock nothing: seed rows); `clear_halt` within the hour refused.
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** `npx tsc --build && npx vitest run <the four files>` GREEN. **Step 5: Commit** `feat(control): the Supervisor's failure facts, retryTask, retry_review, clear_halt, autonomy setting`.

---

### Task 5: Task needs and the review window (spec R5, R6, R3)

**Files:**
- Modify: `packages/domain/src/planning/graph.ts` (`needs?: readonly TaskNeed[]`, `TASK_NEEDS = ['network_fetch', 'run_commands'] as const`, validation drops unknown values into `droppedNeeds`)
- Modify: `packages/domain/src/permission/resolve.ts` (`resolveGrants(rows, provider, runKind, taskGrants: readonly PermissionKind[] = [])`)
- Modify: `packages/control/src/permission.ts` (`writePermissionsFile` input `taskGrants?`; passes to `resolveGrants`; `grants` field in the file includes them)
- Modify: `apps/orchestrator/src/planning.ts` (`concludePlanning` writes `requiredPermissions: planTask.needs ?? []`; records `droppedNeeds` on the plan event beside `droppedCapabilities`)
- Modify: `packages/domain/src/run-context/render.ts` (`PLANNING_GRAPH_INSTRUCTIONS` gains the `needs` line from spec R5)
- Modify: `apps/orchestrator/src/tick.ts` (`startRun`: `taskGrants: task.requiredPermissions` for implementation runs; `task.started` payload `{ title, grants }`)
- Modify: `apps/orchestrator/src/review.ts` (`dispatchReview`: `startedAt: { gt: max(latestImpl.startedAt, task.reviewWindowFrom ?? epoch) }`)
- Tests: `packages/domain/test/planning/graph.test.ts`, `packages/domain/test/permission/resolve.test.ts`, `packages/control/test/integration/permission.test.ts` (or wherever `writePermissionsFile` is tested), `apps/orchestrator/test/integration/planning.test.ts` (needs written; unknown dropped), `apps/orchestrator/test/integration/tick.test.ts` (the permissions file carries the task grant; `task.started` lists it), `apps/orchestrator/test/integration/review.test.ts` (attempts counted since the window), `apps/orchestrator/test/integration/runContext.test.ts` (the prompt line)

- [ ] **Step 1:** failing tests as listed (one `it` each; assert the exact `permissions.json` `allow` list contains the `network_fetch` tools for the provider when the task needs it and the run is implementation; not for review).
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** `npx tsc --build`, run the listed files one at a time — GREEN. **Step 5: Commit** `feat(planning,permissions): task needs flow from the plan into the run's permissions; review attempts count from the retry window`.

---

### Task 6: Auto-merge and autonomy as settings — verbs, CLI, routes, intake (spec R1, R7)

**Files:**
- Modify: `packages/control/src/workspace.ts` (`CreateWorkspaceInput.autoMerge?`, `.supervisorAutonomy?`; new `setWorkspaceIntegration(workspaceId, { autoMerge }, principal)` emitting `workspace.settings_changed { field: 'autoMerge', from, to }` and returning `{ unintegratedDone: number }`)
- Modify: `packages/domain/src/intake/draft.ts` (`autoMerge: z.boolean().default(true)`, `autonomy: z.enum(['propose','act']).default('act')`), `packages/control/src/intake.ts` (`acceptIntake` passes both to `createWorkspace`)
- Modify: `apps/orchestrator/src/cli.ts` (`create-workspace --auto-merge`, `set-auto-merge --workspace <id> --on|--off`, `set-supervisor --autonomy propose|act`, `status` prints `autoMerge` and `autonomy` per workspace; help lines)
- Create: `apps/web/src/app/api/w/[workspaceId]/integration/route.ts` (PUT `{ autoMerge: boolean }`)
- Modify: `apps/web/src/app/api/w/[workspaceId]/supervisor/settings/route.ts` (PATCH accepts `autonomy`)
- Modify: `apps/web/src/components/project/RuntimePanel.tsx` (two toggles under the read-only limits: `data-testid="runtime-auto-merge"`, `data-testid="runtime-autonomy"`, PUT/PATCH via the existing `submit` helper)
- Modify: `apps/web/src/components/projects/IntakeConversation.tsx` (two checkboxes on the card, `data-testid="intake-auto-merge"`, `data-testid="intake-autonomy"`, default checked, edit `edited.autoMerge` / `edited.autonomy`)
- Tests: `packages/control/test/integration/workspace.test.ts`, `intake-accept.test.ts` (both defaults reach the row), `packages/domain/test/intake/draft.test.ts`, `apps/orchestrator/test/integration/cli.test.ts` (the two verbs + status line), `apps/web/test/runtime-panel.test.tsx` (or the panel's existing test), `apps/web/test/intake-conversation.test.tsx` (or existing), a route test for `/integration`

- [ ] **Step 1:** failing tests. **Step 2:** RED. **Step 3:** implement (the `set-auto-merge --on` path prints the README caveat when `unintegratedDone > 0`). **Step 4:** GREEN; `npm run typecheck`; `npm run web:build`. **Step 5: Commit** `feat(settings): auto-merge and autonomy are switches — intake defaults, verbs, CLI, routes, Settings panel`.

---

### Task 7: The feed and the panel switch (spec R1, R8)

**Files:**
- Modify: `apps/web/src/lib/happening.ts` (`HAPPENING_TYPES` += `supervisor.applied`, `supervisor.failed`; `SENTENCE` entries: `'supervisor.applied': (p) => \`The Supervisor ${verbPhrase(p)}\``, `'supervisor.failed': (p) => \`The Supervisor could not ${verbPhrase(p)}: ${str(p,'reason') ?? 'unknown'}\`` where `verbPhrase` maps `action.kind` to a phrase: `retry_task` "retried \"<title>\"", `retry_review` "sent \"<title>\" back to review", `clear_halt` "cleared the halt", `request_permission` "granted <kindLabel> to <name>", `hire_from_catalog` "hired <name>", `unblock_task` "unblocked a task", `steer_run` "steered a worker", default "applied <kind>")
- Modify: `apps/web/src/components/supervisor/SupervisorThreadPanel.tsx` (the scope line gains a switch `data-testid="supervisor-autonomy"` bound to the view's `autonomy`, PATCH `/supervisor/settings { autonomy }`, then reload; label "act on its own")
- Modify: `apps/web/src/server/supervisorThreads.ts` / the supervisor view builder (`buildSupervisorView`) to expose `autonomy`
- Tests: `apps/web/test/happening.test.ts` (sentences), the panel's test file (switch renders from the view and PATCHes), `home.test.tsx` if it asserts the family list

- [ ] Steps: failing tests → RED → implement → GREEN (`npx tsc --build` first) → `npm run web:build` → **Commit** `feat(web): the feed says what the Supervisor did; the panel's autonomy switch`.

---

### Task 8: End to end under `act` — orchestrator, gate, docs, ladder (spec §5)

**Files:**
- Modify: `apps/orchestrator/src/supervisor.ts` only if `carryOut` needs the tick's `now`/deps for `clear_halt` (check; prefer control-side).
- Test: `apps/orchestrator/test/integration/supervise-act.test.ts` (new): a workspace with `supervisorAutonomy: 'act'`, one research seat, one task `failed` whose runs carry a `run.tool_denied { capability: 'network_fetch' }` and a `run.failed { reason: 'cancelling this run: it is going in circles' }`, and the workspace halted `circuit_breaker` in the stats (seed three failed runs); run `supervise` (the orchestrator's) twice with the fake CLI's `supervisor-decision` fixture answering `candidateIndex: 0`: after pass 1 the task is `rework` with `attempt 0`, the seat has `network_fetch: allow`, `supervisor.applied` carries `retry_task`; after pass 2 (`haltClearedAt` null before) the halt is cleared (`clearHalt` applied) and the tick starts a run. A third pass within the hour with a fresh halt proposes `escalate_to_human`.
- Modify: `scripts/gate-m38-supervisor.mjs` — Stage 6 "the switch: a failed task comes back on its own": same scenario through the real daemon with `--fixture m8a-flow`, assert the task is `running` and the permission row exists, no human verb called.
- Modify: `README.md` (the Supervisor section: the switch, `set-auto-merge`, `set-supervisor --autonomy`), `docs/ia.md` (the panel switch and the two feed rows), the spec's §7 errata.
- The full ladder: `npm run typecheck && npx vitest run && npm run web:build` (no daemon running on the host; one process).

- [ ] Steps: failing test → RED → implement whatever the end-to-end path still lacks → GREEN → gate stage → docs → ladder → **Commit** `test,docs: the self-running project end to end; gate stage 6; README and ia`.

---

## Self-review

**Spec coverage.** R1 → T1, T2, T6, T7. R2 → T2, T4. R3 → T3, T4, T5 (review window). R4 → T3, T4. R5 → T5. R6 → T4 (`retry_task` uses `rework`, which `acquireWorktree` already adopts) — the spec's "adopt on retry" is satisfied by that status choice; ledger it as an erratum. R7 → T6. R8 → T7. R9 → no task touches `decide()`, thresholds, verdict parsing; T8's ladder proves it. §5 tests → each task's Step 1 and T8.

**Placeholders.** Each task lists concrete files, interfaces, rules and the assertions its tests make; Steps 1–5 are the same TDD cycle everywhere, spelled out in T2 and referenced by shape in T5–T8 (an implementer writing T6 reads T2's step list; the plan does not repeat five identical lines eight times).

**Type consistency.** `TaskFailure` (T2) is what T4's loader builds and T3's `readFailure` reads through `task.latestFailure`. `retry_task.grant` (T3) is what `retryTask(input.grant)` (T4) consumes. `TASK_NEEDS` (T5) is the value set `Task.requiredPermissions` (T1) holds and `readFailure`'s `requiredPermissions` (T3) reads. `autonomy` (T2 world) is loaded from `Workspace.supervisorAutonomy` (T1) in T4 and set by T6's verb. `verbPhrase` (T7) switches on the same `action.kind` strings T3 declares.
