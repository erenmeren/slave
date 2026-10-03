/**
 * Skeleton spec S7: the smoke gate's attempt -- claimed under the delivery's lock, run outside it in
 * a fresh checkout of the integration tip, concluded into a pass, a rework or a stop. Real git, a
 * real bash script on the integration branch, task states driven with Prisma.
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abandonGoal, isAlive } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_BOOTSTRAP_SMOKE_SCRIPT, RUN_REQUIREMENT, SMOKE_OUTPUT_MAX_CHARS, integrationBranchName, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { ClaudeCodeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGoalPass } from '../../src/goal.js'
import { ensureIntegrationBranch, ensureIntegrationWorktree } from '../../src/goalBranch.js'
import { applySmokeOutcome, cleanUpSmokeProject, handOffSmokeRework, settleStrandedSmoke, smokeWorktreeKey, startSmoke } from '../../src/smoke.js'
import { drainPumps, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'
import { fileRunReport } from '../../src/report.js'
import { dispatchVerification } from '../../src/verification.js'

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

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

/** The fake's verification arm: every requirement passes, RUN with a check of its own. */
const verifier = (): ClaudeCodeAdapter => new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'm8-flow'], hookPath: REAL_GATE })
const depsFor = (workspaceId: string, adapter: ClaudeCodeAdapter): TickDeps => ({ workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } })

/** `seed` plus what a verification run needs: a provider, and a verifier seat recorded on the delivery. */
async function seedWithVerifier(smoke: string | null): Promise<Fixture & { readonly verifierId: string }> {
  const f = await seed(smoke)
  await prisma.providerConfiguration.create({ data: { workspaceId: f.workspaceId, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: f.workspaceId, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Vera' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Verifier', runtimeRoles: ['reviewer', 'verifier'], profile: 'You check what was built.', personId: person.id } })
  await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { verifierSlaveId: seat.id } })
  return { ...f, verifierId: seat.id }
}

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
      'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "ProviderConfiguration", "RunContext", "Checkpoint", "Artifact", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
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

  it('records a pass whose output holds a NUL byte and other control characters as a pass (final review I2)', async (): Promise<void> => {
    const f = await seed("#!/usr/bin/env bash\nprintf 'ok\\0 bell\\a esc\\033[0m\\tTab\\r\\nnext line\\n'\nexit 0\n")
    await startSmoke(f.deliveryId)
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ status: 'passed', exitCode: 0 })
    expect(attempt?.output).toBe('ok bell esc[0m\tTab\nnext line')
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(event.payload).toMatchObject({ outcome: 'passed', output: 'ok bell esc[0m\tTab\nnext line' })
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', activeSmokeId: null, roundRunFailures: 0 })
  }, 60_000)

  it('records a cut output that would split a character in two, so the outcome still applies (final review I2)', async (): Promise<void> => {
    // 'x' then 10 000 emoji (two UTF-16 units each): the cut's head ends between an emoji's two halves.
    const f = await seed("#!/usr/bin/env bash\nprintf x\nfor i in $(seq 1 10000); do printf '\\360\\237\\230\\200'; done\nexit 1\n")
    await startSmoke(f.deliveryId)
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ status: 'failed', reworkedTaskId: f.taskOf.integration })
    expect(Buffer.from(attempt?.output ?? '', 'utf8').toString('utf8')).toBe(attempt?.output)
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

describe('the goal pass and the smoke gate', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "ProviderConfiguration", "RunContext", "Checkpoint", "Artifact", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })
  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('starts a smoke, not a verification run, once every package is integrated; the next pass verifies', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho "flow ok"\n')
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    await drainPumps()
    expect((await attemptsOf(f))[0]?.status).toBe('passed')
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    const runs = await prisma.slaveRun.findMany({ where: { kind: 'verification' } })
    expect(runs).toHaveLength(1)
    expect((await deliveryOf(f)).round).toBe(1)
    const context = await prisma.runContext.findFirstOrThrow({ where: { runId: runs[0]?.id ?? '' } })
    expect(context.prompt).toContain('and it passed')
    expect(context.prompt).toContain('flow ok')
  }, 120_000)

  it('verifies the smoked SHA with the smoked output, and dispatches nothing once the tip has moved', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho "flow ok"\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    const smoked = { output: 'pinned output', durationMs: 1000, tip: attempt?.tip ?? '' }
    writeFileSync(join(f.integrationPath, 'app.txt'), 'moved after the smoke\n')
    git(['commit', '-q', '-am', 'merge(T-pkg): a later rework'], f.integrationPath)
    expect(await dispatchVerification(depsFor(f.workspaceId, verifier()), f.deliveryId, smoked)).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', activeRunId: null, roundRunFailures: 0 })
    // The goal pass then smokes the new tip instead of verifying the old one.
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect(await attemptsOf(f)).toHaveLength(2)
  }, 120_000)

  it('takes no smoke claim when a hand-off reopened a package after the pass looked (Task 5 review I1)', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n')
    // The pass read every package integrated; a report's hand-off reopened the skeleton since.
    await prisma.task.update({ where: { id: f.taskOf.skeleton }, data: { status: 'rework', integratedAt: null } })
    expect(await startSmoke(f.deliveryId)).toBeNull()
    expect(await attemptsOf(f)).toEqual([])
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 0, activeSmokeId: null, activeRunId: null })
    expect(await taskStatus(f.taskOf.skeleton)).toBe('rework')
  }, 60_000)

  it('takes no verification claim when a hand-off reopened a package after the pass looked (Task 5 review I1)', async (): Promise<void> => {
    const f = await seedWithVerifier(null)
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { smokeRequired: false } })
    await prisma.task.update({ where: { id: f.taskOf.api }, data: { status: 'rework', integratedAt: null } })
    expect(await dispatchVerification(depsFor(f.workspaceId, verifier()), f.deliveryId)).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 0, activeRunId: null, activeSmokeId: null, roundRunFailures: 0 })
    expect(await taskStatus(f.taskOf.api)).toBe('rework')
  }, 60_000)

  it('refuses to verify a version that needs a smoke when no smoked attempt is handed in (final review minor 3)', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    expect(await dispatchVerification(depsFor(f.workspaceId, verifier()), f.deliveryId)).toBeNull()
    expect(await dispatchVerification(depsFor(f.workspaceId, verifier()), f.deliveryId, null)).toBeNull()
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 0, activeRunId: null, roundRunFailures: 0 })
  }, 60_000)

  it('hands the verifier the attempt it was given, on exactly that commit', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho "flow ok"\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    const tip = attempt?.tip ?? ''
    const runId = await dispatchVerification(depsFor(f.workspaceId, verifier()), f.deliveryId, { output: 'pinned output', durationMs: 1000, tip })
    await drainPumps()
    expect(runId).not.toBeNull()
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'verification' } })
    expect(run.verificationTip).toBe(tip)
    const context = await prisma.runContext.findFirstOrThrow({ where: { runId: run.id } })
    expect(context.prompt).toContain('pinned output')
    expect(context.prompt).toContain(`commit ${tip.slice(0, 12)}`)
  }, 120_000)

  it('starts nothing while the scheduler has no room', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: false })
    expect(await attemptsOf(f)).toEqual([])
  }, 60_000)

  it('verifies a retried version of an unchanged tree without running the smoke again', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'integrating', roundBase: 1 } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect(await attemptsOf(f)).toHaveLength(1)
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)
    expect((await deliveryOf(f)).round).toBe(2)
  }, 120_000)

  it('smokes a moved tip again even after an earlier pass', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    writeFileSync(join(f.integrationPath, 'app.txt'), 'the product, reworked\n')
    git(['commit', '-q', '-am', 'merge(T-pkg): a rework'], f.integrationPath)
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'integrating' } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    await drainPumps()
    expect(await attemptsOf(f)).toHaveLength(2)
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 2, activeSmokeId: null })
  }, 120_000)

  it('ends in needs_human after three smoke attempts that could not run in one round, saying so', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, roundRunFailures: 3 } })
    await prisma.smokeAttempt.create({ data: { workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: 'x', status: 'error', output: 'worktree add failed' } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    const delivery = await deliveryOf(f)
    expect(delivery.status).toBe('needs_human')
    expect(delivery.needsHumanReason).toContain('1 smoke check(s) could not be run; the last: worktree add failed')
  }, 60_000)

  it('waits for a smoke another live process is running, and settles one whose owner is gone', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    const tip = git(['rev-parse', f.branch], f.repoPath)
    const live = await prisma.smokeAttempt.create({ data: { workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip, ownerInstance: `${String(process.ppid)}/another-daemon` } })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: live.id } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    expect(await deliveryOf(f)).toMatchObject({ activeSmokeId: live.id, activeRunId: null })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)

    await prisma.smokeAttempt.update({ where: { id: live.id }, data: { ownerInstance: '999999/dead-daemon' } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    // Settled as an error (one run failure), and the same round's smoke started again on this pass.
    expect(await attemptsOf(f)).toMatchObject([{ id: live.id, status: 'error' }, { status: 'passed', round: 1 }])
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, roundRunFailures: 1, activeSmokeId: null })
  }, 120_000)

  it('says once that the integration branch is gone, from integrating and from verifying, instead of waiting in silence (final review I1)', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    git(['update-ref', '-d', `refs/heads/${f.branch}`], f.repoPath)
    const trips = async (): Promise<readonly string[]> =>
      (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' }, orderBy: { seq: 'asc' } })).map(
        (row) => String((row.payload as Record<string, unknown>)['detail']),
      )
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    const gone = `the integration branch ${f.branch} of goal v1 is gone: restore it or run abandon-goal --workspace ${f.workspaceId} --version 1`
    expect(await trips()).toEqual([gone])
    expect(await attemptsOf(f)).toEqual([])
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', activeSmokeId: null, activeRunId: null })
    // Mid-version (a round already started): the same trip, said once, and nothing dispatched.
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1 } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect(await trips()).toEqual([gone])
    expect(await attemptsOf(f)).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
  }, 60_000)

  it('abandons a version mid-smoke: the script is signalled, its outcome moves nothing', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\ntrap "echo stopped; exit 143" TERM\nsleep 30 &\nwait\n')
    await startSmoke(f.deliveryId)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await abandonGoal(f.workspaceId, 1)).ok).toBe(true)
    await drainPumps()
    expect(await deliveryOf(f)).toMatchObject({ status: 'abandoned', activeSmokeId: null })
    expect((await attemptsOf(f))[0]?.status).toBe('failed')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'task_rework' } })).toBe(0)
    // Ruling F2: the abandoned attempt still says how it ended, once, sending nobody back.
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ outcome: 'failed', reworkedPackage: null })
    expect(smokeWorktrees(f)).toEqual([])
  }, 60_000)

  it('never starts the script of a version abandoned while its checkout was made (fix ruling 2)', async (): Promise<void> => {
    const marker = join(mkdtempSync(join(tmpdir(), 'smoke-marker-')), 'ran')
    const f = await seedWithVerifier(`#!/usr/bin/env bash\ntouch '${marker}'\n`)
    // `git worktree add` runs post-checkout: a slow one holds the attempt in its checkout while the person abandons.
    writeFileSync(join(f.repoPath, '.git/hooks/post-checkout'), '#!/bin/sh\nsleep 1.5\n')
    chmodSync(join(f.repoPath, '.git/hooks/post-checkout'), 0o755)
    await startSmoke(f.deliveryId)
    expect((await abandonGoal(f.workspaceId, 1)).ok).toBe(true)
    await drainPumps()
    expect(existsSync(marker)).toBe(false)
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ status: 'error', pid: null })
    expect(attempt?.output).toContain('was not started')
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ outcome: 'error', reworkedPackage: null })
    expect(await deliveryOf(f)).toMatchObject({ status: 'abandoned', activeSmokeId: null, roundRunFailures: 0 })
    expect(smokeWorktrees(f)).toEqual([])
  }, 60_000)

  it('abandoning a stranded attempt from before a reboot signals nothing, even a process in its checkout (fix ruling 1)', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    const attempt = await prisma.smokeAttempt.create({
      data: {
        workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', f.branch], f.repoPath),
        ownerInstance: '999999/dead-daemon', startedAt: new Date('2000-01-01T00:00:00Z'),
      },
    })
    const leftover = join(worktreeRootFor(f.repoPath), smokeWorktreeKey(attempt.id))
    git(['worktree', 'add', '--quiet', '--detach', leftover, attempt.tip], f.repoPath)
    // Started after the attempt, on a machine booted after it: whoever leads the stored id now is a stranger.
    const stranger = spawn('sleep', ['60'], { cwd: leftover, detached: true, stdio: 'ignore' })
    const pid = stranger.pid as number
    await prisma.smokeAttempt.update({ where: { id: attempt.id }, data: { worktreePath: leftover, pid } })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: attempt.id } })
    try {
      expect((await abandonGoal(f.workspaceId, 1)).ok).toBe(true)
      await new Promise((res) => setTimeout(res, 200))
      expect(isAlive(pid)).toBe(true)
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  }, 60_000)

  it('settles an abandoned version\'s attempt whose process died, so it still gets its one event (F2)', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    const attempt = await prisma.smokeAttempt.create({
      data: { workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', f.branch], f.repoPath), ownerInstance: '999999/dead-daemon' },
    })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: attempt.id } })
    expect((await abandonGoal(f.workspaceId, 1)).ok).toBe(true)
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    expect(await prisma.smokeAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'error' })
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ attemptId: attempt.id, outcome: 'error', reworkedPackage: null })
    expect(await deliveryOf(f)).toMatchObject({ status: 'abandoned', activeSmokeId: null, roundRunFailures: 0 })
  }, 60_000)

  it('verifies a legacy version whose set has no RUN as before, with no smoke', async (): Promise<void> => {
    const f = await seedWithVerifier(null)
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { smokeRequired: false } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect(await attemptsOf(f)).toEqual([])
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)
    expect((await deliveryOf(f)).round).toBe(1)
  }, 120_000)

  it('sends the skeleton back when a version whose set has RUN has no scripts/smoke.sh', async (): Promise<void> => {
    const f = await seedWithVerifier(null)
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect((await attemptsOf(f))[0]).toMatchObject({ status: 'missing', reworkedTaskId: f.taskOf.skeleton })
    expect(await taskStatus(f.taskOf.skeleton)).toBe('rework')
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1 })
  }, 60_000)
})

const FAILING = '#!/usr/bin/env bash\necho \'npm error Missing script: "start"\' >&2\nexit 1\n'

/** A finished rework run of the package `key`'s task whose final message carries `report`, filed
 *  exactly as `verifyConcludedRun` files it -- the hand-off's only entry point. Names carry a random
 *  suffix: `Team` is unique per (workspace, name) and `Person.name` is unique (ruling F3). */
async function fileRework(f: Fixture, key: 'integration' | 'api' | 'main', report: object): Promise<string> {
  const suffix = String(Math.random()).slice(2, 10)
  const team = await prisma.team.create({ data: { workspaceId: f.workspaceId, name: `Engineering ${key} ${suffix}` } })
  const person = await prisma.person.create({ data: { name: `Ivo ${key} ${suffix}` } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'implementer', runtimeRoles: ['implementer'], personId: person.id } })
  const run = await prisma.slaveRun.create({ data: { taskId: f.taskOf[key], slaveId: slave.id, kind: 'implementation', status: 'succeeded', terminalAt: new Date() } })
  await appendEvent({ type: 'run.output', workspaceId: f.workspaceId, slaveId: slave.id, runId: run.id, actor: 'slave', payload: { text: `Done.\n<slave-report>${JSON.stringify(report)}</slave-report>` } })
  const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf[key] }, select: { id: true, workspaceId: true, workPackageId: true } })
  await fileRunReport(run, { id: task.id, workspaceId: task.workspaceId, workPackageId: task.workPackageId ?? '' })
  return run.id
}

const integrationReport = (handOff?: object): object => ({
  requirements: [{ key: 'RUN', status: 'not_done', evidence: 'the image cannot start' }],
  filesTouched: [],
  workflow: [],
  questions: [],
  ...(handOff === undefined ? {} : { handOff }),
})

const handOffs = async (f: Fixture) => prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_handed_off' } })

describe('the smoke hand-off (plan B D11, user ruling 2026-09-30)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "RunReport", "ProviderConfiguration", "RunContext", "Checkpoint", "Artifact", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })
  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('sends a failed smoke on to the skeleton when integration names a file the skeleton owns, spending no round', async (): Promise<void> => {
    const f = await seed(FAILING)
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect(await taskStatus(f.taskOf.integration)).toBe('rework')
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/package.json', change: 'add a "start" script' }))

    const skeleton = await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })
    expect(skeleton).toMatchObject({ status: 'rework', integratedAt: null, attempt: 0 })
    expect(skeleton.lastRejectionReason).toContain('found the fix is in a file you own: skeleton/package.json')
    expect(skeleton.lastRejectionReason).toContain('add a "start" script')
    expect(skeleton.lastRejectionReason).toContain('Missing script: "start"')
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ handOffTaskId: f.taskOf.skeleton, handOffPath: 'skeleton/package.json', handOffChange: 'add a "start" script', reworkedTaskId: f.taskOf.integration })
    const events = await handOffs(f)
    expect(events.map((e) => e.payload)).toEqual([
      { version: 1, round: 1, attemptId: attempt?.id, fromPackage: 'integration', toPackage: 'skeleton', path: 'skeleton/package.json', change: 'add a "start" script' },
    ])
    // No round spent: the failed attempt spent round 1; the next smoke is round 2, as without the hand-off.
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1, activeSmokeId: null })
    const rework = await prisma.executionEvent.findFirstOrThrow({ where: { taskId: f.taskOf.skeleton, type: 'task_rework' } })
    expect(rework.payload).toMatchObject({ attempt: 0, verificationRound: 1 })
    // Both packages back in and integrated: the next smoke is round 2.
    await prisma.task.updateMany({ where: { id: { in: [f.taskOf.skeleton, f.taskOf.integration] } }, data: { status: 'done', integratedAt: new Date() } })
    expect(await startSmoke(f.deliveryId)).not.toBeNull()
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 2 })
  }, 60_000)

  it('files a report whose hand-off change holds a NUL byte, and hands it off with the control characters dropped (final review I2)', async (): Promise<void> => {
    const f = await seed(FAILING)
    await startSmoke(f.deliveryId)
    await drainPumps()
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/package.json', change: 'add a "start"\u0000 script\u001b[0m' }))
    expect(await prisma.runReport.count({ where: { taskId: f.taskOf.integration } })).toBe(1)
    expect(await taskStatus(f.taskOf.skeleton)).toBe('rework')
    expect((await attemptsOf(f))[0]?.handOffChange).toBe('add a "start" script[0m')
    expect((await handOffs(f)).map((e) => (e.payload as Record<string, unknown>)['change'])).toEqual(['add a "start" script[0m'])
  }, 60_000)

  it('hands off at most once per smoke attempt -- no ping-pong', async (): Promise<void> => {
    const f = await seed(FAILING)
    await startSmoke(f.deliveryId)
    await drainPumps()
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/package.json', change: 'add a "start" script' }))
    // The skeleton finished; integration reports the same hand-off again on a later run.
    await prisma.task.update({ where: { id: f.taskOf.skeleton }, data: { status: 'done', integratedAt: new Date() } })
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/package.json', change: 'still no start script' }))
    expect(await handOffs(f)).toHaveLength(1)
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
    expect((await attemptsOf(f))[0]?.handOffChange).toBe('add a "start" script')
  }, 60_000)

  it('does not hand off a path a third package owns: the version proceeds as today, the next smoke is round 2 (pinned)', async (): Promise<void> => {
    const f = await seed(FAILING)
    await startSmoke(f.deliveryId)
    await drainPumps()
    await fileRework(f, 'integration', integrationReport({ path: 'api/server.ts', change: 'export the router' }))
    expect(await handOffs(f)).toEqual([])
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
    expect(await taskStatus(f.taskOf.api)).toBe('done')
    expect((await attemptsOf(f))[0]?.handOffTaskId).toBeNull()
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1 })
    // As today: integration's rework integrates, and the next smoke is the next round.
    await prisma.task.update({ where: { id: f.taskOf.integration }, data: { status: 'done', integratedAt: new Date() } })
    expect(await startSmoke(f.deliveryId)).not.toBeNull()
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 2 })
    // A late report naming a skeleton file, once the version moved on to round 2, hands nothing off.
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/package.json', change: 'x' }))
    expect(await handOffs(f)).toEqual([])
    await drainPumps()
  }, 60_000)

  it('does not hand off a file a person gave away from the skeleton (human cards plan B D5)', async (): Promise<void> => {
    const f = await seed(FAILING)
    await prisma.workPackage.updateMany({ where: { workspaceId: f.workspaceId, key: 'skeleton' }, data: { releasedPaths: ['skeleton/package.json'] } })
    await startSmoke(f.deliveryId)
    await drainPumps()
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/package.json', change: 'add a "start" script' }))
    expect(await handOffs(f)).toEqual([])
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
    expect((await attemptsOf(f))[0]?.handOffTaskId).toBeNull()
  }, 60_000)

  it('does nothing for no handOff, an unowned or refused path, or a report that is not integration\'s', async (): Promise<void> => {
    const f = await seed(FAILING)
    await startSmoke(f.deliveryId)
    await drainPumps()
    await fileRework(f, 'integration', integrationReport())
    await fileRework(f, 'integration', integrationReport({ path: 'wiring.ts', change: 'x' }))
    await fileRework(f, 'integration', integrationReport({ path: '../skeleton/package.json', change: 'x' }))
    await fileRework(f, 'integration', integrationReport({ path: './skeleton/package.json', change: 'x' }))
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton/*.json', change: 'x' }))
    await fileRework(f, 'integration', integrationReport({ path: '/skeleton/package.json', change: 'x' }))
    await fileRework(f, 'integration', integrationReport({ path: 'skeleton//package.json', change: 'x' }))
    await fileRework(f, 'api', { requirements: [{ key: 'R1', status: 'done', evidence: 'x' }], filesTouched: [], workflow: [], questions: [], handOff: { path: 'skeleton/package.json', change: 'x' } })
    expect(await handOffs(f)).toEqual([])
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
    expect((await attemptsOf(f))[0]?.handOffTaskId).toBeNull()
  }, 60_000)

  it('takes a hand-off only from the integration package, even for an attempt that sent another package back', async (): Promise<void> => {
    const f = await seed(FAILING)
    await startSmoke(f.deliveryId)
    await drainPumps()
    // Not a route the smoke takes today (a failure goes to integration): the reporter check alone refuses it.
    const [attempt] = await attemptsOf(f)
    await prisma.smokeAttempt.update({ where: { id: attempt?.id ?? '' }, data: { reworkedTaskId: f.taskOf.api } })
    const report = { requirements: [{ key: 'R1', status: 'done', evidence: 'x' }], filesTouched: [], workflow: [], questions: [], handOff: { path: 'skeleton/package.json', change: 'x' } }
    expect(await handOffSmokeRework({ id: await fileRework(f, 'api', report) }, { id: f.taskOf.api }, { path: 'skeleton/package.json', change: 'x' })).toBe(false)
    expect(await handOffs(f)).toEqual([])
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
  }, 60_000)

  it('has no hand-off in single mode: the one package owns everything', async (): Promise<void> => {
    const f = await seed(FAILING, { single: true })
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect(await taskStatus(f.taskOf.main)).toBe('rework')
    const report = { requirements: [{ key: 'R1', status: 'done', evidence: 'x' }, { key: 'RUN', status: 'not_done', evidence: 'x' }], filesTouched: [], workflow: [], questions: [], handOff: { path: 'package.json', change: 'x' } }
    expect(await handOffSmokeRework({ id: await fileRework(f, 'main', report) }, { id: f.taskOf.main }, { path: 'package.json', change: 'x' })).toBe(false)
    expect(await handOffs(f)).toEqual([])
  }, 60_000)
})

describe('the smoke cleanup (final review minor 6)', () => {
  it('removes the attempt\'s compose project, and every container, network and volume named with its prefix -- nothing else', async (): Promise<void> => {
    const project = 'slaveofai-smoke-0123456789ab'
    const bin = mkdtempSync(join(tmpdir(), 'smoke-fake-docker-'))
    const log = join(bin, 'calls.log')
    // A docker that answers the listings and records every call, so no Docker daemon is needed.
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> '${log}'`,
        'case "$1 $2" in',
        `  "ps -aq") echo c1 ;;`,
        `  "network ls") printf '%s\\n' ${project}_default ${project}-net bridge slaveofai-smoke-ffffffffffff_default ;;`,
        `  "volume ls") printf '%s\\n' ${project}-data unrelated-data ;;`,
        'esac',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(join(bin, 'docker'), 0o755)
    const path = process.env['PATH']
    process.env['PATH'] = `${bin}:${path ?? ''}`
    try {
      await cleanUpSmokeProject(project)
    } finally {
      process.env['PATH'] = path
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls).toContain(`compose -p ${project} down -v --remove-orphans`)
    expect(calls).toContain('rm -f c1')
    expect(calls).toContain(`network rm ${project}_default ${project}-net`)
    expect(calls).toContain(`volume rm -f ${project}-data`)
    // Containers first: a network still in use by one cannot be removed.
    expect(calls.findIndex((c) => c.startsWith('rm -f'))).toBeLessThan(calls.findIndex((c) => c.startsWith('network rm')))
    rmSync(bin, { recursive: true, force: true })
  }, 60_000)
})
