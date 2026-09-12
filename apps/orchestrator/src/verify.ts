import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runbookForWorkspace } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  parseHandoffContract,
  runId as brandRunId,
  taskId as brandTaskId,
  type GuardrailKind,
  type RunId,
  type TaskId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { promote } from './memory.js'
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
  /**
   * M48 R6: the runbook stage whose GATE failed, when one did.
   *
   * `null` on every non-failure and on a workspace command's failure -- a workspace command is the
   * project's own, whatever stage the task happens to be in, and attributing it to a stage would
   * tell an operator the process is at fault for a command every task runs.
   */
  readonly stage: string | null
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
  /**
   * M48 R6: the runbook stage's own gates, appended to {@link commands} by the caller and named
   * here so a failure can be attributed. `null` for a task with no stage, which is every task
   * planned before this milestone and every hand-made one.
   *
   * The GATES are passed rather than the index they start at: the two lists are concatenated by the
   * caller, and a count that had to stay in step with a concatenation is exactly the kind of
   * arithmetic that goes wrong when somebody later prepends a command. The one consequence of
   * matching by VALUE is that a workspace command spelt exactly like one of this stage's gates is
   * attributed to the stage -- a project that runs `npm test` as both has named the same check
   * twice, and pointing at the stage is the more useful of the two readings.
   */
  readonly stage: { readonly key: string; readonly gates: readonly string[] } | null
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
 * The contract's `expectedOutput`, when the task carries a contract that parses (M49 R2b).
 *
 * A column that will not parse is silently `null` here -- `handoffSection` already warns about it
 * once per dispatch, and a second warning per verify would be noise about the same row.
 */
function expectedOutputOf(handoff: unknown): string | null {
  if (handoff === null || handoff === undefined) return null
  const parsed = parseHandoffContract(handoff)
  return parsed.ok ? parsed.value.expectedOutput : null
}

/**
 * The worker that DID the work this outcome is about (M49 R2d, plan erratum E2).
 *
 * `hint` is the run the caller already holds, used only when it turns out to be an IMPLEMENTATION
 * run -- `advance`'s is. `concludeReview`'s is the REVIEWER's, so it passes null and this reads the
 * task's newest implementation run instead: the reviewer caught it, the implementer learns from it.
 * `Task.assigneeId` is not an answer -- nothing in the pipeline writes it.
 */
export async function implementerOf(taskId: string, hint: string | null): Promise<string | null> {
  if (hint !== null) {
    const run = await prisma.slaveRun.findUnique({ where: { id: hint }, select: { kind: true, slaveId: true } })
    if (run?.kind === 'implementation') return run.slaveId
  }
  const latest = await prisma.slaveRun.findFirst({
    where: { taskId, kind: 'implementation' },
    orderBy: { startedAt: 'desc' },
    select: { slaveId: true },
  })
  return latest?.slaveId ?? null
}

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
      stage: null,
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
      // Which list this command came from. A gate and a workspace command are the same shell
      // invocation; what differs is who is owed the explanation when it fails.
      const fromStage = input.stage !== null && input.stage.gates.includes(command)
      const label = fromStage && input.stage !== null ? `stage "${input.stage.key}" gate: ${command}` : command
      const summary = failed
        ? describeOutcome(label, input.timeoutMs, outcome)
        : `command exit 0: ${label}\n${outcome.output}`.trim()

      // The log inherits `COMMAND_OUTPUT_LIMIT`'s tail bound even though a file has no column
      // constraint. Deliberate: the bound is on the *capture*, not on the write, and lifting it
      // would put an unbounded stream in memory -- the hazard Task 11's runner exists to avoid.
      // The tail is the part that carries the error.
      const path = logPathFor(input.artifactDir, task.attempt + 1, index, command)
      writeFileSync(path, `${summary}\n`)
      await prisma.artifact.create({ data: { taskId: task.id, kind: 'verify', path } })

      if (failed) {
        return {
          kind: 'failed',
          passed: false,
          failedCommand: command,
          exitCode: outcome.code,
          output: summary,
          stage: fromStage && input.stage !== null ? input.stage.key : null,
        }
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
      stage: null,
      output: `verify could not run in ${input.worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  return { kind: 'passed', passed: true, failedCommand: null, exitCode: null, output: '', stage: null }
}

/**
 * The gates a task's runbook stage owes, ready to hand to {@link runVerify} (M48 R6).
 *
 * `null` in all three ordinary cases: the task carries no stage, the project has adopted no
 * runbook, or the adopted runbook has no key matching the stamp. The third is a task stamped
 * against a runbook the project has since replaced, which is a fact rather than a reason to refuse
 * the verify it would otherwise have had.
 *
 * The `stage === null` guard comes FIRST so an UNSTAGED task -- every task planned before this
 * milestone and every hand-made one -- pays no runbook read at all. That is the common case on both
 * call sites, and both of them are on a per-task hot path.
 *
 * Shared by {@link verifyConcludedRun} and the merge pass's post-rebase re-verify
 * (`apps/orchestrator/src/merge.ts`, fix round 1 controller ruling): a rebase can change behaviour
 * without a textual conflict, and what a stage's gate proves is exactly as true of the rebased tree
 * as of the tree review read. One gate therefore runs twice for a clean merge -- once at verify,
 * once here -- which is intended: a gate is a check, and running a check twice costs its runtime.
 */
export async function stageGatesFor(
  workspaceId: string,
  stage: string | null,
  workspaceCommands: readonly string[],
): Promise<{ readonly key: string; readonly gates: readonly string[] } | null> {
  if (stage === null) return null
  const runbook = await runbookForWorkspace(workspaceId)
  if (runbook === null) return null
  const found = runbook.stages.find((entry) => entry.key === stage)
  if (found === undefined) return null
  // A gate the workspace ALREADY runs is dropped here (M48 final review, Minor 4). Both callers
  // concatenate `[...workspaceCommands, ...gates]`, so a runbook whose verify stage gates `npm
  // test` on a project whose verify list is `npm test` ran it twice -- the same command, the same
  // tree, the same answer, at the cost of a second full test run on every task of that stage. Once
  // is enough, and the surviving copy is the WORKSPACE's: `runVerify` attributes a failure by
  // asking whether the command is in `stage.gates`, so leaving it in both lists would report the
  // project's own verify command failing as a stage gate and send an operator looking for it in
  // the runbook. Byte-equality, deliberately: "the same command" is not a judgement this can make
  // about `npm test` versus `npm test --silent`.
  //
  // The workspace's list is a PARAMETER rather than a second read of the row: both call sites hold
  // the workspace already, and a required argument is what stops a third one from silently
  // reintroducing the duplicate.
  return { key: found.key, gates: found.gates.filter((gate) => !workspaceCommands.includes(gate)) }
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
 * run's task gets its CLAIM back and nothing else — no status change and no attempt, because the
 * review retry cap governs review failures; see the comment on that branch below for why. A
 * `stopped` run was concluded by an operator whose decision stands; a `paused` run is
 * not terminal at all — both are left alone. That last clause is also what covers M36 t2 with no
 * branch of its own: a run that ended by asking another slave a question parks in `paused` (with
 * `SlaveRun.pauseReason = waiting_for_answer`) and its task in `waiting`, so it falls out of the
 * `succeeded`/`failed` checks below untouched — no verify pass, no release, no attempt. The
 * detection itself cannot live here: it needs the spawn facts a `Checkpoint` is written from, and
 * those exist only inside the pump that started the run (see `apps/orchestrator/src/ask.ts`). The status checks read the row rather than trusting
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
    if (run.kind === 'review') {
      // The claim, and ONLY the claim. Since M41 Task 3b a review run holds `Task.activeRunId`
      // from its dispatch (`review.ts`, mirroring `startRun`) precisely so the tick its own
      // `run.succeeded` wakes cannot start a second reviewer on the same branch. That claim has to
      // come back when the run ends `failed` without a conclusion -- an operator's stop, a gate
      // failure, the sweep -- or the task sits in `reviewing` pointing at a terminal run and NO
      // later dispatch can ever claim it again. That is the strand this arm closes.
      //
      // `Task.status` is deliberately untouched and NO attempt is charged, which is why this is not
      // `releaseTaskAfterFailure`. `review.ts` has its own bounded-retry policy for a review run
      // that fails (`REVIEW_RETRY_CAP`, tested in review.test.ts's "invalid verdict" and "diff
      // itself cannot be produced" cases): it leaves the task in `reviewing` and charges no
      // `Task.attempt` for any SINGLE review failure, and once the cap is spent `dispatchReview`
      // parks the task `blocked` and says so (`guardrail.tripped`, M35 Task 4). An
      // implementation-shaped rework/attempt charge here would fight that policy rather than
      // handle it consistently -- the review's failure is judged by the cap, not by the task's
      // attempt budget. So the retry policy is exactly what it was; all that changed is that the
      // retry can now actually claim the task.
      //
      // Guarded on the run id, like every other release: a cancel, the sweep, or a conclusion for
      // this run replayed a second time must not clear a newer run's claim.
      if (run.taskId !== null) {
        await prisma.task.updateMany({
          where: { id: run.taskId, activeRunId: run.id },
          data: { activeRunId: null },
        })
      }
    }
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

  // M49 R2(a), here and not in `advance` (plan erratum E1): this is the one place a SUCCEEDED
  // implementation run, its slave and its task are all in hand, and `advance` is handed a result
  // rather than a run. BEFORE the verify below, so the candidate already exists for the fact to
  // retire (plan decision D3).
  //
  // Guarded on what is already there, because this function is legitimately REPLAYABLE: a
  // restarted daemon or a duplicate pump settlement concludes the same succeeded run again, and a
  // second observation for one run is a second unverified claim for the Supervisor to count and a
  // person to read. Keyed on the task, which is the index this table has for exactly that.
  const remembered = await prisma.memory.count({
    where: { taskId: task.id, runId: run.id, type: 'observation' },
  })
  if (remembered === 0) {
    const lastOutput = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_output' },
      orderBy: { seq: 'desc' },
      select: { seq: true, payload: true },
    })
    await promote({
      kind: 'run_succeeded',
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskTitle: task.title,
      runId: run.id,
      slaveId: run.slaveId,
      finalText:
        lastOutput === null ? '' : ((lastOutput.payload as { text?: unknown }).text as string | undefined) ?? '',
      lastOutputSeq: lastOutput === null ? null : Number(lastOutput.seq),
      requiredCapabilities: task.requiredCapabilities,
      goalVersion: task.goalVersion,
    })
  }

  // M48 R6: the stage's gates, after the workspace's own. A stage gate is a project's answer to
  // "what does this phase have to prove", and it runs LAST for `runVerify`'s own reason -- later
  // commands routinely depend on earlier ones, and a stage's gate is the most specific thing here.
  const stage = await stageGatesFor(task.workspaceId, task.stage, task.workspace.verifyCommands)

  const result = await runVerify({
    taskId: brandTaskId(task.id),
    worktreePath: run.worktreePath,
    // Outside the worktree — that is what the slave commits from — and per task, the same layout
    // verify's own tests pin.
    artifactDir: join(task.workspace.repoPath, '.slaveofai', 'artifacts', task.id),
    commands: [...task.workspace.verifyCommands, ...(stage?.gates ?? [])],
    stage,
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
        // The slave-facing channel: `buildRunContext`'s `rejection` section puts this in front of
        // the next run as the thing to fix first.
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
  // M49 R2: the workspace's own verify commands ride along, because the fact a passed verification
  // becomes has to name what proved it and a `VerifyResult` carries no command list.
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: input.taskId },
    include: { workspace: { select: { verifyCommands: true } } },
  })
  const workspaceId = task.workspaceId
  // M49 R2: every branch below clears the claim, and both promotions want the run that did the
  // work. Read once, here, where it is still set.
  const runId = task.activeRunId

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
    // M49 R2(b): the commands agreed, so what the contract asked for is now a fact -- and the
    // observation the run left behind is answered by something better (plan decision D3).
    await promote({
      kind: 'verify_passed',
      workspaceId,
      taskId: task.id,
      taskTitle: task.title,
      runId,
      expectedOutput: expectedOutputOf(task.handoff),
      commands: task.workspace.verifyCommands,
      requiredCapabilities: task.requiredCapabilities,
      goalVersion: task.goalVersion,
    })
    return
  }

  // Neither of these is the slave's doing, so neither costs it an attempt: charging one spends the
  // task's budget on the orchestrator's problem, and with `maxAttempts` full slave runs per task it
  // would spend the workspace's too.
  if (input.result.kind !== 'failed') {
    // `satisfies GuardrailKind`, like every other `guardrail.tripped` producer (final wave, I2).
    // `verify_not_configured` was written here for a whole milestone without being in the closed
    // list, which is exactly the mistake this clause turns into a build error.
    const guardrail = (
      input.result.kind === 'not_configured' ? 'verify_not_configured' : 'verify_could_not_run'
    ) satisfies GuardrailKind
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
    payload: {
      command: input.result.failedCommand ?? '',
      exitCode: input.result.exitCode ?? NO_EXIT_CODE,
      // M48 R6/E11: which stage's gate it was, when it was one. Absent for a workspace command,
      // exactly as `droppedCapabilities` is absent when nothing was dropped.
      ...(input.result.stage === null ? {} : { stage: input.result.stage }),
    },
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

  // M49 R2(d): the commands turned the work down, and the worker that did it is the one that
  // learns from it. AFTER the events, never before: a lesson is a record of what happened, and
  // what happened is what those events say.
  await promote({
    kind: 'work_rejected',
    workspaceId,
    taskId: task.id,
    taskTitle: task.title,
    slaveId: await implementerOf(task.id, runId),
    runId,
    reason: input.result.output,
    by: 'verification',
    sourceRef: runId,
    requiredCapabilities: task.requiredCapabilities,
    goalVersion: task.goalVersion,
  })
}
