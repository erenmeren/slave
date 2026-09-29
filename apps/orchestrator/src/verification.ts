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
import {
  admitProvider,
  goalEventWith,
  implementersOf,
  refusalText,
  runFilePaths,
  staffVerifier,
  withDeliveryLock,
  writePermissionsFile,
} from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  VERIFICATION_DIFF_STAT_MAX_CHARS,
  VERIFIER_ROLE,
  err,
  parseSlaveVerification,
  renderVerificationRework,
  requirementItemsSchema,
  runId as brandRunId,
  slaveId as brandSlaveId,
  type RunId,
  type VerificationItem,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { checkpointRunFiles, runTokenHash, verifyDirPathFor, type RunHandle, type SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { tripConductor } from './conductor.js'
import { acceptInLock, needsHumanInLock } from './goal.js'
import { resolveRuntime, workspaceDefaultProvider } from './model.js'
import { verificationOwnership } from './ownership.js'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { buildRunContext } from './runContext.js'
import { joinRunOutput } from './runOutput.js'
import { createRunUnlessArchived, failConcludedRun } from './runs.js'
import { STRANDED_CLAIM_GRACE_MS } from './sweep.js'
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
 * Paths a verifier's checks routinely leave behind in a checkout -- dependency installs, test and
 * type-checker caches, coverage, bytecode, build output -- in a repository that does not ignore
 * them (ruling V4b). Running the project's own tests is what a verifier is FOR, so treating these
 * as tampering would discard every verification of such a repository and end it in `needs_human`.
 * They are left out of the UNTRACKED half of the baseline only: a tracked file under one of these
 * directories that changes is still a tracked change and still discards. Anything not listed that
 * appears untracked -- a source file the verifier wrote in -- still discards.
 *
 * Matched per path segment: `directories` against any directory segment, `fileNames` against the
 * last segment, `fileSuffixes` against the end of the last segment, `directorySuffixes` against
 * the end of any directory segment, `filePrefixes` against the start of the last segment.
 */
export const VERIFICATION_ARTIFACT_PATTERNS = {
  directories: [
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',
    '.nox',
    'node_modules',
    '.next',
    '.turbo',
    '.cache',
    'coverage',
    'htmlcov',
    '.nyc_output',
    'dist',
    'build',
    'target',
    '.gradle',
    '.venv',
    'venv',
  ],
  directorySuffixes: ['.egg-info'],
  fileNames: ['.coverage', '.DS_Store'],
  filePrefixes: ['.coverage.'],
  fileSuffixes: ['.pyc', '.pyo'],
} as const

const ARTIFACT_DIRECTORIES: ReadonlySet<string> = new Set(VERIFICATION_ARTIFACT_PATTERNS.directories)

/** True for a worktree-relative path (`/`-separated, as git prints it) that is a well-known
 *  build or test artifact ({@link VERIFICATION_ARTIFACT_PATTERNS}). */
export function isVerificationArtifact(path: string): boolean {
  const segments = path.split('/').filter((segment) => segment !== '')
  const file = segments.at(-1) ?? ''
  const directories = segments.slice(0, -1)
  const p = VERIFICATION_ARTIFACT_PATTERNS
  return (
    directories.some((d) => ARTIFACT_DIRECTORIES.has(d) || p.directorySuffixes.some((suffix) => d.endsWith(suffix))) ||
    (p.fileNames as readonly string[]).includes(file) ||
    p.filePrefixes.some((prefix) => file.startsWith(prefix)) ||
    p.fileSuffixes.some((suffix) => file.endsWith(suffix))
  )
}

/** How many untracked paths a baseline names (the digest covers them all): enough for a discard
 *  reason to say what appeared, bounded so the row stays small. */
export const BASELINE_UNTRACKED_LISTED = 200

/**
 * The state of a verification worktree the tamper check compares (controller ruling Q5, narrowed
 * by rulings V4/V4b): its `HEAD`, the tracked files git reports as changed, the untracked
 * non-ignored non-artifact files, and a digest of the CONTENT of both halves -- the tracked
 * changes (`git diff --binary HEAD`) and every such untracked file. A file setup left dirty that
 * the verifier edits again keeps the same status line, and only the digest sees it; a missing
 * source file the verifier writes in through its shell is untracked, and without the untracked
 * half a check would pass against a feature the verified tip does not have. Gitignored files and
 * {@link VERIFICATION_ARTIFACT_PATTERNS} stay out: writing those is what running checks does.
 */
export interface VerificationBaseline {
  readonly head: string
  /** `git status --porcelain=v1 --untracked-files=no`: the tracked half. */
  readonly status: string
  /** The untracked, non-ignored, non-artifact paths, sorted, the first
   *  {@link BASELINE_UNTRACKED_LISTED} of them. */
  readonly untracked: readonly string[]
  /** How many there were in all. */
  readonly untrackedCount: number
  readonly diff: string
}

/** Past this size an untracked file is identified by its size and mtime, not read: the digest
 *  stays bounded however large a generated file is. */
const UNTRACKED_HASH_MAX_BYTES = 64 * 1024 * 1024

/** Reads a worktree's {@link VerificationBaseline}. Task 6 calls it again at the conclusion and
 *  compares the two with `sameBaseline` (and names what appeared with `newUntrackedPaths`). */
export async function worktreeBaseline(worktreePath: string): Promise<VerificationBaseline> {
  const head = await gitIn(worktreePath, 'rev-parse', 'HEAD')
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
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
  const { stdout: listed } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: worktreePath,
    maxBuffer: DIFF_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
  })
  const untracked = listed
    .split('\0')
    .filter((entry) => entry !== '' && !isVerificationArtifact(entry))
    .toSorted()
  const digest = createHash('sha256').update(diff)
  for (const name of untracked) {
    digest.update('\0untracked\0').update(name).update('\0').update(await untrackedFileDigest(join(worktreePath, name)))
  }
  return {
    head,
    status,
    untracked: untracked.slice(0, BASELINE_UNTRACKED_LISTED),
    untrackedCount: untracked.length,
    diff: digest.digest('hex'),
  }
}

/** True when two baselines describe the same worktree state. */
export function sameBaseline(a: VerificationBaseline, b: VerificationBaseline): boolean {
  return a.head === b.head && a.status === b.status && a.untrackedCount === b.untrackedCount && a.diff === b.diff
}

/**
 * The untracked, non-artifact paths `after` names that `before` does not -- what a verifier's
 * shell wrote into the checkout, for the discard reason. Bounded by what each baseline lists
 * ({@link BASELINE_UNTRACKED_LISTED}), so a flood of new files is named in part; `sameBaseline`,
 * not this, is the verdict.
 */
export function newUntrackedPaths(before: VerificationBaseline, after: VerificationBaseline): readonly string[] {
  const known = new Set(before.untracked)
  return after.untracked.filter((path) => !known.has(path))
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

  // Ruling Q1: the claim -- for a new round, the `integrating` -> `verifying` move -- is taken under
  // the delivery's lock, like every other move of a delivery, so a conclusion, a release or a
  // person's verb holding the lock cannot interleave with it. It is re-read there: the row above
  // was read without the lock. No event of its own: `workspace.verification_started` follows once
  // the run is set up, and a lost claim leaves no trace at all.
  const claimed = await withDeliveryLock(delivery.id, async (tx) => {
    const now = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
    if (now.status !== delivery.status || now.round !== delivery.round || now.activeRunId !== null) return { count: 0 }
    return tx.goalDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, activeRunId: null },
      data: newRound ? { status: 'verifying', activeRunId: run.id, round, roundRunFailures: 0 } : { activeRunId: run.id },
    })
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
    await releaseClaim(delivery.id, run.id)
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

/**
 * D7: gives a verification run's claim back and counts one unusable run in the round, under the
 * delivery's lock (ruling Q1), guarded on the run still holding it. Returns whether THIS call
 * released it -- the one caller that may then fail the run (ruling Q2), so two concluders racing
 * cannot both announce the failure.
 */
async function releaseClaim(deliveryId: string, runId: string): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const released = await tx.goalDelivery.updateMany({
      where: { id: deliveryId, activeRunId: runId },
      data: { activeRunId: null, roundRunFailures: { increment: 1 } },
    })
    return released.count > 0
  })
}

/**
 * The verification run `runId` ended without a usable verdict (D7): a process failure, a stop, a
 * stranded claim. Its claim is released first, counting one run failure (so the goal pass retries
 * the same round, and stops at `VERIFICATION_RUN_RETRY_CAP`); the worktree goes either way.
 * Replay-safe: a run no longer holding the claim changes nothing but the (already removed) worktree.
 */
export async function releaseVerification(runId: string): Promise<void> {
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    include: { goalDelivery: { include: { workspace: { select: { repoPath: true } } } } },
  })
  if (run === null || run.goalDelivery === null) return
  await releaseClaim(run.goalDelivery.id, run.id)
  await removeVerificationWorktree(run.goalDelivery.workspace.repoPath, run.worktreePath)
}

/**
 * A claim the goal pass found on a `verifying` delivery (D3, ruling Q2). Nothing while its run is
 * live -- non-terminal, or still pumped by this process (whose chain concludes it) -- or terminal
 * for less than {@link STRANDED_CLAIM_GRACE_MS} (another process -- a CLI `tick` beside the daemon
 * -- may be mid-conclusion; the sweep's own grace, for its reason). Past that: a `succeeded` run
 * is concluded here; any other, and a claim naming a run that does not exist, is released.
 */
export async function settleStrandedClaim(runId: string): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: { id: true, status: true, terminalAt: true } })
  if (run === null) {
    // Bad data -- the claim is always written after the row exists -- but a claim naming nothing
    // would hold the version forever. Released, one run failure, the same as any stranded claim.
    const delivery = await prisma.goalDelivery.findUnique({ where: { activeRunId: runId }, select: { id: true } })
    if (delivery !== null) await releaseClaim(delivery.id, runId)
    return
  }
  if ((NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return
  if (activePumpRunIds.has(run.id)) return
  if (run.terminalAt !== null && Date.now() - run.terminalAt.getTime() < STRANDED_CLAIM_GRACE_MS) return
  if (run.status === 'succeeded') {
    await concludeVerification(brandRunId(run.id))
    return
  }
  await releaseVerification(run.id)
}

/** How many changed or new paths a tamper reason names. */
const TAMPER_PATHS_NAMED = 10

/**
 * Plan D1/D7 and ruling V4b: why a verification's checkout is not the one it was given, or null
 * when it is. Compares the baseline dispatch recorded after setup with the checkout now, and names
 * what changed: a moved HEAD, tracked paths whose status changed, new untracked non-artifact paths.
 */
async function tamperedReason(worktreePath: string | null, stored: unknown): Promise<string | null> {
  if (worktreePath === null || !existsSync(worktreePath)) return 'the verification worktree is gone'
  if (stored === null || typeof stored !== 'object') return 'the verification run has no recorded baseline to compare its worktree with'
  const before = stored as VerificationBaseline
  let after: VerificationBaseline
  try {
    after = await worktreeBaseline(worktreePath)
  } catch (error) {
    return `the verification worktree could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
  if (sameBaseline(before, after)) return null
  if (before.head !== after.head) {
    return `the verifier moved HEAD in its checkout (from ${before.head.slice(0, 12)} to ${after.head.slice(0, 12)})`
  }
  const statusLines = (text: string): ReadonlySet<string> => new Set(text.split('\n').filter((line) => line !== ''))
  const earlier = statusLines(before.status)
  const tracked = [...statusLines(after.status)].filter((line) => !earlier.has(line)).map((line) => line.slice(3))
  const added = newUntrackedPaths(before, after)
  const named = [...tracked, ...added]
  if (named.length === 0) return 'the verifier changed files in its checkout'
  const shown = named.slice(0, TAMPER_PATHS_NAMED).join(', ')
  return `the verifier changed its checkout: ${shown}${named.length > TAMPER_PATHS_NAMED ? ` and ${String(named.length - TAMPER_PATHS_NAMED)} more` : ''}`
}

/** Thrown inside the gate's lock when the run no longer holds the claim: a replay, or a release
 *  that won the race. A refusal inside a Prisma transaction must throw (house rule). */
class NotTheClaim extends Error {}

type Outcome =
  | { readonly kind: 'accept' }
  | { readonly kind: 'rework' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'needs_human'; readonly reason: string }

/** The first line of a verifier's reason, for a sentence a person reads in one go. */
const firstLine = (text: string): string => text.split('\n')[0] ?? ''

/**
 * The conclusion of a `succeeded` verification run (spec R8/R9): the gate. Replay-safe -- only the
 * run holding the delivery's claim concludes anything, and every event is written only if missing.
 *
 * - An unusable verification (plan D7): no or malformed `<slave-verification>` block, or a checkout
 *   the verifier changed (D1, V4b) -- the claim is released first (one run failure, the same round
 *   again), and the run failed only by the call that won the release (ruling Q2).
 * - Otherwise its verdict is stored as `VerificationResult` rows, `workspace.verified` is written,
 *   and in the same locked write that releases the claim the version moves on:
 *   - every requirement `pass` -> `accepted`, with `verifiedCommit` = the tip it checked (Q6) --
 *     unless the integration branch has moved since, when it goes back to `integrating` and the
 *     next pass verifies the new tip (`stale`);
 *   - a `fail` -> each failing requirement's package task `done -> rework`, no attempt charged
 *     (D5), and the version back to `integrating`; the next round waits for them to be integrated;
 *   - only `unverifiable` (D6), a `fail` whose package cannot be reworked, or the round cap (R9)
 *     -> `needs_human`, with the reason and what the person can do (Q9).
 * The budget is not one of these (D8): it halts the workspace, which pauses this run.
 *
 * The verification worktree is removed at every conclusion (D12).
 */
export async function concludeVerification(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUniqueOrThrow({
    where: { id: runId },
    include: { goalDelivery: { include: { workspace: true } } },
  })
  const delivery = run.goalDelivery
  if (delivery === null) return
  const workspace = delivery.workspace
  if (delivery.activeRunId !== run.id) {
    // A replay, or the claim was released meanwhile: nothing to decide, and the checkout is spent.
    await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
    return
  }
  const set = await prisma.requirementSet.findUniqueOrThrow({
    where: { workspaceId_goalVersion: { workspaceId: workspace.id, goalVersion: delivery.goalVersion } },
  })
  const requirements = requirementItemsSchema.parse(set.items)
  const keys = requirements.map((requirement) => requirement.key)

  // D1/D7: a verifier that changed what it verifies has no verdict worth keeping.
  const tampered = await tamperedReason(run.worktreePath, run.verificationBaseline)
  const rows = await prisma.executionEvent.findMany({
    where: { runId: run.id, type: 'run_output' },
    orderBy: { seq: 'asc' },
    select: { payload: true },
  })
  const parsed = tampered !== null ? err(tampered) : parseSlaveVerification(joinRunOutput(rows.map((row) => row.payload)), keys)
  if (!parsed.ok) {
    if (await releaseClaim(delivery.id, run.id)) {
      await failConcludedRun(run, workspace.id, `verification: ${parsed.error}`)
    }
    await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
    return
  }
  const items = parsed.value
  const failed = items.filter((item) => item.status === 'fail')
  const unverifiable = items.filter((item) => item.status === 'unverifiable')
  const passed = items.filter((item) => item.status === 'pass')
  const textOf = new Map(requirements.map((requirement) => [requirement.key, requirement.text] as const))
  const tip = await gitIn(workspace.repoPath, 'rev-parse', delivery.integrationBranch)

  try {
    await withDeliveryLock(delivery.id, async (tx) => {
      const now = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
      if (now.activeRunId !== run.id || now.status !== 'verifying') throw new NotTheClaim()

      await tx.verificationResult.createMany({
        data: items.map((item) => ({
          workspaceId: workspace.id,
          goalDeliveryId: delivery.id,
          goalVersion: delivery.goalVersion,
          round: now.round,
          runId: run.id,
          key: item.key,
          status: item.status,
          check: item.check,
          output: item.output,
          reason: item.reason,
        })),
        skipDuplicates: true,
      })

      const owners = await ownersOf(tx, workspace.id, delivery.goalVersion, failed.map((item) => item.key))
      const orphaned = failed.filter((item) => owners.get(item.key)?.status !== 'done')
      const roundsUsed = now.round - now.roundBase
      const outcome: Outcome =
        failed.length === 0 && unverifiable.length === 0
          ? run.verificationTip !== null && run.verificationTip === tip
            ? { kind: 'accept' }
            : { kind: 'stale' }
          : failed.length === 0
            ? {
                kind: 'needs_human',
                reason: `requirement(s) could not be verified: ${unverifiable.map((item) => `${item.key} (${firstLine(item.reason)})`).join('; ')}`,
              }
            : orphaned.length > 0
              ? { kind: 'needs_human', reason: `requirement(s) failed whose package cannot be reworked: ${orphaned.map((item) => item.key).join(', ')}` }
              : roundsUsed >= workspace.verificationRoundCap
                ? {
                    kind: 'needs_human',
                    reason: `the verification round cap (${String(workspace.verificationRoundCap)}) was reached; still failing: ${failed.map((item) => item.key).join(', ')}`,
                  }
                : { kind: 'rework' }

      // Ruling Q1: every event first (each only if a crash did not already write it), then the
      // guarded moves. A crash in between leaves the claim held by a `succeeded` run, which the
      // goal pass concludes again (settleStrandedClaim) and finds the events already written.
      if (!(await goalEventWith(tx, workspace.id, 'workspace_verified', { runId: run.id }))) {
        await appendEvent({
          type: 'workspace.verified',
          workspaceId: workspace.id,
          runId: run.id,
          actor: 'system',
          payload: {
            version: delivery.goalVersion,
            round: now.round,
            runId: run.id,
            pass: passed.length,
            fail: failed.length,
            unverifiable: unverifiable.length,
            failedKeys: failed.map((item) => item.key).slice(0, 60),
          },
        })
      }

      if (outcome.kind === 'accept') {
        if (!(await acceptInLock(tx, delivery.id, { runId: run.id, verifiedCommit: tip }))) throw new NotTheClaim()
        return
      }
      if (outcome.kind === 'needs_human') {
        if (!(await needsHumanInLock(tx, delivery.id, run.id, outcome.reason))) throw new NotTheClaim()
        return
      }
      if (outcome.kind === 'rework') {
        const byTask = new Map<string, (VerificationItem & { readonly text: string })[]>()
        for (const item of failed) {
          const owner = owners.get(item.key)
          if (owner === undefined) continue
          byTask.set(owner.taskId, [...(byTask.get(owner.taskId) ?? []), { ...item, text: textOf.get(item.key) ?? '' }])
        }
        for (const [taskId, its] of byTask) {
          const reason = renderVerificationRework(now.round, its)
          const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { attempt: true } })
          if (!(await goalEventWith(tx, workspace.id, 'task_rework', { verificationRound: now.round }, { taskId }))) {
            await appendEvent({
              type: 'task.rework',
              workspaceId: workspace.id,
              taskId,
              actor: 'system',
              // D5: no attempt is charged, so the event carries the task's current count.
              payload: { reason, attempt: task.attempt, verificationRound: now.round },
            })
          }
          await tx.task.updateMany({
            where: { id: taskId, status: 'done' },
            data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: reason },
          })
        }
      }
      // `rework` and `stale`: back to `integrating`, the claim released in the same write. The next
      // round starts once every package is integrated again (for `stale`, at once: the new tip).
      const moved = await tx.goalDelivery.updateMany({
        where: { id: delivery.id, status: 'verifying', activeRunId: run.id },
        data: { status: 'integrating', activeRunId: null },
      })
      if (moved.count === 0) throw new NotTheClaim()
    })
  } catch (error) {
    if (!(error instanceof NotTheClaim)) throw error
  }
  await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
}

/** Which package task owns each of `keys` in the goal version (its package lists the key), and
 *  that task's status -- a `fail` is reworked only on a `done` owner (D5). */
async function ownersOf(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  goalVersion: number,
  keys: readonly string[],
): Promise<ReadonlyMap<string, { readonly taskId: string; readonly status: string }>> {
  if (keys.length === 0) return new Map()
  const packages = await tx.workPackage.findMany({
    where: { workspaceId, goalVersion, requirementKeys: { hasSome: [...keys] } },
    orderBy: { key: 'asc' },
    select: { requirementKeys: true, tasks: { select: { id: true, status: true }, orderBy: { createdAt: 'asc' } } },
  })
  const owners = new Map<string, { readonly taskId: string; readonly status: string }>()
  for (const pkg of packages) {
    const task = pkg.tasks[0]
    if (task === undefined) continue
    for (const key of pkg.requirementKeys) {
      if (keys.includes(key) && !owners.has(key)) owners.set(key, { taskId: task.id, status: task.status })
    }
  }
  return owners
}
