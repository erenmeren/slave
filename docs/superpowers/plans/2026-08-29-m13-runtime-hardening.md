# M13: Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a paused run actually stopped before anything calls it paused, collapse the
copy-pasted runtime helpers into one module, prove Cursor's write gate with committed evidence,
and give the operator a Runtime card that sets the workspace's provider and budget.

**Architecture:** Five series. **A** fixes the pause/resume/attempt semantics in the orchestrator
and `packages/control` — the pump publishes `paused` only once the child is dead, `requestResume`
refuses a run that is still stopping, every failed start *or resume* costs an attempt, and a
pause that cannot be signalled releases its claim. **B** extracts the verbatim-copied blocks from
both adapters into `packages/providers/src/runtime/` and both bash gates into
`scripts/lib/pause-flag.sh`, behavior-preserving and proved by a suite that never changes. **C**
settles Cursor's gate capability with two measured runs whose recordings are committed fixtures.
**D** puts provider and budget on the workspace page through control-layer verbs and routes shaped
like Goal's. **E** proves the milestone live on both runtimes with `gate-m13-runtime.mjs`.

**Tech Stack:** TypeScript, Prisma/Postgres, vitest, Next.js (App Router), bash for the two hook
gates, `playwright-core` for the gate script, the `claude` and `cursor-agent` CLIs as child
processes.

**Spec:** `docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md`

## Global Constraints

- **New refusal texts, verbatim** (`packages/control/src/refusal.ts`, in the existing switch that
  already returns `a model must name the provider that runs it`):
  - `run_still_stopping` → `the run is still stopping; retry in a moment`
  - `invalid_budget` → `a budget must be a non-negative amount or absent`
- **Ordering is law (Decision 1 + 2):** `checkpoint → kill → paused → run.paused`. A run is
  `paused` when its process is dead — not when the checkpoint is written, not when the kill is
  sent. During the kill's grace window the row reads `pause_requested`.
- **The kill grace is 2 000 ms** (`KILL_GRACE_MS`), in the one remaining copy of the escalation.
- **New event type `workspace.settings_changed`**, actor `human`, payload
  `{ field: 'provider' | 'budgetUsd', from, to }`.
- **Gate PASS line, verbatim:** `a pause is a stop and a stop is resumable`.
- **Series B is behavior-preserving.** Each extraction task runs the full suite before and after
  and reports the deleted line count. No adapter or gate test changes in Series B tasks 5, 6 and 7.
  Task 8 is the one Series B task that changes gate BEHAVIOR (spec §4.2) and therefore its own two
  named gate tests — nothing else.
- **A capability is raised only by committed evidence** (Decision 8). Cursor's `gate` moves off
  `'shell-only'` only if a recorded run shows a file write refused while paused, and the recording
  lives under `packages/providers/test/fixtures/cursor/gate/`, never in a scratch directory.
- **Halted workspaces stay editable** (Decision 11). Neither settings verb refuses a halted
  workspace, and neither duplicates the budget/provider compatibility rule (Decision 10) that
  dispatch already enforces with `unmeasurable_budget`.
- **Money-spending gates say so** (Decision 12): marked in the README, vendor children killed in
  `finally`, rehearsed against fake CLIs before the first paid execution.
- **Spend caps.** At most **three** two-runtime executions of `gate:m13-runtime`, each preceded by
  a zero-spend rehearsal against fake CLIs (`AITEAMOS_CLAUDE_BIN` / `AITEAMOS_CURSOR_BIN`). At most
  **three** `cursor-agent` runs in Series C (two measured, one spare).
- **One vitest run at a time on this machine.** Never run suites in parallel, never `git push`
  while a suite runs (the pre-push hook runs the suite).
- **`npm run web:build` is part of every gate** — tsc and vitest miss bundler-only breakage.
- **Stage named files only.** Never `git add -A`; the tree carries unrelated untracked paths.
- **No task may modify a test file it does not name in its own `Files:` block.**

---

## File Structure

New files this plan creates:

| File | Responsibility |
|---|---|
| `packages/providers/src/runtime/event-queue.ts` | `AsyncEventQueue<T>` — the one copy |
| `packages/providers/src/runtime/summary.ts` | `isRecord`, `summaryFor`, both key lists |
| `packages/providers/src/runtime/process.ts` | `isAlive`, `signalRun`, `killWithEscalation`, `terminateChild`, `buildChildEnv`, `KILL_GRACE_MS` |
| `packages/providers/src/runtime/pause-flag.ts` | `clearAndVerifyPauseFlagAbsent` |
| `packages/providers/src/runtime/gate-preflight.ts` | `runGateScript`, `preflightGate` |
| `scripts/lib/pause-flag.sh` | `json_string`, `read_pause_reason` — shared by both bash gates |
| `packages/control/src/workspace.ts` | `setWorkspaceProvider`, `setWorkspaceBudget` |
| `apps/web/src/app/api/w/[workspaceId]/provider/route.ts` | `PUT { provider }` |
| `apps/web/src/app/api/w/[workspaceId]/budget/route.ts` | `PUT { budgetUsd }` |
| `apps/web/src/components/RuntimeCard.tsx` | the operator's runtime + budget control |
| `scripts/gate-m13-runtime.mjs` | the measured milestone gate |

---

## Series A — A Pause Is a Stop

### Task 1: The pump publishes `paused` only once the child is dead

**Files:**
- Modify: `apps/orchestrator/src/pump.ts:469-528` (the `stopped_by_gate` branch)
- Modify: `apps/orchestrator/src/pump.ts:277-279` (the comment inside
  `recordCursorPauseIfRequested` that claims it uses "the same order the gate path uses")
- Test: `apps/orchestrator/test/integration/pump.test.ts` (extend — this file already owns every
  gate-deny pause assertion)

**Interfaces:**
- Consumes: `killWithEscalation(pid: number | null, graceMs?: number): Promise<boolean>` from
  `@ai-team-os/control` (`packages/control/src/kill.ts`), whose `KILL_GRACE_MS` is `2_000`.
- Produces: no new export. The observable contract every later task and the gate rely on: after
  `writeCheckpoint` has landed and while `killWithEscalation` is still inside its grace window,
  the `AgentRun` row still reads whatever status it had (`pause_requested` when an operator asked)
  and **no `run.paused` event exists**; both appear only after the pid is gone.

**Why the in-memory `paused` flag moves to the top of the branch.** Today `paused = true` is set
just before the status write. With the write moved to the end, a flag set at the end would leave
the whole branch re-enterable for the entire grace window — exactly the duplicate-work case the
existing "reacts to a second hook deny … only once" test pins. So the flag is claimed FIRST, and
everything after it is the one-shot body.

**Why the status write is still `where: { id, endedAt: null }`** and deliberately not narrowed to
`status: 'pause_requested'`: spec §3.1. A deny that arrives on a `working` run (nobody asked; the
domain machine does not admit it as `paused`) is still reported as what the runtime did, exactly
as today. Only the ordering moves.

- [ ] **Step 1: Write the failing test**

Add to `apps/orchestrator/test/integration/pump.test.ts`, beside the existing
`spawnNeverExiting` helper:

```typescript
/**
 * A real child that IGNORES SIGTERM for longer than `killWithEscalation`'s 2 000 ms grace, so the
 * window between "the kill was sent" and "the pid is gone" is long enough to observe from another
 * task. `spawnNeverExiting` above dies on the first SIGTERM and cannot exercise this.
 */
async function spawnSigtermIgnoring(): Promise<number> {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)"],
    { stdio: 'ignore' },
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('spawnSigtermIgnoring: child did not receive a pid')
  return child.pid
}

/** Polls the DB until `probe` is true, or throws naming what it last saw. */
async function until(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}
```

and the test itself, in the same `describe` block as
`'records a hook deny as a pause, so the killed process is not read as an orphan'`:

```typescript
it('leaves the row pause_requested and run.paused unannounced until the child is actually dead', async (): Promise<void> => {
  const pid = await spawnSigtermIgnoring()
  await prisma.agentRun.update({
    where: { id: ids.runId },
    // `pause_requested` is what an operator's `requestPause` leaves behind; the deny below is the
    // gate answering it. This is the state Decision 1 is about.
    data: { pid, worktreePath: '/tmp', status: 'pause_requested' },
  })

  try {
    const pumping = pumpRun({
      ...ids,
      spawn: {
        settingsPath: '/tmp/settings.json',
        pauseFlagPath: '/tmp/pause.flag',
        hookPath: '/tmp/pause-gate.sh',
        gitIdentity: { name: 'Alex', email: 'alex@aiteamos.local' },
      },
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Bash', summary: 'Bash echo hi' },
        { kind: 'hook_denied', hookName: 'PreToolUse', reason: 'operator asked to pause' },
      ]),
    })

    // The checkpoint is written FIRST (Decision 2), so its existence is the proof we are inside
    // the kill's grace window rather than before the branch ran at all.
    await until('the checkpoint to be written', async () => {
      return (await prisma.checkpoint.findUnique({ where: { runId: ids.runId } })) !== null
    })

    const during = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(during.status).toBe('pause_requested')
    expect(await eventTypesFor(ids.runId)).not.toContain('run.paused')
    expect(isAlive(pid)).toBe(true)

    await pumping

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(after.status).toBe('paused')
    expect(after.pausedAtStep).toBe(1)
    expect(await eventTypesFor(ids.runId)).toContain('run.paused')
    // The whole point: every consumer of `paused` may rely on the pid being gone.
    expect(isAlive(pid)).toBe(false)
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already dead -- that is the outcome under test.
    }
  }
}, 30_000)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts -t 'until the child is actually dead'`
Expected: FAIL — `expected 'paused' to be 'pause_requested'` at the `during.status` assertion, and
`run.paused` already present in the event list. The status and the event are written before the
kill today.

- [ ] **Step 3: Reorder the branch**

In `apps/orchestrator/src/pump.ts`, the `case 'stopped_by_gate'` body becomes, in this order:

```typescript
case 'stopped_by_gate': {
  // Once only, and claimed BEFORE any of the work below (M13 Decision 1). The real CLI does not
  // exit promptly on the SIGTERM further down -- the live-gate trace that motivated this file's
  // kill call shows a second deny arriving after the first pause -- and with the status write now
  // at the END of this branch, `paused` is the only thing standing between that second deny and a
  // duplicate checkpoint write, a duplicate multi-second kill and a duplicate `run.paused`.
  if (paused) break
  paused = true

  // 1. The checkpoint, still before the kill (M13 Decision 2): killing first risks losing the
  // resume point if the checkpoint write fails partway through.
  await writeCheckpoint({
    runId,
    sessionId,
    toolCalls,
    lastToolUseId,
    lastToolName,
    denied,
    spawn: input.spawn,
    pauseReason: gateOutcome.reason,
    // Who asked, when the flag file says. §6 lists it as provenance and nothing wrote it.
    requestedBy: readPauseRequester(input.spawn?.pauseFlagPath),
  })

  // 2. The kill. Unconditional on whether a checkpoint actually got written: a run with no spawn
  // facts or no session id cannot be resumed by anyone (`writeCheckpoint`'s own early return) --
  // but that is a reason to kill, not a reason not to. `killWithEscalation` SIGKILLs at the grace
  // deadline, so on return the pid is gone.
  await killWithEscalation(startingRow.pid)

  // 3. Only now is the run PAUSED (M13 Decision 1). Every consumer of this status -- the orphan
  // sweep, `requestResume`, the operator's panel -- may rely on the pid being gone. Until this
  // write lands, the row reads whatever it read before (`pause_requested` when an operator asked),
  // which is exactly the honest answer during the grace window.
  //
  // `endedAt: null`, deliberately NOT narrowed to `status: 'pause_requested'`: a deny that arrives
  // on a `working` run (no operator asked; the domain machine does not admit it as `paused`) is
  // still reported as what the runtime did, exactly as before this reordering. Only the ordering
  // moved.
  await prisma.agentRun.updateMany({
    where: { id: runId, endedAt: null },
    data: { status: 'paused', pausedAtStep: toolCalls },
  })

  // 4. And only now is it announced.
  await emit('run.paused', 'system', { atStep: toolCalls })
  break
}
```

- [ ] **Step 4: Correct the Cursor path's ordering comment**

`recordCursorPauseIfRequested` does not change (its stream has already ended, so the child is
already dead — Decision 1 is satisfied there by construction). Its comment at
`apps/orchestrator/src/pump.ts:277-279` now says something false. Replace:

```typescript
  // Status first, then the checkpoint, then the event -- the two pause routes deliberately DIFFER
  // in ordering as of M13, and the difference is not drift. The gate path writes the checkpoint,
  // kills the child, and only then writes `paused` (Decision 1: a run is paused when its process
  // is dead). This path runs after the stream has already ended, i.e. after the child is already
  // gone, so the claim IS the moment the run became paused and there is nothing left to kill --
  // see this function's "No kill here" note above.
```

- [ ] **Step 5: Run the whole pump and cursor-pause suites**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts apps/orchestrator/test/integration/cursor-pause.test.ts`
Expected: PASS, including the new test and the existing
`'reacts to a second hook deny after the pause only once'`.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

**Report requirement:** list every existing assertion in
`apps/orchestrator/test/integration/pump.test.ts` you had to re-point at the new ordering (spec
§3.5 makes this the one place M12's test freeze is lifted). The expectation is ZERO — the existing
tests assert end state, not ordering — so any edit at all is a finding worth naming.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/pump.ts apps/orchestrator/test/integration/pump.test.ts
git commit -m "fix(orchestrator): a run is paused when its process is dead, not when the kill is sent"
```

---

### Task 2: `requestResume` refuses a run that is still stopping

**Files:**
- Modify: `packages/control/src/refusal.ts` (the `ControlRefusal` union and the `refusalText` switch)
- Modify: `packages/control/src/resume.ts:80-98` (between the checkpoint check and the claim)
- Test: `packages/control/test/integration/resume-intent.test.ts` (extend)

**Interfaces:**
- Consumes: `isAlive(pid: number | null): boolean` from `packages/control/src/kill.ts` — already
  exported, already treats `EPERM` as alive and `ESRCH` as dead, already returns `false` for
  `null` and for a non-positive pid.
- Produces:

```typescript
// packages/control/src/refusal.ts
/**
 * The run's row says `paused` but its process is still alive (M13 §3.2). The pump's ordering
 * (Task 1) is supposed to make this unreachable; this is the SECOND lock (Decision 3), and it is
 * cheap: it turns a future ordering regression into a refusal instead of two agents on one branch.
 */
| { readonly kind: 'run_still_stopping'; readonly runId: string }
```

`refusalText({ kind: 'run_still_stopping' })` returns exactly
`the run is still stopping; retry in a moment`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/control/test/integration/resume-intent.test.ts`. The file's `seed()` already
builds a workspace/team/agent/task/run; these tests set the run `paused`, give it a checkpoint,
and vary only the pid.

```typescript
import { spawn } from 'node:child_process'
import { refusalText } from '../../src/refusal.js'

/** A real, live pid: `/bin/sleep` for long enough that no test outlives it. */
function liveSleeper(): { pid: number; stop: () => void } {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('liveSleeper: no pid')
  return {
    pid: child.pid,
    stop: () => {
      try {
        process.kill(child.pid as number, 'SIGKILL')
      } catch {
        // Already gone.
      }
    },
  }
}

/** A real pid that is definitely gone: spawn `/bin/true` and wait for its exit. */
async function deadPid(): Promise<number> {
  const child = spawn('/bin/true', [], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('deadPid: no pid')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return child.pid
}

describe('requestResume liveness', () => {
  async function pausedRunWithCheckpoint(pid: number | null): Promise<string> {
    await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused', pid } })
    await prisma.checkpoint.create({
      data: {
        runId: fixture.run.id,
        sessionId: 's-1',
        worktreePath: '/tmp',
        pauseFlagPath: '/tmp/pause.flag',
        settingsPath: '/tmp/settings.json',
        hookPath: '/tmp/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@aiteamos.local',
        headCommit: 'abc123',
      },
    })
    return fixture.run.id
  }

  it('refuses a paused run whose process is still alive, with the verbatim text', async (): Promise<void> => {
    const sleeper = liveSleeper()
    try {
      const runId = await pausedRunWithCheckpoint(sleeper.pid)
      const result = await requestResume(runId, null, 'meren')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('run_still_stopping')
      expect(refusalText(result.error)).toBe('the run is still stopping; retry in a moment')

      // Nothing was recorded: a refused resume must not arm one.
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      expect(after.resumeRequestedAt).toBeNull()
      expect(await prisma.executionEvent.count({ where: { runId, type: 'run_resume_requested' } })).toBe(0)
    } finally {
      sleeper.stop()
    }
  })

  it('proceeds for a paused run whose pid is really gone', async (): Promise<void> => {
    const runId = await pausedRunWithCheckpoint(await deadPid())
    const result = await requestResume(runId, null, 'meren')

    expect(result.ok).toBe(true)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(after.resumeRequestedAt).not.toBeNull()
  })

  it('proceeds for a row that never recorded a pid at all', async (): Promise<void> => {
    // Pre-M12 rows, and rows the pump already cleared. A null pid is not a refusal (spec §3.2).
    const runId = await pausedRunWithCheckpoint(null)
    expect((await requestResume(runId, null, 'meren')).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/control/test/integration/resume-intent.test.ts -t 'liveness'`
Expected: FAIL — the first case returns `ok: true` (there is no liveness check), and
`'run_still_stopping'` is not a member of `ControlRefusal`, so `refusalText` does not compile.

- [ ] **Step 3: Add the refusal**

In `packages/control/src/refusal.ts`, add the union member shown in **Interfaces** above (place it
directly after `no_checkpoint`, whose neighbourhood it belongs to), and the switch arm:

```typescript
    case 'run_still_stopping':
      return 'the run is still stopping; retry in a moment'
```

- [ ] **Step 4: Add the liveness check**

In `packages/control/src/resume.ts`, import `isAlive` and insert AFTER the checkpoint check and
BEFORE the claim:

```typescript
import { isAlive } from './kill.js'

  // The second lock (M13 Decision 3). Task 1's pump ordering is what makes this unreachable in a
  // correct system: `paused` is written only once `killWithEscalation` has returned, and it
  // SIGKILLs at the grace deadline. Checking anyway is cheap and turns a future ordering
  // regression into a refusal instead of a lost run -- resuming a run whose old process is still
  // alive puts two agents on one branch, which is the failure this whole milestone is about.
  //
  // `isAlive` treats EPERM as alive (the process exists, it is just not ours to inspect) and only
  // ESRCH as gone, and returns `false` for a null pid -- which is NOT a refusal here: pre-M12 rows
  // carry no pid, and the pump clears nothing but records one only when it spawned.
  if (isAlive(run.pid)) {
    return err({ kind: 'run_still_stopping', runId: run.id })
  }
```

- [ ] **Step 5: Run the tests to green**

Run: `npx vitest run packages/control/test/integration/resume-intent.test.ts`
Expected: PASS, all cases including the file's pre-existing ones.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

**Report requirement:** name every existing test you had to touch. Expected: none — but
`apps/orchestrator/test/integration/resume-execution.test.ts` pauses runs through the real pump,
so if any of its fixtures leave a live pid on a `paused` row, that is a genuine finding about the
pump and must be reported, not silenced.

- [ ] **Step 7: Commit**

```bash
git add packages/control/src/refusal.ts packages/control/src/resume.ts packages/control/test/integration/resume-intent.test.ts
git commit -m "feat(control): a run that is still stopping cannot be resumed"
```

---

### Task 3: Every failed run start or resume costs an attempt

**Files:**
- Modify: `apps/orchestrator/src/tick.ts:346-380` (`concludeFailedResume`)
- Modify: `apps/orchestrator/src/tick.ts:615-689` (`failToStart`)
- Test: `apps/orchestrator/test/integration/resume-execution.test.ts` (extend)

**Interfaces:**
- Produces (module-private to `tick.ts`, consumed by both callers in this task):

```typescript
/** What {@link releaseTaskAfterFailure} did, so the caller can announce it. */
interface TaskRelease {
  /** The task's attempt count AFTER the increment. */
  readonly attempt: number
  /** `true` when that count reached `maxAttempts` and the task was parked `failed`. */
  readonly exhausted: boolean
}

async function releaseTaskAfterFailure(
  task: { readonly id: string; readonly maxAttempts: number },
  runId: string,
  parked: 'rework' | 'blocked',
): Promise<TaskRelease>
```

**The rule the helper carries is `failToStart`'s existing one:** `exhausted ? 'failed' : parked`.
An exhausted task is `failed` — the non-startable, operator-visible terminal the board already
uses. `parked` is where a non-exhausted attempt lands: `blocked` for a `WorktreeExistsError`
leftover (which is the exact precondition `acquireWorktree` tests for before it adopts, so `rework`
would hand the next tick the tree this one just refused), `rework` for everything else.

**`lastRejectionReason` stays untouched on both paths** (spec §3.3). It is the agent-facing channel
— `buildPrompt` puts it in front of the next run as the thing to fix first — so an
orchestrator-side failure landing in it both destroys the verify feedback and instructs the next
agent to fix a setup command it cannot see.

- [ ] **Step 1: Write the failing tests**

Add to `apps/orchestrator/test/integration/resume-execution.test.ts`. This file already has
`pauseARun()`, `fakeAdapter()` and `singleAdapterRegistry()`; the failure is produced by pointing
the checkpoint at a session the fake CLI cannot continue, using a command that does not exist.

```typescript
describe('a resume that fails to spawn', () => {
  /** An adapter whose configured command is not on disk, so `resume()` throws at spawn. */
  function brokenAdapter(): ClaudeCodeAdapter {
    return new ClaudeCodeAdapter({
      command: join(tmpdir(), 'aiteamos-no-such-binary-m13'),
      hookPath: REAL_GATE,
    })
  }

  it('counts the attempt, releases the task to rework, and records run.failed', async (): Promise<void> => {
    const runId = await pauseARun()
    await prisma.task.update({ where: { id: fixture.taskId }, data: { maxAttempts: 3, attempt: 0 } })
    expect((await requestResume(runId, null, 'web')).ok).toBe(true)

    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(brokenAdapter()),
    })
    await drainPumps()

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    // The whole point of Decision 4: no path re-dispatches a paid run without counting it.
    expect(task.attempt).toBe(1)
    expect(task.status).toBe('rework')
    expect(task.activeRunId).toBeNull()
    // The agent-facing channel is untouched -- an orchestrator-side failure is not feedback.
    expect(task.lastRejectionReason).toBeNull()

    expect(await prisma.executionEvent.count({ where: { runId, type: 'run_failed' } })).toBe(1)
  }, 60_000)

  it('parks the task failed at maxAttempts and starts no run on the next tick', async (): Promise<void> => {
    const runId = await pauseARun()
    await prisma.task.update({ where: { id: fixture.taskId }, data: { maxAttempts: 1, attempt: 0 } })
    expect((await requestResume(runId, null, 'web')).ok).toBe(true)

    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(brokenAdapter()),
    })
    await drainPumps()

    const exhausted = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(exhausted.attempt).toBe(1)
    expect(exhausted.status).toBe('failed')
    expect(
      await prisma.executionEvent.count({ where: { taskId: fixture.taskId, type: 'task_failed' } }),
    ).toBe(1)

    const runsBefore = await prisma.agentRun.count({ where: { taskId: fixture.taskId } })
    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('complete')),
    })
    await drainPumps()
    // A `failed` task is not startable: the next tick must not hand it to an agent again.
    expect(await prisma.agentRun.count({ where: { taskId: fixture.taskId } })).toBe(runsBefore)
  }, 60_000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/integration/resume-execution.test.ts -t 'fails to spawn'`
Expected: FAIL — `expected 0 to be 1` on `task.attempt` in the first test, and
`expected 'rework' to be 'failed'` on the second. `concludeFailedResume` releases the task to
`rework` without ever incrementing.

- [ ] **Step 3: Extract the helper out of `failToStart`**

In `apps/orchestrator/src/tick.ts`, add above `failToStart`:

```typescript
/** What {@link releaseTaskAfterFailure} did, so the caller can announce it. */
interface TaskRelease {
  /** The task's attempt count AFTER the increment. */
  readonly attempt: number
  /** `true` when that count reached `maxAttempts` and the task was parked `failed`. */
  readonly exhausted: boolean
}

/**
 * Counts one failed attempt against a task and puts it somewhere it can be retried -- or stops it.
 *
 * Shared by `failToStart` and `concludeFailedResume` (M13 Decision 4). Both are "an attempted run
 * that failed", and until M13 only the first of them counted: a resume that could not spawn
 * released the task straight back to `rework`, so a run that failed to resume forever was handed
 * out forever, each attempt costing real money and none of them costing an attempt.
 *
 * Conditional on still owning the task, and incremented rather than assigned: a tick that lost the
 * claim race must not roll back the winner's task row or burn an attempt against a run that is very
 * much alive.
 *
 * `lastRejectionReason` is deliberately NOT written here. It is the agent-facing channel --
 * `buildPrompt` puts it in front of the next run as the thing to fix first -- so an
 * orchestrator-side failure landing in it both destroys the verify feedback §8 requires and
 * instructs the next agent to go and fix a setup command it cannot see. The reason lives on the
 * `AgentRun` row and in `run.failed`, which is where an operator looks for it.
 */
async function releaseTaskAfterFailure(
  task: { readonly id: string; readonly maxAttempts: number },
  runId: string,
  parked: 'rework' | 'blocked',
): Promise<TaskRelease> {
  await prisma.task.updateMany({
    where: { id: task.id, activeRunId: runId },
    data: { attempt: { increment: 1 } },
  })
  const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  const exhausted = after.attempt >= task.maxAttempts
  await prisma.task.updateMany({
    where: { id: task.id, activeRunId: runId },
    data: { status: exhausted ? 'failed' : parked, activeRunId: null },
  })
  return { attempt: after.attempt, exhausted }
}
```

Then replace the body of `failToStart` between its `const parked = …` line and its `appendEvent`
calls with:

```typescript
  const { attempt, exhausted } = await releaseTaskAfterFailure(task, runId, parked)
```

deleting the two `prisma.task.updateMany` calls, the `findUniqueOrThrow` between them and the
`const exhausted = …` line that the helper now owns. `failToStart`'s two `appendEvent` calls then
read `attempt` where they read `after.attempt` before; `exhausted` keeps its name. Nothing else in
`failToStart` moves, and its `const parked = error instanceof WorktreeExistsError ? 'blocked' :
'rework'` line stays exactly where it is and is passed straight through.

- [ ] **Step 4: Call it from `concludeFailedResume`**

`concludeFailedResume` currently takes `run: { id, taskId, agentId }` and releases the task with a
bare `updateMany`. Replace that release with the helper, loading the task for its `maxAttempts`:

```typescript
  // Release the task the run was holding, exactly as `concludeDeadRun` does -- a failed resume
  // that leaves `activeRunId` pointing at a dead run strands the task `running` forever. A
  // `planning` run (M8b) has no task to release.
  //
  // As of M13 the release COUNTS (Decision 4): a resume that cannot spawn is an attempted run that
  // failed, and a task whose resume can never spawn was otherwise re-dispatched every tick forever.
  let release: TaskRelease | null = null
  if (run.taskId !== null) {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } })
    release = await releaseTaskAfterFailure(task, run.id, 'rework')
  }

  await appendEvent({
    type: 'run.failed',
    workspaceId: deps.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    runId: run.id,
    actor: 'system',
    payload: { reason: `resume failed to spawn: ${error instanceof Error ? error.message : String(error)}` },
  })

  // The task's own terminal, not just the run's. Without it an exhausted task drops off the board
  // with `run.failed` as the only trace, and nothing in the log says why nothing is running.
  if (run.taskId !== null && release !== null && release.exhausted) {
    await appendEvent({
      type: 'task.failed',
      workspaceId: deps.workspaceId,
      taskId: run.taskId,
      actor: 'system',
      payload: {
        reason: `could not resume after ${String(release.attempt)} attempts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    })
  }
```

- [ ] **Step 5: Run the tests to green**

Run: `npx vitest run apps/orchestrator/test/integration/resume-execution.test.ts apps/orchestrator/test/integration/tick.test.ts`
Expected: PASS. `tick.test.ts` is the freeze proof for `failToStart` — its behavior did not change,
only its body moved.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/tick.ts apps/orchestrator/test/integration/resume-execution.test.ts
git commit -m "fix(orchestrator): a resume that never spawned still costs the task an attempt"
```

---

### Task 4: A claim that cannot be signalled is released

**Files:**
- Modify: `packages/domain/src/run/state.ts:21-31` (`RunEvent`) and `:77-82` (the
  `pause_requested` case)
- Modify: `packages/control/src/refusal.ts` (union + `refusalText`)
- Modify: `packages/control/src/pause.ts:44-77` (`requestPause`)
- Test: `packages/domain/test/run/state.test.ts` (extend)
- Test: `packages/control/test/integration/pause.test.ts` (extend)

**Interfaces:**
- Consumes: `signalPause(kind, { pauseFlagPath, pid }, reason)` from `@ai-team-os/providers`,
  which **throws** for a `'cursor'` run with a `null` pid — that is the case this task exists for.
- Produces:

```typescript
// packages/domain/src/run/state.ts
/**
 * The pause was claimed but could not be signalled, so the claim is given back (M13 Decision 5).
 * `restoredTo` is the status the run held before the claim -- the machine has no memory of it, so
 * the writer that made the claim is the only thing that can name it.
 */
| { readonly type: 'pause_unsignalled'; readonly restoredTo: 'starting' | 'working' | 'resuming' }
```

```typescript
// packages/control/src/refusal.ts
/** `requestPause` claimed the run but `signalPause` threw; the claim was rolled back (M13 §3.4). */
| { readonly kind: 'pause_unsignalled'; readonly runId: string; readonly reason: string }
```

`refusalText({ kind: 'pause_unsignalled', runId, reason })` returns
`` `the pause could not be signalled to run ${runId}: ${reason}` ``. (The spec fixes verbatim text
only for `run_still_stopping` and `invalid_budget`; this one follows the taxonomy's existing
`run ${runId} …` house style.)

`requestPause`'s signature does not change:
`requestPause(runId: string, requestedBy: string, category?: PauseCategory): Promise<Result<void, ControlRefusal>>`.
`pauseActiveRuns(workspaceId, requestedBy, category): Promise<PauseFanoutReport>` does not change
either — a `pause_unsignalled` refusal lands in `refused` through the `!result.ok` branch it
already has, and its per-run `try/catch` stays as the belt to that braces.

- [ ] **Step 1: Write the failing domain test**

Add to `packages/domain/test/run/state.test.ts`:

```typescript
it('gives a claimed pause back to the status it interrupted when the signal could not be sent', () => {
  const state = drive(initialRunState(), [
    { type: 'started', sessionId: 'sess-1' },
    { type: 'tool_call', name: 'Read' },
    { type: 'pause_requested' },
    { type: 'pause_unsignalled', restoredTo: 'working' },
  ])
  expect(state.status).toBe('working')
  // The claim's rollback is not a step backwards through the run's history: the work it counted
  // stays counted.
  expect(state.toolCalls).toBe(1)
})

it('refuses to un-claim a pause that was never claimed', () => {
  const working = drive(initialRunState(), [{ type: 'started', sessionId: 'sess-1' }])
  const result = applyRunEvent(working, { type: 'pause_unsignalled', restoredTo: 'working' })
  expect(result.ok).toBe(false)
})
```

- [ ] **Step 2: Write the failing control test**

Add to `packages/control/test/integration/pause.test.ts`:

```typescript
describe('a pause that cannot be signalled', () => {
  /**
   * A `cursor` run with no recorded pid. `signalPause` refuses that outright rather than
   * reporting a pause it did not perform (`canPauseMidRun: false` means ENDING THE PROCESS is the
   * pause, and with no pid there is nothing to end), so this is the real throw, not a mock.
   */
  async function unsignallableRun(status: 'working' | 'starting' | 'resuming'): Promise<string> {
    await prisma.agentRun.update({
      where: { id: fixture.run.id },
      data: { provider: 'cursor', pid: null, status },
    })
    return fixture.run.id
  }

  it('restores the prior status, refuses, and appends no pause event', async (): Promise<void> => {
    const runId = await unsignallableRun('working')
    const result = await requestPause(runId, 'meren')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('pause_unsignalled')

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    // A run never parks in `pause_requested` with nothing coming (Decision 5).
    expect(after.status).toBe('working')
    expect(
      await prisma.executionEvent.count({ where: { runId, type: 'run_pause_requested' } }),
    ).toBe(0)
  })

  it('restores a resuming run to resuming, not to working', async (): Promise<void> => {
    const runId = await unsignallableRun('resuming')
    expect((await requestPause(runId, 'meren')).ok).toBe(false)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('resuming')
  })

  it('lands in pauseActiveRuns refused, and the fan-out keeps going', async (): Promise<void> => {
    const unsignallable = await unsignallableRun('working')
    // A second, ordinary run in the same workspace, AFTER the broken one, so a fan-out that
    // abandoned the loop on the first failure would leave this one unsignalled.
    const second = await prisma.agentRun.create({
      data: { taskId: fixture.task.id, agentId: fixture.agent.id, status: 'working' },
    })

    const report = await pauseActiveRuns(fixture.workspace.id, 'meren', 'emergency_stop')

    expect(report.refused).toContain(unsignallable)
    expect(report.requested).toContain(second.id)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: unsignallable } })).status).toBe('working')
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('pause_requested')
  })
})
```

The file's `Fixture` interface gains `readonly agent: { readonly id: string }` and `seed()` returns
`agent: { id: agent.id }` — the third test needs a second run on the same agent.

- [ ] **Step 3: Run both and watch them fail**

Run: `npx vitest run packages/domain/test/run/state.test.ts packages/control/test/integration/pause.test.ts`
Expected: FAIL — the domain file does not compile (`pause_unsignalled` is not a `RunEvent`
member), and the control tests fail with the raw `signalPause: cannot pause a cursor run with no
recorded pid` error escaping `requestPause`, leaving the row in `pause_requested`.

- [ ] **Step 4: Add the domain edge**

In `packages/domain/src/run/state.ts`, add the `RunEvent` member from **Interfaces** above and,
in `case 'pause_requested':`, above the existing arms:

```typescript
      // The claim, given back (M13 Decision 5). `requestPause` claims `pause_requested` before it
      // signals, because the claim is what makes the request idempotent; when the signal then
      // throws, the run is holding a status nothing is coming to resolve, and the machine needs a
      // legal way out. `restoredTo` is supplied by the writer because this machine keeps no
      // history -- `RunState` carries a status, not the one before it.
      if (event.type === 'pause_unsignalled') return ok({ ...state, status: event.restoredTo })
```

- [ ] **Step 5: Add the refusal**

In `packages/control/src/refusal.ts`, add the union member from **Interfaces** (beside
`run_still_stopping`) and the switch arm:

```typescript
    case 'pause_unsignalled':
      return `the pause could not be signalled to run ${refusal.runId}: ${refusal.reason}`
```

- [ ] **Step 6: Claim, signal, release**

In `packages/control/src/pause.ts`, `requestPause` keeps its claim exactly as it is and wraps only
the signal:

```typescript
  // The status the claim interrupted, captured from the row read above -- before the claim
  // overwrote it. `run.status` is the pre-claim value by construction: the `updateMany` below does
  // not refresh this object.
  const priorStatus = run.status

  const claimed = await prisma.agentRun.updateMany({
    where: { id: run.id, status: { in: [...PAUSABLE_STATUSES] } },
    data: { status: 'pause_requested', pauseReason: category },
  })
  if (claimed.count === 0) {
    return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: PAUSABLE_STATUSES })
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.agent.team.workspaceId } })
  const { pauseFlagPath } = runFilePaths(workspace.repoPath, brandRunId(run.id))
  try {
    await signalPause(run.provider ?? 'claude_code', { pauseFlagPath, pid: run.pid }, requestedBy)
  } catch (error) {
    // A claim that cannot be signalled is released (M13 Decision 5). Without this the run parks in
    // `pause_requested` -- a non-terminal status meaning "an operator asked and the signal was
    // sent" -- with nothing coming: it looks paused to the panel, it is excluded from nothing, and
    // the only thing that will ever touch it again is a restart's orphan sweep.
    //
    // Conditional on `pause_requested` so a race that already moved the run past the claim (a
    // concurrent `requestStop`, the pump concluding it) keeps ITS outcome; this rollback only ever
    // undoes a claim that is still standing, and only ever to the status it displaced. That is the
    // `pause_unsignalled` edge in `packages/domain`'s run machine.
    await prisma.agentRun.updateMany({
      where: { id: run.id, status: 'pause_requested' },
      data: { status: priorStatus, pauseReason: run.pauseReason },
    })
    return err({
      kind: 'pause_unsignalled',
      runId: run.id,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
```

The `appendEvent` for `run.pause_requested` stays exactly where it is, after the `try/catch` — a
pause that was rolled back must not announce itself.

- [ ] **Step 7: Run the tests to green**

Run: `npx vitest run packages/domain/test/run/state.test.ts packages/control/test/integration/pause.test.ts packages/control/test/integration/emergency.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/run/state.ts packages/domain/test/run/state.test.ts packages/control/src/refusal.ts packages/control/src/pause.ts packages/control/test/integration/pause.test.ts
git commit -m "fix(control): a pause claim that cannot be signalled is given back"
```

---

## Series B — One Runtime Module

Every task in this series is a **refactor with no behavior change**, so the TDD cycle is replaced
by the protocol spec §4.3 sets out, and each task states it explicitly:

> **suite green before; suite green after; N lines deleted.**

No adapter or gate test changes in Tasks 5, 6 or 7 — a test that must change is a signal to STOP
and report, not a thing to edit. (Task 8 is the exception the spec itself names: it changes gate
behavior, and it changes only the two gate test files it lists.)

### Task 5: `runtime/event-queue.ts` and `runtime/summary.ts`

**Files:**
- Create: `packages/providers/src/runtime/event-queue.ts`
- Create: `packages/providers/src/runtime/summary.ts`
- Modify: `packages/providers/src/claude/adapter.ts:162-213` (delete `isRecord` + `AsyncEventQueue`)
- Modify: `packages/providers/src/cursor/adapter.ts:95-149` (delete the same two)
- Modify: `packages/providers/src/claude/stream.ts:61-63` and `:320-359` (delete `isRecord`,
  `SUMMARY_ARG_KEYS`, `SUMMARY_ARG_MAX_LENGTH`, `firstStringArg`, `summaryFor`)
- Modify: `packages/providers/src/cursor/stream.ts:110-112` and `:283-328` (the same five)
- Modify: `packages/providers/src/index.ts` (export the new module)

**Interfaces:**
- Produces:

```typescript
// packages/providers/src/runtime/event-queue.ts
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  push(item: T): void
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<T, undefined>
}
```

```typescript
// packages/providers/src/runtime/summary.ts
export function isRecord(value: unknown): value is Record<string, unknown>
/** The `input` keys Claude's tool calls carry, in priority order. */
export const CLAUDE_SUMMARY_ARG_KEYS: readonly string[]
/** The `args` keys Cursor's tool calls carry, in priority order. */
export const CURSOR_SUMMARY_ARG_KEYS: readonly string[]
export function summaryFor(toolName: string, args: unknown, keys: readonly string[]): string
```

**Why the key lists are a PARAMETER and not one shared constant.** Spec §4.1 lists
`SUMMARY_ARG_KEYS` as shared, but the two copies are not the same list and never were: Claude's is
nine keys (`file_path`, `path`, `notebook_path`, `command`, `pattern`, `url`, `query`,
`description`, `prompt`), Cursor's is two (`path`, `command`), and `cursor/stream.ts`'s own note
says so ("the two runtimes' argument vocabularies differ"). Merging them would change which
argument each runtime's action line shows — a behavior change, in the one series that must not
have one. The **algorithm** is what is shared; the vocabularies stay each runtime's own, and both
live in this module so there is still exactly one place to read them.

**Second correction to §4.1's table:** these five symbols live in `claude/stream.ts` and
`cursor/stream.ts`, not in the two `adapter.ts` files the table names. `isRecord` in fact has FOUR
copies — one in each stream and one in each adapter — and this task deletes all four.

- [ ] **Step 1: Prove the suite is green before touching anything**

Run: `npm test`
Expected: PASS. Record the summary line (file count and test count) in the task report — it is
half the proof this task offers.

- [ ] **Step 2: Write `event-queue.ts`**

```typescript
// packages/providers/src/runtime/event-queue.ts
/**
 * A single-producer, single-consumer async queue backing an adapter's `events()`.
 *
 * Buffers pushed items until something iterates; never drops one. Closing it ends the iteration
 * for whoever is currently waiting (or will next call `next()`), without discarding anything
 * already buffered.
 *
 * ONE copy, as of M13 Series B. There were two, byte-identical apart from a comment, and
 * `cursor/adapter.ts` carried a note saying so: M12's Series A froze `claude/` so the class could
 * not be exported from where it already lived, and duplicating it was the honest move at the time.
 * That freeze is lifted here, for exactly this.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T, undefined>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: item, done: false })
    } else {
      this.buffered.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: (): Promise<IteratorResult<T, undefined>> => {
        if (this.buffered.length > 0) {
          // Length just checked above; shift() cannot return undefined here.
          const value = this.buffered.shift() as T
          return Promise.resolve({ value, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}
```

- [ ] **Step 3: Write `summary.ts`**

```typescript
// packages/providers/src/runtime/summary.ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The argument keys Claude's tool calls carry, in priority order -- the keys `summaryFor` looks
 * under for the one readable argument that turns a bare tool name into an action line a human can
 * read at a glance (M4 spec §1): `Write /abs/note3.txt` rather than
 * `Write toolu_01UCoRZm85rNxfupNQPToZXL`.
 */
export const CLAUDE_SUMMARY_ARG_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const

/**
 * Cursor's own vocabulary, deliberately NOT merged with Claude's (M13 Task 5).
 *
 * ONLY `path` is measured: the recorded run's single tool call is a read. `command` is here
 * because the shell tool is the entire subject of Cursor's write gate and a shell action line
 * without its command is useless; the rest are absent deliberately rather than guessed at. Merging
 * the two lists would change which argument each runtime's action line shows -- a behavior change,
 * in the one series that must not have one.
 */
export const CURSOR_SUMMARY_ARG_KEYS = ['path', 'command'] as const

const SUMMARY_ARG_MAX_LENGTH = 80

function firstStringArg(args: unknown, keys: readonly string[]): string | null {
  if (!isRecord(args)) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return null
}

/**
 * `<tool name> <its one readable argument>`, or the bare tool name.
 *
 * First string match among `keys` wins; a value present but not a string (or no known key present
 * at all) falls through to the bare tool name, same as `args` being absent entirely.
 */
export function summaryFor(toolName: string, args: unknown, keys: readonly string[]): string {
  const raw = firstStringArg(args, keys)
  if (raw === null) return toolName

  // Collapse newlines/tabs/runs of spaces to one space, so a multiline command reads as one line
  // rather than blowing up the action line's height.
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return toolName

  const trimmedArg =
    normalized.length > SUMMARY_ARG_MAX_LENGTH ? `${normalized.slice(0, SUMMARY_ARG_MAX_LENGTH)}…` : normalized
  return `${toolName} ${trimmedArg}`
}
```

- [ ] **Step 4: Delete the four copies and rewire**

- `claude/adapter.ts`: delete lines 162-213 (`isRecord` + its docstring-less body, the
  `AsyncEventQueue` docstring and class); add
  `import { AsyncEventQueue } from '../runtime/event-queue.js'` and
  `import { isRecord } from '../runtime/summary.js'`.
- `cursor/adapter.ts`: delete lines 95-149 (same two, including the "DELIBERATELY DUPLICATED"
  docstring, which is now false); same two imports.
- `claude/stream.ts`: delete lines 61-63 and 320-359; add
  `import { CLAUDE_SUMMARY_ARG_KEYS, isRecord, summaryFor } from '../runtime/summary.js'`; change
  the one call site at line 390 to
  `summary: summaryFor(result.data.name, result.data.input, CLAUDE_SUMMARY_ARG_KEYS)`.
- `cursor/stream.ts`: delete lines 110-112 and 283-328; add
  `import { CURSOR_SUMMARY_ARG_KEYS, isRecord, summaryFor } from '../runtime/summary.js'`; change
  the call site at line 366 to
  `summary: summaryFor(toolName, args, CURSOR_SUMMARY_ARG_KEYS)`.
- `packages/providers/src/index.ts`: add, above the `claude/` exports,

```typescript
export * from './runtime/event-queue.js'
export * from './runtime/summary.js'
```

- [ ] **Step 5: Prove the suite is still green, unchanged**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS with the same file and test counts as Step 1. `git status --short` must show
**no test file modified** — only the six source files and the two new ones.

- [ ] **Step 6: Count the deletions**

Run: `git diff --numstat -- packages/providers/src/claude packages/providers/src/cursor`
Expected: roughly 190 lines deleted across the four files. Record the exact figure in the task
report; it is the other half of this task's proof.

- [ ] **Step 7: Commit**

```bash
git add packages/providers/src/runtime/event-queue.ts packages/providers/src/runtime/summary.ts packages/providers/src/claude/adapter.ts packages/providers/src/claude/stream.ts packages/providers/src/cursor/adapter.ts packages/providers/src/cursor/stream.ts packages/providers/src/index.ts
git commit -m "refactor(providers): one event queue and one summary, not two of each"
```

---

### Task 6: `runtime/process.ts` — one kill, one escalation, one child environment

**Files:**
- Create: `packages/providers/src/runtime/process.ts`
- Modify: `packages/control/src/kill.ts:1-41` (becomes a re-export)
- Modify: `packages/providers/src/pause-signal.ts:61-65,123-168` (delete the third escalation copy)
- Modify: `packages/providers/src/claude/adapter.ts:237-256` (`buildChildEnv`) and `:637-657`
  (`terminateChild`)
- Modify: `packages/providers/src/cursor/adapter.ts:170-190` (`buildChildEnv`) and `:513-533`
  (`terminateChild`)
- Modify: `packages/providers/src/index.ts`

**Interfaces:**
- Produces:

```typescript
// packages/providers/src/runtime/process.ts
/** How long a cancelled process gets to exit on its own before it is killed outright. */
export const KILL_GRACE_MS = 2_000

export function isAlive(pid: number | null): boolean
export function signalRun(pid: number | null, signal: NodeJS.Signals): boolean
/** SIGTERM, a polled grace window, then SIGKILL. Returns whether anything was signalled. */
export function killWithEscalation(pid: number | null, graceMs?: number): Promise<boolean>
/** The same escalation against a live `ChildProcess` this process spawned. */
export function terminateChild(child: ChildProcess, graceMs: number): Promise<void>
export function buildChildEnv(input: {
  readonly gitIdentity: { readonly name: string; readonly email: string }
  readonly pauseFlagPath: string
}): NodeJS.ProcessEnv
```

- Consumed unchanged by `packages/control`: `import { isAlive, killWithEscalation, signalRun, KILL_GRACE_MS } from '@ai-team-os/control'` keeps working for every existing importer
  (`apps/orchestrator/src/pump.ts`, `sweep.ts`, `scripts/gate-m12-providers.mjs`,
  `apps/orchestrator/test/integration/pump.test.ts`). `packages/control` already **depends on**
  `packages/providers`, so the re-export direction is the only one that is not a cycle
  (Decision 6).

**The one observable difference, stated so it is not discovered later.** `packages/control`'s
`killWithEscalation` sleeps the *whole* grace window before checking; `pause-signal.ts`'s
`terminatePid` *polls* every 25 ms. The merged body polls. A process that dies promptly on SIGTERM
therefore costs milliseconds instead of two seconds — strictly faster, with an identical
post-condition (the pid is gone on return). A process that ignores SIGTERM still costs the full
window, which is exactly what Task 1's grace-window test depends on. If any test asserts elapsed
time here, STOP and report rather than adjusting the test.

- [ ] **Step 1: Prove the suite is green before touching anything**

Run: `npm test`
Expected: PASS. Record the summary line.

- [ ] **Step 2: Write `process.ts`**

```typescript
// packages/providers/src/runtime/process.ts
import type { ChildProcess } from 'node:child_process'

/**
 * How long a signalled process gets to exit on its own before it is killed outright.
 *
 * ONE value, as of M13 Series B. There were three escalations in this repo -- `packages/control`'s
 * `killWithEscalation`, `pause-signal.ts`'s `terminatePid`, and each adapter's `terminateChild` --
 * and `pause-signal.ts`'s own comment explained why it was written a third time: `packages/control`
 * DEPENDS on this package, so importing it back would be a cycle. The fix is the direction, not the
 * duplication: the primitive lives below `control`, and `control/src/kill.ts` re-exports it
 * (M13 Decision 6).
 */
export const KILL_GRACE_MS = 2_000

/** How often the grace window is re-checked, so a process that dies at once is not waited out. */
const DEATH_POLL_MS = 25

export function isAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else -- alive, just not ours to
    // inspect. Only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function signalRun(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, DEATH_POLL_MS))
  }
  return !isAlive(pid)
}

/**
 * SIGTERM, a polled grace window, then SIGKILL. Returns whether anything was signalled.
 *
 * Polled rather than sleeping the whole grace period, so the common case -- a process that exits
 * promptly on SIGTERM -- costs milliseconds instead of seconds inside an emergency stop's per-run
 * loop. A process that IGNORES SIGTERM still costs the whole window, which is what makes the
 * orchestrator's `pause_requested` interval observable (M13 Task 1).
 */
export async function killWithEscalation(pid: number | null, graceMs: number = KILL_GRACE_MS): Promise<boolean> {
  const signalled = signalRun(pid, 'SIGTERM')
  // `false` means the process is already gone (ESRCH) or there was never a pid. Nothing to
  // escalate against.
  if (!signalled || pid === null) return signalled
  if (await waitForExit(pid, graceMs)) return true
  signalRun(pid, 'SIGKILL')
  await waitForExit(pid, graceMs)
  return true
}

/**
 * The same escalation against a live `ChildProcess` this process spawned.
 *
 * A separate entry point rather than `killWithEscalation(child.pid)` because a spawner has
 * something a pid-holder does not: the `exit` event, which resolves the moment the child is reaped
 * rather than at the next poll, and `exitCode`/`signalCode`, which say the child is already gone
 * without signalling anything at all.
 */
export function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
    }, graceMs)

    child.once('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })

    child.kill('SIGTERM')
  })
}

/**
 * The environment every runtime's child is spawned with (ADR 0001, "Concurrency and the git common
 * directory").
 *
 * Identity is supplied per-process rather than by writing `git config`: two concurrent M0 agents
 * both hit the same missing-identity failure, and the one that recovered with an unscoped
 * `git config user.name/user.email` wrote into the repo-wide `.git/config`, which every worktree
 * shares. Environment variables are per-process, write no file, and cannot leak to a sibling
 * worktree's run.
 *
 * `AITEAMOS_PAUSE_FLAG` is the ONE channel either gate reads the flag path on -- the same variable
 * `scripts/pause-gate.sh` and `scripts/cursor-shell-gate.sh` read. One concept, one name, whichever
 * runtime the run is on.
 */
export function buildChildEnv(input: {
  readonly gitIdentity: { readonly name: string; readonly email: string }
  readonly pauseFlagPath: string
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: input.gitIdentity.name,
    GIT_AUTHOR_EMAIL: input.gitIdentity.email,
    GIT_COMMITTER_NAME: input.gitIdentity.name,
    GIT_COMMITTER_EMAIL: input.gitIdentity.email,
    AITEAMOS_PAUSE_FLAG: input.pauseFlagPath,
  }
}
```

Note the parameter type: Claude's copy took a whole `StartRunInput` but read only these two
fields, and Cursor's already took the narrow shape. The narrow shape is what both call sites pass.

- [ ] **Step 3: Turn `control/src/kill.ts` into a re-export**

Replace the entire contents of `packages/control/src/kill.ts` with:

```typescript
/**
 * Signalling a run's process directly, by pid.
 *
 * The adapter cannot do this from here: its registry of live children is per-process, and a CLI
 * invocation is a *different* process from the daemon that spawned the run -- so `adapter.cancel`
 * would throw "no run found" for every run there is. The pid is in the row; that is what it is for.
 *
 * The IMPLEMENTATION moved down to `packages/providers/src/runtime/process.ts` in M13 (Decision 6):
 * `packages/control` depends on `packages/providers`, so a vendor-neutral primitive both packages
 * need can only live in the lower one. This file stays so its importers do not move -- `pump.ts`,
 * `sweep.ts`, the gate scripts and `emergency.ts` all reach these through `@ai-team-os/control`.
 */
export { KILL_GRACE_MS, isAlive, killWithEscalation, signalRun } from '@ai-team-os/providers'
```

- [ ] **Step 4: Delete `pause-signal.ts`'s third copy**

In `packages/providers/src/pause-signal.ts`, delete lines 61-65 (`CURSOR_KILL_GRACE_MS`,
`DEATH_POLL_MS`) and 123-168 (`terminatePid`, `sendSignal`, `isAlive`, `waitForExit`). Import
`killWithEscalation` from `../runtime/process.js` — relative, since this file is in the same
package — and change the one call site:

```typescript
  await writeFile(state.pauseFlagPath, `${reason}\n`, 'utf8')
  await killWithEscalation(state.pid)
```

The docstring on `signalTerminatingPause` that says the escalation is "written here a third time
because neither is reachable" is now false; replace that paragraph with a pointer to
`runtime/process.ts`.

- [ ] **Step 5: Delete both adapters' copies**

- `claude/adapter.ts`: delete `buildChildEnv` (lines 237-256, docstring included) and the
  `terminateChild` method (lines 637-657). Import
  `import { buildChildEnv, terminateChild } from '../runtime/process.js'`; change the two
  `buildChildEnv(input)` / `buildChildEnv(resumedInput)` call sites (lines 384, 631) to pass the
  narrow shape — `buildChildEnv({ gitIdentity: input.gitIdentity, pauseFlagPath: input.pauseFlagPath })`
  — and the one `await this.terminateChild(child)` (line 500) to
  `await terminateChild(child, this.killGraceMs)`.
- `cursor/adapter.ts`: the same deletions at lines 170-190 and 513-533, the same import, the same
  rewrite at lines 273, 334 and 351.
- Both keep their own `DEFAULT_KILL_GRACE_MS = 5_000` and `killGraceMs` option: that is an adapter
  option, not the cross-process primitive, and changing it would be a behavior change.
- `packages/providers/src/index.ts`: add `export * from './runtime/process.js'` beside the two
  runtime exports Task 5 added.

- [ ] **Step 6: Prove the suite is still green, unchanged**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS with the same counts as Step 1, and `git status --short` showing no test file
modified.

- [ ] **Step 7: Count the deletions**

Run: `git diff --numstat -- packages/control/src/kill.ts packages/providers/src/pause-signal.ts packages/providers/src/claude/adapter.ts packages/providers/src/cursor/adapter.ts`
Expected: roughly 130 lines deleted. Record the exact figure.

- [ ] **Step 8: Commit**

```bash
git add packages/providers/src/runtime/process.ts packages/providers/src/pause-signal.ts packages/providers/src/claude/adapter.ts packages/providers/src/cursor/adapter.ts packages/providers/src/index.ts packages/control/src/kill.ts
git commit -m "refactor(providers): the kill primitive has one home, below control"
```

---

### Task 7: `runtime/pause-flag.ts` and `runtime/gate-preflight.ts`

**Files:**
- Create: `packages/providers/src/runtime/pause-flag.ts`
- Create: `packages/providers/src/runtime/gate-preflight.ts`
- Modify: `packages/providers/src/claude/adapter.ts:268-296` (delete
  `clearAndVerifyPauseFlagAbsent`)
- Modify: `packages/providers/src/cursor/adapter.ts:192-218` (delete the same)
- Modify: `packages/providers/src/claude/flags.ts:62-115` (delete `HookRunResult`,
  `runHookScript`) and `:148-187` (delete `preflightGate`'s body and `withFlagFile`)
- Modify: `packages/providers/src/cursor/flags.ts:189-244` (delete `GateRunResult`,
  `runGateScript`) and `:142-170` (`cursorPreflightGate` delegates)
- Modify: `packages/providers/src/index.ts`

**Interfaces:**
- Produces:

```typescript
// packages/providers/src/runtime/pause-flag.ts
export async function clearAndVerifyPauseFlagAbsent(input: {
  readonly flagPath: string
  readonly runId: string
  /** The adapter class name that opens the error, e.g. `'ClaudeCodeAdapter'`. */
  readonly adapterName: string
  /** What denies on this runtime -- `'hook'` for Claude, `'gate'` for Cursor. */
  readonly gateNoun: string
}): Promise<void>
```

```typescript
// packages/providers/src/runtime/gate-preflight.ts
export interface GateRunResult {
  readonly stdout: string
  readonly exitCode: number | null
}

/** Spawns the gate script with `AITEAMOS_PAUSE_FLAG` set, having first armed or disarmed the flag. */
export function runGateScript(input: {
  readonly hookPath: string
  readonly flagPath: string
  readonly flagPresent: boolean
}): Promise<GateRunResult>

/**
 * How the runtime spells an allow. Claude's is SILENCE; Cursor's must be an explicit payload,
 * because Cursor classifies exit 0 with empty stdout as a hook FAILURE which `failClosed` converts
 * into a block.
 */
export type AllowContract =
  | { readonly kind: 'silent' }
  | { readonly kind: 'explicit'; readonly allowedBy: (stdout: string) => boolean; readonly hint: string }

export async function preflightGate(input: {
  readonly hookPath: string
  /** Opens both error messages: `'preflightGate'` or `'cursorPreflightGate'`. */
  readonly label: string
  /** What the message calls the script: `'hook'` or `'gate'`. */
  readonly noun: string
  readonly deniedBy: (stdout: string) => boolean
  readonly expectAllow: AllowContract
}): Promise<void>
```

`claude/flags.ts` keeps exporting `preflightGate({ hookPath })` — its own thin wrapper, same
signature every caller already uses — and `cursor/flags.ts` keeps exporting
`cursorPreflightGate({ gatePath })`. Nothing outside this package changes.

- [ ] **Step 1: Prove the suite is green before touching anything**

Run: `npm test`
Expected: PASS. Record the summary line.

- [ ] **Step 2: Write `pause-flag.ts`**

```typescript
// packages/providers/src/runtime/pause-flag.ts
import { rm, stat } from 'node:fs/promises'
import { isRecord } from './summary.js'

/**
 * Clears `flagPath` and verifies it is actually gone -- the load-bearing half of every runtime's
 * `resume()` contract (ADR 0001 §5/§6, findings 3.10, 4.2).
 *
 * A plain `rm` succeeding is not itself proof the flag is absent: `rm(path, { force: true })`
 * without `recursive: true` throws rather than removing a DIRECTORY sitting at `flagPath` (an
 * anomalous but real way a "flag file" can fail to be a plain file), and `force` only ever
 * suppresses the file-already-missing case. Swallowing whatever `rm` throws and treating the
 * following `stat` as the single source of truth is simpler than classifying every way removal can
 * fail, and just as safe: either the flag is gone, in which case nothing above needed to know why,
 * or it is still there, in which case this throws regardless of the reason.
 *
 * `adapterName` and `gateNoun` keep each runtime's message byte-identical to the one it raised
 * before this function was shared -- Claude says "the hook deny", Cursor says "the gate deny",
 * and both name their own class so an operator reading a stack knows which runtime refused.
 */
export async function clearAndVerifyPauseFlagAbsent(input: {
  readonly flagPath: string
  readonly runId: string
  readonly adapterName: string
  readonly gateNoun: string
}): Promise<void> {
  try {
    await rm(input.flagPath, { force: true })
  } catch {
    // Deliberately swallowed -- see the function comment. The `stat` below decides.
  }
  try {
    await stat(input.flagPath)
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return // confirmed absent -- safe to resume
    throw error
  }
  throw new Error(
    `${input.adapterName}: refusing to resume run ${input.runId} -- its pause flag at ${input.flagPath} ` +
      'still exists after an attempt to clear it. Resuming with the flag present would have the ' +
      `${input.gateNoun} deny every tool call the resumed run attempts, producing a run that looks ` +
      'like a pause loop rather than a resumed one.',
  )
}
```

- [ ] **Step 3: Write `gate-preflight.ts`**

```typescript
// packages/providers/src/runtime/gate-preflight.ts
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GateRunResult {
  readonly stdout: string
  readonly exitCode: number | null
}

/**
 * Spawns the gate script directly (never through a vendor CLI) with `AITEAMOS_PAUSE_FLAG` pointing
 * at `flagPath`, having first created or removed the flag file itself.
 *
 * Both gate scripts open with `cat > /dev/null`, draining what the real CLI would have piped in as
 * the hook payload. Spawned from Node with piped stdio, nothing ever ends that pipe, so the drain
 * would block forever and the probe would hang rather than pass or fail -- `stdin.end()` below is
 * the EOF a real invocation would have supplied.
 */
export async function runGateScript(input: {
  readonly hookPath: string
  readonly flagPath: string
  readonly flagPresent: boolean
}): Promise<GateRunResult> {
  if (input.flagPresent) {
    await writeFile(input.flagPath, '')
  } else {
    await rm(input.flagPath, { force: true })
  }

  return new Promise<GateRunResult>((resolve, reject) => {
    const child = spawn(input.hookPath, [], {
      env: { ...process.env, AITEAMOS_PAUSE_FLAG: input.flagPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // Drained, not asserted on: a real failure path (exit 2) reports its reason on stderr for the
    // vendor CLI, not for this probe, whose verdict is stdout shape plus exit code.
    child.stderr.resume()

    child.once('error', fail)
    child.once('close', (exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve({ stdout, exitCode })
    })

    child.stdin.end()
  })
}

/**
 * How the runtime spells an allow, and the whole reason this function is parameterized at all.
 *
 * Claude's gate allows by staying SILENT. Cursor's must speak: it classifies exit 0 with empty
 * stdout as a hook FAILURE (`empty_stdout`), which `failClosed: true` converts into a block, so a
 * silent Cursor gate would block every tool call of every run while looking correctly installed.
 */
export type AllowContract =
  | { readonly kind: 'silent' }
  | { readonly kind: 'explicit'; readonly allowedBy: (stdout: string) => boolean; readonly hint: string }

/**
 * Design spec §5.5's pre-flight gate check, run once before a run is considered pausable. Spawns
 * the script directly, twice, and asserts BOTH directions:
 *
 * - flag file present -> the runtime's deny shape, exit 0
 * - flag file absent  -> the runtime's allow shape, exit 0
 *
 * One direction is not enough. Both gate scripts also fail loudly when `AITEAMOS_PAUSE_FLAG` is
 * unset -- their deliberate loud-misconfiguration path -- so a check that only asserts "flag
 * present => deny" is satisfied by a script that denies unconditionally, which gates nothing: the
 * run would refuse its first tool call regardless of whether pause was ever requested, while
 * looking armed. Asserting the second direction is what proves the script discriminates.
 *
 * `flagPath` is deliberately NOT a parameter. This check arms and disarms a flag file to probe the
 * script, and a caller-supplied path would make it possible -- by accident -- to point that at a
 * live run's own `pauseFlagPath`, silently disarming that run's gate mid-flight. Minting an
 * isolated temporary flag file internally, in its own directory removed afterward regardless of
 * outcome, makes that mistake impossible to make rather than just documented against.
 *
 * What this does NOT prove: that the vendor CLI will actually invoke the script. A correct,
 * discriminating gate registered under a matcher that never matches, or named in a settings file
 * the CLI never loads, passes this check and still gates nothing. It is a cheap necessary condition
 * on the script itself, not a sufficient one on the wiring around it.
 */
export async function preflightGate(input: {
  readonly hookPath: string
  readonly label: string
  readonly noun: string
  readonly deniedBy: (stdout: string) => boolean
  readonly expectAllow: AllowContract
}): Promise<void> {
  const { hookPath, label, noun } = input
  const dir = await mkdtemp(join(tmpdir(), 'aiteamos-preflight-'))
  const flagPath = join(dir, 'pause.flag')

  try {
    const armed = await runGateScript({ hookPath, flagPath, flagPresent: true })
    if (armed.exitCode !== 0 || !input.deniedBy(armed.stdout)) {
      throw new Error(
        `${label}: ${noun} at ${hookPath} did not deny with the pause flag present ` +
          `(exit code ${String(armed.exitCode)}, stdout ${JSON.stringify(armed.stdout)}). ` +
          'A working pause gate must deny every tool call while the flag file exists.',
      )
    }

    const disarmed = await runGateScript({ hookPath, flagPath, flagPresent: false })
    const allowed =
      input.expectAllow.kind === 'silent'
        ? disarmed.stdout.trim() === ''
        : input.expectAllow.allowedBy(disarmed.stdout)
    if (disarmed.exitCode !== 0 || !allowed) {
      throw new Error(
        `${label}: ${noun} at ${hookPath} did not allow with the pause flag absent ` +
          `(exit code ${String(disarmed.exitCode)}, stdout ${JSON.stringify(disarmed.stdout)}). ` +
          'A hook that denies with the flag both present and absent gates nothing -- it is not an ' +
          'armed gate, it is a broken run.' +
          (input.expectAllow.kind === 'explicit' ? input.expectAllow.hint : ''),
      )
    }
  } finally {
    // The whole temporary directory, not just the flag file: this is the only thing this check
    // ever created, so removing it leaves nothing behind regardless of which branch above ran or
    // threw.
    await rm(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: Rewire the two adapters**

- `claude/adapter.ts`: delete lines 268-296, import
  `import { clearAndVerifyPauseFlagAbsent } from '../runtime/pause-flag.js'`, and change the call
  site at line 591 to:

```typescript
    await clearAndVerifyPauseFlagAbsent({
      flagPath: checkpoint.pauseFlagPath,
      runId,
      adapterName: 'ClaudeCodeAdapter',
      gateNoun: 'hook',
    })
```

- `cursor/adapter.ts`: delete lines 192-218, the same import, and at line 315:

```typescript
    await clearAndVerifyPauseFlagAbsent({
      flagPath: checkpoint.pauseFlagPath,
      runId,
      adapterName: 'CursorAdapter',
      gateNoun: 'gate',
    })
```

- [ ] **Step 5: Rewire the two flag modules**

`claude/flags.ts` keeps `denyOutputSchema`/`isDenyOutput` and becomes:

```typescript
import { preflightGate as runPreflight } from '../runtime/gate-preflight.js'

export async function preflightGate(input: { readonly hookPath: string }): Promise<void> {
  // Claude's allow is SILENCE (ADR 0001 §5.3): exit 0, empty stdout. That is the whole difference
  // from Cursor's contract, and it is why `expectAllow` exists on the shared probe at all.
  return runPreflight({
    hookPath: input.hookPath,
    label: 'preflightGate',
    noun: 'hook',
    deniedBy: isDenyOutput,
    expectAllow: { kind: 'silent' },
  })
}
```

`cursor/flags.ts` keeps `hookResponseSchema`/`permissionOf` and becomes:

```typescript
import { preflightGate as runPreflight } from '../runtime/gate-preflight.js'

export async function cursorPreflightGate(input: { readonly gatePath: string }): Promise<void> {
  return runPreflight({
    hookPath: input.gatePath,
    label: 'cursorPreflightGate',
    noun: 'gate',
    deniedBy: (stdout) => permissionOf(stdout) === 'deny',
    expectAllow: {
      kind: 'explicit',
      allowedBy: (stdout) => permissionOf(stdout) === 'allow',
      hint:
        ' Note that SILENCE is not an allow here: Cursor reads exit 0 with empty stdout as a hook ' +
        'failure, which fails closed.',
    },
  })
}
```

Delete `withFlagFile` and `runHookScript` from `claude/flags.ts` and `runGateScript`/`GateRunResult`
from `cursor/flags.ts`; both now come from the shared module. Add
`export * from './runtime/pause-flag.js'` and `export * from './runtime/gate-preflight.js'` to
`packages/providers/src/index.ts`.

**Name collision check:** `packages/providers/src/index.ts` would now export `preflightGate` from
both `claude/flags.js` and `runtime/gate-preflight.js`. Export the runtime module's under an alias
so the barrel stays unambiguous and `claude/flags.ts`'s public `preflightGate` keeps its name:

```typescript
export { runGateScript, type AllowContract, type GateRunResult } from './runtime/gate-preflight.js'
```

(The generic `preflightGate` is package-internal; nothing outside `packages/providers` calls it.)

- [ ] **Step 6: Prove the suite is still green, unchanged**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS with the same counts as Step 1. `packages/providers/test/flags.test.ts` and
`cursor-flags.test.ts` are the freeze proof and must not be edited.

- [ ] **Step 7: Count the deletions**

Run: `git diff --numstat -- packages/providers/src/claude packages/providers/src/cursor`
Expected: roughly 140 lines deleted. Record the exact figure.

- [ ] **Step 8: Byte-diff Claude's on-disk mechanism against `main`**

Spec §4.3's closing requirement. Run:

```bash
git diff main -- packages/providers/src/claude/settings.ts
node -e "import('./packages/providers/dist/claude/settings.js').then((m) => console.log(JSON.stringify(m.buildSettings({ hookPath: '/abs/pause-gate.sh' }))))"
```

Expected: the first prints nothing (the settings shape is untouched), and the second prints the
same JSON it prints on `main`. Paste both into the task report. The flag path and the hook contract
are covered by the unchanged `settings.test.ts` and `pause-gate.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/providers/src/runtime/pause-flag.ts packages/providers/src/runtime/gate-preflight.ts packages/providers/src/claude/adapter.ts packages/providers/src/claude/flags.ts packages/providers/src/cursor/adapter.ts packages/providers/src/cursor/flags.ts packages/providers/src/index.ts
git commit -m "refactor(providers): one pause-flag clear and one pre-flight probe serve both runtimes"
```

---

### Task 8: `scripts/lib/pause-flag.sh` — one encoder, and a directory is no longer an allow

**Files:**
- Create: `scripts/lib/pause-flag.sh`
- Modify: `scripts/pause-gate.sh:32-47` (`json_string`), `:49-78` (`deny`), `:80-134` (the body)
- Modify: `scripts/cursor-shell-gate.sh:75-106` (`json_string`), `:119-142` (`deny`), `:153-194`
  (the body)
- Test: `packages/providers/test/pause-gate.test.ts`
- Test: `packages/providers/test/cursor-shell-gate.test.ts`

**This is the one Series B task with a RED phase**, because it is the one that changes behavior.
Spec §4.2 names exactly two changes, and this task makes those two and nothing else.

1. **The argv hole, closed where it is shared.** `pause-gate.sh`'s `json_string` still passes the
   operator's reason as a bare `node` argv word, so a reason beginning with `-` is eaten as a node
   option: `--version` prints node's own version string and exits 0 — a MALFORMED DENY
   indistinguishable from a well-formed one at the exit-code/stdout-shape level — and `-e x` fails
   with `bad option`. `cursor-shell-gate.sh` already fixed this on its own copy in M12; the shared
   function fixes it once, for both, and carries the leading-`"` guard with it.
2. **A directory is no longer an allow.** Today `[[ -f "$AITEAMOS_PAUSE_FLAG" ]]` is false for a
   directory, so both gates fall through to their allow path. M12 deferred this; §4.2 closes it for
   both: a path that is present but is not a regular file, or that cannot be read, is exit 2.

**What this task deliberately does NOT change: the unset/empty `AITEAMOS_PAUSE_FLAG` path.** Both
gates today answer it with a DENY PAYLOAD at exit 0 — fail-closed and operator-readable, because
the deny body carries the explanation to whoever is watching the run rather than burying it in a
hook-failure message. That behavior is unchanged on both gates, its three existing assertions in
the two test files are not edited, and both scripts keep their current header-comment wording for
it. The shared helper reports the misconfiguration with a distinct return status and lets each gate
render it in its own deny shape, because the two shapes differ (Claude's reason lives in
`hookSpecificOutput.permissionDecisionReason`, Cursor's in `user_message`).

**Interfaces:**
- Produces (bash, sourced — not executed):

```bash
# scripts/lib/pause-flag.sh
# json_string <text>
#   Writes JSON.stringify(<text>) to stdout. Returns non-zero (writing nothing) when the encoder
#   failed or produced something that is not a JSON string.
# read_pause_reason
#   Sets the global PAUSE_REASON and returns:
#     0 -- a pause is requested; PAUSE_REASON is the operator-facing reason.
#     1 -- no pause is requested; PAUSE_REASON is untouched.
#     2 -- AITEAMOS_PAUSE_FLAG is unset or empty; PAUSE_REASON is the misconfiguration message the
#          caller must DENY with, in its own deny shape (unchanged behaviour on both gates).
#   EXITS 2 (never returns) when the flag path is present but is not a readable regular file.
#   Requires the caller to have set PAUSE_GATE_NAME.
```

Each gate keeps its own output contract in its own file (spec §4.2): Claude's allow is silence,
Cursor's is `{"permission":"allow"}`; Claude's deny body is
`hookSpecificOutput.permissionDecisionReason`, Cursor's key is `user_message`.

- [ ] **Step 1: Write the failing tests**

In `packages/providers/test/pause-gate.test.ts`, add the two argv rows to `REASONS` — this extends
an existing table, it does not re-point any assertion:

```typescript
  const REASONS = [
    'plain reason',
    'has "double quotes"',
    'has \\ backslash',
    'has\nnewline',
    'has\ttab',
    'unicode ünïcödé and emoji 🚀',
    // A reason beginning with `-` is eaten as a `node` option if the encoder passes the operator's
    // text as a bare argv word: `--version` prints node's own version string and exits 0 (a
    // MALFORMED DENY that looks like a well-formed one), and `-e ...` is parsed as inline source
    // and fails with `bad option`. `cursor-shell-gate.sh` closed this on its own copy in M12;
    // M13 closes it in the shared encoder, so both gates are covered by one fix.
    '--version',
    '-e x',
  ]
```

and add one new test — `pause-gate.test.ts` has no directory case today, so this is an addition,
not an edit:

```typescript
  // M13 §4.2 closes M12's deferred "a directory is an allow": a path that is present but is not a
  // regular file is a broken configuration, and a gate that allows on it stops gating the moment
  // someone `mkdir`s the flag path. Exit 2 is the measured fail-closed code for a PreToolUse hook
  // (exit codes 1, 126 and 127 all fail OPEN).
  it('exits 2 when the flag path names a directory rather than a file', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-dir-'))
    try {
      const { stdout, code } = await runHook({ flagVar: dir })
      expect(code).toBe(2)
      expect(stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

The existing `'denies loudly when AITEAMOS_PAUSE_FLAG is unset'` test (line 127) is **not touched**.

In `packages/providers/test/cursor-shell-gate.test.ts`, the `REASONS` table already carries
`--version` and `-e x`, and the two `'denies loudly when AITEAMOS_PAUSE_FLAG is unset/empty'` tests
(lines 164-179) are **not touched**. The single pre-existing assertion this task re-points is the
directory test at lines 192-201, which flips from allow to exit 2:

```typescript
  // Was an ALLOW through M12 ("a directory is not a file, so `-f` is false"), pinned because the
  // alternative reading looked like the tempting one. M13 §4.2 rules the other way for both gates:
  // present-but-not-a-regular-file is a broken configuration, and exit 2 is Cursor's own blocking
  // exit code (measured: exit 2 stopped the command outright, while exit 1 with garbage on stdout
  // let it through).
  it('exits 2 when the flag path names a directory rather than a file', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-cursor-gate-dir-'))
    try {
      const { stdout, code } = await runHook({ flagVar: dir })
      expect(code).toBe(2)
      expect(stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run both and watch them fail**

Run: `npx vitest run packages/providers/test/pause-gate.test.ts packages/providers/test/cursor-shell-gate.test.ts`
Expected: FAIL — four failures, and no others:
- `pause-gate.sh` on `--version`: `SyntaxError: Unexpected token 'v'` out of `JSON.parse(stdout)`,
  because node printed its own version string instead of a deny payload.
- `pause-gate.sh` on `-e x`: node exits non-zero, the script's encode guard fires, and the hook
  exits 2 with empty stdout — so `JSON.parse('')` throws.
- `pause-gate.sh` on a directory: `expected 0 to be 2` (it allows silently today).
- `cursor-shell-gate.sh` on a directory: `expected 0 to be 2` (it emits an explicit allow today).

The unset/empty tests in both files must still PASS at this point and after — they are the proof
that path did not move.

- [ ] **Step 3: Write the shared library**

```bash
# scripts/lib/pause-flag.sh
# Shared by scripts/pause-gate.sh (Claude's PreToolUse hook) and scripts/cursor-shell-gate.sh
# (Cursor's beforeShellExecution/preToolUse hook). SOURCED, never executed: it defines two
# functions and sets no traps, no options and no exit status of its own.
#
# The caller must set PAUSE_GATE_NAME to its own script name before calling read_pause_reason --
# every message this file writes to stderr is prefixed with it, so an operator reading stderr knows
# which gate spoke.
#
# WHAT LIVES HERE AND WHAT DOES NOT. The two gates' OUTPUT contracts differ and stay in their own
# files: Claude allows by staying silent and carries its deny reason in
# hookSpecificOutput.permissionDecisionReason; Cursor must emit {"permission":"allow"} out loud
# (it classifies exit 0 with empty stdout as a hook FAILURE) and its operator-message key is
# user_message. That is also why read_pause_reason REPORTS the unset-variable case rather than
# answering it: the answer is a deny payload, and only the caller knows how to spell one.
# What is shared is the part that had drifted: how a string becomes JSON, and how the pause flag
# is interrogated.

# JSON-encodes a single string the way node's JSON.stringify does: escapes quotes, backslashes and
# control characters, passes valid UTF-8 through unchanged, and never emits a raw newline (control
# characters come back as their two-character escapes). `node` is a hard runtime requirement of this
# monorepo (root package.json: "engines": { "node": ">=26" }) and is therefore present on any host
# able to run the orchestrator that spawns this hook, so this adds no dependency the way reaching
# for `jq` would.
#
# THE STRING IS PASSED ON STDIN, NOT AS A node ARGV WORD, and that is the whole reason this
# function is shared rather than copied. An operator-chosen reason beginning with `-` (say,
# `--version` or `-e x`) is otherwise parsed by node ITSELF as an option rather than reaching
# process.argv. Measured against the argv form: `--version` printed node's own version string with
# exit 0 -- a MALFORMED DENY indistinguishable from a well-formed one at the exit-code/stdout-shape
# level -- and `-e x` failed with `bad option`. Piping instead of a `node -- "$1"` end-of-options
# separator also means this never depends on every future call site remembering to add one.
#
# The leading-`"` guard is the second half. A well-formed JSON.stringify of a string always starts
# with `"`; checking that, not just "nonempty", is what catches a future encoder regression (an
# option misparse, a stray diagnostic on stdout) that produces innocuous-looking but non-JSON text
# with node's own exit 0. A malformed deny is an allow (ADR 0001 §7).
json_string() {
  local encoded
  encoded=$(printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => { process.stdout.write(JSON.stringify(s)); });
  ')
  local status=$?
  if [[ $status -ne 0 || -z "$encoded" || "${encoded:0:1}" != '"' ]]; then
    return 1
  fi
  printf '%s' "$encoded"
  return 0
}

# The operator-facing message, when there is one.
#
# Set by read_pause_reason rather than written to stdout, deliberately: a command substitution
# strips trailing newlines, and the reason must survive byte-for-byte -- neither gaining nor losing
# trailing whitespace depending on how the caller wrote the flag file (`printf '%s'` vs `echo`).
PAUSE_REASON=''

# The message both gates deny with when the flag path was never supplied. UNCHANGED wording, and
# unchanged handling: the caller denies with it at exit 0.
#
# There is deliberately no shared-default fallback path. In an autonomous system running several
# agents concurrently, pause is the operator's only intervention lever: silently falling back to one
# hardcoded path would let pausing one agent inadvertently freeze an unrelated one sharing that
# default, and silently allowing would disable the lever without anyone noticing. Denying loudly,
# naming the misconfiguration, is the least harmful of the three -- it surfaces at the first tool
# call instead of during an incident, and it surfaces IN THE DENY BODY, where the operator watching
# the run is already looking.
PAUSE_FLAG_UNSET_MESSAGE='AITEAMOS_PAUSE_FLAG is unset or empty -- refusing to fall back to a shared default path. Set AITEAMOS_PAUSE_FLAG explicitly for this run before retrying.'

# Interrogates the pause flag. The contract both gates share (M13 §4.2):
#
#   AITEAMOS_PAUSE_FLAG unset or empty        -> return 2, PAUSE_REASON = PAUSE_FLAG_UNSET_MESSAGE.
#                                                The caller DENIES with it, exit 0. Unchanged from
#                                                M12 on both gates.
#   the path does not exist                   -> return 1. No pause. The ordinary case.
#   the path exists but is not a regular file -> exit 2. NEW in M13: closes M12's deferred "a
#                                                directory is an allow". A gate that allows the
#                                                moment someone mkdirs the flag path has stopped
#                                                gating, and unlike the unset case there is no
#                                                reason to trust that a deny body would even be
#                                                readable -- nothing here can produce one.
#   the path cannot be read                   -> exit 2. Same class as a write failure: we cannot
#                                                produce a well-formed answer, so we must not fall
#                                                through to one that reads as allow. Unchanged from
#                                                M12 on both gates.
#   otherwise                                 -> return 0 with PAUSE_REASON set.
#
# Every exit here is exactly 2 and never any other nonzero status, on BOTH runtimes, and both were
# measured: a Claude PreToolUse hook that exits 2 fails CLOSED while 1, 126 and 127 all fail OPEN;
# a Cursor hook that exits 2 stops the command outright while one that exits 1 with garbage on
# stdout lets it through.
read_pause_reason() {
  local name="${PAUSE_GATE_NAME:-pause gate}"

  if [[ -z "${AITEAMOS_PAUSE_FLAG:-}" ]]; then
    PAUSE_REASON="$PAUSE_FLAG_UNSET_MESSAGE"
    return 2
  fi

  if [[ ! -e "$AITEAMOS_PAUSE_FLAG" ]]; then
    return 1
  fi

  if [[ ! -f "$AITEAMOS_PAUSE_FLAG" ]]; then
    printf '%s: the pause flag path %s exists but is not a regular file. A gate cannot read a pause reason out of it, and allowing on it would silently disarm this run.\n' \
      "$name" "$AITEAMOS_PAUSE_FLAG" >&2
    exit 2
  fi

  # Read byte-for-byte, not stripped: a bare `$(cat ...)` would silently drop every trailing
  # newline the file contains. The `&& printf x` / `${var%x}` pair is the standard shell sentinel
  # trick for defeating that stripping -- append one literal byte after the file's content inside
  # the same command substitution, so whatever trailing newlines the file had are no longer
  # trailing, then peel off exactly that one sentinel byte with a parameter expansion (not a second
  # command substitution, which would reintroduce the same stripping one layer up).
  local raw
  raw=$(cat "$AITEAMOS_PAUSE_FLAG" && printf x)
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf '%s: failed to read the pause flag file at %s (exit %s)\n' "$name" "$AITEAMOS_PAUSE_FLAG" "$status" >&2
    exit 2
  fi
  raw=${raw%x}

  # An empty flag file keeps the static message: that is what every caller wrote before the reason
  # channel existed, and what the pre-flight probe's own `writeFile(flagPath, '')` leaves behind.
  PAUSE_REASON="${raw:-Paused by AI Team OS. Stop and wait.}"
  return 0
}
```

`chmod` is deliberately NOT applied — this file is sourced, not executed.

- [ ] **Step 4: Rewrite `scripts/pause-gate.sh`'s body**

Keep the header comment block (lines 1-31) with its exit-code contract as it stands — the
unset/empty clause is unchanged — and add ONE clause to it, beside the existing
"Write failure / crash: exit 2":

```bash
#   - Flag path present but not a readable regular file: exit 2, reason on
#     stderr. A directory (or an unreadable file) at the flag path is a broken
#     configuration, not "no pause requested"; M13 §4.2 closes what M12
#     deferred, for both gates at once.
```

Then replace `json_string` (32-47), `deny` (49-78) and the body (80-134) with:

```bash
PAUSE_GATE_NAME='pause-gate.sh'
# shellcheck source=lib/pause-flag.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/pause-flag.sh"

# Fails loudly on stderr and exits 2 -- the measured fail-closed exit code for a PreToolUse hook.
# Used for every case where this script cannot produce a well-formed answer, so that "the gate
# broke" can never be mistaken for "the gate allowed". Writes nothing to stdout: an exit 0 with no
# body is exactly what an allow looks like.
fail_closed() {
  printf 'pause-gate.sh: %s\n' "$1" >&2
  exit 2
}

deny() {
  local reason="$1"
  local encoded_reason
  encoded_reason=$(json_string "$reason") || fail_closed "failed to JSON-encode the deny reason (reason was: ${reason})"

  local payload
  payload=$(printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}' "$encoded_reason")
  # Single printf call, one line, well under PIPE_BUF (4096 bytes on Linux) -- writes at this size
  # are atomic to a pipe, so this either delivers the complete deny JSON or none of it. json_string
  # never introduces a raw newline, so this stays one line regardless of what the reason contains.
  if printf '%s\n' "$payload"; then
    exit 0
  fi
  fail_closed "failed to write the deny payload (reason was: ${reason})"
}

cat > /dev/null   # drain the hook payload on stdin

read_pause_reason
pause_status=$?
case $pause_status in
  # An operator asked. The flag file's own contents carry the message.
  0) deny "$PAUSE_REASON" ;;
  # No flag path was supplied. Denied loudly, in the deny BODY, at exit 0 -- unchanged from M12,
  # and the reason the shared helper reports this case rather than answering it: only this file
  # knows how Claude spells a deny.
  2) deny "$PAUSE_REASON" ;;
esac

# Status 1: no pause requested. Claude's allow is silence.
exit 0
```

- [ ] **Step 5: Rewrite `scripts/cursor-shell-gate.sh`'s body**

Keep the header (lines 1-73) as it stands, including its unset/empty wording, and point its
`json_string` paragraph at `lib/pause-flag.sh` for the shared half. Insert immediately after the
`set -uo pipefail` block:

```bash
PAUSE_GATE_NAME='cursor-shell-gate.sh'
# shellcheck source=lib/pause-flag.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/pause-flag.sh"
```

Delete the local `json_string` (75-106). `fail_closed`, `deny` and `allow` stay where they are;
`deny`'s encode step becomes the shared form:

```bash
deny() {
  local reason="$1"
  local encoded_reason
  encoded_reason=$(json_string "$reason") || fail_closed "failed to JSON-encode the deny reason (reason was: ${reason})"

  local payload
  payload=$(printf '{"permission":"deny","user_message":%s}' "$encoded_reason")
  # Single printf call, one line, well under PIPE_BUF -- atomic to a pipe at this size, and
  # json_string never introduces a raw newline, so this stays one line whatever the reason holds.
  if printf '%s\n' "$payload"; then
    exit 0
  fi
  fail_closed "failed to write the deny payload (reason was: ${reason})"
}
```

and the body (153-194) becomes:

```bash
cat > /dev/null   # drain the hook payload on stdin

read_pause_reason
pause_status=$?
case $pause_status in
  0) deny "$PAUSE_REASON" ;;
  # Unchanged from M12: no flag path is a deny with a body, at exit 0, not a hook failure.
  2) deny "$PAUSE_REASON" ;;
esac

# Status 1: no pause requested. Cursor's allow must say so OUT LOUD -- silence here is read as a
# hook failure, which `failClosed: true` converts into a block on every tool call of every run.
allow
```

- [ ] **Step 6: Run the gate tests to green**

Run: `npx vitest run packages/providers/test/pause-gate.test.ts packages/providers/test/cursor-shell-gate.test.ts packages/providers/test/flags.test.ts packages/providers/test/cursor-flags.test.ts`
Expected: PASS, including the untouched unset/empty tests in both gate files. The two `flags`
suites are the proof the pre-flight probes still pass against the rewritten scripts — and note that
`preflightGate` and `cursorPreflightGate` always set `AITEAMOS_PAUSE_FLAG`, so neither ever reaches
the misconfiguration branch.

- [ ] **Step 7: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

**Report requirement:** state the deleted line count across the two scripts, confirm the only two
test files touched are the two this task names, and list every PRE-EXISTING assertion re-pointed.
That list must contain exactly one entry:
`packages/providers/test/cursor-shell-gate.test.ts` — `'allows when the flag path names a directory rather than a file'`
(lines 192-201), now `'exits 2 when the flag path names a directory rather than a file'`. Everything
else in both files is an addition (`pause-gate.test.ts`'s two `REASONS` rows and its new directory
test). If anything else needed editing, STOP and report — it means a behavior moved that this task
did not intend to move.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/pause-flag.sh scripts/pause-gate.sh scripts/cursor-shell-gate.sh packages/providers/test/pause-gate.test.ts packages/providers/test/cursor-shell-gate.test.ts
git commit -m "fix(scripts): both gates share one encoder, and a directory is not an allow"
```

---

## Series C — Cursor's Gate, Proven

### Task 9: Two measured runs, committed as fixtures

**Files:**
- Create: `packages/providers/test/fixtures/cursor/gate/README.md` (what each artifact is and the
  exact command that produced it)
- Create: `packages/providers/test/fixtures/cursor/gate/hooks.json` (the file the adapter wrote,
  copied out of the worktree verbatim)
- Create: `packages/providers/test/fixtures/cursor/gate/run-1-flag-absent.ndjson`
- Create: `packages/providers/test/fixtures/cursor/gate/run-1-hook.log`
- Create: `packages/providers/test/fixtures/cursor/gate/run-2-flag-present.ndjson`
- Create: `packages/providers/test/fixtures/cursor/gate/run-2-hook.log`
- Test: `packages/providers/test/cursor-adapter.test.ts` (extend — the recorded deny line becomes
  a parser fixture)

**Interfaces:**
- Consumes: `writeCursorHooksFile({ hooksPath, gatePath })` and
  `cursorHooksPath(worktreePath)` from `packages/providers/src/cursor/hooks.ts`;
  `cursorFlags()` from `cursor/flags.ts`; the deny-observation path
  `observeRawLine` → `CursorRunState.rejectedCallIds` → `RunOutcome.deniedToolUseIds` in
  `packages/providers/src/cursor/adapter.ts:584-611,549`.
- Produces: the six committed artifacts above, and the evidence that settles Task 10's capability
  decision.

**Spend: two `cursor-agent` runs, one spare.** No other task in this plan spends on Cursor.

**The worktree must be a GIT ROOT, not a subdirectory.** `cursor-agent` resolves
`.cursor/hooks.json` against the git root (`cursor/hooks.ts`'s measured note 1 — M12 Task 12's
own runs were invalidated by exactly this mistake). Use `git worktree add`, which is the shape a
real run gets.

- [ ] **Step 1: Build the two run roots**

```bash
mkdir -p /tmp/m13-cursor-gate && cd /tmp/m13-cursor-gate
git init -q -b main fixture-repo
cd fixture-repo
git config user.name Fixture && git config user.email fixture@example.com
echo '# fixture' > README.md && git add README.md && git commit -q -m initial
git worktree add -q ../run-1 -b m13-run-1
git worktree add -q ../run-2 -b m13-run-2
```

- [ ] **Step 2: Arm both worktrees with the adapter's own hooks file**

Do NOT hand-write the JSON — the point is to test what the adapter writes.

```bash
npm run --silent -w @ai-team-os/providers build 2>/dev/null || tsc --build
node -e "
  const { cursorHooksPath, writeCursorHooksFile } = await import('./packages/providers/dist/cursor/hooks.js')
  const gate = '$PWD/scripts/cursor-shell-gate.sh'
  for (const root of ['/tmp/m13-cursor-gate/run-1', '/tmp/m13-cursor-gate/run-2']) {
    writeCursorHooksFile({ hooksPath: cursorHooksPath(root), gatePath: gate })
  }
" --input-type=module
cat /tmp/m13-cursor-gate/run-1/.cursor/hooks.json
```

Expected: a single line carrying `"version":1`, a `beforeShellExecution` entry and a `preToolUse`
entry, each with `"failClosed":true` and the absolute gate path.

- [ ] **Step 3: Run 1 — the flag absent, both actions must succeed**

```bash
cd /tmp/m13-cursor-gate/run-1
export AITEAMOS_PAUSE_FLAG=/tmp/m13-cursor-gate/run-1.flag
rm -f "$AITEAMOS_PAUSE_FLAG"
cursor-agent --print --output-format stream-json --trust --force \
  'Run the shell command `echo m13-shell-ok > shell.txt`, then write a file named write.txt whose only content is the word ok. Do both, then stop.' \
  > /tmp/m13-cursor-gate/run-1-flag-absent.ndjson 2> /tmp/m13-cursor-gate/run-1.stderr
ls shell.txt write.txt
```

Expected: both files exist. This is the control: it proves the gate is INSTALLED and permissive,
so run 2's refusals cannot be "the agent never tried".

- [ ] **Step 4: Run 2 — the flag present, both actions must be refused**

```bash
cd /tmp/m13-cursor-gate/run-2
export AITEAMOS_PAUSE_FLAG=/tmp/m13-cursor-gate/run-2.flag
printf 'Paused by the M13 gate evidence run.' > "$AITEAMOS_PAUSE_FLAG"
cursor-agent --print --output-format stream-json --trust --force \
  'Run the shell command `echo m13-shell-ok > shell.txt`, then write a file named write.txt whose only content is the word ok. Do both, then stop.' \
  > /tmp/m13-cursor-gate/run-2-flag-present.ndjson 2> /tmp/m13-cursor-gate/run-2.stderr
ls shell.txt write.txt   # expected: neither exists
grep -o '"rejected":{[^}]*}' /tmp/m13-cursor-gate/run-2-flag-present.ndjson
```

Expected for a full pass: **neither file exists**, and the NDJSON carries at least two
`tool_call`/`completed` lines whose `result.rejected.reason` begins
`Command execution was blocked by a hook` — one for the shell call, one for the write.

- [ ] **Step 5: Capture the hook's own view**

The gate script writes nothing but its verdict, so wrap it for the recording. Before steps 3 and 4,
point `hooks.json` at a wrapper instead:

```bash
cat > /tmp/m13-cursor-gate/gate-wrapper.sh <<'WRAP'
#!/usr/bin/env bash
LOG="${AITEAMOS_GATE_LOG:?}"
payload=$(cat)
printf '>>> stdin: %s\n' "$payload" >> "$LOG"
out=$(printf '%s' "$payload" | /home/meren/projects/slave-of-ai/scripts/cursor-shell-gate.sh)
status=$?
printf '<<< exit %s stdout: %s\n' "$status" "$out" >> "$LOG"
printf '%s\n' "$out"
exit $status
WRAP
chmod +x /tmp/m13-cursor-gate/gate-wrapper.sh
```

Re-arm each worktree with `writeCursorHooksFile({ hooksPath, gatePath: '/tmp/m13-cursor-gate/gate-wrapper.sh' })`,
export `AITEAMOS_GATE_LOG=/tmp/m13-cursor-gate/run-N-hook.log`, and re-run. If the spare run is
consumed here, record that in the report; the cap is three Cursor runs total.

- [ ] **Step 6: Commit the artifacts under the fixtures directory**

```bash
mkdir -p packages/providers/test/fixtures/cursor/gate
cp /tmp/m13-cursor-gate/run-1-flag-absent.ndjson /tmp/m13-cursor-gate/run-2-flag-present.ndjson \
   /tmp/m13-cursor-gate/run-1-hook.log /tmp/m13-cursor-gate/run-2-hook.log \
   packages/providers/test/fixtures/cursor/gate/
cp /tmp/m13-cursor-gate/run-2/.cursor/hooks.json packages/providers/test/fixtures/cursor/gate/hooks.json
```

Write `packages/providers/test/fixtures/cursor/gate/README.md` naming, for each file: the exact
command, the `cursor-agent --version` string, the date, and whether `shell.txt` / `write.txt`
existed afterwards. Evidence with no provenance is not evidence (Decision 8).

- [ ] **Step 7: Turn the recorded deny line into a parser fixture test**

`packages/providers/test/cursor-adapter.test.ts` currently proves `deniedToolUseIds` with a
hand-built `rejectedCompletedLine('call-a')`. Add a test that replays the REAL line, so the
observation path is pinned to the shape the binary actually emits:

```typescript
import { readFileSync } from 'node:fs'

/**
 * The `tool_call` / `completed` lines the RECORDED gate run produced (M13 Task 9), not
 * synthesized ones. `observeRawLine` reads the rejection out of `tool_call.<name>ToolCall.result
 * .rejected` -- where the tool's name is the KEY of the `tool_call` object rather than a field --
 * and a hand-built line proves only that this test agrees with itself about that shape.
 */
const RECORDED_DENY_LINES = readFileSync(
  new URL('./fixtures/cursor/gate/run-2-flag-present.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.includes('"rejected"'))

it('reads the recorded gate denials off the real stream, not a synthesized one', async () => {
  expect(RECORDED_DENY_LINES.length).toBeGreaterThan(0)

  const adapter = adapterFor(
    writeStreamScript(runDir, 'recorded-denied.sh', { lines: [...RECORDED_DENY_LINES, RESULT_LINE] }),
  )
  await adapter.start(input)

  const outcome = terminatedOf(await drain(adapter, input.runId)).outcome
  const recordedIds = RECORDED_DENY_LINES.map((line) => (JSON.parse(line) as { call_id: string }).call_id)
  expect(outcome.deniedToolUseIds).toEqual(recordedIds)
  // A denied run is a failed run to `pump.ts` even when `is_error` is false -- the list has to be
  // non-empty for that to fire.
  expect(outcome.deniedToolUseIds.length).toBeGreaterThan(0)
})

it('the recorded denial says the hook is what blocked it', () => {
  const reasons = RECORDED_DENY_LINES.map(
    (line) => (JSON.parse(line) as { tool_call: Record<string, { result?: { rejected?: { reason?: string } } }> }),
  ).flatMap((parsed) =>
    Object.values(parsed.tool_call).map((call) => call.result?.rejected?.reason ?? ''),
  )
  expect(reasons.some((reason) => reason.startsWith('Command execution was blocked by a hook'))).toBe(true)
})
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run packages/providers/test/cursor-adapter.test.ts packages/providers/test/cursor-stream.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

**Report requirement (this task's real deliverable):** state, in the report, exactly which of spec
§5's three outcomes the evidence produced —

1. both `shell.txt` and `write.txt` absent in run 2, with a `rejected` line for each → **both
   refusals observed**;
2. `shell.txt` absent, `write.txt` present → **only the shell refusal**, and say why the write
   was not gated (which hook fired, what the hook log shows for the write attempt);
3. both files present → **BLOCKED**: the hooks file the adapter writes is wrong, and Task 10
   becomes a fix rather than a capability change.

Task 10 acts on this and nothing else.

- [ ] **Step 10: Commit**

```bash
git add packages/providers/test/fixtures/cursor/gate packages/providers/test/cursor-adapter.test.ts
git commit -m "test(providers): Cursor's gate is recorded, not assumed"
```

---

### Task 10: The capability follows the evidence

**Files:**
- Modify: `packages/providers/src/capabilities.ts:50-69` (`CURSOR_CAPABILITIES`)
- Modify: `packages/providers/src/cursor/hooks.ts:52-76` (the `preToolUse` docstring that records
  the asymmetry M12 left behind)
- Test: `packages/providers/test/capabilities.test.ts`
- No `apps/web` source change: the mark is `apps/web/src/components/ShellOnlyMark.tsx`, which
  renders nothing unless `gate === 'shell-only'`, and `gate` is derived server-side from
  `capabilitiesOf` (`apps/web/src/server/overview.ts:243`, `apps/web/src/server/org.ts`). Raising
  the capability makes the mark stop appearing on Cursor with no component edit at all
- Test (outcome 1 only): `apps/web/test/overview-components.test.tsx` — the two `gate:
  'shell-only'` fixtures that name Cursor

**Interfaces:**
- Consumes: Task 9's committed fixtures and its recorded outcome.
- Produces: `capabilitiesOf('cursor').gate` — the value every gate-mark consumer reads
  (`apps/web/src/server/overview.ts:243`, `apps/web/src/server/org.ts`).

**All three branches, spelled out. Take exactly one.**

**Outcome 1 — both refusals observed.**

- `packages/providers/src/capabilities.ts`:

```typescript
/**
 * Cursor's row, PROVEN against the installed binary in M13 Task 9 and no longer conservative.
 *
 * `gate: 'all-tools'` because the recorded run at
 * `packages/providers/test/fixtures/cursor/gate/run-2-flag-present.ndjson` shows BOTH a shell
 * command and a file write refused through the `preToolUse` registration while the pause flag was
 * present, with the control run (flag absent) showing both succeeding. M12 spec §7's premise --
 * "Cursor fires only the shell hooks" -- is superseded and false; `preToolUse` fires for `Read`,
 * `Write` and `Shell` alike.
 *
 * `canPauseMidRun` stays `false`: there is still no mechanism that stops the agent between tool
 * calls and leaves it resumable in place. The gate refuses calls; it does not suspend the run.
 * `reportsCost` stays `false`: the `result` line carries no cost figure at all.
 */
const CURSOR_CAPABILITIES: ProviderCapabilities = {
  canPauseMidRun: false,
  canResumeSession: true,
  gate: 'all-tools',
  reportsCost: false,
}
```

- `packages/providers/test/capabilities.test.ts` — update the Cursor expectation:

```typescript
  it('describes the Cursor runtime: no mid-run pause, resumable, gates every tool, cost-blind', () => {
    expect(capabilitiesOf('cursor')).toEqual({
      canPauseMidRun: false,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: false,
    })
  })
```

- `apps/web/test/overview-components.test.tsx` — the two assertions that pair Cursor with
  `gate: 'shell-only'` become `gate: 'all-tools'`, and the "marks a shell-only gate" test keeps a
  hand-written `gate: 'shell-only'` fixture (the mark itself is still real; no shipped provider
  produces it any more, which is exactly what the test now documents):

```typescript
  it('marks a shell-only gate, and shows no mark for a runtime that gates every tool', () => {
    // `gate` is server-derived (`overview.ts`, via `capabilitiesOf`). As of M13 Task 10 no shipped
    // provider reports `shell-only` -- Cursor's gate was proven to cover writes too -- so this
    // fixture is hand-written: the MARK is still part of the contract, and a third runtime that
    // gates only shells must light it up on day one.
    const { rerender } = render(<AgentCard agent={agent({ provider: 'cursor', gate: 'shell-only' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByText(/shell only/i)).toBeTruthy()

    rerender(<AgentCard agent={agent({ provider: 'cursor', gate: 'all-tools' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.queryByText(/shell only/i)).toBeNull()
  })
```

- `cursor/hooks.ts`'s `preToolUse` docstring: delete the paragraph beginning "**Registered even
  though `capabilitiesOf('cursor').gate` still reads `'shell-only'`, and that asymmetry is
  deliberate.**" and replace it with the recorded finding and the fixture path.

**Outcome 2 — only the shell refusal.** `CURSOR_CAPABILITIES` is unchanged, and no test changes.
Instead, `cursor/hooks.ts`'s `preToolUse` docstring gains the measured reason the write was not
gated (which hook fired, what the hook log shows), citing the fixture files by path, and the task
report states it. The commit is documentation only.

**Outcome 3 — neither refusal.** STOP. Report BLOCKED: the hooks file the adapter writes does not
arm anything, which makes Cursor's pause unenforced in production. Do not change the capability
(it is already at its conservative value); open the finding with the two recorded NDJSON files and
the two hook logs as the evidence, and hand it back — fixing the hooks file is a redesign of
`cursor/hooks.ts`, not a value edit.

- [ ] **Step 1: Read Task 9's report and name the outcome**

State outcome 1, 2 or 3 in this task's report before editing anything.

- [ ] **Step 2: Apply exactly that outcome's edits from the three blocks above**

- [ ] **Step 3: Run the affected suites**

Run: `npx vitest run packages/providers/test/capabilities.test.ts packages/providers/test/pause-signal-capability.test.ts apps/web/test/overview-components.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
# outcome 1
git add packages/providers/src/capabilities.ts packages/providers/src/cursor/hooks.ts packages/providers/test/capabilities.test.ts apps/web/test/overview-components.test.tsx
git commit -m "feat(providers): Cursor gates every tool, and the recording says so"

# outcome 2
git add packages/providers/src/cursor/hooks.ts
git commit -m "docs(providers): Cursor's gate stays shell-only, and the recording says why"
```

---

## Series D — The Operator Chooses

### Task 11: `setWorkspaceProvider` and `setWorkspaceBudget`

**Files:**
- Create: `packages/control/src/workspace.ts`
- Modify: `packages/control/src/index.ts` (export it)
- Modify: `packages/control/src/refusal.ts` (`invalid_budget`)
- Modify: `packages/db/prisma/schema.prisma:499` (the `EventType` enum)
- Create: `packages/db/prisma/migrations/20260829120000_m13_settings_changed_event/migration.sql`
- Modify: `packages/db/src/enums.ts:36-38` (`EVENT_TYPE_BY_DOMAIN_TYPE`)
- Modify: `packages/domain/src/events/schema.ts` (the discriminated union)
- Test: `packages/control/test/integration/workspace-settings.test.ts` (create)

**Interfaces:**
- Consumes: `ProviderKind` and `PROVIDER_KINDS` from `@ai-team-os/providers`;
  `Result`/`ok`/`err` from `@ai-team-os/domain`; `appendEvent` from `@ai-team-os/events`.
- Produces:

```typescript
// packages/control/src/workspace.ts
export async function setWorkspaceProvider(
  workspaceId: string,
  kind: ProviderKind | null,
): Promise<Result<void, ControlRefusal>>

export async function setWorkspaceBudget(
  workspaceId: string,
  usd: number | null,
): Promise<Result<void, ControlRefusal>>
```

```typescript
// packages/control/src/refusal.ts
/** A budget was set to something that is neither a non-negative number nor `null` (M13 §6.1). */
| { readonly kind: 'invalid_budget' }
```

`refusalText({ kind: 'invalid_budget' })` returns exactly
`a budget must be a non-negative amount or absent`.

```typescript
// packages/domain/src/events/schema.ts -- the new member's payload
payload: z.object({
  field: z.enum(['provider', 'budgetUsd']),
  from: z.union([z.string(), z.number(), z.null()]),
  to: z.union([z.string(), z.number(), z.null()]),
})
```

**What these verbs deliberately do NOT do:**
- Neither refuses a halted workspace (Decision 11) — changing the runtime or the budget is a
  legitimate way to make a halt clearable.
- Neither enforces the budget/provider compatibility rule (Decision 10). Writing a cost-blind
  provider onto a budgeted workspace is allowed; dispatch refuses it with `unmeasurable_budget` as
  today, and Task 13's card shows the consequence before the operator hits it. The refusal lives in
  one place (`packages/control/src/budget.ts`) and is not duplicated at write time.
- `setWorkspaceProvider` keeps `workspaceDefaultProvider`'s "exactly one row or nothing" rule
  intact (Decision 9) by REPLACING in one transaction, never by inserting a second row.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/control/test/integration/workspace-settings.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { refusalText } from '../../src/refusal.js'
import { setWorkspaceBudget, setWorkspaceProvider } from '../../src/workspace.js'
import { workspaceDefaultProvider } from '../../src/runtime.js'

interface Fixture {
  readonly workspace: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/does-not-matter',
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  return { workspace: { id: workspace.id } }
}

describe('the workspace settings verbs', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  describe('setWorkspaceProvider', () => {
    it('replaces any existing row so the workspace always resolves exactly one default', async (): Promise<void> => {
      expect((await setWorkspaceProvider(fixture.workspace.id, 'claude_code')).ok).toBe(true)
      expect((await setWorkspaceProvider(fixture.workspace.id, 'cursor')).ok).toBe(true)

      const rows = await prisma.providerConfiguration.findMany({ where: { workspaceId: fixture.workspace.id } })
      // Decision 9: one workspace, one provider row. Two rows make
      // `workspaceDefaultProvider` return null, which stops every dispatch in the workspace.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('cursor')
      expect(rows[0]?.settings).toEqual({})
      expect(await workspaceDefaultProvider(fixture.workspace.id)).toBe('cursor')
    })

    it('deletes the row on null, leaving no default at all', async (): Promise<void> => {
      await setWorkspaceProvider(fixture.workspace.id, 'cursor')
      expect((await setWorkspaceProvider(fixture.workspace.id, null)).ok).toBe(true)

      expect(await prisma.providerConfiguration.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0)
      expect(await workspaceDefaultProvider(fixture.workspace.id)).toBeNull()
    })

    it('records what changed, from what, to what', async (): Promise<void> => {
      await setWorkspaceProvider(fixture.workspace.id, 'cursor')
      const events = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspace.id, type: 'workspace_settings_changed' },
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ field: 'provider', from: null, to: 'cursor' })
      expect(events[0]?.actor).toBe('human')
    })

    it('refuses an unknown workspace and an unknown kind, writing nothing', async (): Promise<void> => {
      const missing = await setWorkspaceProvider('00000000-0000-0000-0000-000000000000', 'cursor')
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error.kind).toBe('workspace_not_found')

      const bogus = await setWorkspaceProvider(fixture.workspace.id, 'gpt' as never)
      expect(bogus.ok).toBe(false)
      if (!bogus.ok) expect(refusalText(bogus.error)).toBe('a provider must be a configured kind')
      expect(await prisma.providerConfiguration.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0)
    })

    it('does not refuse a halted workspace', async (): Promise<void> => {
      // Decision 11: changing the runtime is a legitimate way to make a halt clearable.
      await prisma.workspace.update({
        where: { id: fixture.workspace.id },
        data: { haltedReason: 'emergency stop by meren', haltedAt: new Date() },
      })
      expect((await setWorkspaceProvider(fixture.workspace.id, 'cursor')).ok).toBe(true)
    })
  })

  describe('setWorkspaceBudget', () => {
    it('writes a number, and null for "not budgeted"', async (): Promise<void> => {
      expect((await setWorkspaceBudget(fixture.workspace.id, 42.5)).ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBe(42.5)

      expect((await setWorkspaceBudget(fixture.workspace.id, null)).ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBeNull()
    })

    it('accepts zero, which is a budget an operator set', async (): Promise<void> => {
      expect((await setWorkspaceBudget(fixture.workspace.id, 0)).ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBe(0)
    })

    it('refuses a negative, a NaN and an infinity with the verbatim text', async (): Promise<void> => {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = await setWorkspaceBudget(fixture.workspace.id, bad)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(refusalText(result.error)).toBe('a budget must be a non-negative amount or absent')
      }
      // The `@default(20)` the workspace was created with is untouched by every refusal.
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBe(20)
    })

    it('records the change with the previous figure', async (): Promise<void> => {
      await setWorkspaceBudget(fixture.workspace.id, null)
      const events = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspace.id, type: 'workspace_settings_changed' },
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ field: 'budgetUsd', from: 20, to: null })
    })

    it('allows a cost-blind provider on a budgeted workspace: the refusal lives at dispatch', async (): Promise<void> => {
      // Decision 10. `admitProvider` already refuses this pair at dispatch with
      // `a budget needs a provider that reports cost`; duplicating it here would give the
      // operator two different moments to be told the same thing, and would make it impossible to
      // reach the configuration by setting the provider first and the budget second.
      await setWorkspaceBudget(fixture.workspace.id, 20)
      expect((await setWorkspaceProvider(fixture.workspace.id, 'cursor')).ok).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/control/test/integration/workspace-settings.test.ts`
Expected: FAIL — `packages/control/src/workspace.js` does not exist.

- [ ] **Step 3: Add the event type end to end**

`packages/db/prisma/schema.prisma`, in the `EventType` enum, after `workspace_company_assigned`:

```prisma
  workspace_settings_changed @map("workspace.settings_changed")
```

`packages/db/prisma/migrations/20260829120000_m13_settings_changed_event/migration.sql`:

```sql
-- M13 §6.1: the workspace's runtime and its budget become writable, and every write is recorded.
--
-- Additive in the sense the milestone's constraint means: one new enum member, no column touched,
-- no existing row rewritten, nothing dropped. `IF NOT EXISTS` makes re-running it a no-op.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction. Nothing here uses it.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.settings_changed';
```

`packages/db/src/enums.ts`, in `EVENT_TYPE_BY_DOMAIN_TYPE`, after `'workspace.company_assigned'`:

```typescript
  'workspace.settings_changed': 'workspace_settings_changed',
```

`packages/domain/src/events/schema.ts`, as the last member of `executionEventSchema`:

```typescript
  z.object({
    ...envelope,
    type: z.literal('workspace.settings_changed'),
    /**
     * Which setting moved, and both ends of the move (M13 §6.1). `from`/`to` are a union rather
     * than two typed members because the two fields carry different shapes -- a `ProviderKind`
     * string or a USD number -- and `null` is a real value on both: "no provider configured" and
     * "this workspace is not budgeted".
     */
    payload: z.object({
      field: z.enum(['provider', 'budgetUsd']),
      from: z.union([z.string(), z.number(), z.null()]),
      to: z.union([z.string(), z.number(), z.null()]),
    }),
  }),
```

Then run `npm run db:generate && npm run db:migrate && npm run db:migrate:test`.

- [ ] **Step 4: Add the refusal**

`packages/control/src/refusal.ts`: the union member from **Interfaces** (beside `invalid_model`),
and the switch arm:

```typescript
    case 'invalid_budget':
      return 'a budget must be a non-negative amount or absent'
```

- [ ] **Step 5: Write `workspace.ts`**

```typescript
// packages/control/src/workspace.ts
import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { PROVIDER_KINDS, type ProviderKind } from '@ai-team-os/providers'
import type { ControlRefusal } from './refusal.js'

/** Validates an UNTRUSTED provider string (a CLI flag, a web request body), like `org.ts`'s copy. */
function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value)
}

/**
 * Sets (or clears) the workspace's default runtime -- the last link of `resolveRuntime`'s override
 * chain, and until M13 a row nothing in this codebase could write.
 *
 * ONE TRANSACTION, DELETE-THEN-INSERT (Decision 9). `workspaceDefaultProvider` returns a default
 * only for a workspace with EXACTLY ONE `ProviderConfiguration` row -- more than one and it
 * returns `null`, because the table has no "this one is the default" column, so picking one would
 * be an arbitrary choice dressed up as a default. An upsert on `(workspaceId, kind)` would create
 * a SECOND row when the kind changes, which would silently stop every dispatch in the workspace.
 * Replacing is the only shape that keeps the rule true.
 *
 * `null` deletes: "this workspace has no configured default", which is a real state and not the
 * same as "the operator configured Claude".
 *
 * Deliberately NOT refused for a halted workspace (Decision 11) and deliberately NOT checked
 * against `Workspace.budgetUsd` (Decision 10): a cost-blind provider on a budgeted workspace is a
 * configuration dispatch refuses with `unmeasurable_budget`, and duplicating that refusal here
 * would make the pair unreachable in the order (provider first, budget second) an operator
 * naturally uses -- while telling them the same thing twice.
 */
export async function setWorkspaceProvider(
  workspaceId: string,
  kind: ProviderKind | null,
): Promise<Result<void, ControlRefusal>> {
  if (kind !== null && !isProviderKind(kind)) return err({ kind: 'invalid_provider', provider: kind })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const from = await prisma.$transaction(async (tx) => {
    const existing = await tx.providerConfiguration.findMany({ where: { workspaceId }, select: { kind: true } })
    await tx.providerConfiguration.deleteMany({ where: { workspaceId } })
    if (kind !== null) {
      // `settings: {}` -- the column has no reader anywhere in this codebase, and inventing a
      // shape for it now, with nothing to pass it to, is the mistake M12 Task 5 already caught
      // once. An empty object is the honest "nothing configured".
      await tx.providerConfiguration.create({ data: { workspaceId, kind, settings: {} } })
    }
    return existing.length === 1 ? existing[0]!.kind : null
  })

  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'provider', from, to: kind },
  })
  return ok(undefined)
}

/**
 * Sets (or clears) the workspace's spend ceiling.
 *
 * `null` is the deliberate "this workspace is not budgeted" state -- spec §6's ONLY state in which
 * a cost-blind runtime may run. `0` is a budget an operator SET and is refused at dispatch as
 * firmly as any other figure, so it is accepted here.
 *
 * `Number.isFinite` rather than a bare `>= 0` check: `NaN >= 0` is `false` (so NaN is caught
 * either way) but `Infinity >= 0` is `true`, and an infinite ceiling written into a Float column
 * is a budget that can never be exceeded -- a guardrail that is silently inert, which is exactly
 * the shape M12 made this column nullable to avoid.
 */
export async function setWorkspaceBudget(
  workspaceId: string,
  usd: number | null,
): Promise<Result<void, ControlRefusal>> {
  if (usd !== null && (!Number.isFinite(usd) || usd < 0)) return err({ kind: 'invalid_budget' })

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, budgetUsd: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  await prisma.workspace.update({ where: { id: workspaceId }, data: { budgetUsd: usd } })
  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'budgetUsd', from: workspace.budgetUsd, to: usd },
  })
  return ok(undefined)
}
```

`packages/control/src/index.ts`: add `export * from './workspace.js'` beside `export * from './goal.js'`.

- [ ] **Step 6: Run the tests to green**

Run: `npx vitest run packages/control/test/integration/workspace-settings.test.ts packages/control/test/integration/runtime.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS. `packages/db`'s enum parity test is what fails if the four places the new event
type has to be named are not all named.

- [ ] **Step 8: Commit**

```bash
git add packages/control/src/workspace.ts packages/control/src/index.ts packages/control/src/refusal.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260829120000_m13_settings_changed_event packages/db/src/enums.ts packages/domain/src/events/schema.ts packages/control/test/integration/workspace-settings.test.ts
git commit -m "feat(control): a workspace's runtime and budget are writable, and every change is recorded"
```

---

### Task 12: The two routes

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/provider/route.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/budget/route.ts`
- Test: `apps/web/test/integration/workspace-settings-routes.test.ts` (create)

**Interfaces:**
- Consumes: `setWorkspaceProvider`, `setWorkspaceBudget` from `@ai-team-os/control` (Task 11);
  `workspaceControlResponse(workspaceId, operate)` from
  `apps/web/src/server/workspaceControlRoute.ts`.
- Produces: `PUT /api/w/[workspaceId]/provider` with body `{ provider: ProviderKind | null }` and
  `PUT /api/w/[workspaceId]/budget` with body `{ budgetUsd: number | null }`. Both return
  `{ ok: true }` on success, `{ error: <verbatim refusal text> }` with status 409 on a refusal, and
  `{ error: … }` with 400 on a body of the wrong shape.

**Which route shell.** Spec §6.2 says "through `orgControlRoute` … mirroring `goal/route.ts`", and
those two halves disagree: `goal/route.ts` uses `workspaceControlResponse`, whose only difference
from `orgControlResponse` is a workspace-existence pre-check that answers 404. These routes are
workspace-scoped and their path carries a `workspaceId`, so the mirror wins:
**`workspaceControlResponse`**. The parenthetical requirement — 409 plus the verbatim refusal text
— is identical in both shells, so nothing the spec actually asks for is lost, and an unknown
workspace gets a 404 instead of a 409 saying `no workspace with id …`.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/test/integration/workspace-settings-routes.test.ts
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PUT as providerPUT } from '../../src/app/api/w/[workspaceId]/provider/route.js'
import { PUT as budgetPUT } from '../../src/app/api/w/[workspaceId]/budget/route.js'

interface Fixture {
  readonly workspaceId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/workspace-settings-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  return { workspaceId: workspace.id }
}

function jsonRequest(body: unknown): Request {
  return new Request('http://x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function params(workspaceId: string): { params: Promise<{ workspaceId: string }> } {
  return { params: Promise.resolve({ workspaceId }) }
}

describe('the workspace settings routes', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('PUT /api/w/[workspaceId]/provider', () => {
    it('writes the row and returns 200', async (): Promise<void> => {
      const response = await providerPUT(jsonRequest({ provider: 'cursor' }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })

      const rows = await prisma.providerConfiguration.findMany({ where: { workspaceId: fixture.workspaceId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('cursor')
    })

    it('accepts an explicit null and deletes the row', async (): Promise<void> => {
      await providerPUT(jsonRequest({ provider: 'cursor' }), params(fixture.workspaceId))
      const response = await providerPUT(jsonRequest({ provider: null }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect(await prisma.providerConfiguration.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    })

    it('409s with the verbatim refusal on an unknown kind', async (): Promise<void> => {
      const response = await providerPUT(jsonRequest({ provider: 'gpt' }), params(fixture.workspaceId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a provider must be a configured kind')
    })

    it('400s when the body has no provider key at all', async (): Promise<void> => {
      // Distinct from `{ provider: null }`, which is a real instruction ("no default").
      const response = await providerPUT(jsonRequest({}), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })

    it('404s for an unknown workspace', async (): Promise<void> => {
      const response = await providerPUT(jsonRequest({ provider: 'cursor' }), params('00000000-0000-0000-0000-000000000000'))
      expect(response.status).toBe(404)
    })
  })

  describe('PUT /api/w/[workspaceId]/budget', () => {
    it('writes a number and returns 200', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: 12.5 }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).budgetUsd).toBe(12.5)
    })

    it('accepts an explicit null -- "this workspace is not budgeted"', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: null }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).budgetUsd).toBeNull()
    })

    it('409s with the verbatim refusal on a negative amount', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: -3 }), params(fixture.workspaceId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a budget must be a non-negative amount or absent')
    })

    it('400s when budgetUsd is neither a number nor null', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: '12' }), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/web/test/integration/workspace-settings-routes.test.ts`
Expected: FAIL — neither route module exists.

- [ ] **Step 3: Write the provider route**

```typescript
// apps/web/src/app/api/w/[workspaceId]/provider/route.ts
import { setWorkspaceProvider, type ProviderKind } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  // `'provider' in body` rather than a truthiness check: `null` is a real instruction here ("this
  // workspace has no configured default"), and an OMITTED key is a malformed body. Collapsing the
  // two would make a typo in the field name read as "clear the provider".
  if (typeof body !== 'object' || body === null || !('provider' in body)) {
    return Response.json({ error: 'the body must be { "provider": string | null }' }, { status: 400 })
  }
  const provider = (body as { provider: unknown }).provider
  if (provider !== null && typeof provider !== 'string') {
    return Response.json({ error: 'the body must be { "provider": string | null }' }, { status: 400 })
  }
  // The STRING is handed on unvalidated: `setWorkspaceProvider` owns the `invalid_provider`
  // refusal and its verbatim text, and a second validator here would be a second place for the
  // list of kinds to go stale.
  return workspaceControlResponse(workspaceId, () =>
    setWorkspaceProvider(workspaceId, provider as ProviderKind | null),
  )
}
```

- [ ] **Step 4: Write the budget route**

```typescript
// apps/web/src/app/api/w/[workspaceId]/budget/route.ts
import { setWorkspaceBudget } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (typeof body !== 'object' || body === null || !('budgetUsd' in body)) {
    return Response.json({ error: 'the body must be { "budgetUsd": number | null }' }, { status: 400 })
  }
  const budgetUsd = (body as { budgetUsd: unknown }).budgetUsd
  if (budgetUsd !== null && typeof budgetUsd !== 'number') {
    return Response.json({ error: 'the body must be { "budgetUsd": number | null }' }, { status: 400 })
  }
  // A negative or non-finite number is a REFUSAL, not a 400: `invalid_budget` carries the
  // operator-facing text, and the card shows it verbatim.
  return workspaceControlResponse(workspaceId, () => setWorkspaceBudget(workspaceId, budgetUsd))
}
```

- [ ] **Step 5: Run the tests to green**

Run: `npx vitest run apps/web/test/integration/workspace-settings-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS. `web:build` is what catches a route file the App Router cannot compile.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/api/w/[workspaceId]/provider/route.ts" "apps/web/src/app/api/w/[workspaceId]/budget/route.ts" apps/web/test/integration/workspace-settings-routes.test.ts
git commit -m "feat(web): the workspace's runtime and budget have routes shaped like the goal's"
```

---

### Task 13: The Runtime card

**Files:**
- Create: `apps/web/src/components/RuntimeCard.tsx`
- Modify: `apps/web/src/server/overview.ts:78-104` (`OverviewSnapshot.workspace`), `:114-116` (the
  workspace read) and `:221-231` (the returned object)
- Modify: `apps/web/src/components/OverviewClient.tsx:54-56` (beside `GoalCard`)
- Test: `apps/web/test/runtime-card.test.tsx` (create)
- Test: `apps/web/test/overview-components.test.tsx:36` (the `OverviewSnapshot` fixture gains two
  fields)
- Test: `apps/web/test/useOverview.test.tsx:8` (the same fixture, same two fields)
- Test: `apps/web/test/integration/overview.test.ts` (assert the two new DTO fields)

**Interfaces:**
- Consumes: Task 12's two routes; `ProviderSelect` from
  `apps/web/src/components/ProviderSelect.tsx` with props
  `{ ariaLabel, testId, value: ProviderKind | '', onChange, disabled, placeholder, className }`;
  `capabilitiesOf` and `ProviderKind`, both re-exported by `@ai-team-os/control` for server use.
- Produces:

```typescript
// apps/web/src/server/overview.ts -- OverviewSnapshot.workspace gains
    /** The workspace's configured default runtime, or `null` for "nothing configured" (M13 §6.3). */
    readonly provider: ProviderKind | null
    /**
     * `true` when the configured provider cannot report cost AND a budget is set -- the
     * combination `admitRun` refuses at dispatch with `a budget needs a provider that reports
     * cost`. Derived HERE with `capabilitiesOf` and shipped as a plain boolean, so the client
     * never needs the capability table (spec §6.3).
     */
    readonly costBlindBudgeted: boolean
```

```typescript
// apps/web/src/components/RuntimeCard.tsx
export function RuntimeCard({
  workspaceId,
  provider,
  budgetUsd,
  costBlindBudgeted,
}: {
  readonly workspaceId: string
  readonly provider: ProviderKind | null
  readonly budgetUsd: number | null
  readonly costBlindBudgeted: boolean
}): React.JSX.Element
```

Aria labels, fixed by spec §6.3: `workspace provider`, `workspace budget`, `not budgeted`.

- [ ] **Step 1: Write the failing component tests**

```typescript
// apps/web/test/runtime-card.test.tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeCard } from '../src/components/RuntimeCard.js'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: (): void => {} }) }))

describe('RuntimeCard', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('PUTs the chosen provider', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace provider'), { target: { value: 'cursor' } })
      fireEvent.click(screen.getByTestId('runtime-provider-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/provider',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ provider: 'cursor' }) }),
    )
  })

  it('sends an explicit null when the operator picks (none)', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={null} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace provider'), { target: { value: '' } })
      fireEvent.click(screen.getByTestId('runtime-provider-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/provider',
      expect.objectContaining({ body: JSON.stringify({ provider: null }) }),
    )
  })

  it('PUTs the typed budget', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '35.5' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/budget',
      expect.objectContaining({ body: JSON.stringify({ budgetUsd: 35.5 }) }),
    )
  })

  it('the not-budgeted checkbox disables the input and submits null', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={20} costBlindBudgeted={true} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('not budgeted'))
    })
    expect(screen.getByLabelText('workspace budget')).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/budget',
      expect.objectContaining({ body: JSON.stringify({ budgetUsd: null }) }),
    )
  })

  it('a 409 keeps the operator input and shows the refusal verbatim', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'a budget must be a non-negative amount or absent' }), { status: 409 }),
    )
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '-3' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a budget must be a non-negative amount or absent')
    // M11's idiom: a refused write keeps what the operator typed.
    expect(screen.getByLabelText('workspace budget')).toHaveValue(-3)
  })

  it('warns only for the cost-blind-and-budgeted combination', (): void => {
    const warning = /this provider reports no cost; a budgeted workspace will refuse it at dispatch/i
    const { rerender } = render(
      <RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={20} costBlindBudgeted={true} />,
    )
    expect(screen.getByText(warning)).toBeTruthy()

    // Same cost-blind provider, no budget: nothing to warn about.
    rerender(<RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={null} costBlindBudgeted={false} />)
    expect(screen.queryByText(warning)).toBeNull()

    // Budgeted, but on a runtime that reports cost.
    rerender(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)
    expect(screen.queryByText(warning)).toBeNull()
  })
})
```

- [ ] **Step 2: Write the failing DTO test**

In `apps/web/test/integration/overview.test.ts`, beside the existing `budgetUsd` assertion:

```typescript
  it('carries the workspace default provider and the cost-blind warning as a plain boolean', async (): Promise<void> => {
    await prisma.providerConfiguration.create({
      data: { workspaceId: fixture.workspaceId, kind: 'cursor', settings: {} },
    })
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.workspace.provider).toBe('cursor')
    // `budgetUsd` is 100 in this file's fixture, and `capabilitiesOf('cursor').reportsCost` is
    // false -- the exact pair `admitRun` refuses at dispatch.
    expect(snapshot?.workspace.costBlindBudgeted).toBe(true)

    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: null } })
    const unbudgeted = await buildOverviewSnapshot(fixture.workspaceId)
    expect(unbudgeted?.workspace.costBlindBudgeted).toBe(false)
  })
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run apps/web/test/runtime-card.test.tsx apps/web/test/integration/overview.test.ts`
Expected: FAIL — `RuntimeCard` does not exist, and `snapshot?.workspace.provider` does not compile.

- [ ] **Step 4: Widen the overview DTO**

In `apps/web/src/server/overview.ts`, add the two fields from **Interfaces** to
`OverviewSnapshot.workspace`, read the configuration rows beside the workspace, and fill them:

```typescript
  // Exactly the rule `workspaceDefaultProvider` (packages/control/src/runtime.ts) applies: ONE
  // row is a default, none is "nothing configured", and more than one is ALSO null -- the table
  // has no "this one is the default" column, so picking one would be an arbitrary choice dressed
  // up as a default. Read here rather than imported because this function is already inside a
  // batch of prisma reads and `workspaceDefaultProvider` would be a second round trip.
  const providerRows = await prisma.providerConfiguration.findMany({
    where: { workspaceId },
    select: { kind: true },
  })
  const provider = providerRows.length === 1 ? providerRows[0]!.kind : null
```

and in the returned `workspace` object:

```typescript
      provider,
      // The warning the Runtime card shows, derived SERVER-side (spec §6.3): `capabilitiesOf` is
      // safe here and unsafe in a client component -- `@ai-team-os/providers`'s barrel imports
      // `node:child_process` at module scope, which is why `ProviderSelect.tsx` carries its own
      // compiler-guarded mirror of `PROVIDER_KINDS` rather than importing the list. The client gets
      // a boolean and needs no table at all.
      costBlindBudgeted: provider !== null && workspace.budgetUsd !== null && !capabilitiesOf(provider).reportsCost,
```

- [ ] **Step 5: Write the card**

```typescript
// apps/web/src/components/RuntimeCard.tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ProviderKind } from '@ai-team-os/control'
import { ProviderSelect } from './ProviderSelect'
import { Button } from './ui/Button'
import { Panel } from './ui/Panel'

/** Pulls a 409 refusal's `{ error }` text -- the same local helper `GoalCard.tsx` carries. */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

async function putControl(url: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * The workspace's runtime and its spend ceiling, beside `GoalCard` on `/w/[workspaceId]`.
 *
 * No optimistic state: every control on this page follows M11's rule that the server's next
 * snapshot is what changes what is rendered. `router.refresh()` after each mutation is what asks
 * for that snapshot; a 409 keeps whatever the operator typed, so a refused write is correctable
 * rather than lost.
 *
 * `costBlindBudgeted` arrives as a plain boolean because deriving it needs `capabilitiesOf`, which
 * lives behind a package this client bundle must not evaluate. It describes the SAVED pair, not
 * the pending selection -- the point is to tell an operator what their current configuration will
 * do at dispatch, and the pending selection has not configured anything yet.
 */
export function RuntimeCard({
  workspaceId,
  provider,
  budgetUsd,
  costBlindBudgeted,
}: {
  readonly workspaceId: string
  readonly provider: ProviderKind | null
  readonly budgetUsd: number | null
  readonly costBlindBudgeted: boolean
}): React.JSX.Element {
  const router = useRouter()
  const [draftProvider, setDraftProvider] = useState<ProviderKind | ''>(provider ?? '')
  const [draftBudget, setDraftBudget] = useState(budgetUsd === null ? '' : String(budgetUsd))
  const [unbudgeted, setUnbudgeted] = useState(budgetUsd === null)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (url: string, body: Record<string, unknown>): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const result = await putControl(url, body)
    setPending(false)
    if (result.ok) {
      router.refresh()
    } else {
      setErrorText(result.error)
    }
  }

  return (
    <Panel title="Runtime">
      <div className="flex flex-col gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            // `''` is the "(none)" option and means an explicit `null` -- "this workspace has no
            // configured default" -- which the route distinguishes from an omitted key.
            void submit(`/api/w/${workspaceId}/provider`, { provider: draftProvider === '' ? null : draftProvider })
          }}
        >
          <ProviderSelect
            ariaLabel="workspace provider"
            testId="runtime-provider"
            value={draftProvider}
            onChange={setDraftProvider}
            disabled={pending}
            placeholder="(none)"
            className="rounded border border-line bg-bg-0 px-2 py-1 text-sm text-text-1"
          />
          <Button type="submit" variant="primary" data-testid="runtime-provider-submit" disabled={pending}>
            set runtime
          </Button>
        </form>

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit(`/api/w/${workspaceId}/budget`, {
              budgetUsd: unbudgeted ? null : Number(draftBudget),
            })
          }}
        >
          <input
            type="number"
            step="0.01"
            data-testid="runtime-budget-input"
            aria-label="workspace budget"
            value={draftBudget}
            onChange={(event) => setDraftBudget(event.target.value)}
            disabled={pending || unbudgeted}
            className="w-32 rounded border border-line bg-bg-0 px-2 py-1 text-sm text-text-1"
          />
          <label className="flex items-center gap-1 text-xs text-text-2">
            <input
              type="checkbox"
              aria-label="not budgeted"
              checked={unbudgeted}
              onChange={(event) => setUnbudgeted(event.target.checked)}
              disabled={pending}
            />
            not budgeted
          </label>
          <Button type="submit" variant="primary" data-testid="runtime-budget-submit" disabled={pending}>
            set budget
          </Button>
        </form>

        {costBlindBudgeted && (
          <span data-testid="runtime-cost-blind-warning" className="text-xs text-status-warn">
            this provider reports no cost; a budgeted workspace will refuse it at dispatch
          </span>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="runtime-error" className="text-xs text-status-danger">
            {errorText}
          </span>
        )}
      </div>
    </Panel>
  )
}
```

- [ ] **Step 6: Place it beside `GoalCard`**

`apps/web/src/components/OverviewClient.tsx`, replacing the single-card wrapper at lines 54-56:

```tsx
        <div className="grid grid-cols-1 gap-4 px-4 pt-4 md:grid-cols-2">
          <GoalCard workspaceId={workspaceId} goal={view.workspace.goal} />
          <RuntimeCard
            workspaceId={workspaceId}
            provider={view.workspace.provider}
            budgetUsd={view.workspace.budgetUsd}
            costBlindBudgeted={view.workspace.costBlindBudgeted}
          />
        </div>
```

with `import { RuntimeCard } from './RuntimeCard'` beside the `GoalCard` import.

- [ ] **Step 7: Widen the two `OverviewSnapshot` fixtures**

`apps/web/test/overview-components.test.tsx:36` and `apps/web/test/useOverview.test.tsx:8` each
carry a literal `workspace` object that must now type-check. Add the two fields to both:

```typescript
  workspace: { id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 3, unmeasuredRuns: 0, goal: null, provider: 'claude_code', costBlindBudgeted: false },
```

(`spentUsd: 0` in `useOverview.test.tsx` — keep each file's own figure.) These are the only two
test files outside this task's own that it may touch, and the edit is additive.

- [ ] **Step 8: Run the tests to green**

Run: `npx vitest run apps/web/test/runtime-card.test.tsx apps/web/test/overview-components.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/RuntimeCard.tsx apps/web/src/components/OverviewClient.tsx apps/web/src/server/overview.ts apps/web/test/runtime-card.test.tsx apps/web/test/overview-components.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts
git commit -m "feat(web): the operator picks the workspace's runtime and its budget"
```

---

## Series E — The Gate

### Task 14: `gate-m13-runtime.mjs` — a pause is a stop and a stop is resumable

**Files:**
- Create: `scripts/gate-m13-runtime.mjs`
- Modify: `package.json:30` (add the script after `gate:m12-providers`)
- Modify: `README.md:67` (add the row after the M12 row)

**Interfaces:**
- Consumes, from `packages/control/dist/index.js`: `isAlive`, `requestPause`, `requestResume`,
  `refusalText`, `setWorkspaceBudget`, `setWorkspaceProvider`. From `packages/db/dist/index.js`:
  `DOMAIN_EVENT_TYPE_BY_DB_VALUE`. From `packages/db/dist/client.js`: `prisma`. From
  `playwright-core`: `chromium`, as `gate-m11-shell.mjs` uses it.
- Produces: `npm run gate:m13-runtime`, whose final line on success is exactly
  `PASS: a pause is a stop and a stop is resumable` and whose exit code is 0.

**Skeleton, taken from `scripts/gate-m12-providers.mjs`:** dist imports; `let exitCode = 1` set to
`0` only by falling off the end of one `try`; bounded `waitUntil(description, timeoutMs, probe)`
whose probe returns `{ done, value, detail }` so a timeout says what it last SAW; `preflightCleanup()`
removing prior `M13 Gate`-prefixed workspaces; `dumpGateRows()` and `fail(message)` for the
diagnostic throw; `resolveOnPath(name)` honouring `AITEAMOS_CLAUDE_BIN` / `AITEAMOS_CURSOR_BIN`;
FK-ordered cleanup in `finally`; `process.exit(exitCode)` as the last line.

**What this gate adds to that skeleton, and must not omit:**

- **Vendor children die too.** M12's `finally` killed only the daemon. This one also kills every
  `claude` and `cursor-agent` process it caused, by pid from the `AgentRun` rows, before it deletes
  them (Decision 12): a gate that leaves a paid vendor process running is a gate that spends money
  after it exits.
- **A browser.** Stage 1 and stage 4 drive the real Runtime card, so `chromium` from
  `CHROMIUM_PATH` (defaulting to `/usr/bin/chromium`) launches as in `gate-m11-shell.mjs`, and
  `browser.close()` joins the `finally`.
- **Fail fast, never skip.** A missing `cursor-agent`, `claude`, `.env`, `DATABASE_URL` or Chromium
  is an immediate failure with a message naming the override variable.

**The five stages, each asserted against the DB and not against anything a process printed:**

1. **The card writes the configuration.** In a real browser, on `/w/<id>`, set the workspace's
   provider to `cursor` and tick "not budgeted". Assert the single `ProviderConfiguration` row
   reads `cursor` and `Workspace.budgetUsd` is `null`.
2. **A pause is a stop, on both runtimes.** For each of the two workers: wait for `working`; call
   `requestPause`; the instant `run.pause_requested` is in the log, call `requestResume` and assert
   it refuses with `run_still_stopping`; wait for `run.paused`; assert the pid is dead; call
   `requestResume` again and assert it is accepted; wait for `succeeded`; assert `Task.attempt` is
   unchanged.
3. **Cursor's gate refuses while paused.** On the Cursor run, a shell command attempted during the
   pause window lands as a `tool_call`/`completed` line with `result.rejected.reason`, and the
   run's `Checkpoint.deniedToolUseIds` is non-empty.
4. **The budget rule, and the card clearing it.** A second, budgeted workspace refuses `cursor`
   with `a budget needs a provider that reports cost`; then, through the card, set its budget to
   "not budgeted" and assert the same task dispatches.
5. **A failed resume costs an attempt.** Point a paused run's checkpoint at a dead session, request
   a resume on a task with `maxAttempts: 1`, and assert `Task.attempt` became 1, the task is
   `failed`, and the next tick starts no run.

**Stage order: 4, 1, 2, 3, 5 — not 1..5**, for M12's reason. Stage 4's refusal happens at dispatch
before any child exists, so running it first finds a broken admission guard in seconds rather than
after two paid runs; and stage 3's evidence is written by the pause stage 2 drives, so stage 2 must
run before stage 3 reads what it left behind. *(Corrected 2026-08-29, spec erratum E5: this line
read "4, 1, 3, 2, 5", which contradicted the very sentence after it. The executed order — and the
one the gate script's own header derives — is 4, 1, 2, 3, 5.)* Say this in the script's header comment, as
`gate-m12-providers.mjs` does.

- [ ] **Step 1: Write the script complete** (no RED phase — the script is the assertion)

Follow `scripts/gate-m12-providers.mjs` line for line for the skeleton pieces named above, with
these M13-specific constants at the top:

```javascript
const WORKSPACE_PREFIX = 'M13 Gate Project'
const UNBUDGETED_WORKSPACE = `${WORKSPACE_PREFIX} (unbudgeted) ${runTimestamp}`
const BUDGETED_WORKSPACE = `${WORKSPACE_PREFIX} (budgeted) ${runTimestamp}`
const CLAUDE_WORKER = 'Claude Worker'
const CURSOR_WORKER = 'Cursor Worker'
const PAUSE_REQUESTER = 'the M13 gate'
const PASS_LINE = 'a pause is a stop and a stop is resumable'
```

and this stage-2 core, which is the milestone's whole claim:

```javascript
/**
 * Pauses one run and proves the two locks in the order they actually fire.
 *
 * The immediate resume is issued the instant `run.pause_requested` is in the log -- NOT after a
 * sleep, and not after `run.paused`. That is the only window in which the run's row can still be
 * `pause_requested` with a live child, which is exactly what `run_still_stopping` exists to refuse
 * (M13 Decision 3). A gate that waited would prove nothing: after `run.paused` the pid is gone by
 * construction and the resume is legitimately accepted.
 */
async function pauseThenResume(label, runId, taskId) {
  const before = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })

  await waitUntil(`${label} to be working with at least one tool call recorded`, WORKING_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    if (row.status === 'working' && row.toolCalls >= 1) return { done: true, value: row }
    return { done: false, detail: `${row.status} toolCalls=${String(row.toolCalls)}` }
  })

  const requested = await requestPause(runId, PAUSE_REQUESTER)
  if (!requested.ok) await fail(`${label}: requestPause refused: ${refusalText(requested.error)}`)

  await waitUntil(`${label} to announce run.pause_requested`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
    const seen = await prisma.executionEvent.count({ where: { runId, type: 'run_pause_requested' } })
    return seen > 0 ? { done: true, value: true } : { done: false, detail: 'not announced yet' }
  })

  // Lock two, in its only observable window.
  const early = await requestResume(runId, null, PAUSE_REQUESTER)
  if (early.ok) {
    await fail(`${label}: a resume issued while the run was still stopping was ACCEPTED; it must be refused`)
  }
  if (early.error.kind !== 'run_still_stopping') {
    await fail(`${label}: expected run_still_stopping, got ${early.error.kind}: ${refusalText(early.error)}`)
  }
  if (refusalText(early.error) !== 'the run is still stopping; retry in a moment') {
    await fail(`${label}: the refusal text drifted: ${refusalText(early.error)}`)
  }

  const paused = await waitUntil(`${label} to settle on paused with a dead process`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { checkpoint: true } })
    if (row.status !== 'paused') return { done: false, detail: `status ${row.status}` }
    const announced = await prisma.executionEvent.count({ where: { runId, type: 'run_paused' } })
    if (announced === 0) return { done: false, detail: 'paused, but run.paused not announced yet' }
    // Decision 1, asserted against the operating system rather than against a status column.
    if (isAlive(row.pid)) return { done: false, detail: `paused and announced, but pid ${String(row.pid)} is alive` }
    if (row.checkpoint === null) return { done: false, detail: 'paused with no checkpoint' }
    return { done: true, value: row }
  })

  const accepted = await requestResume(runId, null, PAUSE_REQUESTER)
  if (!accepted.ok) await fail(`${label}: the resume after run.paused was refused: ${refusalText(accepted.error)}`)

  await waitUntil(`${label} to succeed after its resume`, RESUME_TERMINAL_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    if (row.status === 'succeeded') return { done: true, value: row }
    if (row.terminalAt !== null) return { done: false, detail: `terminal as ${row.status}` }
    return { done: false, detail: row.status }
  })

  const after = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
  if (after.attempt !== before.attempt) {
    await fail(`${label}: a pause-and-resume cost an attempt (${String(before.attempt)} -> ${String(after.attempt)}); only FAILURES count`)
  }
  return paused
}
```

and this `finally`, which is the part M12's does not have:

```javascript
} finally {
  // Vendor children first, by pid off the rows, BEFORE the rows are deleted (Decision 12). A gate
  // that exits leaving a `claude` or `cursor-agent` alive is a gate that keeps spending after it
  // has reported.
  for (const workspaceId of [unbudgetedWorkspaceId, budgetedWorkspaceId]) {
    if (workspaceId === null) continue
    const runs = await prisma.agentRun
      .findMany({ where: { agent: { team: { workspaceId } } }, select: { id: true, pid: true } })
      .catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      console.log(`cleanup: killing vendor child ${String(run.pid)} for run ${run.id}`)
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone between the check and the signal -- the outcome we wanted anyway.
      }
    }
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) nextServer.kill('SIGKILL')
  if (daemon !== null && daemon.exitCode === null) { /* the m12 SIGTERM-then-SIGKILL block, verbatim */ }
  // …then the FK-ordered row cleanup, exactly as gate-m12-providers.mjs does it.
}
```

- [ ] **Step 2: Rehearse against fake CLIs — zero spend**

```bash
tsc --build
AITEAMOS_CLAUDE_BIN="$PWD/packages/providers/test/fake-claude.mjs" \
AITEAMOS_CURSOR_BIN="$PWD/scripts/fake-cursor-for-gate.sh" \
node --env-file=.env scripts/gate-m13-runtime.mjs
```

Write `scripts/fake-cursor-for-gate.sh` as part of this step if one does not exist: a shell script
that ignores argv, emits a `system`/`init` line, a `tool_call` pair, and a `result` line, then
sleeps until signalled — enough for stages 1, 4 and 5 and for every wait's plumbing. Iterate here,
not against the real binaries, until the script's own bugs are gone. Record how many rehearsals it
took.

- [ ] **Step 3: Run `npm run gate:m13-runtime` for real**

Expected final line: `PASS: a pause is a stop and a stop is resumable`, exit 0.

**Budget: three paid executions, no more.** If the third fails on something product-shaped, STOP and
report BLOCKED with the diagnostic dump rather than spending a fourth. A failure in the script's own
plumbing goes back to Step 2's fake CLIs, which cost nothing.

- [ ] **Step 4: Wire the script and the README row**

`package.json`, after `gate:m12-providers`:

```json
    "gate:m13-runtime": "tsc --build && node --env-file=.env scripts/gate-m13-runtime.mjs"
```

`README.md`, after the M12 row:

```markdown
| `npm run gate:m13-runtime` | The M13 gate: a pause is a stop and a stop is resumable — both runtimes paused, refused mid-stop, resumed, and re-budgeted from the browser (**spends real money**: it drives live Claude and Cursor accounts, so it is not CI-runnable and is run deliberately, by hand) |
```

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/gate-m13-runtime.mjs scripts/fake-cursor-for-gate.sh package.json README.md
git commit -m "docs(m13): the measured gate proves a pause is a stop on both runtimes"
```

---

## Spec coverage

Every section of `docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md`, and the task
that implements it.

| Spec | Task |
|---|---|
| §1 Series A — a pause is a stop | 1, 2, 3, 4 |
| §1 Series B — one runtime module | 5, 6, 7, 8 |
| §1 Series C — Cursor's gate proven | 9, 10 |
| §1 Series D — the operator chooses | 11, 12, 13 |
| §1 Series E — the record and the gate | 14 |
| §2 D1 a run is `paused` when its process is dead | 1 |
| §2 D2 the checkpoint is still written before the kill | 1 |
| §2 D3 two locks, not one | 1 (pump ordering) + 2 (`run_still_stopping`) |
| §2 D4 every failed start or resume costs an attempt | 3 |
| §2 D5 a claim that cannot be signalled is released | 4 |
| §2 D6 shared code has one home, below `control` | 6 (`kill.ts` re-export), 5, 7, 8 |
| §2 D7 refactors are behavior-preserving and prove it | 5, 6, 7 (suite-green protocol); 7 step 8 (byte-diff) |
| §2 D8 a capability is raised only by committed evidence | 9, 10 |
| §2 D9 one workspace, one provider row | 11 (`setWorkspaceProvider` replaces in one transaction) |
| §2 D10 the budget rule lives in one place | 11 (no write-time check) + 13 (the derived warning) |
| §2 D11 halted workspaces stay editable | 11 (test: "does not refuse a halted workspace") |
| §2 D12 money-spending gates say so | 14 (README marker, vendor kill, fake-CLI rehearsal) |
| §3.1 the pump's gate-deny branch | 1 |
| §3.2 `requestResume` liveness | 2 |
| §3.3 attempts on a failed resume | 3 |
| §3.4 claim, signal, release | 4 |
| §3.5 tests (ordering, liveness, attempts, fan-out; re-pointed Claude tests listed in the report) | 1, 2, 3, 4 — each carries a report requirement naming its re-pointed tests |
| §4.1 `runtime/` — event-queue, summary | 5 |
| §4.1 `runtime/` — process (kill, terminateChild, buildChildEnv) + `control/kill.ts` re-export | 6 |
| §4.1 `runtime/` — pause-flag, gate-preflight | 7 |
| §4.2 `scripts/lib/pause-flag.sh`, the argv hole, the directory hole | 8 |
| §4.3 proof of behavior preservation | 5, 6, 7 (before/after suite + deleted line count); 7 step 8 (byte-diff vs `main`) |
| §5 two measured runs, committed fixtures, parser fixture | 9 |
| §5 the three outcome branches | 10 |
| §6.1 `setWorkspaceProvider` / `setWorkspaceBudget`, `invalid_budget`, the event | 11 |
| §6.2 the two routes | 12 |
| §6.3 `RuntimeCard`, the DTO's `provider`, the derived warning | 13 |
| §6.4 tests: control (real DB), routes, component | 11, 12, 13 |
| §7.1 supersedes (already recorded in the spec itself) | — no task; §7.1 IS the record. Task 10 lands the capability the second bullet defers to, and Task 14's README row carries the milestone's public entry |
| §7.2 `gate-m13-runtime.mjs`, the five stages, the PASS line | 14 |
| §8 testing (ordering, liveness, attempts, preservation, evidence, surfaces) | 1, 2, 3, 5–7, 9, 11–13 |
| §9 milestone gate: `npm run gate:m13-runtime` + the triple on every task | 14, and every task's own gate step |

## After the plan

Deferred beyond M13 and still open from the M11 backlog: the global `AgentRun` spend scan, the
`sweep.test.ts` timing flake, the spec §3 new-row rise, and an auth/origin story before any
non-loopback binding. Deferred by this spec: API-based adapters, failover chains, pricing tables, a
third provider, multi-row provider configuration per workspace, and un-assigning a company.

One thing this plan records rather than fixes:

- **Cursor's gate configuration lives inside the worktree it gates** (`.cursor/hooks.json`; the CLI
  has no out-of-tree settings path), so a run can delete its own gate. Claude's settings live
  outside the worktree. Emergency stop (cancellation) is unaffected on both. Spec §7.1 states this
  as the milestone's new named limitation.
