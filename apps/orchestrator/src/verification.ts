/**
 * Conductor Plan 4b (spec R8): a goal version's verification run. Once every package of the
 * version is on its integration branch -- and again after each rework round -- a verifier seat that
 * implemented nothing in the version checks every requirement in a FRESH, detached checkout of that
 * branch, writing its checks in a scratch directory outside the repository.
 *
 * This module dispatches the run and owns its worktree. The run's conclusion (the verdict, the
 * tamper check, the rework it sends) is Task 6's; it reads what this module records on the run row:
 * `verificationTip` (the commit verified) and `verificationBaseline` (the worktree after setup).
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { admitProvider, implementersOf, refusalText, runFilePaths, staffVerifier, writePermissionsFile } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  VERIFICATION_DIFF_STAT_MAX_CHARS,
  VERIFIER_ROLE,
  requirementItemsSchema,
  runId as brandRunId,
  slaveId as brandSlaveId,
  type RunId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { checkpointRunFiles, runTokenHash, verifyDirPathFor, type RunHandle, type SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { tripConductor } from './conductor.js'
import { resolveRuntime, workspaceDefaultProvider } from './model.js'
import { verificationOwnership } from './ownership.js'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { buildRunContext } from './runContext.js'
import { createRunUnlessArchived } from './runs.js'
import { activePumpRunIds, emailLocalPart, pumps, type TickDeps } from './tick.js'
import { verifyConcludedRun } from './verify.js'
import { gitIn, provisionDetachedWorktree, worktreeRootFor } from './worktree.js'

const execFileAsync = promisify(execFile)

/** Room for a goal version that touched a very large tree: execFile's 1 MiB default would throw. */
const DIFF_MAX_BUFFER = 16 * 1024 * 1024
/** Bounded, like every git call made on a run's behalf. */
const GIT_TIMEOUT_MS = 30_000

/** The verification worktree's directory name under `worktreeRootFor(repo)` (plan D12). */
export const verificationWorktreeKey = (runId: string): string => `verify-${runId.slice(0, 8)}`

/**
 * The state of a verification worktree the tamper check compares (controller ruling Q5, narrowed
 * by ruling V4): its `HEAD`, every path git reports as changed or untracked, and a digest of the
 * CONTENT of both -- the tracked changes (`git diff --binary HEAD`) and every untracked,
 * non-ignored file. A file setup left dirty that the verifier edits again keeps the same status
 * line, and only the digest sees it; a missing source file the verifier writes in through its
 * shell is untracked, and without the untracked half a check would pass against a feature the
 * verified tip does not have. Gitignored files stay out (a dependency install, a build, a test
 * cache): writing those is what running checks does.
 */
export interface VerificationBaseline {
  readonly head: string
  readonly status: string
  readonly diff: string
}

/** Past this size an untracked file is identified by its size and mtime, not read: the digest
 *  stays bounded however large a generated file is. */
const UNTRACKED_HASH_MAX_BYTES = 64 * 1024 * 1024

/** Reads a worktree's {@link VerificationBaseline}. Task 6 calls it again at the conclusion and
 *  compares the two with `sameBaseline`. */
export async function worktreeBaseline(worktreePath: string): Promise<VerificationBaseline> {
  const head = await gitIn(worktreePath, 'rev-parse', 'HEAD')
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: worktreePath,
    maxBuffer: DIFF_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
  })
  const { stdout: diff } = await execFileAsync('git', ['diff', '--binary', 'HEAD'], {
    cwd: worktreePath,
    maxBuffer: 256 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'buffer',
  })
  // `-z`: a path with a newline or a quote in it stays one entry, unquoted.
  const { stdout: untracked } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: worktreePath,
    maxBuffer: DIFF_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
  })
  const digest = createHash('sha256').update(diff)
  for (const name of untracked.split('\0').filter((entry) => entry !== '').toSorted()) {
    digest.update('\0untracked\0').update(name).update('\0').update(await untrackedFileDigest(join(worktreePath, name)))
  }
  return { head, status, diff: digest.digest('hex') }
}

/** One untracked file's identity: a symlink's target, a small enough file's content hash
 *  (streamed, so memory stays bounded), a larger one's size and mtime, or `gone`. */
async function untrackedFileDigest(path: string): Promise<string> {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return 'gone'
  }
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`
  if (!stat.isFile()) return `other:${String(stat.mode)}`
  if (stat.size > UNTRACKED_HASH_MAX_BYTES) return `large:${String(stat.size)}:${String(stat.mtimeMs)}`
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return `file:${hash.digest('hex')}`
}

/** True when two baselines describe the same worktree state. */
export function sameBaseline(a: VerificationBaseline, b: VerificationBaseline): boolean {
  return a.head === b.head && a.status === b.status && a.diff === b.diff
}

/**
 * Removes a verification worktree, and only one: a path under `worktreeRootFor(repoPath)` whose
 * basename starts with `verify-`. Anything else is refused silently -- this runs on failure paths
 * and at conclusions, where a wrong path must never be `--force`-removed. Errors are logged, not
 * thrown: a worktree left behind is an operator's tidy-up, not a reason to fail the conclusion.
 */
export async function removeVerificationWorktree(repoPath: string, worktreePath: string | null): Promise<void> {
  if (worktreePath === null) return
  const root = worktreeRootFor(repoPath)
  const path = resolve(worktreePath)
  if (dirname(path) !== root || !basename(path).startsWith('verify-')) {
    console.warn(`[verification] refusing to remove ${path}: not a verification worktree under ${root}`)
    return
  }
  try {
    if (existsSync(path)) await gitIn(resolve(repoPath), 'worktree', 'remove', '--force', path)
    await gitIn(resolve(repoPath), 'worktree', 'prune')
  } catch (error) {
    console.error(`[verification] could not remove the worktree ${path}:`, error)
  }
}

/** `git diff --stat base..head`, capped at {@link VERIFICATION_DIFF_STAT_MAX_CHARS}. */
async function diffStat(cwd: string, base: string, head: string): Promise<{ readonly text: string; readonly capped: boolean }> {
  const { stdout } = await execFileAsync('git', ['diff', '--stat', `${base}..${head}`], {
    cwd,
    maxBuffer: DIFF_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
  })
  return stdout.length > VERIFICATION_DIFF_STAT_MAX_CHARS
    ? { text: stdout.slice(0, VERIFICATION_DIFF_STAT_MAX_CHARS), capped: true }
    : { text: stdout, capped: false }
}

const seatInclude = { person: { include: { template: true } }, permissions: true } as const
type VerifierSeat = Prisma.SlaveGetPayload<{ include: typeof seatInclude }>

/**
 * The seat that verifies this round (plan D4): the delivery's recorded verifier while it is open,
 * unreleased, holds VERIFIER_ROLE and implemented nothing in the version; otherwise a fresh
 * `staffVerifier` choice, recorded on the delivery. `null` when nobody can be staffed (said once,
 * through the conductor's own trip); `'busy'` when the chosen seat holds a live run -- silent, the
 * round waits its turn the way a review waits for a free reviewer.
 */
async function eligibleVerifier(
  workspaceId: string,
  delivery: { readonly id: string; readonly goalVersion: number; readonly verifierSlaveId: string | null },
  excluded: ReadonlySet<string>,
): Promise<VerifierSeat | 'busy' | null> {
  const recorded =
    delivery.verifierSlaveId === null
      ? null
      : await prisma.slave.findFirst({
          where: {
            id: delivery.verifierSlaveId,
            team: { workspaceId },
            closedAt: null,
            person: { releasedAt: null },
            runtimeRoles: { has: VERIFIER_ROLE },
          },
          include: seatInclude,
        })
  let seat: VerifierSeat | null = recorded !== null && !excluded.has(recorded.id) ? recorded : null
  if (seat === null) {
    const packages = await prisma.workPackage.findMany({
      where: { workspaceId, goalVersion: delivery.goalVersion },
      orderBy: { key: 'asc' },
      select: { templateId: true },
    })
    // Least-used persona first, the conductor's `verifierPersonas` order: a verifier hired from the
    // persona holding most packages would be the likeliest to exhaust its pool.
    const count = new Map<string, number>()
    for (const pkg of packages) count.set(pkg.templateId, (count.get(pkg.templateId) ?? 0) + 1)
    const personas = [...count.keys()].toSorted((a, b) => (count.get(a) ?? 0) - (count.get(b) ?? 0))
    const staffed = await staffVerifier(workspaceId, delivery.goalVersion, excluded, personas)
    if (!staffed.ok) {
      await tripConductor(workspaceId, `staffing the verifier of goal v${String(delivery.goalVersion)}: ${staffed.error}`)
      return null
    }
    await prisma.goalDelivery.update({ where: { id: delivery.id }, data: { verifierSlaveId: staffed.value } })
    seat = await prisma.slave.findUniqueOrThrow({ where: { id: staffed.value }, include: seatInclude })
  }
  const live = await prisma.slaveRun.count({ where: { slaveId: seat.id, status: { in: [...NON_TERMINAL_RUN_STATUSES] } } })
  return live > 0 ? 'busy' : seat
}

/**
 * Starts the verification run of a goal version, or does nothing and returns `null`.
 *
 * A new round starts from `integrating` (every package integrated); a retry of the same round
 * (plan D7) from `verifying` with no claim. Mirrors `dispatchReview`'s shape and discipline: the
 * row is created before anything can fail, the delivery is claimed with a guarded `updateMany`
 * (`GoalDelivery.activeRunId`, the `Task.activeRunId` idiom -- D3), a lost claim deletes the row,
 * and a spawn error cancels what was spawned, fails the row, releases the claim (counting one run
 * failure) and removes the worktree.
 */
export async function dispatchVerification(deps: TickDeps, deliveryId: string): Promise<RunId | null> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: true } })
  const newRound = delivery.status === 'integrating'
  if (!newRound && !(delivery.status === 'verifying' && delivery.activeRunId === null)) return null
  const workspace = delivery.workspace

  const excluded = await implementersOf(workspace.id, delivery.goalVersion)
  const seat = await eligibleVerifier(workspace.id, delivery, excluded)
  if (seat === 'busy' || seat === null) return null

  // M27 §8 (ruling R15): `null` is an archived workspace -- nothing attempted, nothing counted.
  const run = await createRunUnlessArchived(workspace.id, {
    slaveId: seat.id,
    kind: 'verification',
    status: 'starting',
    goalDeliveryId: delivery.id,
  })
  if (run === null) return null
  const runId = brandRunId(run.id)
  const round = newRound ? delivery.round + 1 : delivery.round

  const claimed = await prisma.goalDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status, activeRunId: null },
    data: newRound ? { status: 'verifying', activeRunId: run.id, round, roundRunFailures: 0 } : { activeRunId: run.id },
  })
  if (claimed.count === 0) {
    // Lost the race (another pass claimed it, or the version moved on): nothing was attempted, so
    // no failed row may be left to read as a verification attempt.
    await prisma.slaveRun.delete({ where: { id: run.id } })
    return null
  }

  // Outside the `try` for `dispatchReview`'s reason: the catch must tell "never spawned" from
  // "spawned, then something else failed", and knows the worktree's path before provisioning
  // returns it (a setup command that failed leaves the checkout behind).
  let handle: RunHandle | null = null
  let adapter: SlaveRuntimeAdapter | null = null
  const worktreePath = resolve(worktreeRootFor(workspace.repoPath), verificationWorktreeKey(run.id))

  try {
    const workspaceDefault = await workspaceDefaultProvider(workspace.id)
    const resolved = resolveRuntime(
      {
        model: seat.model,
        provider: seat.provider,
        person: { model: seat.person.model, provider: seat.person.provider, template: seat.person.template },
      },
      workspaceDefault,
    )
    if (resolved.provider === null) {
      throw new Error(
        'no runtime could be resolved for this run: either this workspace has no configured ' +
          'default provider (ProviderConfiguration), or a level of the model override chain names ' +
          'a model with no provider recorded for it',
      )
    }
    adapter = resolveAdapter(deps.registry, resolved.provider)
    const admission = admitProvider(workspace, resolved.provider)
    if (!admission.ok) throw new Error(refusalText(admission.refusal))
    const runAdapter = adapter
    const model = resolved.model

    // D12: a fresh detached checkout of the integration branch, setup commands run in it. The tip
    // it checked out and the state setup left it in go on the row at once (rulings Q5/Q6), where
    // the verifier's shell cannot reach them and the conclusion (Task 6) reads them back.
    const worktree = await provisionDetachedWorktree({
      repoPath: workspace.repoPath,
      ref: delivery.integrationBranch,
      key: verificationWorktreeKey(run.id),
      setupCommands: workspace.setupCommands,
    })
    const baseline = await worktreeBaseline(worktree.path)
    await prisma.slaveRun.update({
      where: { id: run.id },
      data: {
        worktreePath: worktree.path,
        verificationTip: worktree.refCommit,
        verificationBaseline: baseline as unknown as Prisma.InputJsonValue,
      },
    })

    const { runDir, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)
    // D2: the scratch directory's presence is what makes the adapter export
    // `$SLAVEOFAI_VERIFY_DIR`, at the first spawn and at every resume. 0700 like the run directory:
    // the checks and their output are this run's evidence.
    const verifyDir = verifyDirPathFor(runDir)
    mkdirSync(verifyDir, { recursive: true, mode: 0o700 })
    chmodSync(verifyDir, 0o700)

    const runToken = randomBytes(32).toString('hex')
    await prisma.slaveRun.update({ where: { id: run.id }, data: { runTokenHash: runTokenHash(runToken) } })
    // D1: the owns-nothing rule confines `Write`/`Edit` to outside the worktree; the writer refuses
    // a verification run's file without it.
    const permissionsFilePath = writePermissionsFile(runDir, {
      rows: seat.permissions,
      provider: resolved.provider,
      runKind: 'verification',
      runId: run.id,
      runToken,
      ownership: verificationOwnership(worktree.path),
    })

    const stat = await diffStat(workspace.repoPath, delivery.baseCommit, worktree.refCommit)
    const requirementSet = await prisma.requirementSet.findUniqueOrThrow({
      where: { workspaceId_goalVersion: { workspaceId: workspace.id, goalVersion: delivery.goalVersion } },
    })
    const requirements = requirementItemsSchema.parse(requirementSet.items)

    const gitIdentity = { name: seat.person.name, email: `${emailLocalPart({ id: seat.id, name: seat.person.name })}@slaveofai.local` }

    const built = await buildRunContext({
      runId,
      kind: 'verification',
      slaveId: seat.id,
      workspaceId: workspace.id,
      taskId: null,
      worktreePath: worktree.path,
      provider: resolved.provider,
      verification: {
        goalVersion: delivery.goalVersion,
        round,
        requirements,
        diffStat: stat.text,
        diffCapped: stat.capped,
        verifyDir,
      },
    })

    await appendEvent({
      type: 'workspace.verification_started',
      workspaceId: workspace.id,
      slaveId: seat.id,
      runId: run.id,
      actor: 'system',
      payload: { version: delivery.goalVersion, round, runId: run.id },
    })

    handle = await runAdapter.start({
      runId,
      prompt: built.prompt,
      worktreePath: worktree.path,
      pauseFlagPath,
      runDir,
      permissionsFilePath,
      runToken,
      gitIdentity,
      ...(model !== undefined ? { model } : {}),
    })

    await prisma.slaveRun.update({
      where: { id: run.id },
      data: { pid: handle.pid, provider: resolved.provider, model: resolved.model ?? null },
    })

    const pump = pumpRun({
      runId,
      taskId: null,
      slaveId: brandSlaveId(seat.id),
      workspaceId: deps.workspaceId,
      events: runAdapter.events(runId),
      cancel: () => runAdapter.cancel(runId),
      spawn: {
        ...checkpointRunFiles(resolved.provider, handle),
        pauseFlagPath,
        gitIdentity,
        provider: resolved.provider,
        ...(model !== undefined ? { model } : {}),
      },
    })
      .then(() => verifyConcludedRun(runId))
      .catch((error: unknown): void => {
        console.error(`[verification] pump for run ${runId} failed:`, error)
      })
      .finally((): void => {
        activePumpRunIds.delete(run.id)
        pumps.delete(pump)
      })
    pumps.add(pump)
    activePumpRunIds.add(run.id)

    return runId
  } catch (error) {
    // Kill what was spawned before recording anything -- `dispatchReview`'s discipline.
    let cancelError: unknown = null
    if (handle !== null && adapter !== null) {
      try {
        await adapter.cancel(runId)
      } catch (failure) {
        cancelError = failure
      }
    }
    const reason =
      (error instanceof Error ? error.message : String(error)) +
      (cancelError === null
        ? ''
        : ` -- AND THE CANCEL FAILED (${String(cancelError)}): the process may still be running.`)
    const spawnFailed = handle === null
    const now = new Date()
    await prisma.slaveRun.update({
      where: { id: run.id },
      data: { status: 'failed', terminalAt: now, endedAt: now, failureClass: spawnFailed ? 'platform' : 'worker' },
    })
    // D7: a run that produced no verdict is not a round -- the claim goes back and the round's run
    // failures count one more, so the goal pass retries the same round (and stops at the cap).
    await prisma.goalDelivery.updateMany({
      where: { id: delivery.id, activeRunId: run.id },
      data: { activeRunId: null, roundRunFailures: { increment: 1 } },
    })
    await removeVerificationWorktree(workspace.repoPath, worktreePath)
    await appendEvent({
      type: 'run.failed',
      workspaceId: workspace.id,
      slaveId: seat.id,
      runId: run.id,
      actor: 'system',
      payload: { reason, ...(spawnFailed ? { phase: 'spawn' as const } : {}) },
    })
    return null
  }
}
