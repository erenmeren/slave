/**
 * Skeleton spec S7: the smoke gate's attempt. Before a goal version's verification run, the
 * orchestrator runs the project's own `bash scripts/smoke.sh` -- no model -- in a fresh detached
 * checkout of the integration tip, and routes the outcome: a pass lets the verification run start;
 * a stub, a missing or a non-executable script sends the skeleton back; any other failure sends the
 * integration package back; the round cap stops the version for a person.
 *
 * The delivery's lock is taken to CLAIM and to CONCLUDE, never around the run (plan B D1): a smoke
 * can take fifteen minutes, and the lock's transaction times out at two. The run itself is
 * background work in the tick's `pumps`, like a slave's run.
 */
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { goalEventWith, isAlive, withDeliveryLock } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  SMOKE_OUTPUT_MAX_CHARS,
  SMOKE_SCRIPT_PATH,
  SMOKE_STRANDED_GRACE_MS,
  classifySmoke,
  renderSmokeRework,
  smokeProjectName,
  smokeReworkTarget,
  smokeScriptFailure,
  smokeStopReason,
  trimEvidence,
  type SmokeFailure,
  type SmokeOutcome,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { CHILD_ENV_ALLOW } from '@slave-of-ai/providers'
import { needsHumanInLock } from './goal.js'
import { OWNER_INSTANCE, ownerGone } from './runs.js'
import { runShellCommand } from './shell.js'
import { pumps } from './tick.js'
import { removeVerificationWorktree } from './verification.js'
import { gitIn, provisionDetachedWorktree, worktreeRootFor } from './worktree.js'

/** The attempts THIS process is running (the `activePumpRunIds` idiom, plan B D8). */
export const activeSmokeIds = new Set<string>()

/** Under the `verify-` prefix on purpose: `removeVerificationWorktree` removes it unchanged (plan B D6). */
export const smokeWorktreeKey = (attemptId: string): string => `verify-smoke-${attemptId.slice(0, 8)}`

/** Plan B D6 (ruling F12): what a daemon may hand a smoke script beyond `CHILD_ENV_ALLOW` -- how to reach Docker. */
const SMOKE_ENV_EXTRA = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR'] as const

/** The docker cleanup's bound: a hung daemon must not hold a tick's background work forever. */
const DOCKER_CLEANUP_TIMEOUT_MS = 120_000

/**
 * The stored output's bound (ruling F1): `trimEvidence` adds a cut marker of about thirty
 * characters past its `max`, and the `workspace.smoke_run` event rejects more than
 * {@link SMOKE_OUTPUT_MAX_CHARS}. A rejected event would throw inside the conclusion every pass,
 * never releasing the claim -- so the stored text leaves the marker room.
 */
const SMOKE_STORED_OUTPUT_MAX_CHARS = SMOKE_OUTPUT_MAX_CHARS - 64

/** The recorded output of a script that exists without its executable bit (F10). Its conclusion
 *  reads this prefix back to tell the skeleton to `chmod +x` rather than to write the script. */
const NOT_EXECUTABLE_OUTPUT = `${SMOKE_SCRIPT_PATH} is not executable`

/**
 * The smoke script's environment (spec S7): a run's allow list, how to reach Docker, and the
 * attempt's own project name. Absent, never empty, for a name the daemon does not hold.
 */
export function smokeEnv(project: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...CHILD_ENV_ALLOW, ...SMOKE_ENV_EXTRA]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, SLAVEOFAI_SMOKE_PROJECT: project }
}

/** Thrown inside the lock when the claim was lost: the attempt row inserted beside it must roll back. */
class LostSmokeClaim extends Error {}
/** Thrown inside the lock when a rework's delivery move lost its guard: the task's move must roll back. */
class NotTheSmoke extends Error {}

/**
 * Starts a smoke attempt of a goal version, or returns null. From `integrating` it starts a new
 * round (`round + 1`, `verifying`, run failures reset -- plan B D3); from `verifying` with no claim
 * it tries the same round again. The tip is read first and checked out by SHA, so the attempt
 * checks exactly the commit it records.
 */
export async function startSmoke(deliveryId: string): Promise<string | null> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { repoPath: true, archivedAt: true } } } })
  const newRound = delivery.status === 'integrating'
  if (!newRound && !(delivery.status === 'verifying' && delivery.activeRunId === null && delivery.activeSmokeId === null)) return null
  if (delivery.workspace.archivedAt !== null) return null
  let tip: string
  try {
    tip = await gitIn(delivery.workspace.repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${delivery.integrationBranch}^{commit}`)
  } catch {
    // A deleted branch: the goal pass's own trip says so (`integrationTipOrTrip`); nothing to check.
    return null
  }
  const round = newRound ? delivery.round + 1 : delivery.round
  let attemptId: string | null
  try {
    attemptId = await withDeliveryLock(delivery.id, async (tx) => {
      // Re-read under the lock: an overlapping pass may have claimed it, or moved the version, meanwhile.
      const now = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
      if (now.status !== delivery.status || now.round !== delivery.round || now.activeRunId !== null || now.activeSmokeId !== null) return null
      const attempt = await tx.smokeAttempt.create({
        data: { workspaceId: now.workspaceId, goalDeliveryId: now.id, goalVersion: now.goalVersion, round, tip, ownerInstance: OWNER_INSTANCE },
        select: { id: true },
      })
      const moved = await tx.goalDelivery.updateMany({
        where: { id: now.id, status: now.status, activeRunId: null, activeSmokeId: null },
        data: newRound ? { status: 'verifying', round, roundRunFailures: 0, activeSmokeId: attempt.id } : { activeSmokeId: attempt.id },
      })
      // A THROW, not a return: a returned value would commit the attempt row inserted above.
      if (moved.count === 0) throw new LostSmokeClaim()
      return attempt.id
    })
  } catch (error) {
    if (error instanceof LostSmokeClaim) return null
    throw error
  }
  if (attemptId === null) return null
  const id = attemptId
  activeSmokeIds.add(id)
  const job: Promise<void> = executeSmoke(id)
    .catch((error: unknown): void => {
      // The attempt stays `running` and claimed; `settleStrandedSmoke` finds it (this process no longer runs it).
      console.error(`[smoke] attempt ${id} failed outside its own handling:`, error)
    })
    .finally((): void => {
      activeSmokeIds.delete(id)
      pumps.delete(job)
    })
  pumps.add(job)
  return id
}

interface SmokeResult {
  readonly status: Exclude<SmokeOutcome, 'running'>
  readonly exitCode: number | null
  readonly signal: string | null
  readonly output: string
}

/** The checkout's script: absent, present without its executable bit, or runnable (F10). */
function scriptState(path: string): { readonly exists: boolean; readonly executable: boolean } {
  try {
    const stat = statSync(path)
    return { exists: stat.isFile(), executable: stat.isFile() && (stat.mode & 0o111) !== 0 }
  } catch {
    return { exists: false, executable: false }
  }
}

/** Kills what is left of a finished script's process group -- a server it backgrounded and never
 *  stopped. Its leader is gone, so the group id cannot yet belong to anything else. */
function killLeftovers(pid: number | null): void {
  if (pid === null) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The whole group is already gone -- the ordinary case.
  }
}

/**
 * The attempt itself: checkout, script, cleanup, record, apply. The checkout and the script's
 * containers are removed whatever happened, before the result is recorded.
 */
async function executeSmoke(attemptId: string): Promise<void> {
  const attempt = await prisma.smokeAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { workspace: { select: { repoPath: true, smokeTimeoutMs: true } } } })
  const repoPath = attempt.workspace.repoPath
  const key = smokeWorktreeKey(attemptId)
  const worktreePath = resolve(worktreeRootFor(repoPath), key)
  const project = smokeProjectName(attemptId)
  const started = Date.now()
  let result: SmokeResult
  let pid: number | null = null
  let pidWritten: Promise<unknown> = Promise.resolve()
  try {
    // Recorded before the add, so a daemon that dies mid-provision leaves the next one a path to remove.
    await prisma.smokeAttempt.update({ where: { id: attemptId }, data: { worktreePath } })
    // Plan B D6: no setup commands -- the smoke starts the product the way the README says, from a clean clone.
    await provisionDetachedWorktree({ repoPath, ref: attempt.tip, key, setupCommands: [] })
    const state = scriptState(join(worktreePath, SMOKE_SCRIPT_PATH))
    if (smokeScriptFailure(state) === 'missing') {
      const why = state.exists ? NOT_EXECUTABLE_OUTPUT : `${SMOKE_SCRIPT_PATH} does not exist`
      result = { status: 'missing', exitCode: null, signal: null, output: `${why} at ${attempt.tip.slice(0, 12)}` }
    } else {
      const outcome = await runShellCommand({
        command: `bash ${SMOKE_SCRIPT_PATH}`,
        cwd: worktreePath,
        timeoutMs: attempt.workspace.smokeTimeoutMs,
        env: smokeEnv(project),
        onSpawn: (spawned): void => {
          pid = spawned
          pidWritten = prisma.smokeAttempt.update({ where: { id: attemptId }, data: { pid: spawned } }).catch(() => undefined)
        },
      })
      result = { status: classifySmoke(outcome), exitCode: outcome.code, signal: outcome.signal, output: outcome.output }
    }
  } catch (error) {
    // The orchestrator's own failure (worktree, spawn): retried like an unusable verification, charged to nobody.
    result = { status: 'error', exitCode: null, signal: null, output: `the smoke check could not be run: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    killLeftovers(pid)
    await pidWritten
    await cleanUpSmokeProject(project)
    await removeVerificationWorktree(repoPath, worktreePath)
  }
  await recordSmokeResult(attemptId, result, Date.now() - started)
  await applySmokeOutcome(attemptId)
}

/** `running` -> the outcome, once (a second writer finds it concluded). */
async function recordSmokeResult(attemptId: string, result: SmokeResult, durationMs: number): Promise<void> {
  await prisma.smokeAttempt.updateMany({
    where: { id: attemptId, status: 'running' },
    data: {
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: Math.max(0, Math.round(durationMs)),
      output: trimEvidence(result.output, SMOKE_STORED_OUTPUT_MAX_CHARS),
      endedAt: new Date(),
    },
  })
}

/**
 * Plan B D6: best effort, by name -- containers a killed script started outside its process group
 * (a Docker daemon's children are not the script's). Logged, never thrown: a leftover container is
 * an operator's tidy-up, not a reason to lose the attempt's result.
 */
async function cleanUpSmokeProject(project: string): Promise<void> {
  const command = [
    'command -v docker >/dev/null 2>&1 || exit 0',
    `docker compose -p ${project} down -v --remove-orphans >/dev/null 2>&1`,
    `ids=$(docker ps -aq --filter "name=^${project}" 2>/dev/null)`,
    '[ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1',
    'exit 0',
  ].join('; ')
  await runShellCommand({ command, cwd: tmpdir(), timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS, env: smokeEnv(project) }).catch((error: unknown) => {
    console.warn(`[smoke] could not clean up ${project}: ${String(error)}`)
  })
}

/**
 * Applies a concluded attempt to its delivery (spec S7, plan B D3/D4), under the delivery's lock, in
 * the Plan 4b order: `workspace.smoke_run` (and a `task.rework`) first, each only if missing, then
 * the guarded moves. The event is written for EVERY concluded attempt, the claim held or not (ruling
 * F2, S7's "one event per attempt"): an attempt whose claim a person's abandon released still says
 * how it ended, with nothing sent back. Only the attempt holding `activeSmokeId` on a `verifying`
 * delivery moves anything. Replay-safe: a second call finds the event and the claim gone.
 */
export async function applySmokeOutcome(attemptId: string): Promise<void> {
  const attempt = await prisma.smokeAttempt.findUnique({ where: { id: attemptId } })
  if (attempt === null || attempt.status === 'running') return
  const outcome = attempt.status
  await withDeliveryLock(attempt.goalDeliveryId, async (tx) => {
    const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: attempt.goalDeliveryId }, include: { workspace: { select: { verificationRoundCap: true } } } })
    const holds = delivery.activeSmokeId === attempt.id && delivery.status === 'verifying'
    const cap = delivery.workspace.verificationRoundCap
    const capped = delivery.round - delivery.roundBase >= cap
    const packages = await tx.workPackage.findMany({
      where: { workspaceId: delivery.workspaceId, goalVersion: delivery.goalVersion },
      orderBy: { key: 'asc' },
      select: { key: true, isIntegration: true, tasks: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true, status: true, attempt: true } } },
    })
    const failure: SmokeFailure | null = outcome === 'passed' || outcome === 'error' ? null : outcome
    const targetKey = failure === null ? null : smokeReworkTarget(failure, packages)
    const task = packages.find((pkg) => pkg.key === targetKey)?.tasks[0]
    const reworks = holds && failure !== null && !capped && task?.status === 'done'

    if (!(await goalEventWith(tx, delivery.workspaceId, 'workspace_smoke_run', { attemptId: attempt.id }))) {
      await appendEvent({
        type: 'workspace.smoke_run',
        workspaceId: delivery.workspaceId,
        actor: 'system',
        payload: {
          version: delivery.goalVersion,
          round: attempt.round,
          attemptId: attempt.id,
          outcome,
          exitCode: attempt.exitCode,
          durationMs: attempt.durationMs ?? 0,
          output: attempt.output,
          reworkedPackage: reworks ? targetKey : null,
        },
      })
    }
    // Nothing written in this transaction yet, so returning commits nothing but the lock's release.
    if (!holds) return

    if (failure === null) {
      // A pass: the verification run may start. An error: the same round again, one run failure (D3).
      await tx.goalDelivery.updateMany({
        where: { id: delivery.id, status: 'verifying', activeSmokeId: attempt.id },
        data: outcome === 'error' ? { activeSmokeId: null, roundRunFailures: { increment: 1 } } : { activeSmokeId: null },
      })
      return
    }
    const stop = smokeStopReason({ outcome: failure, output: attempt.output })
    if (capped) {
      await needsHumanInLock(tx, delivery.id, null, `the verification round cap (${String(cap)}) was reached on a failing smoke check: ${stop}`)
      return
    }
    if (task === undefined || task.status !== 'done') {
      const reason = `the smoke check found ${stop}, and ${targetKey === null ? 'no package' : `package "${targetKey}"`} can be sent back for it`
      const cause = task === undefined ? undefined : { kind: 'blocked_package' as const, tasks: [{ taskId: task.id, status: task.status }] }
      await needsHumanInLock(tx, delivery.id, null, reason, cause)
      return
    }
    const executable = failure === 'missing' ? !attempt.output.startsWith(NOT_EXECUTABLE_OUTPUT) : undefined
    const reason = renderSmokeRework({ round: attempt.round, outcome: failure, output: attempt.output, ...(executable === undefined ? {} : { executable }) })
    if (!(await goalEventWith(tx, delivery.workspaceId, 'task_rework', { verificationRound: attempt.round }, { taskId: task.id }))) {
      await appendEvent({
        type: 'task.rework',
        workspaceId: delivery.workspaceId,
        taskId: task.id,
        actor: 'system',
        // Plan 4b D5: no attempt is charged -- the round cap bounds this loop.
        payload: { reason, attempt: task.attempt, verificationRound: attempt.round },
      })
    }
    await tx.task.updateMany({
      where: { id: task.id, status: 'done' },
      data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: reason },
    })
    await tx.smokeAttempt.update({ where: { id: attempt.id }, data: { reworkedTaskId: task.id } })
    const moved = await tx.goalDelivery.updateMany({
      where: { id: delivery.id, status: 'verifying', activeSmokeId: attempt.id },
      data: { status: 'integrating', activeSmokeId: null },
    })
    if (moved.count === 0) throw new NotTheSmoke()
  }).catch((error: unknown): void => {
    if (!(error instanceof NotTheSmoke)) throw error
  })
}

/**
 * Plan B D8: a claim the goal pass found. Nothing while this process runs the attempt, or while a
 * live owner elsewhere may still be inside its timeout. A claim naming no row, a `running` attempt
 * whose owner is gone (or is this process, which no longer runs it), or one past its timeout plus
 * the grace, is recorded `error` (its group killed, its checkout removed) and applied. An attempt
 * already concluded but still holding the claim (a crash between the two writes) is applied again.
 */
export async function settleStrandedSmoke(attemptId: string): Promise<void> {
  const attempt = await prisma.smokeAttempt.findUnique({ where: { id: attemptId }, include: { workspace: { select: { repoPath: true, smokeTimeoutMs: true } } } })
  if (attempt === null) {
    const delivery = await prisma.goalDelivery.findUnique({ where: { activeSmokeId: attemptId }, select: { id: true } })
    if (delivery !== null) {
      await withDeliveryLock(delivery.id, async (tx) =>
        tx.goalDelivery.updateMany({ where: { id: delivery.id, activeSmokeId: attemptId }, data: { activeSmokeId: null, roundRunFailures: { increment: 1 } } }),
      )
    }
    return
  }
  if (attempt.status !== 'running') {
    await applySmokeOutcome(attemptId)
    return
  }
  if (activeSmokeIds.has(attemptId)) return
  const mine = attempt.ownerInstance === OWNER_INSTANCE
  const overdue = Date.now() - attempt.startedAt.getTime() > attempt.workspace.smokeTimeoutMs + SMOKE_STRANDED_GRACE_MS
  if (!mine && !ownerGone(attempt.ownerInstance) && !overdue) return
  if (attempt.pid !== null && isAlive(attempt.pid)) killLeftovers(attempt.pid)
  await cleanUpSmokeProject(smokeProjectName(attemptId))
  await removeVerificationWorktree(attempt.workspace.repoPath, attempt.worktreePath)
  await recordSmokeResult(
    attemptId,
    { status: 'error', exitCode: null, signal: null, output: 'the process running this smoke check is gone; it will be tried again' },
    Date.now() - attempt.startedAt.getTime(),
  )
  await applySmokeOutcome(attemptId)
}

/** Plan B D5: the latest passing attempt on the integration branch's CURRENT tip, or null. */
export async function passedSmokeAtTip(
  repoPath: string,
  delivery: { readonly id: string; readonly integrationBranch: string },
): Promise<{ readonly output: string; readonly durationMs: number | null; readonly tip: string } | null> {
  let tip: string
  try {
    tip = await gitIn(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${delivery.integrationBranch}^{commit}`)
  } catch {
    return null
  }
  return prisma.smokeAttempt.findFirst({
    where: { goalDeliveryId: delivery.id, status: 'passed', tip },
    orderBy: { startedAt: 'desc' },
    select: { output: true, durationMs: true, tip: true },
  })
}

/** How many attempts of `round` the orchestrator could not run, and the last one's output -- for the run-failure cap's reason. */
export async function smokeErrorsInRound(deliveryId: string, round: number): Promise<{ readonly count: number; readonly last: string | null }> {
  const rows = await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: deliveryId, round, status: 'error' }, orderBy: { startedAt: 'asc' }, select: { output: true } })
  return { count: rows.length, last: rows.at(-1)?.output ?? null }
}
