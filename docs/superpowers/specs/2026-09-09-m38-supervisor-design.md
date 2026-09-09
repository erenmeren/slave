# M38 — Supervisor core: observe, adjudicate, apply with tiers

Fourth milestone of the Supervisor sequence (M35 pipeline honesty, M36 messaging and waiting, M37 run context). Design approved in chat 2026-09-09; the user waived the spec and plan review gates and asked for subagent-driven execution. This file is the record. "Slave" is this project's word for an AI worker.

**Goal.** A workspace gets a Supervisor: a control-layer service — not a `Slave` row — that on every tick observes the workspace for stuck situations, chooses an action for each from a fixed catalogue, applies routine actions itself through the existing control verbs, records risky actions as proposals for a human, and can always say what is done, what is stuck and what comes next. Every decision is a row with its rationale and an event.

**Why now.** The pipeline tells the truth (M35), slaves can wait on each other (M36), and every run's inputs are recorded (M37). What remains is that every escalation still ends in a `guardrail.tripped` that a human must notice: a reviewer-less workspace, a task parked at the review cap, a question nobody can answer, a done task nobody integrates. The Supervisor turns those dead ends into decisions.

**Scope split (user's ruling).** The user asked for report + adjudication + question routing, "done well", and allowed two milestones. M38 is the core: situations, candidates, tiered application, the decision record, web/CLI, gate. Question handling in M38 is detection and escalation only (`waiting_stale`, `unanswerable_question`). **M39 (Supervisor mailbox)** reads pending questions, answers routine ones itself, routes to the right slave, escalates critical ones — on M38's decision record and approval flow.

## 1. Rules that bind every part
- **A decision is not work.** The Supervisor never spawns a run, never edits a repository, never writes a prompt for a slave. Its output is a `SupervisorDecision` row; its only effects on the world go through existing control verbs (`unblockTask`, `setRuntimeRoles`, …) called with `actor: 'supervisor'`.
- **Model output never writes.** The model picks a candidate index and writes a rationale; the catalogue of candidate actions is produced by pure rules. An answer outside the catalogue, or unparseable, falls back to `chooseByRules`. (Same rule as M37 §1 for profiles/roles/skills.)
- **Pure observation, reactive application** (ADR 0004). `observe`, `candidates`, `tierOf`, `chooseByRules`, `buildDecisionPrompt`, `parseDecisionAnswer`, `summarise` live in `packages/domain/src/supervisor/` with no I/O. `packages/control/src/supervisor.ts` records and applies; `apps/orchestrator/src/supervisor.ts` runs the loop at the end of the tick. `decide()` is untouched.
- **Single write gate** (ADR 0003): every event goes through `appendEvent`; `apps/web` mutates only through control verbs.
- **Tiers are fixed in code, not chosen by the model.** Routine actions apply immediately; risky ones become `pending` proposals. A workspace can only narrow the Supervisor (`supervisorEnabled=false` → report only), never widen it.
- **Cost is workspace cost.** A Supervisor model call uses M31a's isolation (`--restricted --strict-mcp-config --tools ""`, no session persistence, scrubbed env), a per-call cap `SUPERVISOR_PER_CALL_CAP_USD = 1`, and an unmeasured cost is charged at the cap. `SupervisorDecision.modelCostUsd` sums into `WorkspaceStats.spentUsd`, so the budget guardrail sees it. When the budget guardrail halts scheduling, or no decider is wired, the Supervisor makes rule-only decisions and never calls a model.
- **Never a real model call in tests or gates**: `packages/providers/test/fake-claude.mjs` gains a supervisor arm keyed on the literal `"candidateIndex"` in the prompt.
- **Idempotent and quiet.** One open decision per situation key at a time; a cooldown after each resolved decision; at most `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK = 3` model calls per tick; the rest wait for the next tick.
- Refusals: control verbs return `ok()/err()` with `ControlRefusal` kinds; a refusal inside a Prisma transaction throws; `refusalText` covers every new kind; `apps/web/test/refusal-status.test.ts` completeness list extended.
- Migrations are real directories; `prisma migrate diff` empty. Vocabulary: `slave`. One vitest at a time; `npm run --silent typecheck`; `web:build` last and only when no `next dev`.

## 2. Data model
```prisma
model SupervisorDecision {
  id               String   @id @default(uuid())
  workspaceId      String
  situationKind    SupervisorSituationKind
  subjectId        String            // taskId | slaveMessageId | workspaceId | role name — what the situation is about
  situation        Json              // the Situation snapshot the decision was made on
  candidates       Json              // Candidate[] the rules offered
  chosenIndex      Int
  action           Json              // the chosen Action (kind + params)
  rationale        String
  tier             SupervisorTier    // applied | proposed | escalated | noop
  status           SupervisorDecisionStatus // applied | pending | approved | rejected | expired | failed
  decidedBy        SupervisorDecider // model | rules
  modelCostUsd     Float?            // null = unmeasured (charged at the cap in spentUsd)
  failureReason    String?           // refusalText when applying failed
  createdAt        DateTime @default(now())
  expiresAt        DateTime?         // pending only: createdAt + 24h
  resolvedAt       DateTime?
  resolvedByUserId String?
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, createdAt])
  @@index([workspaceId, situationKind, subjectId, createdAt])
}
enum SupervisorSituationKind { no_reviewer no_planner review_cap_blocked task_failed task_blocked_human waiting_stale unanswerable_question ready_unstaffed done_not_integrated_stale workspace_halted }
enum SupervisorTier { applied proposed escalated noop }
enum SupervisorDecisionStatus { applied pending approved rejected expired failed }
enum SupervisorDecider { model rules }
```
`Workspace` gains `supervisorEnabled Boolean @default(true)` and `supervisorProfile String?` (persona/rules text for the decision prompt; `PROFILE_MAX_CHARS` and `neutraliseMarkers` from M37 apply). `EventType` gains `supervisor.decided`, `supervisor.applied`, `supervisor.proposed`, `supervisor.resolved`, `supervisor.failed`. Thresholds are domain constants in M38 (`WAITING_STALE_MS = 30 min`, `INTEGRATED_STALE_MS = 6 h`, `COOLDOWN_MS = 15 min`, `PENDING_TTL_MS = 24 h`), not settings.

**Situation key** = `(workspaceId, situationKind, subjectId)`. `subjectId` is the task id for task situations, the message id for question situations, the role name for `no_reviewer`/`no_planner`/`ready_unstaffed`, and the workspace id for `workspace_halted`.

## 3. Domain (`packages/domain/src/supervisor/`)
- `world.ts` — `SupervisorWorld`: `{ workspaceId, now, halted: { reason } | null, budgetExhausted: boolean, tasks: { id, title, status, attempt, maxAttempts, requiredRole, integratedAt, statusChangedAt, dependents: number }[], slaves: { id, name, role, runtimeRoles, busy }[], questions: { messageId, askerSlaveId, recipientRole, createdAt, answered: boolean }[], recentGuardrails: { guardrail, detail, at, subjectId? }[], openDecisions: { situationKind, subjectId, status, resolvedAt }[] }`. Built by the orchestrator from Prisma; the domain never sees Prisma types.
- `observe.ts` — `observe(world): Situation[]`. One rule per kind, each documented with the exact predicate:
  - `no_reviewer`: a task in `reviewing` and no slave with `'reviewer' ∈ runtimeRoles`.
  - `no_planner`: `goal` set, zero tasks, no slave with `'manager'`.
  - `review_cap_blocked`: task `blocked` whose latest guardrail is `review_retry_cap_exhausted`.
  - `task_failed`: task `failed` with `dependents > 0` (a dead end that blocks other work).
  - `task_blocked_human`: task `blocked` for any other reason (verify misconfig, pause gate).
  - `waiting_stale`: an unanswered question older than `WAITING_STALE_MS` whose recipient role has a holder.
  - `unanswerable_question`: an unanswered question whose recipient role no slave holds.
  - `ready_unstaffed`: a `ready` task whose `requiredRole` no slave holds (and dependencies done).
  - `done_not_integrated_stale`: `done`, `integratedAt` null, older than `INTEGRATED_STALE_MS`, with dependents.
  - `workspace_halted`: `halted` non-null.
  Situations already covered by an open (`pending`) decision or inside cooldown of a resolved one are dropped by `filterFresh(situations, world)`.
- `actions.ts` — `Action` union: `unblock_task { taskId }`, `raise_max_attempts { taskId }` (= `unblockTask` with the allowance), `set_runtime_roles { slaveId, roles }` (the slave's current set plus the missing role; `candidates` offers one such action per non-busy slave, at most three, ordered by whether the slave's title contains the role name), `nudge_answer { messageId }` (records an escalation for the question's holders; M39 answers), `mark_task_failed { taskId }`, `escalate_to_human { summary }`, `no_action`.
- `candidates.ts` — `candidates(situation, world): Candidate[]` where `Candidate = { action, tier, why }`; always ends with `escalate_to_human` and `no_action` so the list is never empty.
- `policy.ts` — `tierOf(action, world)`: routine = `unblock_task` (attempt < maxAttempts), `nudge_answer`, `no_action`, `escalate_to_human`; risky = `raise_max_attempts`, `set_runtime_roles`, `mark_task_failed`, and ANY action while `halted`. `chooseByRules(cands)`: the single routine candidate that is not `no_action`/`escalate_to_human` if exactly one exists, else `escalate_to_human`.
- `prompt.ts` — `buildDecisionPrompt({ situation, candidates, profile, world })` (profile through `neutraliseMarkers`; asks for JSON `{ "candidateIndex": number, "rationale": string }`; contains the literal `"candidateIndex"`), `parseDecisionAnswer(text, candidateCount)` (zod; `null` on anything invalid or out of range).
- `report.ts` — `summarise(world, recent: DecisionSummary[]): SupervisorReport` = `{ done: { integrated, awaitingIntegration }, stuck: Situation[], next: { ready: number, running: number, waiting: number }, supervisor: { applied, pending, escalated, lastDecisionAt } }`.

## 4. Control (`packages/control/src/supervisor.ts`)
- `recordDecision(input): Result<SupervisorDecision, ControlRefusal>` — in one transaction: refuse `supervisor_disabled`; refuse `supervisor_cooldown` when an open decision exists for the key or the last resolved one is within `COOLDOWN_MS`; insert the row with `status` from the tier (`applied`→`applied`, and a later `applyDecision` failure flips it to `failed`; `proposed`→`pending` + `expiresAt`; `escalated`→`pending` + `expiresAt`; `noop`→`applied`); append `supervisor.decided`, plus `supervisor.proposed` when pending.
- `applyDecision(id, actor): Result<void, ControlRefusal>` — maps the action to the verb (`unblockTask`, `unblockTask` with allowance, `setRuntimeRoles`, `failTask` (new, small: `rework|blocked → failed` with a reason; refuses on a live run), `nudge_answer` → append `supervisor.applied` with the message id only). A verb refusal is recorded as `status: failed` + `failureReason` + `supervisor.failed`, never thrown.
- `approveDecision(id, principal)` → `applyDecision` then `status: approved`, `resolvedAt`, `resolvedByUserId`, `supervisor.resolved { outcome: 'approved' }`. `rejectDecision(id, principal, reason?)`. `expirePendingDecisions(workspaceId, now)` (tick). `listDecisions(workspaceId, { pending?: boolean, limit })`. `supervisorReport(workspaceId)` (loads the world, calls `summarise`).
- `setSupervisorSettings(workspaceId, { enabled?, profile? }, principal?)` — `profile_too_long` reuse; emits the existing `workspace.settings_changed`.
- Refusal kinds: `decision_not_found`, `decision_not_pending`, `supervisor_cooldown`, `supervisor_disabled`, `task_not_failable`.

## 5. Orchestrator (`apps/orchestrator/src/supervisor.ts`)
- `supervise({ workspaceId, decider?: ModelDecider, now })` runs after `runMergePass` in `tick()`. Steps: `expirePendingDecisions` → `loadSupervisorWorld` → `observe` → `filterFresh` → for each situation (model calls capped per tick): `candidates` → if `world.budgetExhausted || !decider` then `chooseByRules` (`decidedBy: rules`) else `decider({ model, prompt, maxBudgetUsd: SUPERVISOR_PER_CALL_CAP_USD })` → `parseDecisionAnswer` → fallback to rules on `null`/failure → `recordDecision` → if tier `applied`: `applyDecision`.
- The decider is the same `ModelDecider` seam as M31a (`packages/control/src/simulation/llm.ts`): `cli.ts`'s daemon wires `buildModelDecider` into `TickDeps.supervisorDecider`; tests pass a fake; control never imports `providers`.
- `loadWorld.spentUsd` = Σ `SlaveRun.costUsd` + Σ `SupervisorDecision.modelCostUsd` (unmeasured charged at the cap; count kept for the overview's measured/unmeasured note).
- `TickReport` gains `supervisor: { situations, decided, applied, proposed, skippedCooldown }`.

## 6. Web, CLI, gate
- Routes: `GET /api/w/[workspaceId]/supervisor` → `{ report, pending, recent }`; `POST .../supervisor/decisions/[decisionId]/approve` and `/reject` (`{ reason? }`); `PATCH .../supervisor/settings` (`{ enabled?, profile? }`). All through a `supervisorControlRoute.ts` mirroring `slaveControlRoute.ts` (404 unless the decision's workspace matches). `refusalStatus` unchanged.
- `SupervisorPanel.tsx` on the overview page below the halt banner: three columns Done / Stuck / Next, a pending-proposals list with Approve/Reject, recent decisions with rationale, an enabled toggle and profile editor (reuse the M37 profile block pattern). Timeline cards for the five events.
- CLI (`apps/orchestrator/src/cli.ts`): `supervise --workspace <id> [--dry-run]` (one pass; dry-run prints situations + rule choices and writes nothing), `supervisor-decisions --workspace <id> [--pending]`, `approve-decision --id <id> [--by <name>]`, `reject-decision --id <id> [--reason <text>] [--by <name>]`, `set-supervisor --workspace <id> (--enable|--disable) [--profile-file <path>|--clear-profile]`.
- Gate `scripts/gate-m38-supervisor.mjs` (real daemon, fake CLI): (1) reviewer-less workspace with a task in `reviewing` → `no_reviewer` → `set_runtime_roles` proposal, pending, not applied; approve via CLI → role written → next tick dispatches the review; (2) a task at the review cap (`blocked`, guardrail `review_retry_cap_exhausted`, attempt < maxAttempts) → routine `unblock_task` applied automatically → `rework`; (3) a workspace whose budget is exhausted → no model call, exactly one `escalate_to_human` pending for `workspace_halted`; (4) `supervise --dry-run` writes no rows; (5) the same situation does not produce a second decision inside the cooldown. Wired into `package.json`, `ci.yml` after `gate:m37-run-context`, README section "The Supervisor".

## 7. Testing
Domain: unit tests per rule in `observe`, per kind in `candidates`, the tier table, `chooseByRules`, prompt literal + parser (valid, out-of-range, garbage), `summarise`. Control: `recordDecision` cooldown/pending uniqueness/disabled, `applyDecision` per action incl. a refusal → `failed`, approve/reject/expire, settings. Orchestrator: `supervise` in a tick with a fake decider (model chosen), with no decider (rules), with budget exhausted (no decider call — assert the fake was not invoked), invalid model answer (fallback), per-tick cap, spentUsd includes model cost. Web: routes (happy, cross-workspace 404, malformed 400, refusal 409), panel posts, overview fields. Gate as §6. M35/M36/M37 gates stay green.

## 8. Out of scope (M39+)
Answering or routing questions; thresholds as workspace settings; decision retention; a Supervisor that edits the goal or creates tasks; org-wide (multi-workspace) supervision.

## 9. Errata — where execution corrects this spec
### Plan writing (2026-09-09)
- **E1 — `statusChangedAt` does not exist.** `Task` has no such column and adding one would touch every status write. `SupervisorWorld.tasks[].statusSince` is derived from the latest `task.*` `ExecutionEvent` for the task (else `createdAt`).
- **E2 — where the report lives.** §4 put `supervisorReport` in control; the world loader `loadSupervisorWorld(workspaceId, now)` lives in `packages/control/src/supervisorWorld.ts` (control may read Prisma; `apps/web` must not import the orchestrator), and the report is `summarise(world)` computed by whoever holds the world (the web view builder, the CLI). `workspaceSpend(workspaceId)` is the one exported spend formula both `world.ts` and the loader use.
- **E3 — the Supervisor's model.** `SUPERVISOR_DEFAULT_MODEL = 'claude-sonnet-5'` (domain constant), overridable by `SLAVEOFAI_SUPERVISOR_MODEL`; M31a takes its model from the simulation intent, so there was nothing to reuse.
- **E4 — event actor.** `unblockTask` and `setRuntimeRoles` gain `origin: 'human' | 'system'` so a Supervisor-applied action's event envelope says `actor: 'system'` (the envelope enum has no `supervisor`); the payload `actor` string stays `'supervisor'`.
### Task 3 (2026-09-09)
- **E5 — `task_blocked_human` unblocks are risky.** §3/§4 made `unblock_task` routine whenever `attempt < maxAttempts`. M35 made `blocked` mean "a human must look at this", and two parks are deliberate (`cancel`, the leftover-worktree refusal): a routine unblock undid them one tick later. Corrected: for `task_blocked_human` the `unblock_task` candidate is tier `proposed`; only `review_cap_blocked` keeps the routine unblock (controller ruling).
- **E6 — unmeasured model calls are charged.** A model call whose outcome was unusable (`failed`, `isolation_breach`, unparseable answer) with a null cost was recorded `decidedBy: rules, modelCostUsd: null` and therefore never charged. Corrected: `SupervisorDecision.modelCalled Boolean @default(false)` records whether a call happened; unmeasured = `modelCalled && modelCostUsd === null`, charged at `SUPERVISOR_PER_CALL_CAP_USD` in `workspaceSpend`.
- **§5 clarified — halted workspaces are supervised.** `tick()` returns early on a halt; `supervise` runs on that branch too (rules-only by the model gate), so the `workspace_halted` escalation is actually produced by the daemon and not only by the CLI one-shot.
- **E7 — what "halted" means to the Supervisor.** `tick()` halts on a guardrail breach (`emergency_stop`, `concurrency`, `global_concurrency`, `budget_exhausted`, `circuit_breaker`), but only an emergency stop writes `Workspace.haltedReason`; the loader keyed `halted` on that column alone, so a budget-exhausted workspace looked unhalted to the Supervisor. Corrected: `SupervisorWorld.halted` = `haltedReason` if set, else the first breach of kind `emergency_stop | budget_exhausted | circuit_breaker` from `evaluateGuardrails` over the same limits and stats the scheduler uses (one control helper `workspaceStats(workspaceId)` feeds both `world.ts` and the loader). A concurrency halt is normal operation, not a stuck state: it never sets `halted`, so routine actions still apply and no `workspace_halted` escalation is raised for a merely busy workspace.
- **§5 clarified — expiry and the snapshot.** `expirePendingDecisions` runs on every supervised tick whether or not the Supervisor is enabled (a switched-off workspace must not keep stale proposals approvable forever); the prompt's profile is the one read inside the world's snapshot (`loadSupervisorWorld`'s `settings`), the pre-transaction read decides only whether to load at all.
### Final review (2026-09-09)
- **E8 — situations past the per-tick model cap do not wait.** §1 said "the rest wait for the next tick". The loop decides them by the rules immediately (a row, a cooldown), which the plan's Task 3 test list endorsed ("4 situations → 3 model calls + 1 rules"). Corrected: at most `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK` situations per pass are put to the model; the rest are decided by the rules in the same pass. Because `observe`'s order is deterministic, the same kinds tend to reach the model first — accepted for M38; a rotating cursor is M39 material.
- **§4 clarified — a staffing proposal applies as a union.** `set_runtime_roles` stores the roles computed at decision time; a proposal can wait up to `PENDING_TTL_MS`. Applying it replaces nothing: `applyDecision` re-reads the slave and writes the union of its CURRENT set with the roles the proposal adds (final review, Important 1).
- **§2 clarified — upgrade behaviour.** `supervisorEnabled` defaults to true, so the first daemon start after this migration supervises every existing workspace; for an unbudgeted workspace (`budgetUsd: null`) there is no spend ceiling beyond the per-call cap. The README says so and names `set-supervisor --disable`.
