# M39 Supervisor Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Supervisor answers a slave's pending question itself when the answer is verifiably sourced from recorded context, drafts it for a human when it is not, re-addresses it to a slave who can answer, or escalates it when it is critical — every choice a `SupervisorDecision` through M38's tiers and approval flow — and the four structural items M38 left open are closed.

**Architecture:** Domain gains the mailbox catalogue (`answer_question`, `reassign_question`), the critical lexicon, the answer prompt/parser, source verification and `answerTier`; control gains `reassignQuestion`, `answerQuestion`'s `origin`, drafts on decisions, `pruneDecisions`, the delta-union, a snapshot-reusing loader and `workspaceSpend` for the projects list; the orchestrator's pass makes a second model call for `answer_question` and records the final tier; CLI/web expose editable drafts; a gate proves the five stages against a real daemon with the fake CLI.

**Tech Stack:** TypeScript monorepo, Prisma 7 + Postgres (:5433, shared test DB), zod, vitest, Next.js app router, fake provider `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-09-m39-supervisor-mailbox-design.md` — the plan argues from it; conflicts resolve against the spec. Plan-time errata: **E1** `Source.ref` is required only for `kind: 'message'` (a fixture cannot know a task id); for `task`/`goal`/`run_context` the source is single-valued and `ref` is ignored. **E2** a lexicon match short-circuits: no answer call is made, the decision is `escalated` with `draft: { body: null, sources: [], critical: { lexicon: [...], model: false }, confidence: 'interpretation' }`. **E3** the fake CLI's answer arm keys on the literal `"sources"` and replays the fixture named by env `FAKE_CLAUDE_ANSWER_FIXTURE` (default `supervisor-answer`), so a gate can choose sourced vs unsourced per daemon spawn.

## Global Constraints
- Everything in M38's plan Global Constraints still binds (a decision is not work; pure domain; single write gate; tiers fixed in code; cost is workspace cost; never a real model call; one open decision per key + cooldown; ≤ `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK` model calls per pass — the answer call counts as one).
- **The only model text that reaches the world is an answer body**, through `answerQuestion` after `neutraliseMarkers` and `ANSWER_MAX_CHARS = 4_000`, and only when `answerTier` says `applied` or a human approved the draft.
- **Sourced = verified in code**: every `sources[]` quote is a verbatim substring (whitespace-normalised) of the named source and at least one source exists. Otherwise `interpretation` → `proposed`.
- **Critical never auto-answers**: `criticalMatches(body).length > 0 || model.critical` → `escalated`.
- Constants (`packages/domain/src/supervisor/constants.ts`): `ANSWER_MAX_CHARS = 4_000`, `THREAD_BODY_MAX_CHARS = 2_000`, `RUN_PROMPT_MAX_CHARS = 16_000`, `SOURCE_QUOTE_MAX_CHARS = 300`, `SOURCES_MAX = 8`, `DECISION_RETENTION_MS = 30 * 86_400_000`, `PRUNE_BATCH = 500`.
- `answerQuestion(..., origin)` and `reassignQuestion` are the only writers; envelope actor `system` for the Supervisor, `human` (+ `userId`) when a human approves.
- Refusals in a transaction throw; `refusalText` covers every new kind; `apps/web/test/refusal-status.test.ts` `ALL_KINDS` extended; exhaustive web maps (`ACTIVITY_CARDS`, `TYPES_BY_KIND`, `PAYLOAD_BY_TYPE`) gain `slave.message_reassigned`.
- Migration `20260910100000_m39_mailbox` (`SupervisorDecision.draft JSONB NULL`, `EventType` + `slave.message_reassigned`), `db:migrate` + `db:migrate:test`, `migrate diff` empty. One vitest at a time; `npm run --silent typecheck`; `gate:m26-vocabulary`; `web:build` last with no `next dev`. Known flake: cli.test.ts llm-decision row count.
- Commit trailers:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```

---
## File structure
```
packages/db/prisma/schema.prisma + migrations/20260910100000_m39_mailbox
packages/db/src/enums.ts, packages/domain/src/events/schema.ts          (+ slave.message_reassigned)
packages/domain/src/supervisor/{actions,candidates,policy,world,observe,report,constants}.ts   (mailbox catalogue, answerTier, richer questions)
packages/domain/src/supervisor/{critical,answerPrompt,sourced}.ts (new)
packages/control/src/messaging.ts        (answerQuestion origin; reassignQuestion)
packages/control/src/supervisor.ts       (draft, tier override, carryOut arms, approve with edit, pruneDecisions, delta-union)
packages/control/src/supervisorWorld.ts  (richer question load; stats snapshot reuse)
packages/control/src/refusal.ts, index.ts
apps/orchestrator/src/supervisor.ts, tick.ts, cli.ts
apps/web/src/server/{supervisor,org}.ts, app/api/.../approve/route.ts, components/SupervisorPanel.tsx, activity/cards.tsx, lib/activityFilters.ts
packages/providers/test/fake-claude.mjs + fixtures/{supervisor-answer,supervisor-answer-unsourced}.ndjson
scripts/gate-m39-supervisor-mailbox.mjs, package.json, ci.yml, README.md
```

---
### Task 1: Domain — mailbox catalogue, critical lexicon, answer prompt/parse, source verification, answerTier

**Files:**
- Modify: `packages/domain/src/supervisor/actions.ts` (remove `nudge_answer`; add `{ kind: 'answer_question'; messageId }`, `{ kind: 'reassign_question'; messageId; toSlaveId }`; `ACTION_KINDS`; `actionSchema`), `constants.ts` (+ the seven constants above), `world.ts` (`SupervisorQuestion` + `body: string; taskId: string | null; taskTitle: string | null; taskDescription: string | null; senderRunId: string | null; threadId: string; thread: readonly ThreadMessage[]; askerRunPrompt: string | null; holders: readonly string[]` with `ThreadMessage { messageId; kind: 'question' | 'answer' | 'note'; senderSlaveId: string | null; body; createdAt }`), `observe.ts` (`questionFacts` + `taskId`, `holders: number`), `candidates.ts` (spec §3 arms; `unanswerable_question` keeps the M38 staffing candidates AFTER `answer_question`/`reassign_question`), `policy.ts` (`tierOf`: `answer_question` → `proposed`; `reassign_question` → `applied` iff `world.slaves.find(toSlaveId)` holds the question's `recipientRole` (or the question is slave-addressed) — the candidate carries `why`; halted rule unchanged; new `answerTier`), `report.ts` (+ `mailbox`)
- Create: `critical.ts` (`CRITICAL_PATTERNS`, `criticalMatches`), `answerPrompt.ts` (`buildAnswerPrompt`, `parseAnswer`, `ModelAnswer`, `Source`, `sourceSchema`), `sourced.ts` (`verifySources`, `isSourced`)
- Tests: `packages/domain/test/supervisor/{critical,answerPrompt,sourced,candidates,policy,observe,report}.test.ts`; update `fixtures.ts` so questions carry the new fields

**Interfaces (produces):**
```ts
export interface Source { readonly kind: 'task' | 'goal' | 'run_context' | 'message'; readonly ref: string | null; readonly quote: string }
export interface ModelAnswer { readonly answer: string; readonly sources: readonly Source[]; readonly critical: boolean }
export function buildAnswerPrompt(input: { question: SupervisorQuestion; world: SupervisorWorld; profile: string | null }): string   // contains the literal "sources"; every foreign text through neutraliseMarkers; thread bodies capped
export function parseAnswer(text: string): ModelAnswer | null   // first {...}; zod: answer trimmed 1..ANSWER_MAX_CHARS, sources ≤ SOURCES_MAX, quote 1..SOURCE_QUOTE_MAX_CHARS, ref string|null, critical boolean
export function criticalMatches(body: string): readonly string[]  // pattern keys, in CRITICAL_PATTERNS order, deduped
export function verifySources(sources: readonly Source[], question: SupervisorQuestion, world: SupervisorWorld): { verified: readonly Source[]; rejected: readonly { source: Source; reason: 'unknown_ref' | 'quote_not_found' | 'no_such_source' }[] }
export function isSourced(v: ReturnType<typeof verifySources>): boolean  // verified.length > 0 && rejected.length === 0
export function answerTier(input: { sourced: boolean; critical: boolean; halted: boolean }): Tier  // critical → escalated; halted || !sourced → proposed; else applied
export interface Draft { readonly body: string | null; readonly sources: readonly Source[]; readonly rejectedSources: readonly { source: Source; reason: string }[]; readonly critical: { readonly lexicon: readonly string[]; readonly model: boolean }; readonly confidence: 'sourced' | 'interpretation'; readonly editedBody?: string }
export const draftSchema: z.ZodType<Draft>   // lives in answerPrompt.ts; Task 2 validates the Json column with it
export type SupervisorReport = { ...; mailbox: { pendingQuestions: number; draftsAwaiting: number; answeredBySupervisor24h: number } }
```
Whitespace normalisation: collapse runs of whitespace to one space, trim, compare case-sensitively. `run_context` source text = `question.askerRunPrompt`; `goal` = `world.goal`; `task` = `taskTitle + '\n' + taskDescription`; `message` = the thread message with `messageId === ref`.
- [ ] Tests first: every `CRITICAL_PATTERNS` key positive + a benign body negative; `parseAnswer` valid / prose-wrapped / too long / >8 sources / missing critical; `verifySources` each kind positive, whitespace-normalised match, `quote_not_found`, `unknown_ref` for a message id not in the thread, `no_such_source` for `run_context` when `askerRunPrompt` is null; `isSourced` all four combinations; `answerTier` the 8-row table; candidates for both question kinds incl. "reassign only to a holder"; `tierOf` for `reassign_question` both ways; `summarise.mailbox`.
- [ ] Commit `feat(domain): m39 t1 — the mailbox catalogue, the critical lexicon, the answer prompt and its source verification, answerTier`.

---
### Task 2: Data model and control — draft, reassignQuestion, answer origin, tier override, approve with edit, prune, delta-union

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`SupervisorDecision.draft Json?`; `EventType` + `slave_message_reassigned @map("slave.message_reassigned")`), create migration `20260910100000_m39_mailbox/migration.sql`, `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts` (+ `slave.message_reassigned { messageId, decisionId, from: { role: string | null; slaveId: string | null }, to: { slaveId } }`), `packages/domain/test/events/schema.test.ts`
- Modify: `packages/control/src/messaging.ts` (`AnswerQuestionInput` + `origin?: 'human' | 'system'` → row `actor` and event envelope actor; `answeredBy: 'supervisor'` allowed; idempotency key namespace unchanged), new `reassignQuestion`, `packages/control/src/supervisor.ts` (`RecordDecisionInput` + `draft?: Draft`, `tier?: Tier` override; `DecisionView.draft`; `carryOut` arms; `approveDecision(id, principal?, edit?: { body: string })`; `pruneDecisions`; delta-union), `packages/control/src/refusal.ts` (+ `message_not_question { messageId }`, `question_answered { messageId }`, `reassign_not_permitted { messageId; slaveId; reason }`, `draft_missing { decisionId }`), `index.ts`, `apps/web/test/refusal-status.test.ts`
- Tests: `packages/control/test/integration/{supervisor,messaging}.test.ts`

**Interfaces (produces):**
```ts
// Draft / draftSchema: consumed from Task 1 (packages/domain/src/supervisor/answerPrompt.ts)
export async function reassignQuestion(messageId: string, toSlaveId: string, actor: string, origin: 'human' | 'system' = 'human', principal?: Principal): Promise<Result<void, ControlRefusal>>
  // message_not_found | message_not_question | question_answered (a reply exists or the asker run is no longer waiting) | slave_not_found | reassign_not_permitted (target holds neither recipientRole nor, for a slave-addressed question, any role the asker's task requires — i.e. task.requiredRole); tx: lock the message row, set recipientSlaveId = toSlaveId, recipientRole = null; appendEvent slave.message_reassigned
RecordDecisionInput += { draft?: Draft; tier?: Tier }   // tier overrides candidates[chosenIndex].tier (only answer_question uses it)
carryOut: 'answer_question' → draft required (draft_missing) and draft.body non-null → answerQuestion(messageId, { body: neutraliseMarkers(draft.editedBody ?? draft.body), answeredBy: 'supervisor', principal }, origin)
          'reassign_question' → reassignQuestion(messageId, toSlaveId, 'supervisor', origin, principal)
          'set_runtime_roles' → addRuntimeRoles(slaveId, [situation.facts.role], origin)   // delta-union: carryOut receives the decision's situation; falls back to action.roles only when facts.role is absent
export async function approveDecision(decisionId: string, principal?: Principal, edit?: { body: string }): ...  // edit only for answer_question drafts; stores draft.editedBody before applying; refuses draft_missing otherwise
export async function pruneDecisions(workspaceId: string, now: Date): Promise<number>   // status ∉ pending, (resolvedAt ?? createdAt) < now - DECISION_RETENTION_MS, take PRUNE_BATCH, deleteMany by ids
```
- [ ] Tests first: `answerQuestion` with `origin: 'system'` → row `actor: system`, event envelope `system`, `answeredBy: 'supervisor'` in the payload; `reassignQuestion` happy (role holder), slave-addressed + task role, each refusal, event payload; `recordDecision` with `draft` and `tier` override (stored, status from the override); `carryOut` each new arm incl. `draft_missing` and the edited body winning; `approveDecision` with `edit` records `editedBody` and sends it; delta-union: proposal computed with `['backend','reviewer']`, `backend` revoked meanwhile → approve → `['reviewer']` only (+ the M38 union test adjusted); `pruneDecisions` deletes only old resolved rows, never pending, at most PRUNE_BATCH; enum parity for the new EventType; migrations applied, `migrate diff` empty.
- [ ] Commit `feat(db,control): m39 t2 — drafts on decisions, reassignQuestion, a Supervisor may answer, approve with an edit, prune, and the delta-union`.

---
### Task 3: Orchestrator — richer question load, the answer call, final tier, snapshot reuse, fake CLI arm

**Files:**
- Modify: `packages/control/src/supervisorWorld.ts` (questions select `id, slaveId, taskId, senderRunId, threadId, body, createdAt, recipientRole, recipientSlaveId`; per question: task title/description, thread messages (`threadId`, `orderBy seq asc`, bodies capped), `RunContext.prompt` for `senderRunId` (capped), `holders` = slave ids with `recipientSlaveId === id` or `recipientRole ∈ runtimeRoles`; signature `loadSupervisorWorld(workspaceId, now, opts?: { stats?: WorkspaceStatsSnapshot })` — when given, skip `workspaceStats` and use the snapshot), `packages/control/src/stats.ts` (export `WorkspaceStatsSnapshot` if not already), `apps/orchestrator/src/world.ts` (`LoadedWorld.statsSnapshot`), `apps/orchestrator/src/tick.ts` (pass `statsSnapshot` into `supervise` deps as `stats`), `apps/orchestrator/src/supervisor.ts` (`SuperviseDeps.stats?`; the question path: after the chosen action is `answer_question` → `criticalMatches(question.body)`; if non-empty → record `escalated` with draft (E2, no call); else if `modelCalls < cap` → `modelCalls += 1`, `decider({ model, prompt: buildAnswerPrompt(...), maxBudgetUsd })`, `parseAnswer` (null → rules: `escalate_to_human`, cost recorded), `verifySources`, `answerTier({ sourced, critical: model.critical, halted })` → `recordDecision({ ..., draft, tier, modelCostUsd: sum of both calls, modelCalled: true })` → `applied` → `applyDecision`; `pruneDecisions` after `expirePendingDecisions`; `SuperviseReport` + `answered`, `drafted`), `packages/providers/test/fake-claude.mjs` (`answerArm(prompt)`: `if (!prompt.includes('"sources"')) return false; await replayFixture(process.env.FAKE_CLAUDE_ANSWER_FIXTURE ?? 'supervisor-answer'); return true` — called right after `supervisorArm` in every sniffing mode), fixtures `supervisor-answer.ndjson` (assistant text `{"answer":"Connect to PostgreSQL on port 5433 as the task says.","sources":[{"kind":"task","ref":null,"quote":"PostgreSQL on port 5433"}],"critical":false}`, `total_cost_usd: 0.02`) and `supervisor-answer-unsourced.ndjson` (`sources: [{"kind":"task","ref":null,"quote":"this sentence appears nowhere"}]`)
- Tests: `packages/control/test/integration/supervisorWorld.test.ts` (question fields, holders, snapshot reuse skips the stats queries — count via a spy on the client or by passing a sentinel snapshot), `apps/orchestrator/test/integration/supervisor.test.ts` (sourced → applied + answer row + `deliverAnswers` resumes the waiting run; unsourced → proposed with draft, no answer row; lexicon critical → escalated with no second call (recorder calls = 1); model `critical: true` → escalated; unparseable answer → escalate by rules, cost recorded; cap reached before the answer call → escalate by rules; two calls' costs summed on the row), `tick.test.ts` (the snapshot travels), `packages/providers/test/fake-claude.test.ts` (answer arm precedence and the env fixture switch)
- [ ] Commit `feat(orchestrator,control,providers): m39 t3 — the Supervisor answers, drafts or escalates a question; one stats read per tick`.

---
### Task 4: CLI and web — editable drafts, reassign verb, mailbox block, projects-list spend

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (`approve-decision --id <id> [--body-file <path>]` → `approveDecision(id, undefined, body ? { body } : undefined)`; new `reassign-question --message <id> --to <slaveId> [--by <name>]`; `supervisor-decisions` prints `draft.confidence` and `draft.critical` when present; USAGE), `apps/orchestrator/test/integration/cli.test.ts`
- Modify: `apps/web/src/app/api/w/[workspaceId]/supervisor/decisions/[decisionId]/approve/route.ts` (optional zod body `{ body?: string }` → edit), `apps/web/src/server/supervisor.ts` (`SupervisorView` + `questions: { messageId, body, askerName, waitingOn: string, since }[]` from the world), `apps/web/src/components/SupervisorPanel.tsx` (`ProposalRow` for an `answer_question` draft: the question, a textarea seeded with `draft.body`, verified sources as quotes with origin, rejected sources marked, critical flags; Approve posts `{ body }` when edited; a "Questions waiting" block), `apps/web/src/server/org.ts` (`listProjects` spend: `workspaceSpend` semantics for all projects in ONE query — a `supervisorDecision.groupBy(['workspaceId','modelCalled'])` merged with the run groups), `apps/web/src/components/activity/cards.tsx` + `apps/web/src/lib/activityFilters.ts` (`slave.message_reassigned` card under `interventions`), `apps/web/test/activity-cards.test.tsx`
- Tests: `apps/web/test/integration/control-routes.test.ts` (approve with edited body → answer row carries it; malformed 400), `apps/web/test/supervisor-panel.test.tsx` (draft row renders sources/critical, edited approve posts `{ body }`, questions block), `apps/web/test/integration/org.test.ts` or the projects-list test (Supervisor spend included, one query), `web:build`
- [ ] Commit `feat(cli,web): m39 t4 — edit and approve a drafted answer, reassign a question, see the mailbox; the projects list counts Supervisor spend`.

---
### Task 5: Gate, CI, README, full verification

**Files:** `scripts/gate-m39-supervisor-mailbox.mjs`, `package.json` (`"gate:m39-supervisor-mailbox": "tsc --build && node --env-file=.env scripts/gate-m39-supervisor-mailbox.mjs"`), `.github/workflows/ci.yml` (after `gate:m38-supervisor`), `README.md` (`## The Supervisor` gains a "Its mailbox" paragraph: sourced vs interpretation, the critical lexicon keys, re-addressing, `reassign-question`, `approve-decision --body-file`; "Tests and CI" roster +1)

Gate (real daemon, fake CLI `m36-flow`, borrow gate-m36 for the ask and gate-m38 for the Supervisor helpers): workspace with `Dev` (`runtimeRoles: ['backend']`) and a task whose description contains "PostgreSQL on port 5433"; `FAKE_CLAUDE_ASK_JSON` makes Dev's run ask a `qa`-addressed question (nobody holds `qa`).
- Stage 1 (daemon with `FAKE_CLAUDE_ANSWER_FIXTURE=supervisor-answer`): run parks waiting → `unanswerable_question` → decision `applied`, `draft.confidence: 'sourced'`, `modelCalled: true`, an `answer` message `answeredBy: 'supervisor'`, actor `system` → `deliverAnswers` resumes the run → it concludes.
- Stage 2 (restart daemon with `FAKE_CLAUDE_ANSWER_FIXTURE=supervisor-answer-unsourced`; second task/question): decision `proposed`/pending with `draft.confidence: 'interpretation'`, no answer row; `approve-decision --id --body-file` with an edited body → answer row carries the edited text, `draft.editedBody` set, run resumes.
- Stage 3: a question whose body says "which api key should I use" → decision `escalated`, no second model call (`modelCalled` true from the choice call only — assert the recorded cost equals the choice fixture's 0.01), `draft.critical.lexicon` includes `secrets`, no answer row.
- Stage 4: a `backend`-addressed question, `Dev` busy on another run, a second slave `Ops` holding `backend` idle → `reassign_question` applied → `recipientSlaveId = Ops`, `slave.message_reassigned` event.
- Stage 5: seed a `rejected` decision 31 days old and a `pending` one 31 days old → tick → the first is gone, the second remains.
- [ ] Full verification in order: `npm run --silent typecheck`; `npm run gate:m26-vocabulary`; `npx vitest run` (no daemon; flake → re-run alone); `npm run web:build` (no `next dev`); gates m39, m38, m37, m36, m35, m33, m11.
- [ ] Commit `test(gates),docs: m39 t5 — gate:m39-supervisor-mailbox; README`.
