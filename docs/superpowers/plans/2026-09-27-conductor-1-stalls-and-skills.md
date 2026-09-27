# Conductor, Plan 1 of 5: a stalled run ends, and skills and workflow are in the prompt

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec R0 (a live-but-silent run is ended and retried) and R6 (every implementation run's prompt carries the full text of its skills and its persona's workflow as a checklist).

**Architecture:** R0 is two sweep changes: observed working time counts a normal inter-pass gap in full (not one 60 s beat), and a new `run_stalled` guardrail ends a `working` run whose stream has been silent for `RUN_STALL_MS` with no tool call open; the pump persists `lastOutputAt` (throttled) and `toolCallOpenSince` so the sweep can see both. R6 changes `buildRunContext`: effective skills are ordered persona-first, each skill's `SKILL.md` body is read from its source directory and inlined under caps, the manifest records what was inlined/truncated/omitted, and a new `workflow` section renders the persona's workflow steps as a numbered checklist.

**Tech Stack:** TypeScript monorepo (npm workspaces), Prisma/Postgres, vitest (unit + integration projects), zod.

**Spec:** `docs/superpowers/specs/2026-09-27-conductor-supervisor-design.md` (R0, R6). The rest of the spec is Plans 2–5.

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (gate `node scripts/gate-m26-vocabulary.mjs` must pass).
- Never run prettier (no prettier config in the repo). Match surrounding code: thorough WHY doc comments, `readonly`, explicit return types.
- Tests: ONE vitest process at a time (shared test DB). Targeted runs while iterating (`npx vitest run <file>`); at the end `npm run typecheck && npx vitest run` once (~5 min).
- Never touch the dev DB (`DATABASE_URL`); tests use `TEST_DATABASE_URL`. Never `db:seed`.
- Migrations are hand-written SQL in `packages/db/prisma/migrations/<timestamp>_<name>/migration.sql`, purely additive, with a WHY header like `20260925130000_observed_working_ms`; then `npm run db:generate` and `npm run db:migrate:test`.
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec R6 caps, verbatim: "per-skill cap 8,000 characters, total cap 24,000, skills ordered persona-default first, then grants; a skill cut by a cap says so and keeps the copied files for the rest."

## Review Focus

- A long tick (e.g. a 4-minute merge verify) must not make a running worker's clock fall behind; a host sleep must still add at most one beat.
- A worker running a long shell command (tool call open, no stream lines) must NOT be ended as stalled.
- A resumed run starts with no open tool call and a fresh output time; a stale `toolCallOpenSince` from before the pause must not shield a stall forever.
- A skill whose `SKILL.md` has no front matter, is empty, or is missing must not break the dispatch (inline what exists, record the rest).
- Cursor runs (no skills mechanism) must keep today's "This runtime has no skills mechanism" text and never inline bodies.

---

### Task 1: Observed working time counts a normal gap in full

**Files:**
- Modify: `apps/orchestrator/src/sweep.ts` (the accrual block, ~lines 675-686; `clockJumped` is computed at ~583)
- Test: `apps/orchestrator/test/integration/run-owners.test.ts` (describe `'the run timeout measures observed working time (F11b)'`, ~line 438)

**Interfaces:**
- Consumes: `CLOCK_JUMP_MS`, `BREAKER_BEAT_MS`, `noteSweepAt` (existing).
- Produces: nothing new; `observedWorkingMs` semantics change: a gap of up to `CLOCK_JUMP_MS` since the run was last observed counts in full unless this pass is a clock jump.

- [ ] **Step 1: Write the failing test** (inside the F11b describe, after `'adds at most one beat…'`)

```ts
    it('counts a long pass in full: a four-minute tick does not steal three minutes from the run', async (): Promise<void> => {
      // Large-1 multi rep 2 (2026-09-27): the sweep runs after each tick, a tick that spends minutes
      // in a merge's verify leaves a gap that is NOT a sleep, and crediting it one beat let a silent
      // run outlive its thirty-minute limit by eleven minutes.
      const { runId } = await taskHeldBy(fixture, {
        pid: process.pid,
        startedAt: minutesAgo(10),
        observedWorkingMs: 0,
        observedAt: minutesAgo(4),
      })
      noteSweepAt(fixture.deps.workspaceId, Date.now() - 4 * 60_000)

      await sweep(fixture.deps)

      const observed = (await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).observedWorkingMs
      expect(observed).toBeGreaterThanOrEqual(4 * 60_000 - 1_000)
      expect(observed).toBeLessThanOrEqual(4 * 60_000 + 2_000)
    })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/orchestrator/test/integration/run-owners.test.ts -t "counts a long pass in full"`
Expected: FAIL — `observed` is `60000` (one beat).

- [ ] **Step 3: Implement** — replace the `step` line in the accrual block:

```ts
    // A normal pass credits the whole gap since this run was last observed: the sweep runs after
    // each tick, and a tick that spends minutes in a merge's verify is not a sleep. Only a pass that
    // IS a clock jump (the host slept) caps the gap at one beat -- the 2026-09-22 rule, unchanged.
    const gapCap = clockJumped ? BREAKER_BEAT_MS : CLOCK_JUMP_MS
    const step = Math.min(Math.max(0, now - observedFrom), gapCap)
```

- [ ] **Step 4: Run the whole F11b describe and the sweep suite**

Run: `npx vitest run apps/orchestrator/test/integration/run-owners.test.ts apps/orchestrator/test/integration/sweep.test.ts`
Expected: PASS (the existing "adds at most one beat" test places the previous pass `CLOCK_JUMP_MS + 60s` ago, so it is a clock jump and still gets one beat; "never counts time paused" is capped by wall working time).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/sweep.ts apps/orchestrator/test/integration/run-owners.test.ts
git commit -m "fix(sweep): a long pass credits a run its whole gap, only a clock jump caps it at one beat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The pump records when the stream last spoke and whether a tool call is open

**Files:**
- Create: `packages/db/prisma/migrations/20260927120000_run_output_liveness/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`model SlaveRun`, beside `observedAt`)
- Modify: `apps/orchestrator/src/pump.ts` (the `for await (const event of input.events)` loop, ~line 723; cases `session_started`, `tool_call`, `tool_result`)
- Modify: `packages/domain/src/breaker/constants.ts` (new constants)
- Test: `apps/orchestrator/test/integration/pump.test.ts` (existing file; add a describe)

**Interfaces:**
- Produces: `SlaveRun.lastOutputAt DateTime?`, `SlaveRun.toolCallOpenSince DateTime?`; constants `OUTPUT_BEAT_MS = 30_000`, `RUN_STALL_MS = 15 * 60_000` exported from `@slave-of-ai/domain` (breaker constants).

- [ ] **Step 1: Migration and schema**

`migration.sql`:
```sql
-- Conductor Plan 1 (spec R0), 2026-09-27: a live-but-silent run is visible to the sweep.
--
-- Large-1 multi rep 2: a worker's stream stopped mid-answer and nothing ended the run for 32
-- minutes. The pump now records when the stream last produced an event (`lastOutputAt`, written at
-- most every OUTPUT_BEAT_MS) and since when a tool call has been open (`toolCallOpenSince`, null
-- when none is), so the sweep can tell a stalled stream from a long shell command. PURELY ADDITIVE:
-- both null on every existing row, which the sweep reads as "measure from startedAt".
ALTER TABLE "SlaveRun" ADD COLUMN "lastOutputAt" TIMESTAMP(3);
ALTER TABLE "SlaveRun" ADD COLUMN "toolCallOpenSince" TIMESTAMP(3);
```
`schema.prisma`, in `model SlaveRun` after `observedAt`:
```prisma
  /// Conductor R0: when the pump last saw an event on this run's stream, written at most every
  /// OUTPUT_BEAT_MS. Null until the first event. Read by the sweep's `run_stalled` guardrail.
  lastOutputAt      DateTime?
  /// Conductor R0: since when at least one tool call of this run has had no result; null when none
  /// is open. A worker running a long command is silent on the stream and must not read as stalled.
  toolCallOpenSince DateTime?
```
Run: `npm run db:generate && npm run db:migrate:test`

- [ ] **Step 2: Constants** — append to `packages/domain/src/breaker/constants.ts` (and export from the package index if constants there are re-exported one by one; check `packages/domain/src/breaker/index.ts`):

```ts
/**
 * Conductor R0: the most often the pump writes `SlaveRun.lastOutputAt`. A stream can produce
 * hundreds of events a minute; the sweep only needs to know the stream is alive to this precision.
 */
export const OUTPUT_BEAT_MS = 30_000

/**
 * Conductor R0: a `working` run whose stream has produced nothing for this long, with no tool call
 * open, is stalled and is ended (`run_stalled`) so the ordinary retry path takes over. Fifteen
 * minutes: a model streams thinking and text continuously, so this much silence with nothing
 * running is a dead connection, not a slow answer (large-1 multi rep 2 sat silent for 32 minutes).
 */
export const RUN_STALL_MS = 15 * 60_000
```

- [ ] **Step 3: Write the failing test** in `apps/orchestrator/test/integration/pump.test.ts` (use the file's existing fixture/helpers that feed a synthetic `events` iterable into `pumpRun`; model the new test on the file's `tool_call` counting test):

```ts
  describe('liveness columns (conductor R0)', () => {
    it('writes lastOutputAt on the first event and opens then closes toolCallOpenSince', async (): Promise<void> => {
      const run = await startingRun(fixture)
      const events = queueOf([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Bash', summary: 'Bash npm test', argsHash: 'h' },
      ])
      const pumping = pumpRun(inputFor(fixture, run, events))
      await events.drained()
      const open = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
      expect(open.lastOutputAt).not.toBeNull()
      expect(open.toolCallOpenSince).not.toBeNull()

      events.push({ kind: 'tool_result', toolUseId: 't1', toolName: '', outcome: 'ok', errorClass: null })
      events.end()
      await pumping
      const closed = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
      expect(closed.toolCallOpenSince).toBeNull()
    })

    it('a resumed pump clears a toolCallOpenSince left from before the pause', async (): Promise<void> => {
      const run = await startingRun(fixture, { status: 'resuming', toolCallOpenSince: new Date(Date.now() - 60 * 60_000) })
      const events = queueOf([{ kind: 'session_started', sessionId: 's1' }])
      events.end()
      await pumpRun({ ...inputFor(fixture, run, events), resumed: true })
      const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
      expect(row.toolCallOpenSince).toBeNull()
    })
  })
```
If `pump.test.ts` has no `queueOf`/`startingRun`/`inputFor`-style helpers, add minimal local ones in the describe built from the file's existing setup (the file already constructs `PumpRunInput` objects; reuse that construction verbatim).

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts -t "liveness columns"`
Expected: FAIL — columns stay null.

- [ ] **Step 5: Implement in `pump.ts`** — before the loop, beside the other locals:

```ts
  /** Conductor R0: tool calls with no result yet, so the sweep can tell a long command from a stall. */
  const openToolUses = new Set<string>()
  let lastOutputWrite = 0
```
At the top of the loop body, before `switch`:
```ts
    // Conductor R0: the stream is alive. Throttled -- the sweep needs minutes of precision, not a
    // write per line.
    if (Date.now() - lastOutputWrite >= OUTPUT_BEAT_MS) {
      lastOutputWrite = Date.now()
      await prisma.slaveRun.updateMany({ where: { id: runId, endedAt: null }, data: { lastOutputAt: new Date(lastOutputWrite) } })
    }
```
In `case 'session_started'`, after the existing writes:
```ts
        // A resumed session starts with nothing open: a call left open when the run paused died
        // with its process, and its stale timestamp would shield a later stall forever.
        await prisma.slaveRun.updateMany({ where: { id: runId, endedAt: null }, data: { toolCallOpenSince: null } })
        openToolUses.clear()
```
In `case 'tool_call'`, after `toolNames.set(...)`:
```ts
        openToolUses.add(event.toolUseId)
        if (openToolUses.size === 1) {
          await prisma.slaveRun.updateMany({ where: { id: runId, endedAt: null }, data: { toolCallOpenSince: new Date() } })
        }
```
In `case 'tool_result'`, after the `emit`:
```ts
        if (openToolUses.delete(event.toolUseId) && openToolUses.size === 0) {
          await prisma.slaveRun.updateMany({ where: { id: runId, endedAt: null }, data: { toolCallOpenSince: null } })
        }
```
Import `OUTPUT_BEAT_MS` from `@slave-of-ai/domain`.

- [ ] **Step 6: Run the pump tests**

Run: `npx tsc --build && npx vitest run apps/orchestrator/test/integration/pump.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/prisma packages/domain/src/breaker apps/orchestrator/src/pump.ts apps/orchestrator/test/integration/pump.test.ts
git commit -m "feat(pump): record when a run's stream last spoke and whether a tool call is open

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The sweep ends a stalled run (`run_stalled`)

**Files:**
- Modify: `packages/domain/src/guardrails/kinds.ts` (`GUARDRAIL_KINDS`, `GUARDRAIL_LABEL`)
- Modify: `packages/domain/test/guardrails/kinds.test.ts` (the count assertion)
- Modify: `apps/orchestrator/src/sweep.ts` (the per-run arm after the accrual; the claim/cancel/event block ~746-799; the `SweepReport` type and its return)
- Test: `apps/orchestrator/test/integration/sweep.test.ts` (extend `givenRun`, add tests next to `'cancels a run past its wall-clock timeout'`)

**Interfaces:**
- Consumes: `RUN_STALL_MS` (Task 2), `lastOutputAt`, `toolCallOpenSince` (Task 2).
- Produces: `GuardrailKind` gains `'run_stalled'`; `SweepReport.stalled: readonly RunId[]`.

- [ ] **Step 1: Write the failing tests** — extend `givenRun`'s parameter with `lastOutputAt?: Date; toolCallOpenSince?: Date` and spread them into `data` like `pausedAt`; then:

```ts
  describe('a stalled stream (conductor R0)', () => {
    it('ends a working run whose stream has been silent past RUN_STALL_MS with no tool call open', async (): Promise<void> => {
      const run = await givenRun({ status: 'working', pid: process.pid, startedAt: minutesAgo(20), lastOutputAt: minutesAgo(16) })

      const report = await sweep(deps)

      expect(report.stalled).toEqual([run.id])
      expect(report.timedOut).toEqual([])
      expect(cancelled).toEqual([run.id])
      const tripped = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'guardrail_tripped' } })
      expect((tripped.payload as { guardrail: string }).guardrail).toBe('run_stalled')
    })

    it('leaves a silent run alone while a tool call is open: a long command is not a stall', async (): Promise<void> => {
      await givenRun({ status: 'working', pid: process.pid, startedAt: minutesAgo(20), lastOutputAt: minutesAgo(16), toolCallOpenSince: minutesAgo(16) })
      const report = await sweep(deps)
      expect(report.stalled).toEqual([])
      expect(cancelled).toEqual([])
    })

    it('leaves a run that spoke recently alone, and measures a run that never spoke from its start', async (): Promise<void> => {
      await givenRun({ status: 'working', pid: process.pid, startedAt: minutesAgo(20), lastOutputAt: minutesAgo(2) })
      const quiet = await givenRun({ status: 'working', pid: process.pid, startedAt: minutesAgo(16) })
      const report = await sweep(deps)
      expect(report.stalled).toEqual([quiet.id])
    })

    it('does not call a run stalled on the pass after a clock jump', async (): Promise<void> => {
      await givenRun({ status: 'working', pid: process.pid, startedAt: minutesAgo(20), lastOutputAt: minutesAgo(16) })
      noteSweepAt(fixture.workspaceId, Date.now() - CLOCK_JUMP_MS - 60_000)
      const report = await sweep(deps)
      expect(report.stalled).toEqual([])
    })
  })
```
(`minutesAgo` may not exist in `sweep.test.ts`; the file has `hoursAgo` — add `const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000)` beside it. Check the event type literal the file's other tests use for `guardrail.tripped` rows and match it.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/orchestrator/test/integration/sweep.test.ts -t "a stalled stream"`
Expected: FAIL — `report.stalled` is undefined.

- [ ] **Step 3: Guardrail kind** — in `kinds.ts`, add `'run_stalled'` right after `'run_timeout'` in `GUARDRAIL_KINDS`, and to `GUARDRAIL_LABEL`: `run_stalled: 'Run went silent'`. Update the count in `kinds.test.ts` by one.

- [ ] **Step 4: Sweep** — after `const timedOutNow = …` (and after `overCapNow` is computed), add:

```ts
    // Conductor R0: a WORKING run whose stream has said nothing for RUN_STALL_MS with no tool call
    // open is a dead connection, not a slow answer. Wall clock since the last output -- the stream
    // either spoke or it did not -- and never on a clock-jump pass, whose silence is the host's.
    const silentFrom = (run.lastOutputAt ?? run.startedAt).getTime()
    const stalledNow =
      !timedOutNow && !overCapNow && !clockJumped && run.status === 'working' && run.toolCallOpenSince === null && now - silentFrom > RUN_STALL_MS
```
Change the early-continue guard from `if (!timedOutNow && !overCapNow)` to `if (!timedOutNow && !overCapNow && !stalledNow)`. In the claim block, after `if (timedOutNow) timedOut.push(…)` add `if (stalledNow) stalled.push(brandRunId(run.id))`; the breaches text gets `stalledNow ? \`silent for ${Math.round((now - silentFrom) / 60_000)} min with no tool call open\` : …` in the same style as the existing ones; the event's guardrail becomes `(timedOutNow ? 'run_timeout' : overCapNow ? 'tool_call_ceiling' : 'run_stalled') satisfies GuardrailKind`. Declare `const stalled: RunId[] = []` beside `timedOut`, add `readonly stalled: readonly RunId[]` to the report type, and return it. Import `RUN_STALL_MS`.

- [ ] **Step 5: Run sweep, run-owners, platform-failures and the guardrail unit tests**

Run: `npx tsc --build && npx vitest run apps/orchestrator/test/integration/sweep.test.ts apps/orchestrator/test/integration/run-owners.test.ts apps/orchestrator/test/integration/platform-failures.test.ts packages/domain/test/guardrails/kinds.test.ts`
Expected: PASS. If a web/UI test enumerates guardrail labels, add the new label there too (`grep -rn "Run took too long" apps/web`).

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/guardrails packages/domain/test/guardrails apps/orchestrator/src/sweep.ts apps/orchestrator/test/integration/sweep.test.ts
git commit -m "feat(sweep): a run whose stream went silent with nothing running is ended (run_stalled)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Skill bodies in the prompt, persona defaults first, under caps

**Files:**
- Modify: `packages/control/src/skills.ts` (export a body reader beside `parseFrontmatter`)
- Modify: `packages/domain/src/run-context/sections.ts` (skills source: optional `inlined`, `truncated`, `omitted`)
- Create: `packages/domain/src/run-context/skillBodies.ts` (pure: order + caps) and export it from `run-context/index.ts`
- Modify: `apps/orchestrator/src/runContext.ts` (`AssignedSkill` gains `origin`; `buildRunContext` uses `effectiveSkills`; `skillsSectionText` renders bodies)
- Modify: `apps/web/src/lib/runContextSummary.ts` (mention inlined/truncated)
- Test: `packages/domain/test/run-context/skillBodies.test.ts` (new), `apps/orchestrator/test/integration/runContext.test.ts`, `packages/domain/test/run-context/sections.test.ts`

**Interfaces:**
- Produces:
  - `readSkillBody(skillDir: string): string | null` in `@slave-of-ai/control` — the `SKILL.md` text after the front matter, trimmed; `null` when the file is missing or unreadable.
  - `SKILL_BODY_MAX_CHARS = 8_000`, `SKILL_BODIES_MAX_CHARS = 24_000`, and
    `fitSkillBodies(skills: readonly { name: string; origin: 'persona' | 'person'; body: string | null }[]): { readonly blocks: readonly { name: string; text: string; truncated: boolean }[]; readonly inlined: readonly string[]; readonly truncated: readonly string[]; readonly omitted: readonly string[] }` in `@slave-of-ai/domain`.
  - Skills manifest source gains `inlined?: string[]; truncated?: string[]; omitted?: string[]` (optional on read).

- [ ] **Step 1: Failing unit test** `packages/domain/test/run-context/skillBodies.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SKILL_BODIES_MAX_CHARS, SKILL_BODY_MAX_CHARS, fitSkillBodies } from '../../src/run-context/skillBodies.js'

describe('fitSkillBodies', () => {
  it('puts persona defaults first, then grants, each by name', () => {
    const out = fitSkillBodies([
      { name: 'zeta', origin: 'person', body: 'z' },
      { name: 'beta', origin: 'persona', body: 'b' },
      { name: 'alpha', origin: 'person', body: 'a' },
    ])
    expect(out.blocks.map((b) => b.name)).toEqual(['beta', 'alpha', 'zeta'])
    expect(out.inlined).toEqual(['beta', 'alpha', 'zeta'])
  })

  it('cuts one skill at the per-skill cap and says so', () => {
    const out = fitSkillBodies([{ name: 'long', origin: 'persona', body: 'x'.repeat(SKILL_BODY_MAX_CHARS + 500) }])
    expect(out.truncated).toEqual(['long'])
    expect(out.blocks[0]?.text.length).toBeLessThanOrEqual(SKILL_BODY_MAX_CHARS + 200)
    expect(out.blocks[0]?.text).toContain('[skill text cut at')
  })

  it('omits what no longer fits the total, and never inlines a missing body', () => {
    const big = 'y'.repeat(SKILL_BODY_MAX_CHARS)
    const out = fitSkillBodies([
      { name: 'a', origin: 'persona', body: big },
      { name: 'b', origin: 'persona', body: big },
      { name: 'c', origin: 'persona', body: big },
      { name: 'd', origin: 'persona', body: big },
      { name: 'gone', origin: 'person', body: null },
    ])
    expect(out.inlined).toEqual(['a', 'b', 'c'])
    expect(out.omitted).toEqual(['d', 'gone'])
    expect(out.blocks.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(SKILL_BODIES_MAX_CHARS)
  })
})
```

- [ ] **Step 2: Run it** — `npx vitest run packages/domain/test/run-context/skillBodies.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/domain/src/run-context/skillBodies.ts`:

```ts
import { sliceCodePoints } from '../profile/spec.js'

/** Conductor spec R6: one skill's inlined text at most. */
export const SKILL_BODY_MAX_CHARS = 8_000
/** Conductor spec R6: all inlined skill text of one run at most. */
export const SKILL_BODIES_MAX_CHARS = 24_000

export interface SkillBodyInput {
  readonly name: string
  readonly origin: 'persona' | 'person'
  /** The SKILL.md text after its front matter; null when there is none to read. */
  readonly body: string | null
}

/**
 * Which skill texts go into a worker's prompt, in what order, and cut where (conductor spec R6).
 *
 * Persona defaults first -- they are what the persona IS -- then the person's grants, each group by
 * name so two runs of the same seat read the same prompt. A body over the per-skill cap is cut and
 * says so; a skill that no longer fits the total is omitted whole (half a skill reads as a
 * different skill). Its files stay copied in the worktree either way, so nothing is lost to a run
 * that goes looking.
 */
export function fitSkillBodies(skills: readonly SkillBodyInput[]): {
  readonly blocks: readonly { readonly name: string; readonly text: string; readonly truncated: boolean }[]
  readonly inlined: readonly string[]
  readonly truncated: readonly string[]
  readonly omitted: readonly string[]
} {
  const ordered = [...skills].toSorted(
    (a, b) => (a.origin === b.origin ? a.name.localeCompare(b.name) : a.origin === 'persona' ? -1 : 1),
  )
  const blocks: { name: string; text: string; truncated: boolean }[] = []
  const truncated: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const skill of ordered) {
    const body = skill.body?.trim() ?? ''
    if (body === '') {
      omitted.push(skill.name)
      continue
    }
    const cut = body.length > SKILL_BODY_MAX_CHARS
    const text = cut
      ? `${sliceCodePoints(body, SKILL_BODY_MAX_CHARS)}\n[skill text cut at ${SKILL_BODY_MAX_CHARS} characters; the full skill is in .claude/skills/${skill.name}]`
      : body
    if (used + text.length > SKILL_BODIES_MAX_CHARS) {
      omitted.push(skill.name)
      continue
    }
    used += text.length
    blocks.push({ name: skill.name, text, truncated: cut })
    if (cut) truncated.push(skill.name)
  }
  return { blocks, inlined: blocks.map((block) => block.name), truncated, omitted }
}
```
Export from `packages/domain/src/run-context/index.ts`: `export * from './skillBodies.js'`.

- [ ] **Step 4: Run the unit test** → PASS.

- [ ] **Step 5: `readSkillBody`** in `packages/control/src/skills.ts` (beside `parseFrontmatter`), exported from the package index:

```ts
/**
 * Conductor R6: the instructions of one skill -- its `SKILL.md` after the front matter -- for a
 * worker's prompt. `null` when there is no readable file; a file with no front matter is all body.
 */
export function readSkillBody(skillDir: string): string | null {
  let text: string
  try {
    text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (match === null ? text : text.slice(match[0].length)).trim()
}
```

- [ ] **Step 6: Manifest schema** — in `sections.ts`, the skills source type gains `readonly inlined?: readonly string[] | undefined; readonly truncated?: readonly string[] | undefined; readonly omitted?: readonly string[] | undefined`, and `skillsSourceSchema` gains `inlined: z.array(z.string()).optional(), truncated: z.array(z.string()).optional(), omitted: z.array(z.string()).optional()`. Add a case to `sections.test.ts` that a skills source with the three arrays parses.

- [ ] **Step 7: Failing integration test** in `runContext.test.ts`, `describe('skill injection')`. Add a helper `giveToPersona(fixture, name, body)` that creates a `SlaveTemplate`, links the person (`person.templateId`), writes the skill with a body, and creates a `TemplateSkill`:

```ts
async function giveToPersona(fixture: Fixture, name: string, body: string): Promise<void> {
  mkdirSync(join(fixture.skillRoots.personal, name), { recursive: true })
  writeFileSync(join(fixture.skillRoots.personal, name, 'SKILL.md'), `---\nname: ${name}\ndescription: does ${name}\n---\n\n${body}\n`)
  const provider = await prisma.skillProvider.upsert({ where: { name: 'personal' }, update: {}, create: { name: 'personal' } })
  const skill = await prisma.skill.create({ data: { providerId: provider.id, name, description: `does ${name}` } })
  let person = await prisma.person.findUniqueOrThrow({ where: { id: fixture.personId } })
  if (person.templateId === null) {
    const template = await prisma.slaveTemplate.create({ data: { name: `Persona ${fixture.personId.slice(0, 6)}`, role: 'engineering', profile: 'You are a persona.' } })
    person = await prisma.person.update({ where: { id: fixture.personId }, data: { templateId: template.id } })
  }
  await prisma.templateSkill.create({ data: { templateId: person.templateId!, skillId: skill.id } })
}
```
(Check `SlaveTemplate`'s required columns in `schema.prisma` and add any other required field the create needs.) Tests:

```ts
    it('puts each skill's instructions in the prompt, persona defaults first, and says they must be applied', async () => {
      await giveToPersona(fixture, 'zz-persona-rule', 'Always write the failing test first.')
      await assign(fixture, 'aa-granted-rule', { description: 'granted' })

      const { prompt, manifest } = await buildImplementation(fixture)

      expect(prompt).toContain('SKILLS YOU MUST APPLY')
      expect(prompt).toContain('Always write the failing test first.')
      expect(prompt.indexOf('zz-persona-rule')).toBeLessThan(prompt.indexOf('aa-granted-rule'))
      expect(prompt).not.toContain('nothing here is compulsory')
      expect(skillsSource(manifest)).toMatchObject({ inlined: ['zz-persona-rule', 'aa-granted-rule'], truncated: [], omitted: [] })
    })

    it('still says a Cursor run has no skills, and inlines nothing for it', async () => {
      await giveToPersona(fixture, 'persona-rule', 'Never inline me for cursor.')
      const { prompt } = await buildRunContext({
        runId: fixture.runId, kind: 'implementation', slaveId: fixture.slaveId, workspaceId: fixture.workspaceId,
        taskId: fixture.taskId, worktreePath: fixture.worktreePath, provider: 'cursor', skillRoots: fixture.skillRoots,
      })
      expect(prompt).toContain('This runtime has no skills mechanism')
      expect(prompt).not.toContain('Never inline me for cursor.')
    })
```
Update the existing test at ~line 210 if its exact-prompt assertions pin the old SKILLS heading.

- [ ] **Step 8: Run** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/runContext.test.ts -t "skill"` → FAIL (old section).

- [ ] **Step 9: Implement in `runContext.ts`.**
  - `AssignedSkill` gains `readonly origin: 'persona' | 'person'`.
  - Replace `effectiveSkillIds({...})` with `effectiveSkills({...})` (same input) and map `({ skillId, origin })` to the row plus `origin`.
  - After `injectSkills`, compute bodies only for skills that are installed (`injection.copied` ∪ `injection.shadowedByRepo`) on a provider that runs skills:
```ts
    const installed = new Set([...injection.copied, ...injection.shadowedByRepo])
    const roots = input.skillRoots ?? skillRoots()
    const fitted = fitSkillBodies(
      assigned
        .filter((skill) => installed.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          origin: skill.origin,
          body: injection.shadowedByRepo.includes(skill.name) && input.worktreePath !== null
            ? readSkillBody(join(input.worktreePath, SKILLS_DIR, skill.name))
            : (() => {
                const dir = skillSourceDir(roots, skill.providerName, skill.name)
                return dir === null ? null : readSkillBody(dir)
              })(),
        })),
    )
```
  - Pass `fitted` to `skillsSectionText` and spread `{ inlined: fitted.inlined, truncated: fitted.truncated, omitted: fitted.omitted }` into the section `source` (only when the provider runs skills).
  - `skillsSectionText(offered, named, injection, fitted)`: keep the two "none" branches verbatim; replace the last branch with:
```ts
  return block('SKILLS YOU MUST APPLY', [
    'These skills are part of how you work on this task. Follow their instructions where they apply;',
    'each is also installed under `.claude/skills/<name>` with any files it refers to.',
    '',
    ...fitted.blocks.flatMap((skill) => [`### ${skill.name}`, '', neutraliseMarkers(skill.text), '']),
    ...(fitted.omitted.length === 0 ? [] : [`Not shown here for length, but installed: ${fitted.omitted.join(', ')}.`]),
  ])
```
  - Import `effectiveSkills`, `fitSkillBodies` from `@slave-of-ai/domain` and `readSkillBody` from `@slave-of-ai/control`.

- [ ] **Step 10: Web summary** — in `runContextSummary.ts` skills case, after the `copied` part: `if (source.inlined?.length) parts.push(\`instructions in the prompt: ${source.inlined.join(', ')}\`)` and `if (source.truncated?.length) parts.push(\`cut for length: ${source.truncated.join(', ')}\`)`. Run its tests: `npx vitest run apps/web/test -t "run context"`.

- [ ] **Step 11: Run** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/runContext.test.ts packages/domain/test/run-context` → PASS; then `npm run typecheck`.

- [ ] **Step 12: Commit**

```bash
git add packages/control/src/skills.ts packages/domain/src/run-context packages/domain/test/run-context apps/orchestrator/src/runContext.ts apps/orchestrator/test/integration/runContext.test.ts apps/web/src/lib/runContextSummary.ts
git commit -m "feat(run-context): a worker's prompt carries its skills' instructions, persona defaults first, under caps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The persona's workflow as a checklist in the prompt

**Files:**
- Modify: `packages/domain/src/run-context/sections.ts` (new section kind `workflow` + source `{ kind: 'workflow', steps: number, origin: 'template' }` + zod)
- Modify: `packages/domain/src/run-context/render.ts` (`SECTION_ORDER.implementation`: insert `'workflow'` after `'skills'`)
- Modify: `packages/domain/test/run-context/render.test.ts` (the order test at line 31) and `sections.test.ts`
- Modify: `apps/orchestrator/src/runContext.ts` (load the template's `profileSpec` and `profileOverrides`; push the section)
- Modify: `apps/web/src/lib/runContextSummary.ts` (a `workflow` case)
- Test: `apps/orchestrator/test/integration/runContext.test.ts`

**Interfaces:**
- Consumes: `profileSpecSchema`, `profileOverridesSchema`, `effectiveProfileSpec` (`packages/domain/src/profile/spec.ts`).
- Produces: section kind `'workflow'` in implementation runs; manifest source `{ kind: 'workflow', steps, origin: 'template' }`.

- [ ] **Step 1: Failing test** in `runContext.test.ts` (new describe):

```ts
  describe('the persona workflow (conductor R6)', () => {
    it('renders the persona's workflow as a numbered checklist the worker must report on', async () => {
      const template = await prisma.slaveTemplate.create({
        data: {
          name: 'Workflow Persona', role: 'engineering', profile: 'You follow a workflow.',
          profileSpec: { ...MINIMAL_PROFILE_SPEC, workflow: ['Read the brief back', 'Write the failing test', 'Make it pass'] },
        },
      })
      await prisma.person.update({ where: { id: fixture.personId }, data: { templateId: template.id } })

      const { prompt, manifest } = await buildImplementation(fixture)

      expect(prompt).toContain('YOUR WORKFLOW')
      expect(prompt).toMatch(/1\. Read the brief back\n2\. Write the failing test\n3\. Make it pass/)
      expect(manifest.sections.find((s) => s.kind === 'workflow')).toEqual({ kind: 'workflow', steps: 3, origin: 'template' })
    })

    it('has no workflow section for a persona without one', async () => {
      const { manifest } = await buildImplementation(fixture)
      expect(manifest.sections.some((s) => s.kind === 'workflow')).toBe(false)
    })
  })
```
`MINIMAL_PROFILE_SPEC`: build it at the top of the test file from the fields `profileSpecSchema` requires (read `packages/domain/src/profile/spec.ts`; copy an existing minimal spec from `packages/domain/test/profile/*.test.ts` if one exists).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Domain** — add `'workflow'` to `SectionKind`; source `{ readonly kind: 'workflow'; readonly steps: number; readonly origin: 'template' }`; zod `z.object({ kind: z.literal('workflow'), steps: z.number().int().nonnegative(), origin: z.literal('template') })` in the discriminated union; `SECTION_ORDER.implementation` becomes `['profile', 'roster', 'skills', 'workflow', 'inbox', 'ask_protocol', 'task', 'handoff', 'memory', 'rejection']`. Update `render.test.ts` line 31's pinned array and add a `workflow` source to `sections.test.ts`'s `validManifest`.

- [ ] **Step 4: Orchestrator** — in `buildRunContext`, extend the template select to `{ profile: true, profileSpec: true, profileOverrides: true }`; for `kind === 'implementation'`:

```ts
  if (order.includes('workflow')) {
    const spec = profileSpecSchema.safeParse(slave.person.template?.profileSpec)
    const overrides = profileOverridesSchema.safeParse(slave.person.template?.profileOverrides ?? {})
    const steps = spec.success
      ? effectiveProfileSpec(spec.data, overrides.success ? overrides.data : {}).workflow.map((step) => step.trim()).filter((step) => step !== '')
      : []
    if (steps.length > 0) {
      sections.push({
        kind: 'workflow',
        text: block('YOUR WORKFLOW', [
          'Work through these steps in order. In your final message, say for each step whether you did it',
          'and, if you skipped one, why.',
          '',
          ...steps.map((step, index) => `${index + 1}. ${neutraliseMarkers(step)}`),
        ]),
        source: { kind: 'workflow', steps: steps.length, origin: 'template' },
      })
    }
  }
```
Import `profileSpecSchema`, `profileOverridesSchema`, `effectiveProfileSpec` from `@slave-of-ai/domain`.

- [ ] **Step 5: Web** — `runContextSummary.ts`: `case 'workflow': return { kind: source.kind, detail: plural(source.steps, 'workflow step'), missing: [] }`.

- [ ] **Step 6: Run** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/runContext.test.ts packages/domain/test/run-context apps/web/test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/run-context packages/domain/test/run-context apps/orchestrator/src/runContext.ts apps/orchestrator/test/integration/runContext.test.ts apps/web/src/lib/runContextSummary.ts
git commit -m "feat(run-context): the persona's workflow is a numbered checklist in the worker's prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Whole-branch verification

- [ ] **Step 1:** `npm run typecheck && npx vitest run` (one process, ~5 min, 600 s timeout) → all green.
- [ ] **Step 2:** `npm run web:build` — only while no `next dev` is running in the same checkout (restart dev afterwards with `rm -rf apps/web/.next`).
- [ ] **Step 3:** Gates on the dedicated DB with the fake CLI env:
```bash
set -a && . ./.env && set +a
export CHROMIUM_PATH=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1) DATABASE_URL="$GATE_DATABASE_URL" \
  SLAVEOFAI_CLAUDE_BIN=$PWD/scripts/gate-fakes/fake-claude.sh SLAVEOFAI_CURSOR_BIN=$PWD/scripts/gate-fakes/fake-cursor-agent.sh SLAVEOFAI_REQUIRE_FAKE_CLI=1
npm run -s gate:m26-vocabulary; npm run -s gate:m37-run-context; npm run -s gate:m51-breaker
```
Expected: pass (m37 pins run-context sections; if it asserts the old SKILLS heading, update the gate's expectation to the new heading and say so in the commit).
- [ ] **Step 4:** Commit any gate fixture update with the trailer.
