import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { runId as brandRunId, taskId as brandTaskId, type RunId, type TaskId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { concludePlanning } from './planning.js'
import { concludeReview } from './review.js'
import { describeOutcome, runShellCommand } from './shell.js'
import { releaseTaskAfterFailure } from './taskRelease.js'

/**
 * Four outcomes, named rather than encoded in the nullability of two other fields.
 *
 * `not_configured` and `could_not_run` are both "we did not learn anything about the work", but for
 * opposite reasons and with opposite remedies: the first is the workspace's configuration and
 * affects every task in it, the second is this task's environment. Neither is the slave's fault,
 * so neither costs it an attempt. Without a discriminator both would have to overload
 * `failedCommand === null`, which already means "everything passed".
 */
export type VerifyOutcome = 'passed' | 'failed' | 'not_configured' | 'could_not_run'

export interface VerifyResult {
  readonly kind: VerifyOutcome
  /** Convenience for the one question most callers ask. Always `kind === 'passed'`. */
  readonly passed: boolean
  /** `null` when nothing failed — either everything passed, or nothing ran. */
  readonly failedCommand: string | null
  /** `null` when the command was killed or timed out rather than exiting. */
  readonly exitCode: number | null
  readonly output: string
}

export interface RunVerifyInput {
  readonly taskId: TaskId
  readonly worktreePath: string
  /**
   * Where the per-command logs go. Explicit rather than derived from `worktreePath` by walking up
   * to the repository root: the logs must not land *inside* the worktree — that is what the slave
   * commits from, and Task 13 already had to move the run's settings and pause flag out for the
   * same reason — and deriving the path would silently couple verify to the worktree layout.
   */
  readonly artifactDir: string
  readonly commands: readonly string[]
  readonly timeoutMs: number
}

export interface AdvanceInput {
  readonly taskId: TaskId
  readonly result: VerifyResult
  readonly branch: string
}

/** `task.verify_failed` wants an integer; a killed or timed-out command has no exit code at all. */
const NO_EXIT_CODE = -1

/**
 * The statuses a verify result may act on. A task that is `cancelled`, already `done`, or already
 * `failed` has left this loop, and a result arriving for it is stale by definition.
 */
const ADVANCEABLE: readonly string[] = ['running', 'verifying']

/**
 * One log file per command, per attempt.
 *
 * The attempt is in the path because the command list is the *same list* every attempt, so a path
 * built from the command alone is the same path every attempt — the second run silently overwrites
 * the first, and the first attempt's `Artifact` row then reports the second attempt's output. That
 * is worse than losing it: M4/M5 render it as the earlier attempt with nothing to say otherwise.
 * The index prefix keeps two commands apart when they slugify identically after truncation.
 */
function logPathFor(artifactDir: string, attempt: number, index: number, command: string): string {
  const slug =
    command
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'command'
  return join(artifactDir, `attempt-${String(attempt).padStart(2, '0')}`, `${String(index + 1).padStart(2, '0')}-${slug}.log`)
}

/**
 * Runs the workspace's verify commands in the worktree, in order, stopping at the first failure.
 *
 * Spec §8. Every command's exit code and captured output is persisted as an `Artifact`, because
 * without it the reason a task failed is lost and M4/M5 have nothing to show.
 *
 * Stopping at the first failure rather than running the list out: later commands routinely depend
 * on earlier ones (`npm run build` then `npm test`), so continuing produces a second, misleading
 * result from a command that should never have run — and here that result is what gets handed to
 * the next slave as the thing to fix.
 */
export async function runVerify(input: RunVerifyInput): Promise<VerifyResult> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })

  await appendEvent({
    type: 'task.verifying',
    workspaceId: task.workspaceId,
    taskId: task.id,
    actor: 'system',
    payload: { commandCount: input.commands.length },
  })

  if (input.commands.length === 0) {
    // The refusal spec §8 exists for. A workspace that configured no verify commands has proved
    // nothing, and "nothing failed" read as "it passed" is how work reaches `done` without anything
    // having checked it. Reported with a null `failedCommand`, which is what tells `advance` this
    // is a misconfiguration rather than a failing test.
    return {
      kind: 'not_configured',
      passed: false,
      failedCommand: null,
      exitCode: null,
      output:
        'this workspace has no verify commands configured, so nothing could be verified. ' +
        'An empty list is a refusal to prove the work, not a pass.',
    }
  }

  const attemptDir = join(input.artifactDir, `attempt-${String(task.attempt + 1).padStart(2, '0')}`)

  try {
    mkdirSync(attemptDir, { recursive: true })

    for (const [index, command] of input.commands.entries()) {
      // No git identity in the environment, deliberately, where provisioning supplies one: setup
      // is expected to be able to commit (§7.3 layer 1), verify is expected to *check* the work
      // rather than change it. A verify command that needs to commit is doing something this
      // milestone has not decided it may do.
      const outcome = await runShellCommand({
        command,
        cwd: input.worktreePath,
        timeoutMs: input.timeoutMs,
      })
      const failed = outcome.timedOut || outcome.signal !== null || outcome.code !== 0
      const summary = failed
        ? describeOutcome(command, input.timeoutMs, outcome)
        : `command exit 0: ${command}\n${outcome.output}`.trim()

      // The log inherits `COMMAND_OUTPUT_LIMIT`'s tail bound even though a file has no column
      // constraint. Deliberate: the bound is on the *capture*, not on the write, and lifting it
      // would put an unbounded stream in memory -- the hazard Task 11's runner exists to avoid.
      // The tail is the part that carries the error.
      const path = logPathFor(input.artifactDir, task.attempt + 1, index, command)
      writeFileSync(path, `${summary}\n`)
      await prisma.artifact.create({ data: { taskId: task.id, kind: 'verify', path } })

      if (failed) {
        return { kind: 'failed', passed: false, failedCommand: command, exitCode: outcome.code, output: summary }
      }
    }
  } catch (error) {
    // A missing worktree, an unwritable artifact directory, no `/bin/sh`. Returned rather than
    // thrown: `task.verifying` has already been emitted, and throwing from here left the task
    // `running` with no terminal event and nothing to reconcile it -- silent, which §13 forbids.
    // Spec §13's taxonomy has no row for this; §8 is amended to name it.
    return {
      kind: 'could_not_run',
      passed: false,
      failedCommand: null,
      exitCode: null,
      output: `verify could not run in ${input.worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  return { kind: 'passed', passed: true, failedCommand: null, exitCode: null, output: '' }
}

/**
 * The reaction spec §3.2 leaves outside `decide()`: whatever a concluded run means for the *task*
 * it was working. Called by whoever awaited the run's pump — the tick's per-run chain for fresh
 * runs, `resume` for continuations — because the pump owns the *run* row and this owns what
 * happens to the *task* once the run is done with it.
 *
 * A `succeeded` run has work to judge, so verify runs on it and the task advances (or, for
 * `planning`/`review`, whatever concluding that kind means — see below). A `failed` run has no
 * tree anyone claims is finished, so verify never runs against it — but (M35 Task 1) an
 * `implementation` run's task must still be released, exactly as a failed resume already is by
 * `releaseTaskAfterFailure` (`./taskRelease.js`), rather than left `running` forever. A `review`
 * run's task is deliberately left alone on a review failure — see the comment on that branch below
 * for why. A `stopped` run was concluded by an operator whose decision stands; a `paused` run is
 * not terminal at all — both are left alone. The status checks read the row rather than trusting
 * the caller's outcome, because the pump hands back its outcome even when something else — a
 * cancel, the sweep — concluded the run first, and their decision is the one that counts.
 */
export async function verifyConcludedRun(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    include: { task: { include: { workspace: true } } },
  })
  if (run === null) return

  // M35 Task 1: `pump.ts`'s terminal conclusion writes `SlaveRun.status = 'failed'` and emits
  // `run.failed`, but touches no `Task` -- that write is this function's caller's whole reason for
  // existing (see the module doc), and until this branch a failed run was the one conclusion this
  // function silently ignored (the guard below used to read `run.status !== 'succeeded'` alone). A
  // task left `running` with `activeRunId` still pointing at the now-terminal run is invisible to
  // `decide()` (`STARTABLE` never includes `running`) and to the sweep (`ORPHANABLE`/`SWEEPABLE`
  // only reconcile NON-terminal runs) -- permanently stranded, no attempt charged.
  if (run.status === 'failed') {
    if (run.kind === 'implementation') {
      const { task } = run
      // Every `implementation` run has a task by construction (M8b) -- a null one here is data
      // corruption worth failing loudly on, exactly as the `succeeded` path below treats it.
      if (task === null) {
        throw new Error(`run ${run.id} of kind ${run.kind} has no task`)
      }
      const release = await releaseTaskAfterFailure(task, run.id, 'rework')
      if (release.exhausted) {
        // The task's own terminal, not just the run's -- §13: no failure is silent, and without
        // this a task that just spent its last attempt drops off the board with `run.failed` as
        // the only trace of why nothing is running against it any more.
        await appendEvent({
          type: 'task.failed',
          workspaceId: task.workspaceId,
          taskId: task.id,
          actor: 'system',
          payload: { reason: `implementation run failed after ${String(release.attempt)} attempt(s)` },
        })
      }
    }
    // `review`: deliberately left alone. Unlike `implementation`, a `reviewing` task with a dead
    // `activeRunId` does not strand -- `dispatchReview`'s "already live" gate (`review.ts`) counts
    // NON-terminal review runs for the task, never reads `Task.activeRunId`, so a `reviewing` task
    // is re-dispatched normally next tick. `review.ts` already has its own bounded-retry policy
    // for a review run that fails (`REVIEW_RETRY_CAP`, tested in review.test.ts's "invalid
    // verdict" and "diff itself cannot be produced" cases): it deliberately leaves `Task.status`
    // at `reviewing` and charges no `Task.attempt` for any SINGLE review failure. Releasing here
    // too would fight that policy with an implementation-shaped rework/attempt charge for the same
    // failure, not "handle it consistently" with it. Once the cap itself is spent, `dispatchReview`
    // parks the task `blocked` and says so (`guardrail.tripped`, M35 Task 4) on its own -- there is
    // still nothing for this function to release, because by then `Task.status` has already moved
    // off `reviewing` and this branch (guarded on `run.status === 'failed'`, which a `blocked` park
    // does not touch) is not where that happens.
    // `planning`: no task to release (M8b).
    return
  }
  if (run.status !== 'succeeded') return

  if (run.kind === 'planning') {
    // A planning run's succeeded process has produced a task graph, not a tree to check out --
    // `concludePlanning` parses that graph and turns it into the board (spec Decision) rather than
    // running the workspace's verify commands against it. Before the `task === null` check below:
    // a planning run has no task by construction (M8b), and that check exists for `implementation`
    // runs, not this one.
    await concludePlanning(brandRunId(run.id))
    return
  }

  if (run.kind === 'review') {
    // A review run's succeeded process has produced text, not a tree to check out -- `concludeReview`
    // judges that text (spec §3.2) rather than running the workspace's verify commands against it.
    await concludeReview(brandRunId(run.id))
    return
  }

  const { task } = run
  // Every run that reaches here is `implementation`, which always has a task -- M8b's task-less
  // run is `planning`, already routed away above, alongside `review`. A null task on this path is
  // data corruption worth failing loudly on, not a case to route around silently.
  if (task === null) {
    throw new Error(`run ${run.id} of kind ${run.kind} has no task`)
  }
  if (run.worktreePath === null || task.branch === null) {
    // Unreachable from the tick, which writes both before the pump ever starts. Warned rather than
    // silent (§13), and deliberately not advanced: there is no worktree to judge, and advancing a
    // task whose work nothing looked at is the exact failure §8 exists to prevent.
    console.warn(
      `[verify] run ${run.id} succeeded but has no ${run.worktreePath === null ? 'worktree' : 'branch'} recorded: not verifying`,
    )
    return
  }

  const result = await runVerify({
    taskId: brandTaskId(task.id),
    worktreePath: run.worktreePath,
    // Outside the worktree — that is what the slave commits from — and per task, the same layout
    // verify's own tests pin.
    artifactDir: join(task.workspace.repoPath, '.slaveofai', 'artifacts', task.id),
    commands: task.workspace.verifyCommands,
    // Spec §8 reuses the run's ceiling: the same operator's answer to the same question.
    timeoutMs: task.workspace.runTimeoutMs,
  })
  await advance({ taskId: brandTaskId(task.id), result, branch: task.branch })
}

export interface RejectOutcome {
  readonly attempt: number
  readonly exhausted: boolean
}

/**
 * Sends a task back for rework, or to `failed` at the cap: increments `attempt`, then compares it
 * against `maxAttempts`.
 *
 * Shared by `advance`'s verify-failed path and `concludeReview`'s review-rejected path (Task 6) —
 * both mean "another rework cycle, unless the budget is spent" — and by Task 7's merge-conflict
 * path. Extracted rather than left duplicated: two call sites counting attempts differently is a
 * bug waiting for whichever one is read second, the same reasoning `failToStart` in Task 13 was
 * built on.
 *
 * Both writes are one transaction: a crash between them would leave the attempt spent, the status
 * unchanged, and `activeRunId` still set -- a task permanently busy with a burnt attempt, and
 * §3.4's reconciliation looks for runs with dead pids, not for tasks stranded mid-reject.
 */
export async function rejectTask(taskId: TaskId, reason: string): Promise<RejectOutcome> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
  return prisma.$transaction(async (tx) => {
    const incremented = await tx.task.update({
      where: { id: task.id },
      data: { attempt: { increment: 1 } },
    })
    const exhausted = incremented.attempt >= task.maxAttempts
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: exhausted ? 'failed' : 'rework',
        activeRunId: null,
        // The slave-facing channel: `buildPrompt` puts this in front of the next run as the thing
        // to fix first.
        lastRejectionReason: reason,
      },
    })
    return { attempt: incremented.attempt, exhausted }
  })
}

/**
 * Moves the task on from a verify result: `done`, back to `rework`, or `failed` at the cap.
 *
 * The attempt is incremented and then compared, matching `failToStart` in Task 13 — two paths that
 * count attempts differently is a bug waiting for whichever one is read second.
 */
export async function advance(input: AdvanceInput): Promise<void> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })
  const workspaceId = task.workspaceId

  // Only a task that is actually being worked on can be advanced. Two things fall out of one
  // check: a stale result arriving after an operator cancelled the task cannot resurrect it to
  // `done` and announce it, and a second call for the same result is a no-op rather than a second
  // attempt charged and a duplicate terminal event written into an append-only log. "Harmless if
  // called twice" here is a far cheaper property than "exactly once" at every call site.
  if (!ADVANCEABLE.includes(task.status)) {
    console.warn(`[verify] ignoring an advance for task ${task.id}, which is ${task.status}`)
    return
  }

  // `Task.branch` has two writers: the tick sets it at provisioning, this sets it on `done`. They
  // agree today and nothing enforces it. The branch is what a human merges, so finishing a task
  // pointing somewhere else is how work gets merged from a branch nobody looked at. Refuse rather
  // than overwrite -- a caller that legitimately re-branches a task can clear the field first, and
  // will have meant to.
  if (task.branch !== null && task.branch !== input.branch) {
    throw new Error(
      `refusing to advance ${task.id}: it was worked on branch ${task.branch}, ` +
        `but this result is for ${input.branch}`,
    )
  }

  if (input.result.kind === 'passed') {
    // The pipeline flip (M8a): a green verify no longer finishes the task itself -- it hands the
    // task to review (Task 5), whose approval hands it to the merge pass (Task 7), which is the
    // only place `task.done` is emitted now. `ADVANCEABLE` stays `['running', 'verifying']`: review
    // conclusion has its own path back to `rework`/`failed`/`merging`, not through here.
    await prisma.task.update({
      where: { id: task.id },
      // The rejection is cleared: it is the *previous* attempt's, and a task entering review
      // carrying one reads as a task that failed.
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

  // Neither of these is the slave's doing, so neither costs it an attempt: charging one spends the
  // task's budget on the orchestrator's problem, and with `maxAttempts` full slave runs per task it
  // would spend the workspace's too.
  if (input.result.kind !== 'failed') {
    const guardrail = input.result.kind === 'not_configured' ? 'verify_not_configured' : 'verify_could_not_run'
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'blocked', activeRunId: null },
    })
    if (input.result.kind === 'not_configured') {
      // Workspace-wide: every task here will hit the same wall, and §13.1 already settled what to
      // do about a misconfiguration that affects every run -- "failing runs one at a time while
      // continuing to start new ones is the worst available behaviour". Same mechanism, so the
      // operator's `clear-halt` retracts it the same way. Conditional, so the first reason stands.
      await prisma.workspace.updateMany({
        where: { id: workspaceId, haltedReason: null },
        data: { haltedReason: input.result.output, haltedAt: new Date() },
      })
    }
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { guardrail, detail: input.result.output },
    })
    return
  }

  await appendEvent({
    type: 'task.verify_failed',
    workspaceId,
    taskId: task.id,
    actor: 'system',
    payload: { command: input.result.failedCommand ?? '', exitCode: input.result.exitCode ?? NO_EXIT_CODE },
  })

  // Verify output is exactly what `lastRejectionReason` is for -- which is why Task 13 was
  // corrected to stop writing infrastructure errors into it, and why the two branches above do not
  // write it at all.
  const counted = await rejectTask(brandTaskId(task.id), input.result.output)

  await appendEvent(
    counted.exhausted
      ? {
          type: 'task.failed',
          workspaceId,
          taskId: task.id,
          actor: 'system',
          payload: { reason: `verify failed after ${counted.attempt} attempts: ${input.result.output}` },
        }
      : {
          type: 'task.rework',
          workspaceId,
          taskId: task.id,
          actor: 'system',
          payload: { reason: input.result.output, attempt: counted.attempt },
        },
  )
}
