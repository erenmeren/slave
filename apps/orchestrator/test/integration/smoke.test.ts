/**
 * Skeleton spec S7: the smoke gate's attempt -- claimed under the delivery's lock, run outside it in
 * a fresh checkout of the integration tip, concluded into a pass, a rework or a stop. Real git, a
 * real bash script on the integration branch, task states driven with Prisma.
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAlive } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_BOOTSTRAP_SMOKE_SCRIPT, RUN_REQUIREMENT, SMOKE_OUTPUT_MAX_CHARS, integrationBranchName } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureIntegrationBranch, ensureIntegrationWorktree } from '../../src/goalBranch.js'
import { applySmokeOutcome, settleStrandedSmoke, smokeWorktreeKey, startSmoke } from '../../src/smoke.js'
import { drainPumps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repos: string[] = []
const git = (args: readonly string[], cwd: string): string => execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-smoke-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly repoPath: string
  readonly deliveryId: string
  readonly branch: string
  readonly integrationPath: string
  /** `''` for a key the layout does not have (`main` when partitioned; the other three when single). */
  readonly taskOf: Readonly<Record<'skeleton' | 'api' | 'integration' | 'main', string>>
}

/**
 * A conducted workspace at goal v1 whose three packages (skeleton, api, integration) are done and
 * integrated, a set with R1 and RUN, `smokeRequired`, and `scripts/smoke.sh` on the integration
 * branch holding `smoke` (or no script at all when `smoke` is null). `single` makes it one package,
 * `main`, owning `**` and every requirement (Task 5's single-mode case). The script is committed
 * executable (F10) unless `executable` is false.
 */
async function seed(
  smoke: string | null,
  options: { readonly smokeTimeoutMs?: number; readonly verificationRoundCap?: number; readonly single?: boolean; readonly executable?: boolean } = {},
): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Smoke', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', goal: 'Make it run.', goalVersion: 1,
      ...(options.smokeTimeoutMs === undefined ? {} : { smokeTimeoutMs: options.smokeTimeoutMs }),
      ...(options.verificationRoundCap === undefined ? {} : { verificationRoundCap: options.verificationRoundCap }),
    },
  })
  await prisma.requirementSet.create({ data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'an API', source: 'x' }, { ...RUN_REQUIREMENT }] } })
  const branch = integrationBranchName(1, workspace.id)
  const { baseCommit } = await ensureIntegrationBranch(repoPath, 'main', branch)
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: workspace.id, goalVersion: 1, integrationBranch: branch, baseCommit, smokeRequired: true } })
  const integrationPath = await ensureIntegrationWorktree(repoPath, { deliveryId: delivery.id, goalVersion: 1, branch }, workspace.id)
  if (smoke !== null) {
    mkdirSync(join(integrationPath, 'scripts'), { recursive: true })
    writeFileSync(join(integrationPath, 'scripts/smoke.sh'), smoke)
    chmodSync(join(integrationPath, 'scripts/smoke.sh'), options.executable === false ? 0o644 : 0o755)
  }
  writeFileSync(join(integrationPath, 'app.txt'), 'the product\n')
  git(['add', '-A'], integrationPath)
  git(['commit', '-q', '-m', 'merge(T-pkg): the packages'], integrationPath)
  const taskOf: Record<'skeleton' | 'api' | 'integration' | 'main', string> = { skeleton: '', api: '', integration: '', main: '' }
  const layout: readonly (readonly ['skeleton' | 'api' | 'integration' | 'main', boolean, readonly string[]])[] =
    options.single === true
      ? [['main', false, ['R1', 'RUN']]]
      : [['skeleton', false, []], ['api', false, ['R1']], ['integration', true, ['RUN']]]
  for (const [key, isIntegration, requirementKeys] of layout) {
    const pkg = await prisma.workPackage.create({
      data: {
        workspaceId: workspace.id, goalVersion: 1, key, title: key, requirementKeys: [...requirementKeys],
        ownedPaths: key === 'main' ? ['**'] : [`${key}/**`], interface: '', templateId: 'tpl', isIntegration,
      },
    })
    const task = await prisma.task.create({
      data: { workspaceId: workspace.id, title: key, description: 'x', status: 'done', integratedAt: new Date(), requiredRole: 'implementer', maxAttempts: 5, workPackageId: pkg.id, goalVersion: 1 },
    })
    taskOf[key] = task.id
  }
  return { workspaceId: workspace.id, repoPath, deliveryId: delivery.id, branch, integrationPath, taskOf }
}

const deliveryOf = async (f: Fixture) => prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
const attemptsOf = async (f: Fixture) => prisma.smokeAttempt.findMany({ where: { goalDeliveryId: f.deliveryId }, orderBy: { startedAt: 'asc' } })
const smokeWorktrees = (f: Fixture): string[] => {
  const root = worktreeRootFor(f.repoPath)
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('verify-smoke-')) : []
}
const taskStatus = async (id: string) => (await prisma.task.findUniqueOrThrow({ where: { id } })).status

afterAll(async (): Promise<void> => {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
  await prisma.$disconnect()
}, 30_000)

describe('a smoke attempt', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })
  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('passes in a fresh checkout with the constrained env, starts the round, keeps the output and removes the checkout', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho "project=$SLAVEOFAI_SMOKE_PROJECT db=${DATABASE_URL:-absent}"\ntest -f app.txt && echo "flow ok"\n')
    const tip = git(['rev-parse', f.branch], f.repoPath)
    const id = await startSmoke(f.deliveryId)
    expect(id).not.toBeNull()
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, activeSmokeId: id })
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ status: 'passed', exitCode: 0, round: 1, tip })
    expect(attempt?.output).toContain('flow ok')
    expect(attempt?.output).toContain('project=slaveofai-smoke-')
    expect(attempt?.output).toContain('db=absent')
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, activeSmokeId: null, activeRunId: null, roundRunFailures: 0 })
    expect(smokeWorktrees(f)).toEqual([])
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(event.payload).toMatchObject({ version: 1, round: 1, attemptId: id, outcome: 'passed', exitCode: 0, reworkedPackage: null })
  }, 60_000)

  it('sends the stub back to the skeleton, with the smoke contract, charging no attempt', async (): Promise<void> => {
    const f = await seed(INTAKE_BOOTSTRAP_SMOKE_SCRIPT)
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]).toMatchObject({ status: 'stub', exitCode: 2, reworkedTaskId: f.taskOf.skeleton })
    const skeleton = await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })
    expect(skeleton).toMatchObject({ status: 'rework', integratedAt: null, attempt: 0 })
    expect(skeleton.lastRejectionReason).toContain('scripts/smoke.sh is still the stub')
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1, activeSmokeId: null })
    const rework = await prisma.executionEvent.findFirstOrThrow({ where: { taskId: f.taskOf.skeleton, type: 'task_rework' } })
    expect(rework.payload).toMatchObject({ attempt: 0, verificationRound: 1 })
  }, 60_000)

  it('sends a missing script to the skeleton, saying it does not exist yet', async (): Promise<void> => {
    const f = await seed(null)
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]?.status).toBe('missing')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })).lastRejectionReason).toContain('This project has no scripts/smoke.sh yet')
  }, 60_000)

  it('sends a failing smoke to integration with its output -- the 2026-09-29 project\'s class', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho "docker compose up --build"\necho \'npm error Missing script: "start"\' >&2\nexit 1\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]).toMatchObject({ status: 'failed', exitCode: 1, reworkedTaskId: f.taskOf.integration })
    const integration = await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.integration } })
    expect(integration.status).toBe('rework')
    expect(integration.lastRejectionReason).toContain('Missing script: "start"')
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
  }, 60_000)

  it('kills a timed-out smoke\'s whole process group and sends it to integration', async (): Promise<void> => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'smoke-pid-')), 'pid')
    const f = await seed(`#!/usr/bin/env bash\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`, { smokeTimeoutMs: 1500 })
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]?.status).toBe('timed_out')
    expect(await taskStatus(f.taskOf.integration)).toBe('rework')
    const child = Number(readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(child)).toBe(false)
    expect(smokeWorktrees(f)).toEqual([])
  }, 60_000)

  it('stops for a person at the round cap, with the smoke output in the reason', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho "the app crash-loops"\nexit 1\n', { verificationRoundCap: 1 })
    await startSmoke(f.deliveryId)
    await drainPumps()
    const delivery = await deliveryOf(f)
    expect(delivery).toMatchObject({ status: 'needs_human', round: 1, activeSmokeId: null })
    expect(delivery.needsHumanReason).toContain('the verification round cap (1) was reached')
    expect(delivery.needsHumanReason).toContain('the app crash-loops')
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
    expect((await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })).payload).toMatchObject({ reworkedPackage: null })
  }, 60_000)

  it('starts at most one attempt when two passes race for the claim', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n')
    const ids = await Promise.all([startSmoke(f.deliveryId), startSmoke(f.deliveryId)])
    expect(ids.filter((id) => id !== null)).toHaveLength(1)
    await drainPumps()
    expect(await attemptsOf(f)).toHaveLength(1)
  }, 60_000)

  it('settles an attempt whose owner died: error, one run failure, the claim released -- never a round', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n')
    const attempt = await prisma.smokeAttempt.create({
      data: { workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', f.branch], f.repoPath), ownerInstance: '999999/dead-daemon' },
    })
    // The dead daemon's checkout is still there: settling removes it.
    const leftover = join(worktreeRootFor(f.repoPath), smokeWorktreeKey(attempt.id))
    git(['worktree', 'add', '--quiet', '--detach', leftover, attempt.tip], f.repoPath)
    // ...and so is a server its script backgrounded, in the group of a leader that already exited.
    const leader = spawn('/bin/sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { cwd: leftover, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let printed = ''
    leader.stdout.on('data', (chunk: Buffer) => { printed += chunk.toString() })
    await new Promise<void>((res) => leader.stdout.on('close', () => res()))
    const survivor = Number(printed.trim())
    expect(isAlive(survivor)).toBe(true)
    await prisma.smokeAttempt.update({ where: { id: attempt.id }, data: { worktreePath: leftover, pid: leader.pid ?? null } })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: attempt.id } })
    try {
      await settleStrandedSmoke(attempt.id)
      for (let i = 0; i < 50 && isAlive(survivor); i += 1) await new Promise((res) => setTimeout(res, 20))
      expect(isAlive(survivor)).toBe(false)
    } finally {
      try {
        process.kill(survivor, 'SIGKILL')
      } catch {
        // Gone, as it should be.
      }
    }
    expect(await prisma.smokeAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'error' })
    expect(smokeWorktrees(f)).toEqual([])
    expect((await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })).payload).toMatchObject({ attemptId: attempt.id, outcome: 'error', reworkedPackage: null })
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, roundRunFailures: 1, activeSmokeId: null })
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
  }, 60_000)

  it('kills nothing for an attempt that started before the machine booted, and says so', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n')
    const attempt = await prisma.smokeAttempt.create({
      data: {
        workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', f.branch], f.repoPath),
        ownerInstance: '999999/dead-daemon', startedAt: new Date('2000-01-01T00:00:00Z'),
      },
    })
    // Whatever now leads a group of the stored id is somebody else's, even with its cwd in the checkout.
    const leftover = join(worktreeRootFor(f.repoPath), smokeWorktreeKey(attempt.id))
    git(['worktree', 'add', '--quiet', '--detach', leftover, attempt.tip], f.repoPath)
    const stranger = spawn('sleep', ['60'], { cwd: leftover, detached: true, stdio: 'ignore' })
    const pid = stranger.pid as number
    await prisma.smokeAttempt.update({ where: { id: attempt.id }, data: { worktreePath: leftover, pid } })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: attempt.id } })
    try {
      await settleStrandedSmoke(attempt.id)
      expect(isAlive(pid)).toBe(true)
      const settled = await prisma.smokeAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
      expect(settled.status).toBe('error')
      expect(settled.output).toContain('the machine restarted since the attempt started')
      expect(await deliveryOf(f)).toMatchObject({ roundRunFailures: 1, activeSmokeId: null })
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  }, 60_000)

  it('applies an outcome at most once', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\nexit 1\n')
    const id = await startSmoke(f.deliveryId)
    await drainPumps()
    await applySmokeOutcome(id ?? '')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })).toBe(1)
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'task_rework' } })).toBe(1)
  }, 60_000)

  it('sends a script without the executable bit to the skeleton, saying to chmod it (F10)', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n', { executable: false })
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]).toMatchObject({ status: 'missing', exitCode: null, reworkedTaskId: f.taskOf.skeleton })
    const reason = (await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })).lastRejectionReason
    expect(reason).toContain('scripts/smoke.sh is not executable')
    expect(reason).toContain('chmod +x scripts/smoke.sh')
    expect(smokeWorktrees(f)).toEqual([])
  }, 60_000)

  it('keeps a 20 000-character output within the event\'s bound, so the outcome still applies (F1)', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\nhead -c 20000 /dev/zero | tr "\\0" x\necho\necho "the last line"\nexit 1\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ status: 'failed', reworkedTaskId: f.taskOf.integration })
    expect(attempt?.output.length).toBeLessThanOrEqual(SMOKE_OUTPUT_MAX_CHARS)
    expect(attempt?.output).toContain('the last line')
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(event.payload).toMatchObject({ outcome: 'failed', reworkedPackage: 'integration' })
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', activeSmokeId: null })
  }, 60_000)

  it('records one event for an attempt whose claim was already released, and moves nothing (F2)', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\nexit 1\n')
    const attempt = await prisma.smokeAttempt.create({
      data: {
        workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', f.branch], f.repoPath),
        status: 'failed', exitCode: 1, durationMs: 12, output: 'it broke', endedAt: new Date(),
      },
    })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'integrating', round: 1, activeSmokeId: null } })
    await applySmokeOutcome(attempt.id)
    await applySmokeOutcome(attempt.id)
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ attemptId: attempt.id, outcome: 'failed', reworkedPackage: null })
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1 })
  }, 60_000)
})
