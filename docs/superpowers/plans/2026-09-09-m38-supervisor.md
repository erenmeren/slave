# M38 Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A control-layer Supervisor that, at the end of every tick, observes a workspace for stuck situations, chooses one action per situation from a rule-built catalogue (a model picks and explains when one is wired and the budget allows), applies routine actions through existing control verbs, records risky ones as proposals a human approves or rejects, and can report done / stuck / next — every decision a row with a rationale and an event.

**Architecture:** Pure domain (`packages/domain/src/supervisor/`: world shape, `observe`, `candidates`, tier policy, prompt build/parse, `summarise`); control (`packages/control/src/supervisor.ts`: record, apply, approve, reject, expire, list, report, settings + a small `failTask` verb); orchestrator (`apps/orchestrator/src/supervisor.ts`: `supervise()` after `runMergePass` in `tick()`, `loadSupervisorWorld`, the M31a `ModelDecider` seam); CLI, web routes + panel, gate. `decide()` is untouched (ADR 0004).

**Tech Stack:** TypeScript monorepo, Prisma 7 + Postgres (:5433, shared test DB), zod, vitest, Next.js app router, fake provider `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-09-m38-supervisor-design.md` — the plan argues from it; conflicts resolve against the spec. Erratum E1 (this plan): `Task` has no `statusChangedAt`; staleness is derived from the latest `task.*` event for the task (`statusSince`).

## Global Constraints
- **A decision is not work.** The Supervisor never spawns, never edits a repo, never composes a slave prompt; its effects go only through control verbs (`unblockTask`, `setRuntimeRoles`, `failTask`) invoked with `origin: 'system'` so the event envelope says `actor: 'system'`.
- **Model output never writes.** The model returns `{ candidateIndex, rationale }`; anything unparseable or out of range → `chooseByRules`. The candidate list is rule-built; the model cannot add an action.
- **Pure domain, reactive application** (ADR 0004): `packages/domain/src/supervisor/*` has no I/O; `decide()` unchanged; every event via `appendEvent` (ADR 0003); `apps/web` mutates only through control verbs.
- **Tiers fixed in code.** Routine: `unblock_task` (attempt < maxAttempts), `nudge_answer`, `no_action`, `escalate_to_human`. Risky: `raise_max_attempts`, `set_runtime_roles`, `mark_task_failed`, and ANY action while the workspace is halted. `supervisorEnabled=false` → report only, `recordDecision` refuses `supervisor_disabled`.
- **Constants** (`packages/domain/src/supervisor/constants.ts`): `WAITING_STALE_MS = 30 * 60_000`, `INTEGRATED_STALE_MS = 6 * 3_600_000`, `COOLDOWN_MS = 15 * 60_000`, `PENDING_TTL_MS = 24 * 3_600_000`, `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK = 3`, `SUPERVISOR_PER_CALL_CAP_USD = 1`.
- **Cost is workspace cost.** `SupervisorDecision.modelCostUsd` (null = unmeasured, charged at `SUPERVISOR_PER_CALL_CAP_USD`) is summed into `WorkspaceStats.spentUsd` in `loadWorld`. No model call when `budgetExhausted`, when halted, or when no decider is wired.
- **Never a real model call.** Tests pass a fake `ModelDecider`; the gate's daemon uses the fake CLI, which gains a prompt-keyed arm on the literal `"candidateIndex"` replaying a new static fixture `supervisor-decision.ndjson`.
- **Idempotent and quiet.** One open (`pending`) decision per situation key `(workspaceId, situationKind, subjectId)`; `COOLDOWN_MS` after a resolved one; at most 3 model decisions per tick.
- Refusals inside a Prisma `$transaction` throw; verbs return `ok()/err()`; `refusalText` covers every new kind; `apps/web/test/refusal-status.test.ts` `ALL_KINDS` extended (typecheck enforces it).
- Exhaustive web maps (`ACTIVITY_CARDS`, `TYPES_BY_KIND`, test `PAYLOAD_BY_TYPE`) must gain every new event type or `apps/web` typecheck fails.
- One vitest at a time; iterate on single files; `npm run --silent typecheck`; `npm run --silent gate:m26-vocabulary` (the word is `slave`); `npm run web:build` last and only when `ps -eo args | grep -v grep | grep -c "next dev"` is 0. Migrations: real directories, newest naming as precedent (`20260909100000_m38_supervisor`), `npm run db:migrate` and `npm run db:migrate:test`, `npx prisma migrate diff` empty. Known flake: cli.test.ts llm-decision row count — re-run the file alone.
- Commit trailers:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```

---
## File structure
```
packages/db/prisma/schema.prisma + migrations/20260909100000_m38_supervisor   (SupervisorDecision, 4 enums, Workspace.supervisorEnabled/supervisorProfile, 5 EventTypes)
packages/db/src/enums.ts                                   (EVENT_TYPE_BY_DOMAIN_TYPE +5)
packages/domain/src/events/schema.ts                       (+5 supervisor.* arms)
packages/domain/src/supervisor/{constants,world,situations,actions,observe,candidates,policy,prompt,report,index}.ts
packages/domain/src/index.ts                               (export * from './supervisor/index.js')
packages/control/src/supervisor.ts                         (recordDecision, applyDecision, approveDecision, rejectDecision, expirePendingDecisions, listDecisions, supervisorReport, setSupervisorSettings)
packages/control/src/task.ts (new)                         (failTask)
packages/control/src/unblock.ts, profile.ts                (+ origin)
packages/control/src/refusal.ts, index.ts
apps/orchestrator/src/supervisor.ts                        (supervise, loadSupervisorWorld)
apps/orchestrator/src/tick.ts, world.ts, daemon.ts, cli.ts (wiring; spentUsd; CLI verbs)
packages/providers/test/fake-claude.mjs + fixtures/supervisor-decision.ndjson
apps/web/src/server/{supervisorControlRoute,supervisor}.ts, app/api/w/[workspaceId]/supervisor/**, components/SupervisorPanel.tsx, components/activity/cards.tsx, lib/activityFilters.ts
scripts/gate-m38-supervisor.mjs, package.json, .github/workflows/ci.yml, README.md
```

---
### Task 1: Data model and the pure domain

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (spec §2 verbatim: `model SupervisorDecision`, enums `SupervisorSituationKind`, `SupervisorTier`, `SupervisorDecisionStatus`, `SupervisorDecider`; `Workspace.supervisorEnabled Boolean @default(true)`, `Workspace.supervisorProfile String?`, relation `supervisorDecisions SupervisorDecision[]`; `EventType` + `supervisor_decided @map("supervisor.decided")`, `supervisor_applied`, `supervisor_proposed`, `supervisor_resolved`, `supervisor_failed`)
- Create: `packages/db/prisma/migrations/20260909100000_m38_supervisor/migration.sql` (enum types, table with the two indexes and the FK `ON DELETE CASCADE`, two workspace columns, five `ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS`)
- Modify: `packages/db/src/enums.ts` (+5), `packages/domain/src/events/schema.ts` (+5 arms, envelope spread + `z.literal`): `supervisor.decided { decisionId, situationKind, subjectId, tier, decidedBy, action: { kind } }`, `supervisor.proposed { decisionId, situationKind, subjectId, action: { kind }, expiresAt }`, `supervisor.applied { decisionId, action: { kind } }`, `supervisor.resolved { decisionId, outcome: 'approved'|'rejected'|'expired', reason: string | null }`, `supervisor.failed { decisionId, action: { kind }, reason }` — `decisionId: z.string().min(1)`, kinds as `z.enum` of the domain unions
- Create: `packages/domain/src/supervisor/constants.ts`, `world.ts`, `situations.ts`, `actions.ts`, `observe.ts`, `candidates.ts`, `policy.ts`, `prompt.ts`, `report.ts`, `index.ts`; Modify: `packages/domain/src/index.ts`
- Tests: `packages/domain/test/supervisor/{observe,candidates,policy,prompt,report}.test.ts`, `packages/domain/test/events/schema.test.ts` (+5 round-trips), `packages/db` migration applied to dev + test DB, `npx prisma migrate diff` empty

**Interfaces (produces):**
```ts
// world.ts
export interface SupervisorWorld {
  readonly workspaceId: string; readonly now: number /* epoch ms */
  readonly goal: string | null
  readonly halted: { readonly reason: string } | null
  readonly budgetExhausted: boolean
  readonly tasks: readonly { id: string; title: string; status: TaskStatusName; attempt: number; maxAttempts: number; requiredRole: string; integratedAt: number | null; statusSince: number /* latest task.* event ts, else createdAt */; dependents: number; dependenciesDone: boolean; latestGuardrail: string | null }[]
  readonly slaves: readonly { id: string; name: string; role: string; runtimeRoles: readonly string[]; busy: boolean }[]
  readonly questions: readonly { messageId: string; askerSlaveId: string; recipientRole: string | null; recipientSlaveId: string | null; createdAt: number }[]   // pending questions only (control's stillPendingQuestion semantics)
  readonly decisions: readonly { situationKind: SituationKind; subjectId: string; status: DecisionStatus; createdAt: number; resolvedAt: number | null }[]  // recent, for filterFresh
}
export type TaskStatusName = 'backlog'|'ready'|'blocked'|'assigned'|'running'|'verifying'|'reviewing'|'merging'|'rework'|'done'|'failed'|'cancelled'|'waiting'
// situations.ts
export const SITUATION_KINDS = ['no_reviewer','no_planner','review_cap_blocked','task_failed','task_blocked_human','waiting_stale','unanswerable_question','ready_unstaffed','done_not_integrated_stale','workspace_halted'] as const
export type SituationKind = typeof SITUATION_KINDS[number]
export interface Situation { readonly kind: SituationKind; readonly subjectId: string; readonly summary: string; readonly facts: Readonly<Record<string, string | number | boolean | null>> }
export const situationSchema: z.ZodType<Situation>
// actions.ts
export type Action = { kind: 'unblock_task'; taskId: string } | { kind: 'raise_max_attempts'; taskId: string } | { kind: 'set_runtime_roles'; slaveId: string; roles: readonly string[] } | { kind: 'nudge_answer'; messageId: string } | { kind: 'mark_task_failed'; taskId: string; reason: string } | { kind: 'escalate_to_human'; summary: string } | { kind: 'no_action' }
export const ACTION_KINDS = [...] as const; export const actionSchema: z.ZodType<Action>
export type Tier = 'applied' | 'proposed' | 'escalated' | 'noop'
export interface Candidate { readonly action: Action; readonly tier: Tier; readonly why: string }
export const candidateSchema: z.ZodType<Candidate>
export type DecisionStatus = 'applied'|'pending'|'approved'|'rejected'|'expired'|'failed'
// observe.ts
export function observe(world: SupervisorWorld): readonly Situation[]           // spec §3 predicates, deterministic order: by kind order then subjectId
export function filterFresh(situations: readonly Situation[], world: SupervisorWorld): readonly Situation[]  // drops keys with a pending decision, or a resolved one within COOLDOWN_MS of world.now
// candidates.ts
export function candidates(situation: Situation, world: SupervisorWorld): readonly Candidate[]  // never empty; always ends with escalate_to_human then no_action
// policy.ts
export function tierOf(action: Action, world: SupervisorWorld): Tier   // escalate_to_human → 'escalated'; no_action → 'noop'; halted → 'proposed' for everything else; else routine → 'applied', risky → 'proposed'
export function chooseByRules(cands: readonly Candidate[]): number       // index: the single 'applied'-tier candidate whose action is not no_action/escalate if exactly one; else the escalate_to_human index
// prompt.ts
export function buildDecisionPrompt(input: { situation: Situation; candidates: readonly Candidate[]; profile: string | null; world: SupervisorWorld }): string   // contains the literal "candidateIndex"; profile through neutraliseMarkers
export function parseDecisionAnswer(text: string, candidateCount: number): { candidateIndex: number; rationale: string } | null  // first {...} JSON object in text; zod; null on any failure
// report.ts
export interface SupervisorReport { done: { integrated: number; awaitingIntegration: number }; stuck: readonly Situation[]; next: { ready: number; running: number; waiting: number; blocked: number }; supervisor: { applied: number; pending: number; escalated: number; failed: number; lastDecisionAt: number | null } }
export function summarise(world: SupervisorWorld): SupervisorReport
```
Predicates (`observe`): `no_reviewer` — some task `reviewing` and no slave holds `reviewer` (subjectId `'reviewer'`); `no_planner` — `goal !== null`, `tasks.length === 0`, no slave holds `manager` (subjectId `'manager'`); `review_cap_blocked` — task `blocked` with `latestGuardrail === 'review_retry_cap_exhausted'`; `task_blocked_human` — task `blocked` otherwise; `task_failed` — task `failed` and `dependents > 0`; `waiting_stale` — question with `now - createdAt > WAITING_STALE_MS` and its role/slave has a holder; `unanswerable_question` — question whose `recipientRole` no slave holds (or `recipientSlaveId` not in slaves); `ready_unstaffed` — task `ready` with `dependenciesDone` and no slave holding `requiredRole` (subjectId = the role); `done_not_integrated_stale` — `done`, `integratedAt === null`, `dependents > 0`, `now - statusSince > INTEGRATED_STALE_MS`; `workspace_halted` — `halted !== null` (subjectId = workspaceId). Candidates per kind: `review_cap_blocked`/`task_blocked_human` → `unblock_task` if `attempt < maxAttempts` else `raise_max_attempts`, plus `mark_task_failed`; `task_failed` → `escalate_to_human` only (no verb re-opens a `failed` task; the human decides); `no_reviewer`/`no_planner`/`ready_unstaffed` → `set_runtime_roles` for up to 3 non-busy slaves ordered by `role.toLowerCase().includes(roleName)`; `waiting_stale`/`unanswerable_question` → `nudge_answer`; `done_not_integrated_stale` → escalate; `workspace_halted` → escalate.

- [ ] Tests first (each a discriminating fixture): every `observe` predicate positive + negative; `filterFresh` pending + cooldown edge (exactly `COOLDOWN_MS` is still cooling); every `candidates` kind incl. the ≤3 slaves ordering; `tierOf` table incl. halted → proposed; `chooseByRules` single-routine / two-routine / none; prompt contains `"candidateIndex"` and the neutralised profile; `parseDecisionAnswer` valid / out of range / garbage / JSON embedded in prose; `summarise` counts.
- [ ] Migration applied to dev + test DB; `migrate diff` empty; typecheck; vocabulary.
- [ ] Commit `feat(db,domain): m38 t1 — SupervisorDecision, supervisor events, and the pure observe/candidates/policy/prompt/report`.

---
### Task 2: Control — record, apply, approve, reject, expire, settings, failTask

**Files:**
- Create: `packages/control/src/supervisor.ts`, `packages/control/src/task.ts` (`failTask`)
- Modify: `packages/control/src/unblock.ts` (`UnblockTaskInput` + `origin?: 'human' | 'system'` → envelope `actor`), `packages/control/src/profile.ts` (`setRuntimeRoles(slaveId, roles, actor, origin: 'human' | 'system' = 'human')`), `packages/control/src/refusal.ts` (+ `decision_not_found { decisionId }`, `decision_not_pending { decisionId; status }`, `supervisor_cooldown { situationKind; subjectId; untilTs }`, `supervisor_disabled { workspaceId }`, `task_not_failable { taskId; status }` + `refusalText` arms), `packages/control/src/index.ts`, `apps/web/test/refusal-status.test.ts` (`ALL_KINDS` +5)
- Tests: `packages/control/test/integration/supervisor.test.ts`, `task.test.ts` (failTask), `unblock.test.ts` (+origin), `profile.test.ts` (+origin)

**Interfaces (produces):**
```ts
export interface RecordDecisionInput { workspaceId: string; situation: Situation; candidates: readonly Candidate[]; chosenIndex: number; rationale: string; decidedBy: 'model' | 'rules'; modelCostUsd: number | null; now?: Date }
export async function recordDecision(input: RecordDecisionInput): Promise<Result<{ id: string; tier: Tier; status: DecisionStatus }, ControlRefusal>>
  // $transaction: workspace.supervisorEnabled else err supervisor_disabled (throw inside tx → rollback, return err outside); an existing pending row for the key, or a resolved row with resolvedAt/createdAt within COOLDOWN_MS → supervisor_cooldown; insert; status from tier (applied→applied, proposed/escalated→pending + expiresAt = now+PENDING_TTL_MS, noop→applied); appendEvent supervisor.decided (+ supervisor.proposed when pending), actor 'system'
export async function applyDecision(decisionId: string, origin: 'human' | 'system', principal?: Principal): Promise<Result<void, ControlRefusal>>
  // maps action → unblockTask(taskId, { origin }) | unblockTask(taskId, { allowAnotherAttempt: true, origin }) | setRuntimeRoles(slaveId, roles, 'supervisor', origin) | failTask(taskId, reason, origin) | nudge_answer → event only | escalate/no_action → nothing; ok → supervisor.applied; a verb err → row status 'failed' + failureReason = refusalText + supervisor.failed, then RETURN that err (the row and the event are written either way, so a caller sees the refusal and the record stays truthful)
export async function approveDecision(decisionId: string, principal: Principal): Promise<Result<void, ControlRefusal>>   // decision_not_found | decision_not_pending; applyDecision(id,'human',principal); on ok: status approved, resolvedAt, resolvedByUserId, supervisor.resolved{approved}; on verb err: status failed (already), still resolvedAt/resolvedByUserId, return err
export async function rejectDecision(decisionId: string, principal: Principal, reason?: string): Promise<Result<void, ControlRefusal>>  // pending only → rejected + supervisor.resolved{rejected, reason}
export async function expirePendingDecisions(workspaceId: string, now: Date): Promise<number>   // pending with expiresAt <= now → expired + supervisor.resolved{expired}
export interface DecisionView { id; workspaceId; situationKind; subjectId; situation: Situation; candidates: Candidate[]; chosenIndex; action: Action; rationale; tier; status; decidedBy; modelCostUsd; failureReason; createdAt: string; expiresAt: string|null; resolvedAt: string|null }
export async function listDecisions(workspaceId: string, opts?: { pending?: boolean; limit?: number }): Promise<readonly DecisionView[]>
export async function setSupervisorSettings(workspaceId: string, patch: { enabled?: boolean; profile?: string | null }, principal?: Principal): Promise<Result<void, ControlRefusal>>
  // workspace_not_found; profile trimmed, '' → null, > PROFILE_MAX_CHARS → profile_too_long; one workspace.settings_changed per changed field: { field: 'supervisorEnabled', from, to } / { field: 'supervisorProfile', from: sha256|null, to: sha256|null }
// task.ts
export async function failTask(taskId: string, reason: string, origin: 'human' | 'system' = 'human', principal?: Principal): Promise<Result<void, ControlRefusal>>
  // task_not_found; activeRunId → task_run_active; status ∉ {rework, blocked} → task_not_failable; lock (lockTask idiom if one exists, else SELECT … FOR UPDATE), set failed + lastRejectionReason, appendEvent task.failed { reason }
```
`supervisorReport(workspaceId)` is NOT in control (it needs the orchestrator's world loader) — Task 3 exports it from the orchestrator and Task 5's web reads the world through a control-level loader: to keep `apps/web` off the orchestrator, Task 3 puts `loadSupervisorWorld(prisma, workspaceId, now)` in `packages/control/src/supervisorWorld.ts` (control may read Prisma) and the orchestrator imports it.

- [ ] Tests first: recordDecision statuses per tier, cooldown (pending key; resolved within/over cooldown), disabled → refusal with no row; applyDecision per action incl. a verb refusal → failed row + supervisor.failed event + returned err; approve/reject/expire transitions and `decision_not_pending`; settings incl. `profile_too_long` and the two payload shapes; failTask refusals and event; origin='system' produces `actor: 'system'` envelopes on unblock/roles events.
- [ ] Commit `feat(control): m38 t2 — the Supervisor's decision record, tiered application, approvals, settings, and failTask`.

---
### Task 3: Orchestrator — loadSupervisorWorld, supervise() in the tick, model seam, spentUsd, fake CLI arm

**Files:**
- Create: `packages/control/src/supervisorWorld.ts` (`loadSupervisorWorld`), `apps/orchestrator/src/supervisor.ts` (`supervise`)
- Modify: `apps/orchestrator/src/tick.ts` (`TickDeps` + `supervisorDecider?: ModelDecider`, `supervisorModel?: string`, `now?: () => Date`; call `supervise` after `runMergePass` at ~L287; `TickReport.supervisor`), `apps/orchestrator/src/daemon.ts` (pass `modelDecider` through as `supervisorDecider`), `apps/orchestrator/src/cli.ts` (`supervisorModel: process.env['SLAVEOFAI_SUPERVISOR_MODEL'] ?? SUPERVISOR_DEFAULT_MODEL`, where `SUPERVISOR_DEFAULT_MODEL = 'claude-sonnet-5'` is added to `packages/domain/src/supervisor/constants.ts` — M31a takes its model from the simulation intent, so there is no shared default to reuse), `apps/orchestrator/src/world.ts` (`loadRunStats`: `spentUsd` += Σ `supervisorDecision.modelCostUsd` + unmeasured × `SUPERVISOR_PER_CALL_CAP_USD`; expose `supervisorSpend: { measuredUsd, unmeasuredCalls }` for the overview), `packages/providers/test/fake-claude.mjs` (in the flow modes `m8-flow`/`m8a-flow`/`m36-flow` and the plain modes: `if (prompt.includes('"candidateIndex"')) { await replayFixture('supervisor-decision'); return }` BEFORE the `"verdict"`/`"task graph"` checks), `packages/providers/test/fixtures/supervisor-decision.ndjson` (mirror `decision.ndjson`: assistant text `{"candidateIndex":0,"rationale":"the first candidate is the routine fix"}`, `result` line with `total_cost_usd: 0.01`, Stop hook line)
- Tests: `apps/orchestrator/test/integration/supervisor.test.ts` (tick-level), `world.test.ts` (+spentUsd), `packages/control/test/integration/supervisorWorld.test.ts`, `packages/providers/test/fake-claude*.test.*` if a fixture-listing test exists

**Interfaces:**
```ts
// packages/control/src/supervisorWorld.ts
export async function loadSupervisorWorld(workspaceId: string, now: Date): Promise<SupervisorWorld>
  // tasks with dependents count, dependenciesDone (integratedAt-gated like world.ts), statusSince = latest ExecutionEvent with taskId and type LIKE 'task.%' (seq desc) ts else createdAt, latestGuardrail = latest guardrail.tripped payload.guardrail for the task; slaves busy = has a non-terminal run; questions via stillPendingQuestion semantics (reuse messaging.ts helpers; export them if private); decisions = last 24h rows; budgetExhausted = budgetUsd !== null && spentUsd >= budgetUsd (spentUsd incl. supervisor spend, same formula as world.ts — put the formula in ONE exported helper in control, `workspaceSpend(workspaceId)`, and make world.ts use it)
// apps/orchestrator/src/supervisor.ts
export interface SuperviseDeps { workspaceId: string; decider?: ModelDecider; model?: string; now?: () => Date }
export interface SuperviseReport { situations: number; decided: number; applied: number; proposed: number; skippedCooldown: number; modelCalls: number; rulesOnly: boolean }
export async function supervise(deps: SuperviseDeps): Promise<SuperviseReport>
  // expirePendingDecisions → loadSupervisorWorld → if !supervisorEnabled: return zeros (report-only) → observe → filterFresh → for each: candidates; useModel = decider && model && !budgetExhausted && !halted && modelCalls < 3; if useModel: outcome = decider({ model, prompt: buildDecisionPrompt(...), maxBudgetUsd: SUPERVISOR_PER_CALL_CAP_USD }); answer kind → parseDecisionAnswer; costUsd from outcome (null stays null); failed/isolation_breach/null → chooseByRules with decidedBy 'rules' (cost still recorded on the row if the call happened: record with decidedBy 'rules' and modelCostUsd); recordDecision; if tier applied → applyDecision(id, 'system'); refusal supervisor_cooldown counts as skippedCooldown, never throws
```
- [ ] Tests first: fake decider chosen (row `decidedBy: model`, cost recorded, action applied, `task.unblocked` envelope actor `system`); no decider → rules; budget exhausted → decider NOT called (spy count 0) and rules used; halted → single escalate proposal, no model; invalid model answer → rules fallback with cost recorded; 4 situations → 3 model calls + 1 rules; second tick within cooldown → 0 new rows; `supervisorEnabled=false` → no rows; `world.test.ts`: spentUsd includes a decision row's cost and an unmeasured one at the cap; fake CLI arm replays the fixture when the prompt carries `"candidateIndex"` (one subprocess test in providers).
- [ ] Commit `feat(orchestrator,control,providers): m38 t3 — supervise() at the end of the tick; the model picks from the catalogue or the rules do; supervisor spend is workspace spend`.

---
### Task 4: CLI verbs

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (USAGE + cases `supervise`, `supervisor-decisions`, `approve-decision`, `reject-decision`, `set-supervisor`), `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
```
supervise --workspace <id> [--dry-run]          one pass of supervise(); --dry-run: loadSupervisorWorld + observe + filterFresh + candidates + chooseByRules, prints JSON [{ situation, candidates, ruleChoice }] and writes NOTHING (no rows, no events)
supervisor-decisions --workspace <id> [--pending] [--limit <n>]     prints listDecisions JSON
approve-decision --id <id> [--by <name>]        approveDecision with a CLI principal (mirror how other CLI verbs build a Principal, e.g. unblock-task); prints the verb result or the refusal
reject-decision --id <id> [--reason <text>] [--by <name>]
set-supervisor --workspace <id> (--enable | --disable) [--profile-file <path> | --clear-profile]
```
The daemon's `supervise` uses `buildModelDecider()`; the one-shot `supervise` CLI case uses it too unless `--dry-run`.
- [ ] Tests first (real subprocess, `runCli`): dry-run prints situations and leaves `supervisorDecision` count 0; `supervise` on a review-cap-blocked task applies `unblock_task` (row applied, task `rework`); a pending proposal seeded via `recordDecision` is approved → verb effect visible; reject → status rejected; `set-supervisor --disable` then `supervise` → no rows; `--profile-file` writes the profile.
- [ ] Commit `feat(cli): m38 t4 — supervise, supervisor-decisions, approve/reject-decision, set-supervisor`.

---
### Task 5: Web — routes, panel, timeline cards

**Files:**
- Create: `apps/web/src/server/supervisorControlRoute.ts` (`decisionControlResponse(workspaceId, decisionId, operate)` — 404 unless the decision's `workspaceId` matches; then `refusalText`/`refusalStatus`), `apps/web/src/server/supervisor.ts` (`buildSupervisorView(workspaceId)` → `{ report: SupervisorReport, pending: DecisionView[], recent: DecisionView[] (last 20), settings: { enabled, profile } }` using `loadSupervisorWorld` + `summarise` + `listDecisions`), `app/api/w/[workspaceId]/supervisor/route.ts` (GET), `.../supervisor/decisions/[decisionId]/approve/route.ts` (POST), `.../reject/route.ts` (POST `{ reason?: string }`), `.../supervisor/settings/route.ts` (PATCH `{ enabled?: boolean; profile?: string | null }`), `apps/web/src/components/SupervisorPanel.tsx`
- Modify: `apps/web/src/components/OverviewClient.tsx` (render `<SupervisorPanel workspaceId=… />` right after the `HaltBanner` line ~218; it fetches `/supervisor` on mount and after each action, and re-fetches on the overview's poll tick), `apps/web/src/components/activity/cards.tsx` (5 cards), `apps/web/src/lib/activityFilters.ts` (`TYPES_BY_KIND.workspace` +5), `apps/web/test/activity-cards.test.tsx` (`PAYLOAD_BY_TYPE` +5), `apps/web/src/server/overview.ts` (`supervisorSpend` on the workspace aggregates so the budget line says how much is the Supervisor's)
- Tests: `apps/web/test/integration/control-routes.test.ts` (+ `describe('supervisor')`: GET shape, approve happy/cross-workspace 404/not-pending 409, reject, settings 400/409 profile_too_long), `apps/web/test/supervisor-panel.test.tsx` (renders Done/Stuck/Next, pending list with Approve/Reject posting the exact URLs, rationale visible, disabled toggle PATCH), `apps/web/test/integration/overview.test.ts` (supervisorSpend), `activity-cards.test.tsx`
- [ ] Tests first → implement → `npx vitest run apps/web` → typecheck → vocabulary → `web:build` (check `next dev` first).
- [ ] Commit `feat(web): m38 t5 — the Supervisor panel: done / stuck / next, proposals to approve or reject, decisions with their reasons`.

---
### Task 6: Gate, CI, README, full verification

**Files:** `scripts/gate-m38-supervisor.mjs`, `package.json` (`"gate:m38-supervisor": "tsc --build && node --env-file=.env scripts/gate-m38-supervisor.mjs"`), `.github/workflows/ci.yml` (after `gate:m37-run-context`), `README.md` (new `## The Supervisor` section after "What a slave is told": what it observes, tiers, the panel, the five CLI verbs, cost rule; "Tests and CI" roster +1 in order)

Gate (borrow `gate-m37-run-context.mjs`'s helpers: `loopbackChildEnv`, `findRealDaemonPids`, `waitUntil`, `fail`, `spawnDaemon`; fake CLI `--fixture m8a-flow` so worker runs conclude and the `"candidateIndex"` arm answers the Supervisor): temp repo + workspace; slaves `Dev` (`runtimeRoles: ['backend']`) only — no reviewer; one `backend` task.
- Stage 1: drive the task through implementation to `reviewing` (as gate-m35 does) → next tick: `no_reviewer` situation → decision row `tier: proposed, status: pending, action.kind: set_runtime_roles, decidedBy: model` (fixture picks index 0 = grant to `Dev`); the slave's `runtimeRoles` UNCHANGED; `supervisor.proposed` event exists. Then `approve-decision --id` via CLI subprocess → `runtimeRoles` now includes `reviewer` → next tick dispatches a review run staffed on `Dev`.
- Stage 2: park a task `blocked` with a `review_retry_cap_exhausted` guardrail event and `attempt < maxAttempts` (seed the rows the way review.ts writes them) → tick → row `tier: applied, status: applied, action.kind: unblock_task` → task `rework`; `task.unblocked` event envelope `actor: system`.
- Stage 3: set `budgetUsd` to 0.01 with a run whose `costUsd` exceeds it → workspace halts (`budget_exhausted`) → tick → exactly one pending decision `workspace_halted` / `escalate_to_human`, `decidedBy: rules`, `modelCostUsd: null`, and the fake CLI log shows no supervisor call (count fixture replays by a marker file or the fake CLI's own log if it has one; else assert `modelCostUsd` null + `decidedBy rules` on every row of this stage).
- Stage 4: `supervise --workspace --dry-run` prints the situations and the decision count is unchanged.
- Stage 5: a second tick inside the cooldown for Stage 2's task (re-park it) creates no new row.
- Teardown in FK order; preflight cleanup by workspace name.
- [ ] Full verification in order, one at a time: `npm run --silent typecheck`; `npm run gate:m26-vocabulary`; `npx vitest run` (no daemon running; cli.test.ts flake → re-run alone); `npm run web:build` (no `next dev`); gates m38, m37, m36, m35, m33, m11.
- [ ] Commit `test(gates),docs: m38 t6 — gate:m38-supervisor; README`.
