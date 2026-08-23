# M8a: Execution Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the execution path — verify green enters a QA review stage, an approved task
flows through a serialized merge queue onto `main`, the missing guardrail halves are wired, and
one emergency stop halts and pauses everything — so that *a task → merged branch, unattended*.

**Architecture:** Two new daemon tick passes (review dispatch, merge) run after the resume pass
behind the existing halted-workspace bail. Review runs are `AgentRun.kind: 'review'` rows spawned
into the task's preserved worktree; their verdict is a Zod-validated JSON object recovered from
the run's own `run.output` events. The merge pass claims one `merging` task at a time with a
conditioned `updateMany` on a new `Task.mergeClaimedAt` column and performs rebase → re-verify →
`--no-ff` merge with the orchestrator's existing `git -c` identity helper. Guardrails gain the
global concurrency count, the budget-warning one-shot, and breach-pauses-runs; `emergencyStop`
is one `packages/control` operation surfaced as a TopBar STOP button and a CLI command.

**Tech Stack:** TypeScript, Prisma/Postgres, Next.js 15 App Router, Tailwind v4, vitest +
testing-library, zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-m8a-execution-closure-design.md`

## Spec errata (decisions of record for this plan)

The spec was written against the design; the code moved on. Three deviations, argued once here:

1. **No run-kind migration.** Spec §3.1 says "`AgentRun` gains `kind: 'work' | 'review'` (one
   migration)". `AgentRun.kind` already exists (`schema.prisma:225`,
   `enum RunKind { implementation review planning }`), defaulted `implementation`, exercised by
   `packages/db/test/integration/work.test.ts:84`. We reuse it verbatim: work runs are
   `implementation` (the schema default — `startRun` passes no kind), review runs pass
   `kind: 'review'`. No migration, no backfill.
2. **"Re-request to the same run" becomes "at most one fresh review run".** Spec §3.2 wants an
   invalid verdict re-requested once on the same run. There is no adapter primitive for messaging
   a live or concluded run (`sendInstruction` exists only in a doc comment; `adapter.resume`
   needs a Checkpoint, written only on pause). Instead: an invalid verdict concludes that review
   run `failed` (visible, feeds the circuit breaker), and the dispatch pass starts at most ONE
   more review run for the same work attempt; a second failure leaves the task waiting in
   `reviewing` with two `run.failed` events as the human escalation. Same retry budget, same
   visible outcome, no new adapter surface.
3. **Verdict transport is the run's `run.output` events.** `pumpRun` returns `RunOutcome`
   (no text); agent text is already persisted as `run.output` events (capped 4000 chars each).
   The verdict is parsed from those events read back in seq order — resilient to pause/resume
   and daemon restart, zero provider changes. The review prompt demands the JSON in the final
   message; `reason` is one paragraph, far under the cap.

## Global Constraints

- Every web mutation goes through `packages/control`; `apps/web` never writes through Prisma
  (M5 §1). `packages/control` never imports `packages/providers`.
- Control refusals map to HTTP 409 with `refusalText` as `{ error }`; route-level mismatch is
  404 JSON `{ error }`; success is `Response.json({ ok: true })` (M5 §4 contract).
- New event types extend ALL exhaustive maps in the same task that adds them:
  `executionEventSchema` → `EVENT_TYPE_BY_DOMAIN_TYPE` (`packages/db/src/enums.ts`) → Prisma
  `enum EventType` + SQL migration → `ACTIVITY_CARDS` (`apps/web/src/components/activity/cards.tsx`)
  → `TYPES_BY_KIND` (`apps/web/src/lib/activityFilters.ts`) → `PAYLOAD_BY_TYPE` fixture
  (`apps/web/test/activity-cards.test.tsx`). The first four are compile-enforced; the last two
  are test-enforced (`activityFilters.test.ts`, `enum-parity.test.ts`).
- The claim idiom is a conditioned `prisma.X.updateMany({ where: { …, status: <expected> } })`
  with `.count` checked — never read-then-write (M5 precedent, `tick.ts:325-334`).
- Git identity only ever via `-c user.name=… -c user.email=…` flags, never `git config`
  (`worktree.ts:36-39`). Reuse/extract the `git()` helper in `worktree.ts`; do not write a
  second one.
- `appendEvent` is never called inside another transaction (`packages/events/src/append.ts` doc).
- Infra failures never become agent instructions: `lastRejectionReason` carries only reviewer
  reasons, verify output, and merge conflict/re-verify detail (the `failToStart` precedent,
  `tick.ts:483-488`).
- Migrations: `npx prisma migrate dev --name <name> --schema packages/db/prisma/schema.prisma
  --config packages/db/prisma.config.ts`, then `npm run db:migrate:test` and `npm run db:generate`.
  Names carry the milestone prefix (`m8a_…`).
- Tests: TDD; unit under `<pkg>/test/`, integration (real Postgres via `TEST_DATABASE_URL`,
  real git repos via `mkdtempSync` + cleanup) under `<pkg>/test/integration/`. `.test.tsx` files
  start with `// @vitest-environment jsdom`. The M4-protected original tests in
  `apps/web/test/useOverview.test.tsx` stay untouched.
- **Every task's full gate: `npm test && npm run typecheck && npm run web:build`.**
- Commits: conventional prefixes as in the log.

---

### Task 1: The four review/merge event types — domain, DB enum, kind map, activity cards

**Files:**
- Modify: `packages/domain/src/events/schema.ts` (four union members),
  `packages/db/src/enums.ts` (`EVENT_TYPE_BY_DOMAIN_TYPE` entries),
  `packages/db/prisma/schema.prisma` (enum `EventType` values), migration via
  `npx prisma migrate dev --name m8a_review_merge_events --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts`
  then `npm run db:migrate:test` and `npm run db:generate`,
  `apps/web/src/lib/activityFilters.ts` (`TYPES_BY_KIND.tasks` gains all four; fix the stale
  "20 `DomainEventType`s" count in the doc comment),
  `apps/web/src/components/activity/cards.tsx` (four card bodies)
- Test: extend `packages/domain/test/events/schema.test.ts`,
  `apps/web/test/activity-cards.test.tsx` (`PAYLOAD_BY_TYPE` fixtures + targeted assertions);
  `apps/web/test/activityFilters.test.ts` and
  `packages/db/test/integration/enum-parity.test.ts` pass untouched once all maps are extended

**Interfaces:**
- Produces (Tasks 5–7 append these events; the schema members verbatim):

```ts
z.object({
  ...envelope,
  type: z.literal('task.review_started'),
  payload: z.object({ title: z.string() }),
}),
z.object({
  ...envelope,
  type: z.literal('task.review_approved'),
  payload: z.object({ reason: z.string() }),
}),
z.object({
  ...envelope,
  type: z.literal('task.review_rejected'),
  payload: z.object({ reason: z.string(), attempt: z.number().int().positive() }),
}),
z.object({
  ...envelope,
  type: z.literal('task.merge_failed'),
  payload: z.object({ reason: z.string() }),
}),
```

DB enum values (the `@map` convention): `task_review_started @map("task.review_started")`,
`task_review_approved @map("task.review_approved")`,
`task_review_rejected @map("task.review_rejected")`,
`task_merge_failed @map("task.merge_failed")`. Migration SQL is four
`ALTER TYPE "EventType" ADD VALUE '…';` lines (the `m7_dependency_events` precedent).
`EVENT_TYPE_BY_DOMAIN_TYPE` gains all four (the `satisfies` clause forces them).

- [ ] **Step 1: Failing tests.** Domain: four new cases in `schema.test.ts` asserting parse of
  each type with the payload above, plus rejection of `task.review_rejected` with `attempt: 0`
  (positive-int refinement). Cards: add all four to `PAYLOAD_BY_TYPE` (e.g.
  `'task.review_approved': { reason: 'diff matches the task' }`,
  `'task.review_rejected': { reason: 'edge case unhandled', attempt: 2 }`) plus two targeted
  assertions: the rejected-card shows the reason and `(attempt 2)`, the merge-failed card shows
  its reason.
- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/domain/test/events` fails on
  unknown literals; `npm run typecheck` fails on the non-exhaustive maps (that IS the
  enforcement working).
- [ ] **Step 3: Implement.** Schema members, enum values + migration (both DBs), map entries,
  kind assignment (`tasks`), four card bodies in the house style: review_started —
  `<Transition tone="paused" label="QA review started">` with the title; review_approved —
  `tone="working" label="review approved"` with the reason; review_rejected — `tone="warn"
  label="review rejected"` mirroring `TaskReworkCard`'s reason + `(attempt N)` layout;
  merge_failed — `tone="danger" label="merge failed"` with the reason.
- [ ] **Step 4: Full gate** — `npm test && npm run typecheck && npm run web:build`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain,db,web): the review and merge event types, kind mapping and cards"
```

---

### Task 2: The review verdict contract — `parseReviewVerdict`

**Files:**
- Create: `packages/domain/src/review/verdict.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from './review/verdict.js'`)
- Test: `packages/domain/test/review/verdict.test.ts`

**Interfaces:**
- Produces (Task 6's `concludeReview` calls this):

```ts
import { z } from 'zod'
import { err, ok, type Result } from '../result.js'

export interface ReviewVerdict {
  readonly verdict: 'approve' | 'reject'
  readonly reason: string
}

export const reviewVerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  reason: z.string().min(1),
})

/**
 * Recover the verdict from a review run's accumulated output text. The prompt demands one JSON
 * object in the final message, but agents wrap JSON in prose and code fences, so this scans for
 * the LAST parseable object that satisfies the schema (spec §3.2: free-form text never reaches
 * the database — only the validated object does).
 */
export function parseReviewVerdict(text: string): Result<ReviewVerdict, string>
```

- [ ] **Step 1: Failing tests.** Cases: (a) a bare JSON object parses; (b) JSON wrapped in prose
  and a ```json fence parses; (c) TWO objects in the text — the last valid one wins; (d) an
  object with `verdict: "maybe"` is rejected with a message naming the failure; (e) text with no
  JSON at all is rejected; (f) `reason: ""` is rejected; (g) nested braces inside the reason
  string do not break extraction.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run packages/domain/test/review` —
  FAIL (module not found).
- [ ] **Step 3: Implement.** Brace-scanning extraction, last match wins:

```ts
export function parseReviewVerdict(text: string): Result<ReviewVerdict, string> {
  for (let start = text.lastIndexOf('{'); start !== -1; start = text.lastIndexOf('{', start - 1)) {
    const candidate = extractObject(text, start)
    if (candidate === null) continue
    const parsed = reviewVerdictSchema.safeParse(candidate)
    if (parsed.success) return ok(parsed.data)
  }
  return err('no JSON object with { "verdict": "approve" | "reject", "reason": string } found in the review output')
}

/** Parse the balanced-brace substring starting at `start`, string-aware; null when unparseable. */
function extractObject(text: string, start: number): unknown {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
```

- [ ] **Step 4: Run to verify green**, then the full gate.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): the review verdict schema and last-object parser"
```

---

### Task 3: Global concurrency and the merge-claim column — domain, world, DB

One task, deliberately: adding required fields to `GuardrailLimits`/`WorkspaceStats` breaks
`loadWorld`'s `World` construction at compile time, so the domain widening and the orchestrator
wiring cannot pass a gate apart. The `mergeClaimedAt` column rides in the same migration window.

**Files:**
- Modify: `packages/domain/src/guardrails/evaluate.ts` (`GuardrailLimits` +
  `maxGlobalConcurrentRuns`, `WorkspaceStats` + `globalActiveRuns`, `DEFAULT_GUARDRAIL_LIMITS`
  + `maxGlobalConcurrentRuns: 6`, one new breach),
  `packages/domain/src/scheduler/decide.ts` (slot budget clamps on the global remainder),
  `packages/db/prisma/schema.prisma` (`model Task` gains `mergeClaimedAt DateTime?`),
  migration via
  `npx prisma migrate dev --name m8a_merge_claim --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts`
  then `npm run db:migrate:test` and `npm run db:generate`,
  `apps/orchestrator/src/world.ts` (`loadRunStats` gains the global count; the `World` assembly
  fills both new fields)
- Test: extend `packages/domain/test/guardrails/evaluate.test.ts`,
  `packages/domain/test/scheduler/decide.test.ts`, and
  `apps/orchestrator/test/integration/world.test.ts`; update every existing fixture that
  constructs `GuardrailLimits`/`WorkspaceStats` (compile errors point at each — typically add
  `maxGlobalConcurrentRuns: 6` and `globalActiveRuns: 0`)

**Interfaces:**
- Produces (`decide()` and Task 9's warning check consume the stats; Task 7 claims on
  `Task.mergeClaimedAt: Date | null`):

```ts
export interface GuardrailLimits {
  // …existing five…
  readonly maxGlobalConcurrentRuns: number   // spec §5: default 6
}
export interface WorkspaceStats {
  // …existing four…
  readonly globalActiveRuns: number          // active runs across ALL workspaces
}
```

The new breach, inserted directly AFTER the per-workspace `concurrency` breach so the pinned
emission order becomes emergency_stop, concurrency, global_concurrency, budget, circuit_breaker:

```ts
if (stats.globalActiveRuns >= limits.maxGlobalConcurrentRuns) {
  breaches.push({
    guardrail: 'global_concurrency',
    detail: `${stats.globalActiveRuns} active runs across all workspaces at the global limit ${limits.maxGlobalConcurrentRuns}.`,
    haltsScheduling: true,
  })
}
```

`decide()`'s slot budget (`decide.ts:54`) becomes:

```ts
let slots = Math.min(
  world.limits.maxConcurrentRuns - world.stats.activeRuns,
  world.limits.maxGlobalConcurrentRuns - world.stats.globalActiveRuns,
)
```

Migration SQL: `ALTER TABLE "Task" ADD COLUMN "mergeClaimedAt" TIMESTAMP(3);`

In `loadRunStats` (`world.ts:144-194`), beside the existing per-workspace count and inside the
same `RepeatableRead` transaction:

```ts
const globalActiveRuns = await tx.agentRun.count({
  where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
})
```

widen its return to `{ activeRuns, globalActiveRuns, spentUsd, consecutiveFailures }`, and in the
`World` assembly (`world.ts:273-296`):

```ts
limits: { …existing…, maxGlobalConcurrentRuns: MAX_GLOBAL_CONCURRENT_RUNS },
stats: { …existing…, globalActiveRuns: runStats.globalActiveRuns },
```

with `const MAX_GLOBAL_CONCURRENT_RUNS = 6` module-level (spec §5 — a constant, not a Workspace
column: the limit is cross-workspace by definition).

A review run concluding `failed` DOES feed the existing consecutive-failure streak
(`world.ts:178-185`) — deliberate: repeated garbage reviews should trip the circuit breaker.
No change there.

- [ ] **Step 1: Failing tests.** Evaluate: at `globalActiveRuns: 6, maxGlobalConcurrentRuns: 6`
  a halting `global_concurrency` breach is reported; at 5 it is not; extend the pinned-order
  test with the new position. Decide: with per-workspace room (`activeRuns: 0`,
  `maxConcurrentRuns: 3`) but only one global slot (`globalActiveRuns: 5`), two startable tasks
  with matching idle agents yield exactly ONE `start_run`. World (`world.test.ts`): seed a
  second workspace with its own team/agent/task and one non-terminal run there; assert
  `world.stats.globalActiveRuns` counts runs from BOTH workspaces while
  `world.stats.activeRuns` counts only the loaded workspace's; assert
  `world.limits.maxGlobalConcurrentRuns === 6`.
- [ ] **Step 2: Run to verify failure** — compile errors in fixtures plus the new assertions.
- [ ] **Step 3: Implement** the widening, the breach, the clamp, the migration, the query, the
  `World` assembly; mend every fixture the compiler flags.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain,db,orchestrator): global concurrency guardrail and the merge claim column"
```

---

### Task 4: Fake CLI review fixtures and the `m8a-flow` mode

**Files:**
- Create: `packages/providers/test/fixtures/review-approve.ndjson`,
  `packages/providers/test/fixtures/review-reject.ndjson`,
  `packages/providers/test/fixtures/review-invalid.ndjson`
- Modify: `packages/providers/test/fake-claude.mjs` (one synthetic mode)
- Test: `packages/providers/test/fake-claude.test.ts` (create if absent — a unit test spawning
  the script and asserting its stdout lines; keep it in `test/`, not `test/integration/`)

**Interfaces:**
- Produces: fixture names Tasks 5–8 pass as `--fixture` values; the `m8a-flow` mode Task 13's
  gate script and Task 8's end-to-end test run the daemon against.

The three `.ndjson` fixtures are copies of `fixtures/complete.ndjson` with the assistant text
content replaced (keep the session/result line structure byte-compatible with `complete`):

- `review-approve`: text `Reviewed the diff. {"verdict":"approve","reason":"The diff implements the task as described and the tests cover it."}`
- `review-reject`: text `{"verdict":"reject","reason":"The diff does not handle the empty-input case the task requires."}`
- `review-invalid`: text `I think this looks fine overall.` (no JSON object anywhere)

The `m8a-flow` synthetic mode in `fake-claude.mjs` (the `env-echo` precedent — a new branch in
`main()` before the replay fallback). It makes the unattended gate REAL: the work run commits an
actual change so the merge pass has something to merge, and the review run emits an approval.
Selection is by prompt content — the adapter passes the prompt via `-p`:

```js
if (fixtureName === 'm8a-flow') {
  const promptIndex = args.indexOf('-p')
  const prompt = promptIndex === -1 ? '' : (args[promptIndex + 1] ?? '')
  if (prompt.includes('"verdict"')) {
    await replayFixture('review-approve')
    return
  }
  // A work run: leave a real commit in the worktree (cwd), then replay success.
  writeFileSync(join(process.cwd(), 'm8a-work.txt'), `${prompt.slice(0, 80)}\n`)
  execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@aiteamos.local', 'add', '-A'], { cwd: process.cwd() })
  execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@aiteamos.local', 'commit', '-q', '-m', 'fake work'], { cwd: process.cwd() })
  await replayFixture('complete')
  return
}
```

(`replayFixture(name)` is the existing default-branch replay body factored into a function; the
review prompt built in Task 5 contains the literal substring `"verdict"`, work prompts never do.)

- [ ] **Step 1: Failing test.** Spawn `node fake-claude.mjs --fixture review-approve` and assert
  stdout contains `"verdict":"approve"`; spawn `--fixture m8a-flow` with `-p 'work on it'` in a
  fresh `mkdtempSync` git repo (init + initial commit first) and assert a new commit exists
  (`git log --oneline` has 2 lines) and stdout replays the complete fixture's result line; spawn
  `m8a-flow` with `-p 'respond with "verdict" json'` and assert stdout contains
  `"verdict":"approve"` and NO new commit is made.
- [ ] **Step 2: Run to verify failure** (fixtures/mode missing).
- [ ] **Step 3: Implement** the three fixtures + the mode + the `replayFixture` extraction.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(providers): review verdict fixtures and the m8a-flow fake CLI mode"
```

---

### Task 5: The review dispatch pass

**Files:**
- Create: `apps/orchestrator/src/review.ts`
- Modify: `apps/orchestrator/src/tick.ts` (call the pass after `resumeRequestedRuns`; extend
  `TickReport`), `apps/orchestrator/src/worktree.ts` (export the private `git` helper as
  `gitIn(cwd: string, ...args: readonly string[]): Promise<string>`)
- Test: `apps/orchestrator/test/integration/review.test.ts`

**Interfaces:**
- Consumes: `TickDeps` (`tick.ts`), `gitIn` (this task's export), Task 1's
  `task.review_started`, the fake CLI fixtures from Task 4, `pumpRun`/`verifyConcludedRun`
  chaining exactly as `startRun` does (`tick.ts:390-419`), `runFilePaths`/`writeSettingsFile`.
- Produces (Task 6 concludes these runs; Task 8's flip makes production reach them):

```ts
/** One dispatch pass: start a review run for every reviewing task that needs one. */
export async function dispatchReviews(deps: TickDeps): Promise<readonly RunId[]>

/** The prompt contains the literal substring `"verdict"` — the fake CLI's m8a-flow keys on it. */
export function buildReviewPrompt(
  task: { readonly title: string; readonly description: string },
  diff: string,
): string
```

`TickReport` gains `readonly reviewsStarted: readonly RunId[]` (tick returns
`reviewsStarted: []` in the halt branch).

Pass logic, per `reviewing` task in the workspace (ordered by `createdAt` then id for
determinism):

1. **Skip if a review run is live:** `prisma.agentRun.count({ where: { taskId, kind: 'review',
   status: { in: [...NON_TERMINAL_RUN_STATUSES] } } }) > 0`.
2. **Retry cap (Erratum 2):** find the latest implementation run
   (`findFirst({ where: { taskId, kind: 'implementation' }, orderBy: { startedAt: 'desc' } })`);
   count review runs with `startedAt > latestImpl.startedAt`; at `>= 2`, skip silently — the two
   `run.failed` events are the escalation. `latestImpl === null` or
   `latestImpl.worktreePath === null` or `task.branch === null` → `console.warn` and skip.
3. **Reviewer staffing:** reviewers are agents in this workspace with `role === 'reviewer'`
   (exact match, the `decide()` convention — lowercase, and Task 8's seed uses the same
   spelling). If NONE exists at all → the one-shot escalation (the empty-verify-commands
   precedent): emit `guardrail.tripped` `{ guardrail: 'no_reviewer', detail:
   'task "<title>" is waiting in reviewing: no reviewer-role agent in this workspace' }` with
   `taskId`, only if no such event already exists for this task —
   `prisma.executionEvent.findFirst({ where: { workspaceId, taskId, type: 'guardrail_tripped',
   payload: { path: ['guardrail'], equals: 'no_reviewer' } }, select: { seq: true } })`. If
   reviewers exist but all are busy (each has a non-terminal run) → wait silently.
4. **Dispatch** (the `startRun` shape, minus worktree provisioning — the review runs in the
   preserved worktree): create
   `prisma.agentRun.create({ data: { taskId, agentId, kind: 'review', status: 'starting' } })`;
   diff via `gitIn(workspace.repoPath, 'diff', `${workspace.baseBranch}...${task.branch}`)`
   truncated to 60 000 chars with a `\n[diff truncated]` marker; emit `task.review_started`
   `{ title: task.title }` (actor `system`, with taskId/agentId/runId);
   `writeSettingsFile` + `adapter.start` with `worktreePath: latestImpl.worktreePath`, the
   reviewer agent's git identity (the `emailLocalPart` convention), and
   `prompt: buildReviewPrompt(task, diff)`; record pid/worktreePath on the run; chain
   `pumpRun(...).then(() => verifyConcludedRun(runId)).catch(...).finally(...)` into the `pumps`
   set exactly as `tick.ts:390-419` does. On spawn failure: cancel if spawned, conclude the run
   `failed` with `run.failed` (reason from the error), leave the task in `reviewing` (do NOT
   touch `attempt` — infra, not agent failure).

```ts
export function buildReviewPrompt(task, diff) {
  return [
    'You are the QA reviewer for this task. Judge the DIFF against the task — do not rebuild or re-run it.',
    '',
    `Task: ${task.title}`,
    '',
    task.description,
    '',
    'DIFF (base...branch):',
    '```diff',
    diff,
    '```',
    '',
    'Your final message must contain exactly one JSON object and nothing else on its line:',
    '{"verdict":"approve","reason":"one paragraph"} or {"verdict":"reject","reason":"one paragraph"}',
  ].join('\n')
}
```

In `tick.ts`, after `await resumeRequestedRuns(deps)`:

```ts
const reviewsStarted = await dispatchReviews(deps)
return { started, halted: null, skippedNoRole, reviewsStarted }
```

- [ ] **Step 1: Failing tests** (`review.test.ts`, the `tick.test.ts` harness: real repo via
  `makeRepo()`, seeded workspace/team, `ClaudeCodeAdapter` with
  `extraArgs: [FAKE, '--fixture', 'review-approve']`, TRUNCATE in `beforeEach`,
  `drainPumps()` in `afterEach`). Seed a task directly in `status: 'reviewing'` with a real
  branch + worktree (drive one `tick` with fixture `complete` first to produce them, then
  `prisma.task.update` to `reviewing` — or provision via `provisionWorktree` and set
  `branch`/a prior succeeded implementation run row by hand). Cases:
  (a) with an idle `reviewer` agent, one review run with `kind: 'review'` is created, a
  `task.review_started` event exists, and the run's events eventually include `run.output`;
  (b) a second `dispatchReviews` call while that run is live starts nothing;
  (c) with NO reviewer agent, no run starts and exactly one `no_reviewer` `guardrail.tripped`
  exists after TWO passes (the one-shot);
  (d) with two failed review runs newer than the latest implementation run, nothing starts;
  (e) `buildReviewPrompt` contains the literal `"verdict"` and the diff body (unit-style
  assertion in the same file).
- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/orchestrator/test/integration/review.test.ts`.
- [ ] **Step 3: Implement** `review.ts`, the `gitIn` export, the tick wiring.
- [ ] **Step 4: Full gate.** (Existing `TickReport` consumers: the daemon's log line and
  `cli.ts` `tick` printer — extend their output with `reviewsStarted.length` where they print
  `started`.)
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): the review dispatch pass"
```

---

### Task 6: Review conclusion — verdict parsing and outcomes

**Files:**
- Modify: `apps/orchestrator/src/verify.ts` (branch on `run.kind` in `verifyConcludedRun`),
  `apps/orchestrator/src/review.ts` (add `concludeReview`)
- Test: extend `apps/orchestrator/test/integration/review.test.ts`

**Interfaces:**
- Consumes: Task 2's `parseReviewVerdict`, Task 1's `task.review_approved` /
  `task.review_rejected` events, the rework transaction shape (`verify.ts:296-344`).
- Produces:

```ts
/** Conclude a succeeded review run: parse the verdict and move the task. */
export async function concludeReview(runId: RunId): Promise<void>
```

In `verifyConcludedRun` (`verify.ts:180-209`), immediately after the `status !== 'succeeded'`
early return:

```ts
if (run.kind === 'review') {
  await concludeReview(brandRunId(run.id))
  return
}
```

`concludeReview` logic:

1. Load the run with task + workspace. Read the text back:

```ts
const rows = await prisma.executionEvent.findMany({
  where: { runId, type: 'run_output' },
  orderBy: { seq: 'asc' },
})
const text = rows.map((row) => (row.payload as { text: string }).text).join('\n')
const parsed = parseReviewVerdict(text)
```

2. **Invalid** (`!parsed.ok`): conditioned
   `prisma.agentRun.updateMany({ where: { id: runId, status: 'succeeded' }, data: { status:
   'failed' } })` + emit `run.failed` `{ reason: `review run produced no valid verdict:
   ${parsed.error}` }` (actor `system`, full ids). The task stays `reviewing`; Task 5's retry
   cap (max 2 review runs per work attempt) bounds the loop. A succeeded process with garbage
   output IS a failed review — it also feeds the circuit breaker, deliberately.
3. **Approve:** conditioned
   `prisma.task.updateMany({ where: { id: task.id, status: 'reviewing' }, data: { status:
   'merging' } })`; on `count === 1` emit `task.review_approved` `{ reason }`. `autoMerge` is
   NOT consulted here (spec Decision 5 — the merge pass owns it).
4. **Reject:** the rework machinery verbatim (`verify.ts:296-344`'s transaction — increment
   `attempt`, exhausted → `failed` else `rework`, `lastRejectionReason: parsed.value.reason`,
   `activeRunId: null`), then emit `task.review_rejected` `{ reason, attempt }` and, when
   exhausted, `task.failed` `{ reason }` (the verify-red event pattern). Extract the transaction
   into a shared `rejectTask(taskId, reason)` helper in `verify.ts` rather than duplicating it
   (export it; Task 7 reuses it too).

- [ ] **Step 1: Failing tests.** Drive a full review run through `tick`/`dispatchReviews` per
  fixture and `await drainPumps()`:
  (a) fixture `review-approve` → task ends `merging`, a `task.review_approved` event carries the
  fixture's reason, the review run is `succeeded`;
  (b) fixture `review-reject` → task ends `rework` with `lastRejectionReason` equal to the
  fixture's reason, `attempt` incremented, a `task.review_rejected` event with `{ reason,
  attempt }`;
  (c) exhaustion: seed `attempt: task.maxAttempts - 1` so the rejection's increment reaches the
  cap → task ends `failed` and a `task.failed` event exists;
  (d) fixture `review-invalid` → the run ends `failed`, a `run.failed` event names the missing
  verdict, the task stays `reviewing`; a second dispatch+conclusion with `review-invalid` leaves
  it `reviewing` with two failed review runs and NO third dispatch (ties to Task 5's cap);
  (e) invalid-then-valid (spec §7's variant): after ONE `review-invalid` round, re-dispatch with
  a `review-approve` adapter (construct a second `ClaudeCodeAdapter` with the new fixture for
  the second tick) → the task ends `merging`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the branch, `concludeReview`, the `rejectTask` extraction.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): review verdict conclusion — approve, reject, invalid"
```

---

### Task 7: The merge pass and crash recovery

**Files:**
- Create: `apps/orchestrator/src/merge.ts`
- Modify: `apps/orchestrator/src/tick.ts` (call after the review pass),
  `apps/orchestrator/src/sweep.ts` (`reconcileOrphans` recovers stale merge claims)
- Test: `apps/orchestrator/test/integration/merge.test.ts`, extend
  `apps/orchestrator/test/integration/sweep.test.ts`

**Interfaces:**
- Consumes: `Task.mergeClaimedAt` (Task 3), `gitIn` (Task 5), `runVerify` and the exported
  `rejectTask` (Task 6), `nextMergeCandidate` (`packages/domain/src/merge/queue.ts` — exists,
  tested, zero callers until now), Task 1's `task.merge_failed`.
- Produces:

```ts
/** One merge-pass step: claim and process at most ONE merging task (spec §4 serialization). */
export async function runMergePass(workspaceId: WorkspaceId): Promise<void>
```

Pass logic:

1. Load `merging` tasks with `mergeClaimedAt: null`. If any `merging` task has a non-null claim,
   return (a merge is in flight — only observable across a crash; recovery below). FIFO by the
   `review_approved` event's seq (spec §4): fetch
   `prisma.executionEvent.findMany({ where: { workspaceId, type: 'task_review_approved', taskId:
   { in: ids } }, orderBy: { seq: 'asc' } })`, take each task's LATEST such seq (rework cycles
   re-approve), and feed `nextMergeCandidate(candidates, false)` with
   `enqueuedAt: Number(seq)` and `blockedUntilRebase: false` — the domain helper owns the
   FIFO-with-tiebreak ordering.
2. **Claim:** `prisma.task.updateMany({ where: { id, status: 'merging', mergeClaimedAt: null },
   data: { mergeClaimedAt: new Date() } })`; `count === 0` → return (an overlapping tick won).
3. **`autoMerge === false` (spec Decision 5):** conclude without merging —
   `prisma.task.update({ where: { id }, data: { status: 'done', mergeClaimedAt: null,
   lastRejectionReason: null } })` + emit `task.done` `{ branch }`. The branch and worktree
   survive for the human. Return.
4. **Rebase** in the preserved worktree (the latest implementation run's `worktreePath`):
   `await gitIn(worktreePath, 'rebase', workspace.baseBranch)`; on throw, best-effort
   `gitIn(worktreePath, 'rebase', '--abort').catch(() => {})`, then step 7 with
   `reason: 'rebase onto ${baseBranch} conflicted: <first 2000 chars of the error message>'`.
5. **Re-verify the rebased result — the real gate:** `runVerify({ taskId, worktreePath,
   artifactDir: join(workspace.repoPath, '.aiteamos', 'artifacts', task.id), commands:
   workspace.verifyCommands, timeoutMs: workspace.runTimeoutMs })`. `result.kind !== 'passed'`
   → step 7 with `reason: 'post-rebase verify failed: <failedCommand> exited <exitCode>'` (or
   the not_configured/could_not_run kind verbatim).
6. **Merge:** guard the primary checkout —
   `await gitIn(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')` must equal
   `workspace.baseBranch` and `await gitIn(repoPath, 'status', '--porcelain')` must be empty,
   else step 7 (`reason: 'primary checkout is not clean on ${baseBranch}'`). Then
   `await gitIn(repoPath, 'merge', '--no-ff', task.branch, '-m',
   `merge(${taskKey}): ${task.title}`)` with `taskKey = `T-${task.id.slice(0, 8)}`` (the
   `taskKeyFor` convention — one `git revert -m 1` undoes it). Success →
   `prisma.task.update({ data: { status: 'done', mergeClaimedAt: null, lastRejectionReason:
   null } })` + emit `task.done` `{ branch }`.
7. **Failure:** emit `task.merge_failed` `{ reason }`; if a PRIOR `task.merge_failed` event
   already exists for this task (existence query by taskId + type), escalate (spec §4 step 4):
   conditioned workspace halt (`updateMany({ where: { id: workspaceId, haltedReason: null },
   data: { haltedReason: `repeated merge failure on task ${taskKey}`, haltedAt: new Date() } })`)
   + emit `guardrail.tripped` `{ guardrail: 'merge_failure', detail: `task ${taskKey} failed to
   merge twice: ${reason}` }`. Either way return the task to rework through `rejectTask(taskId,
   reason)` (Task 6's export — attempt counted, the same feedback channel as review rejection),
   then clear the claim
   (`prisma.task.update({ data: { mergeClaimedAt: null } })` — `rejectTask` does not know the
   column).

In `tick.ts`, after the review pass: `await runMergePass(deps.workspaceId)`.

**Crash recovery** in `reconcileOrphans` (`sweep.ts:103-177`), after the run-orphan loop — the
M5 resume-claim orphan pattern applied to tasks (no attempt increment: a dead daemon is not the
agent failing):

```ts
const interrupted = await db.task.findMany({
  where: { workspaceId, status: 'merging', mergeClaimedAt: { not: null } },
})
for (const task of interrupted) {
  await db.task.update({
    where: { id: task.id },
    data: { status: 'rework', mergeClaimedAt: null, lastRejectionReason: 'merge interrupted' },
  })
  await appendEvent({
    type: 'task.merge_failed',
    workspaceId,
    taskId: task.id,
    actor: 'system',
    payload: { reason: 'merge interrupted' },
  })
}
```

- [ ] **Step 1: Failing tests** (`merge.test.ts`, real repos via `makeRepo()`; build each
  scenario by hand: `provisionWorktree` for the task branch, a commit in the worktree, a
  succeeded implementation `AgentRun` row with `worktreePath`, the task in `merging` with
  `branch` set, and a `task.review_approved` event appended per task):
  (a) **green merge, `autoMerge: true`:** task → `done`, `git log --merges` on `main` in
  `repoPath` contains `merge(T-…)`, the merged file exists on `main`;
  (b) **`autoMerge: false`:** task → `done`, NO merge commit on `main`, branch still exists;
  (c) **rebase conflict** (commit conflicting changes to `main` first): task → `rework`,
  `lastRejectionReason` mentions the conflict, one `task.merge_failed` event, claim cleared,
  `main` unmoved;
  (d) **post-rebase red verify** (`verifyCommands: ['false']`): same rework shape with the
  verify detail;
  (e) **second failure escalates:** run (c) twice → workspace `haltedReason` set,
  a `merge_failure` `guardrail.tripped` exists;
  (f) **FIFO:** two merging tasks, approvals appended in a known order → the pass (run twice)
  merges them in approval order (assert merge-commit order on `main`);
  (g) **claim idempotence:** two concurrent `runMergePass` calls (`Promise.all`) merge exactly
  once (one merge commit).
  Sweep: a `merging` task with `mergeClaimedAt` set → after `reconcileOrphans` it is `rework`
  with `lastRejectionReason: 'merge interrupted'` and a `task.merge_failed` event; a `merging`
  task with a NULL claim is untouched.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `merge.ts`, the tick call, the reconcile extension.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator): the serialized merge pass with re-verify, escalation and crash recovery"
```

---

### Task 8: Flip the pipeline live — verify green enters review; seed the reviewer

**Files:**
- Modify: `apps/orchestrator/src/verify.ts:243-264` (the green branch),
  `packages/db/src/seed.ts` (Riley), `scripts/demo-live.mjs` (a reviewer agent),
  every existing test that asserted verify-green → `done`
- Test: extend `apps/orchestrator/test/integration/verify.test.ts`,
  `apps/orchestrator/test/integration/tick.test.ts`,
  `apps/orchestrator/test/integration/milestone-gate.test.ts`,
  `packages/db/test/integration/seed.test.ts`

**Interfaces:**
- Consumes: everything above. This is the task after which production reaches the review and
  merge passes.
- Produces: the M8a pipeline `verifying → reviewing → merging → done`.

The green branch of `advance` (`verify.ts:243-264`) becomes — `task.done` moves to the merge
pass (Task 8 already emits it); the branch record and the reason clear stay:

```ts
if (input.result.kind === 'passed') {
  await prisma.task.update({
    where: { id: task.id },
    data: { status: 'reviewing', branch: input.branch, activeRunId: null, lastRejectionReason: null },
  })
  await appendEvent({
    type: 'task.verify_passed',
    workspaceId,
    taskId: task.id,
    actor: 'system',
    payload: { branch: input.branch },
  })
  return
}
```

`ADVANCEABLE` (`verify.ts:57`) stays `['running', 'verifying']` — review conclusion has its own
path (Task 7).

Seed: `AGENTS` in `packages/db/src/seed.ts` gains
`{ name: 'Riley', role: 'reviewer', team: 'Engineering' }` (lowercase `reviewer` — Task 5
matches it exactly). `scripts/demo-live.mjs` gains a reviewer agent beside its worker, same
lowercase role. Update `seed.test.ts`'s agent-count assertion (8 → 9).

Test updates — every assertion that verify green lands in `done` moves to `reviewing`:
- `verify.test.ts`: the "passed advances the task" case asserts `reviewing`, `task.verify_passed`
  present, `task.done` ABSENT.
- `tick.test.ts`: flows that ran fixture `complete` to completion now end at `reviewing` (no
  reviewer agent seeded there) — assert that, and that the `no_reviewer` guardrail fires once
  when the tick runs again.
- `milestone-gate.test.ts`: the unattended-flow gate becomes the M8a gate. Seed a worker AND a
  reviewer (`role: 'reviewer'`), `autoMerge: true`, `AITEAMOS_CLAUDE_ARGS: `${FAKE} --fixture
  m8a-flow``; drive the daemon (or repeated ticks + `drainPumps`) until the task is `done`;
  assert the event order `task.started → task.verifying → task.verify_passed →
  task.review_started → task.review_approved → task.done` via `expectOrdered`, and that
  `git log --merges` on `main` contains `merge(T-…)`. Add a sibling `autoMerge: false` case:
  ends `done`, no merge commit, branch preserved.
- [ ] **Step 1: Write the failing tests** (the updated assertions above — they fail while
  verify still writes `done`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the green-branch flip + seeds.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(orchestrator,db): verify green enters review; the pipeline runs to a merged branch unattended"
```

---

### Task 9: Guardrail wiring — budget-warning one-shot, breach pauses runs

**Files:**
- Modify: `packages/control/src/pause.ts` (`requestPause` gains a pause category; a
  `pauseActiveRuns` fan-out), `packages/control/src/index.ts` (no change — `pause.js` already
  re-exported), `apps/orchestrator/src/tick.ts` (the halt branch + the warning one-shot)
- Test: extend `packages/control/test/integration/` pause coverage (follow the existing pause
  test file's seeding), extend `apps/orchestrator/test/integration/tick.test.ts`

**Interfaces:**
- Produces (Task 10 reuses both):

```ts
export type PauseCategory = 'human' | 'guardrail' | 'emergency_stop'

export async function requestPause(
  runId: string,
  requestedBy: string,
  category: PauseCategory = 'human',
): Promise<Result<void, ControlRefusal>>

export interface PauseFanoutReport {
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

/** Request pause on every active run in the workspace; refusals are expected noise (spec §6). */
export async function pauseActiveRuns(
  workspaceId: string,
  requestedBy: string,
  category: PauseCategory,
): Promise<PauseFanoutReport>
```

`requestPause` writes `pauseReason: category` in its existing claim (the only change to its
body). `pauseActiveRuns` finds runs
`{ status: { in: [...NON_TERMINAL_RUN_STATUSES] }, task: { workspaceId } }`, calls
`requestPause(run.id, requestedBy, category)` on each, and buckets ids by `result.ok` —
`wrong_status`/`run_not_found` land in `refused`, never throw.

In `tick.ts`'s halt branch, inside the existing one-shot (`haltAnnounced` transition — so the
fan-out fires once per breach, not per second):

```ts
if (haltAnnounced.get(deps.workspaceId) !== true) {
  haltAnnounced.set(deps.workspaceId, true)
  await appendEvent({ …existing guardrail.tripped… })
  if (halt.reason === 'budget_exhausted') {
    await pauseActiveRuns(deps.workspaceId, 'budget guardrail', 'guardrail')
  }
}
```

The warning one-shot, after the halt branch (mutually exclusive with `budget_exhausted` by the
domain's `else if`):

```ts
const warning = evaluateGuardrails(world.limits, world.stats).find(
  (breach) => breach.guardrail === 'budget_warning',
)
if (warning !== undefined) {
  const announced = await prisma.executionEvent.findFirst({
    where: {
      workspaceId: deps.workspaceId,
      type: 'guardrail_tripped',
      payload: { path: ['guardrail'], equals: 'budget_warning' },
    },
    select: { seq: true },
  })
  if (announced === null) {
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: deps.workspaceId,
      actor: 'system',
      payload: { guardrail: 'budget_warning', detail: warning.detail },
    })
  }
}
```

(The durable existence query, not the in-memory latch — spec §5 wants the one-shot to survive a
daemon restart. `evaluateGuardrails` is pure and cheap; calling it again in the tick is fine.)

- [ ] **Step 1: Failing tests.** Control: `requestPause(id, 'x', 'emergency_stop')` leaves
  `pauseReason: 'emergency_stop'` on the row; the default stays `'human'`; `pauseActiveRuns`
  over one pausable and one already-`paused` run reports one requested + one refused and throws
  nothing. Tick: with `spentUsd` seeded past `budgetUsd` (`AgentRun.costUsd` rows) and one
  active run, ONE tick leaves that run `pause_requested` with `pauseReason: 'guardrail'` and a
  second tick does not re-emit `guardrail.tripped` (the existing one-shot). Warning: with
  `costUsd` at 85% of budget, two ticks yield exactly ONE `budget_warning` event; restart
  semantics — `resetTickObservation()` + a fresh tick still yields no second event (the DB
  existence query, not the map).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(control,orchestrator): budget warning one-shot and breach-pauses-runs"
```

---

### Task 10: `emergencyStop` in control + the CLI command

**Files:**
- Create: `packages/control/src/emergency.ts`
- Modify: `packages/control/src/refusal.ts` (one union member + text case),
  `packages/control/src/index.ts` (`export * from './emergency.js'`),
  `apps/orchestrator/src/cli.ts` (the command + `USAGE`)
- Test: `packages/control/test/integration/emergency.test.ts`, extend
  `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
- Consumes: Task 9's `pauseActiveRuns`.
- Produces (Task 11's route calls this):

```ts
export interface EmergencyStopReport {
  readonly engaged: boolean            // false when the workspace was already halted
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

export async function emergencyStop(
  workspaceId: string,
  requestedBy: string,
): Promise<Result<EmergencyStopReport, ControlRefusal>>
```

`ControlRefusal` gains `{ readonly kind: 'workspace_not_found'; readonly workspaceId: string }`
with `refusalText` case `` `no workspace with id ${refusal.workspaceId}` `` (the exhaustive
switch forces the case).

Body (spec §6 verbatim):

1. `findUnique` the workspace; null → `err({ kind: 'workspace_not_found', workspaceId })`.
2. Halt, first-writer-wins (`pump.ts:434` precedent):
   `updateMany({ where: { id: workspaceId, haltedReason: null }, data: { haltedReason:
   `emergency stop by ${requestedBy}`, haltedAt: new Date() } })` → `engaged = count === 1`.
   Scheduling stops with zero further work — `world.ts:292` derives `emergencyStopped` from
   this column.
3. Only when `engaged`: emit `guardrail.tripped` `{ guardrail: 'emergency_stop', detail:
   `engaged by ${requestedBy}` }` (actor `human` — an operator did this). No new event type.
4. `const { requested, refused } = await pauseActiveRuns(workspaceId, requestedBy,
   'emergency_stop')` — partial failure tolerated, the halt stands regardless.
5. `return ok({ engaged, requested, refused })`.

An already-halted workspace is NOT a refusal: the operator smashing STOP twice deserves the
pause fan-out again, not an error.

CLI (`clear-halt`'s mandatory-`--workspace` idiom):

```ts
case 'emergency-stop': {
  const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
  const result = await emergencyStop(workspaceId, flags['by'] ?? 'operator')
  if (!result.ok) throw new Error(refusalText(result.error))
  const { engaged, requested, refused } = result.value
  process.stdout.write(
    `${engaged ? 'emergency stop engaged' : 'workspace was already halted'} on ${workspaceId}: ` +
      `pause requested on ${requested.length} run(s), ${refused.length} already concluding. ` +
      `Retract with: clear-halt --workspace ${workspaceId}\n`,
  )
  return 0
}
```

`USAGE` gains `  emergency-stop --workspace <id> [--by <name>]` with a line noting it halts
scheduling AND pauses every active run — WITHOUT touching the existing clear-halt help sentences
(`cli.test.ts` asserts their substrings).

- [ ] **Step 1: Failing tests.** Control: (a) e-stop on a workspace with one working run →
  `haltedReason` = `emergency stop by riley`, run `pause_requested` with
  `pauseReason: 'emergency_stop'`, one `emergency_stop` `guardrail.tripped`, report
  `engaged: true`; (b) e-stop again → `engaged: false`, no second guardrail event, original
  reason stands; (c) unknown workspace → `workspace_not_found` refusal; (d) a run already
  `paused` lands in `refused` and the call still succeeds. CLI: `emergency-stop --workspace
  <id>` exits 0 and the workspace row is halted; missing `--workspace` exits 1 with
  `--workspace is required`; the USAGE test still passes.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(control,orchestrator): the emergencyStop operation and CLI command"
```

---

### Task 11: The emergency-stop web route

**Files:**
- Create: `apps/web/src/server/workspaceControlRoute.ts`,
  `apps/web/src/app/api/w/[workspaceId]/emergency-stop/route.ts`
- Test: `apps/web/test/integration/control-routes.test.ts` (a new describe)

**Interfaces:**
- Consumes: Task 10's `emergencyStop`.
- Produces: `POST /api/w/[workspaceId]/emergency-stop` → 200 `{ ok: true }` / 404 / 409 (the
  house contract); the shell Task 12's button posts against.

```ts
// apps/web/src/server/workspaceControlRoute.ts
import { prisma } from '@ai-team-os/db/client'
import { refusalText, type ControlRefusal } from '@ai-team-os/control'
import type { Result } from '@ai-team-os/domain'

/** Route shell: 404 unless the workspace exists, 409 on a control refusal (the M5 contract). */
export async function workspaceControlResponse(
  workspaceId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) {
    return Response.json({ error: 'no such workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
```

(`Result<unknown, …>` — the success payload is deliberately dropped: the event-driven refetch
owns truth, per the no-optimistic-UI rule.)

```ts
// apps/web/src/app/api/w/[workspaceId]/emergency-stop/route.ts
import { emergencyStop } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  return workspaceControlResponse(workspaceId, () => emergencyStop(workspaceId, 'web operator'))
}
```

- [ ] **Step 1: Failing tests** (the `control-routes.test.ts` harness — direct handler import,
  `params: Promise.resolve(...)`, the shared TRUNCATE): (a) 200 on a live workspace with a
  working run; the workspace row is halted and the run is `pause_requested` afterwards; (b) 404
  JSON `{ error }` on an unknown workspace id; (c) posting twice still returns 200 (already
  halted is not an error).
- [ ] **Step 2: Run to verify failure** — module not found.
- [ ] **Step 3: Implement** shell + route.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): the workspace control shell and emergency-stop route"
```

---

### Task 12: The STOP button, the everywhere-banner, and the active-count fix

**Files:**
- Create: `apps/web/src/components/EmergencyStopButton.tsx`
- Modify: `apps/web/src/components/TopBar.tsx` (two new props, render the button),
  `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/components/TasksClient.tsx`,
  `apps/web/src/components/activity/ActivityClient.tsx`,
  `apps/web/src/components/graph/GraphClient.tsx` (pass the props; TasksClient and
  ActivityClient also render `HaltBanner`),
  `apps/web/src/server/overview.ts` (`ACTIVE_TASK_STATUSES` gains `'reviewing'`, `'merging'`)
- Test: `apps/web/test/emergency-stop.test.tsx`, extend `apps/web/test/shell.test.tsx` and
  `apps/web/test/integration/overview.test.ts`

**Interfaces:**
- Consumes: Task 11's route.
- Produces:

```ts
export interface TopBarProps {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly connection: 'connected' | 'reconnecting'
  readonly budget: { readonly spentUsd: number; readonly budgetUsd: number } | null
  readonly halted: boolean
}
```

TopBar stays presentational; the interactivity lives in the child:

```tsx
// EmergencyStopButton.tsx
'use client'
export function EmergencyStopButton({
  workspaceId,
  halted,
}: {
  readonly workspaceId: string
  readonly halted: boolean
}): React.JSX.Element
```

Behaviour (house patterns only — no dialog dependency; the NodeMenu confirm idiom):
- Idle: a red button `data-testid="emergency-stop"`, house button classes with the danger triple
  (`rounded border border-status-danger/40 bg-status-danger/10 px-2 py-1 text-xs
  text-status-danger`), label `STOP`. Disabled with `title="workspace is already halted"` when
  `halted`.
- Click → confirm state: the button is replaced inline by
  `<span role="alertdialog" aria-label="confirm emergency stop">` containing
  `data-testid="emergency-stop-confirm"` (`stop everything`, focused on entry via a ref) and
  `data-testid="emergency-stop-cancel"` (`cancel`). Escape cancels and refocuses the trigger
  (the NodeMenu effect verbatim).
- Confirm → POST `/api/w/${workspaceId}/emergency-stop` with the house `postControl` idiom
  (copy the `errorMessage` helper from `AgentPanel.tsx`); while in flight the confirm button is
  disabled; non-OK → the error text in a `role="alert"` span beside the button; success → back
  to idle. NO optimistic halted state — the snapshot refetch flips `halted` and the banner
  (the standing no-optimistic-UI rule).

TopBar layout: move `ml-auto` to a right-side group wrapping budget + button:

```tsx
<span className="ml-auto flex items-center gap-3">
  {budget !== null && (/* existing budget span, ml-auto removed */)}
  <EmergencyStopButton workspaceId={workspaceId} halted={halted} />
</span>
```

Call sites pass `workspaceId` (each client shell already holds it) and
`halted={view.workspace.haltedReason !== null}` (ActivityClient: from `initial.workspace`).
TasksClient and ActivityClient additionally render
`{…haltedReason !== null && <HaltBanner reason={…} />}` above their content — the
OverviewClient/GraphClient line verbatim — so the banner shows on every page (spec §6).

`overview.ts:58`: `ACTIVE_TASK_STATUSES` becomes
`['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework'] as const` — a task under
review or in the merge queue is active work, not a vanished one.

- [ ] **Step 1: Failing tests.** `emergency-stop.test.tsx` (jsdom pragma, fetch stub per
  `agent-panel.test.tsx`): (a) STOP renders enabled when not halted, disabled when halted;
  (b) click shows confirm + cancel and NO fetch has fired; (c) cancel returns to idle, no
  fetch; (d) confirm POSTs `/api/w/w1/emergency-stop` and returns to idle on 200; (e) a 409
  `{ error: 'no workspace…' }` renders in the `role="alert"` span; (f) Escape in confirm state
  returns focus to the STOP button. `shell.test.tsx`: TopBar with `halted: false` renders the
  button; the TasksClient/ActivityClient banner presence (render each with a halted snapshot
  fixture, assert `role="alert"` with the reason). `overview.test.ts`: a task in `reviewing`
  and one in `merging` count into `tasks.active`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full gate** — `npm run web:build` is the bundler-only-breakage catcher here.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): the emergency STOP button, halt banner on every page, active-count fix"
```

---

### Task 13: The measured gate — two scripts and the docs

**Files:**
- Create: `scripts/gate-m8a-merge.mjs`, `scripts/gate-m8a-estop.mjs`
- Modify: `package.json` (two script entries), `README.md` (the gate table row + the two
  commands and the new CLI verb)
- Test: the scripts ARE the test (each exits 0 on PASS, 1 on FAIL); run both against the dev DB

**Interfaces:**
- Consumes: everything. Both scripts follow `scripts/measure-graph-status-latency.mjs`'s
  skeleton verbatim: dist imports (`../packages/db/dist/client.js`), everything created inside
  `try`, `finally` cleans up (events deleted before the workspace — no FK), `PASS:`/`FAIL:`
  line, `exitCode` initialized to 1, `process.exit(exitCode)`; typechecked by
  `tsconfig.tools.json` via `npm run typecheck`.

`package.json`:

```json
"gate:m8a-merge": "tsc --build && node --env-file=.env scripts/gate-m8a-merge.mjs",
"gate:m8a-estop": "tsc --build && node --env-file=.env scripts/gate-m8a-estop.mjs",
```

**`gate-m8a-merge.mjs`** — spec §8's measured half, *a task → merged branch, unattended*:
1. `makeRepo()`; create a workspace (`autoMerge: true`, `verifyCommands: ['true']`,
   `setupCommands: []`), one team, one worker (`role: 'backend'`), one reviewer
   (`role: 'reviewer'`), ONE task (`status: 'ready'`, `requiredRole: 'backend'`).
2. Spawn the daemon: `spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', id, '--period',
   '500'], { env: { ...process.env, AITEAMOS_CLAUDE_BIN: 'node', AITEAMOS_CLAUDE_ARGS:
   `${FAKE_CLAUDE} --fixture m8a-flow` } })`.
3. Poll (15 ms interval, 120 s timeout) with ZERO writes until the task row is `done`.
4. Assert the merge commit:
   `execFileSync('git', ['log', '--merges', '--format=%s', 'main'], { cwd: repoPath })` output
   contains `merge(T-${task.id.slice(0, 8)})`. Also assert the event log contains
   `task.review_approved` (the review actually gated it).
5. PASS/FAIL; `finally` kills the daemon, deletes events then workspace, `rmSync` the repo.

**`gate-m8a-estop.mjs`** — spec §8's second script:
1. Same seeding, worker only, fixture `hook-deny` with `FAKE_CLAUDE_LINE_DELAY_MS: '150'` in
   the env (a slow run that WILL emit a deniable hook event) and `verifyCommands: ['true']`.
2. Spawn the daemon; poll until one `AgentRun` is non-terminal (`working`/`starting`).
3. `execFileSync('node', [ORCHESTRATOR_CLI, 'emergency-stop', '--workspace', id, '--by',
   'gate-script'])` — engage mid-run.
4. Bounded window (15 s): every run for the workspace reaches `paused` (or a terminal status —
   concluding runs are tolerated noise, but at least one must be `paused` with
   `pauseReason: 'emergency_stop'`) AND `workspace.haltedReason` starts with
   `'emergency stop by'`. Assert no NEW run starts while halted (run count stable across 3 s).
5. `execFileSync('node', [ORCHESTRATOR_CLI, 'clear-halt', '--workspace', id])`, then
   `execFileSync('node', [ORCHESTRATOR_CLI, 'resume', '--run', pausedRunId])`; bounded window:
   the run leaves `paused` (resuming/working or terminal) — work resumes.
6. PASS/FAIL; same cleanup shape.

README: add both commands beside the M6/M7 measure scripts, the `emergency-stop` CLI verb in
the CLI section, and the M8a row in the gate table ("a task → merged branch, unattended;
emergency stop pauses everything and clears clean").

- [ ] **Step 1: Write `gate-m8a-merge.mjs`** (there is no failing-test phase for gate scripts —
  the script is the assertion; write it complete).
- [ ] **Step 2: Run it** — `npm run gate:m8a-merge` — expect `PASS: task reached done and
  merge(T-…) is on main` (fix forward on FAIL; the daemon's stderr is in the script's pipe).
- [ ] **Step 3: Write `gate-m8a-estop.mjs`.**
- [ ] **Step 4: Run it** — `npm run gate:m8a-estop` — expect `PASS: emergency stop paused the
  fleet and clear-halt + resume recovered it`.
- [ ] **Step 5: README + package.json edits, then the full gate** — `npm test && npm run
  typecheck && npm run web:build`.
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs(m8a): the two measured gate scripts and README coverage"
```

---

## After the plan: the by-eyes half

Spec §8's second half is manual (the M3–M7 tradition), run at milestone-gate time, not a plan
task: `npm run demo` with the real CLI, watch one task flow
work → verify → reviewing → merging → done on the board and graph, read the QA reason in the
activity feed, press STOP mid-run, watch the checkpoint-pause and the banner on every page,
`clear-halt` + resume, watch it finish. Findings become gate-fix tasks.
