/**
 * Conductor Plan 4b, Task 5: a goal version is verified by its own run, in a fresh detached
 * checkout of its integration branch. Real git in a temp repository; the `env-echo` fake so the
 * spawn is observable without a verdict (the conclusion is Task 6's).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDirPathFor } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { integrationBranchName, runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, permissionsFilePathFor, verifyDirPathFor } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ensureIntegrationBranch, ensureIntegrationWorktree } from '../../src/goalBranch.js'
import { drainPumps, type TickDeps } from '../../src/tick.js'
import {
  dispatchVerification,
  isVerificationArtifact,
  newUntrackedPaths,
  removeVerificationWorktree,
  sameBaseline,
  verificationWorktreeKey,
  worktreeBaseline,
  type VerificationBaseline,
} from '../../src/verification.js'
import { verifyConcludedRun } from '../../src/verify.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-verification-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  writeFileSync(join(dir, 'a.txt'), 'original\n')
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
  readonly taskIds: readonly string[]
  readonly implementerId: string
  readonly verifierId: string
  readonly reviewerId: string
}

/**
 * A conducted workspace at goal v1: its integration branch carries a package commit, both package
 * tasks are `done` and integrated (each with an implementation run by Alex), a two-requirement set,
 * a verifier seat recorded on the delivery, and a spare reviewer seat.
 */
async function seed(options: { readonly setupCommands?: readonly string[] } = {}): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Verification',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [...(options.setupCommands ?? [])],
      delivery: 'conducted',
      goal: 'Add a CSV mode.\nAnd a JSON one.',
      goalVersion: 1,
    },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const seat = async (name: string, runtimeRoles: readonly string[], profile: string | null = null): Promise<string> =>
    (
      await prisma.slave.create({
        data: { teamId: team.id, role: name, runtimeRoles: [...runtimeRoles], profile, personId: (await prisma.person.create({ data: { name } })).id },
      })
    ).id
  const implementerId = await seat('Alex', ['backend'])
  const verifierId = await seat('Vera', ['reviewer', 'verifier'], 'You check what was built.')
  const reviewerId = await seat('Rhea', ['reviewer'], 'You review.')

  await prisma.requirementSet.create({
    data: {
      workspaceId: workspace.id,
      goalVersion: 1,
      items: [
        { key: 'R1', text: 'a CSV mode', source: 'Add a CSV mode.' },
        { key: 'R2', text: 'a JSON mode', source: 'And a JSON one.' },
      ],
    },
  })

  const branch = integrationBranchName(1, workspace.id)
  const { baseCommit } = await ensureIntegrationBranch(repoPath, 'main', branch)
  const delivery = await prisma.goalDelivery.create({
    data: { workspaceId: workspace.id, goalVersion: 1, integrationBranch: branch, baseCommit, verifierSlaveId: verifierId },
  })
  const integrationPath = await ensureIntegrationWorktree(repoPath, { deliveryId: delivery.id, goalVersion: 1, branch }, workspace.id)
  writeFileSync(join(integrationPath, 'a.txt'), 'the goal changed this\n')
  git(['add', '-A'], integrationPath)
  git(['commit', '-q', '-m', 'merge(T-pkg): the package'], integrationPath)

  const taskIds: string[] = []
  for (const key of ['csv', 'json']) {
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: workspace.id, goalVersion: 1, key, title: key, requirementKeys: [key === 'csv' ? 'R1' : 'R2'], ownedPaths: [`${key}/**`], interface: '', templateId: 'tpl' },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `The ${key} package`,
        description: 'x',
        status: 'done',
        integratedAt: new Date(),
        requiredRole: 'backend',
        maxAttempts: 5,
        workPackageId: pkg.id,
        goalVersion: 1,
      },
    })
    await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: implementerId, status: 'succeeded', terminalAt: new Date() } })
    taskIds.push(task.id)
  }
  return { workspaceId: workspace.id, repoPath, deliveryId: delivery.id, branch, taskIds, implementerId, verifierId, reviewerId }
}

function depsFor(workspaceId: string, adapter: ClaudeCodeAdapter): TickDeps {
  return { workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } }
}

const envEcho = (): ClaudeCodeAdapter => new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath: REAL_GATE })

interface Verdict {
  readonly allow: readonly { readonly tool: string }[]
  readonly ownership?: unknown
}

describe('dispatchVerification', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "RunContext", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) {
      rmSync(worktreeRootFor(repo), { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
    await prisma.$disconnect()
  }, 30_000)

  it('starts a task-less verification run by the recorded verifier and claims the delivery for round 1', async (): Promise<void> => {
    const f = await seed()
    const adapter = envEcho()

    const runId = await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    expect(run).toMatchObject({ kind: 'verification', taskId: null, goalDeliveryId: f.deliveryId, slaveId: f.verifierId, status: 'succeeded' })
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
    expect(delivery).toMatchObject({ status: 'verifying', round: 1, activeRunId: run.id, roundRunFailures: 0 })

    const started = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_verification_started' } })
    expect(started.map((event) => event.payload)).toEqual([{ version: 1, round: 1, runId: run.id }])
    // Until Task 6 concludes it, a concluded verification run is left alone -- not thrown on as an
    // implementation run with no task.
    await expect(verifyConcludedRun(brandRunId(run.id))).resolves.toBeUndefined()
  }, 60_000)

  it('checks out the integration tip detached in verify-<run8>, and records the tip and the post-setup baseline', async (): Promise<void> => {
    // Setup dirties a tracked file: the baseline must be recorded AFTER it (ruling Q5).
    const f = await seed({ setupCommands: ['echo from-setup >> a.txt'] })
    const runId = await dispatchVerification(depsFor(f.workspaceId, envEcho()), f.deliveryId)
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    const path = run.worktreePath ?? ''
    const tip = git(['rev-parse', f.branch], f.repoPath)
    expect(dirname(path)).toBe(worktreeRootFor(f.repoPath))
    expect(basename(path)).toBe(verificationWorktreeKey(run.id))
    expect(basename(path)).toBe(`verify-${run.id.slice(0, 8)}`)
    expect(git(['rev-parse', 'HEAD'], path)).toBe(tip)
    expect(() => git(['symbolic-ref', '-q', 'HEAD'], path)).toThrow()

    expect(run.verificationTip).toBe(tip)
    expect(run.verificationBaseline).toEqual(await worktreeBaseline(path))
    expect(run.verificationBaseline).toMatchObject({ head: tip, status: ' M a.txt\n' })
  }, 60_000)

  it('writes an owns-nothing permissions file and a 0700 scratch directory the child sees as SLAVEOFAI_VERIFY_DIR', async (): Promise<void> => {
    const f = await seed()
    const adapter = envEcho()
    const runId = await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    const runDir = runDirPathFor(brandRunId(run.id))
    const verdict = JSON.parse(readFileSync(permissionsFilePathFor(runDir), 'utf8')) as Verdict
    expect(verdict.ownership).toEqual({ worktreeRoot: realpathSync(run.worktreePath ?? ''), owned: [], excluded: [] })
    expect(verdict.allow.map((entry) => entry.tool)).toContain('Write')

    const verifyDir = verifyDirPathFor(runDir)
    expect(existsSync(verifyDir)).toBe(true)
    expect(statSync(verifyDir).mode & 0o777).toBe(0o700)
    const env = z.record(z.string(), z.string()).parse(adapter.rawTerminalPayload(brandRunId(run.id))?.['env'])
    expect(env['SLAVEOFAI_VERIFY_DIR']).toBe(verifyDir)
  }, 60_000)

  it('records a verification run context: profile, the goal and the protocol, nothing else', async (): Promise<void> => {
    const f = await seed()
    const runId = await dispatchVerification(depsFor(f.workspaceId, envEcho()), f.deliveryId)
    await drainPumps()

    const context = await prisma.runContext.findUniqueOrThrow({ where: { runId: runId ?? '' } })
    const manifest = context.sections as unknown as { readonly kind: string; readonly sections: readonly { readonly kind: string }[] }
    expect(manifest.kind).toBe('verification')
    expect(manifest.sections.map((section) => section.kind)).toEqual(['profile', 'verification_goal', 'verification_protocol'])
    expect(manifest.sections[1]).toMatchObject({ kind: 'verification_goal', goalVersion: 1, round: 1, requirements: 2 })
    expect(context.prompt).toContain('Requirement keys: R1, R2')
    expect(context.prompt).toContain('a.txt')
    // D4: nothing was injected into the checkout being verified.
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    expect(existsSync(join(run.worktreePath ?? '', '.claude'))).toBe(false)
  }, 60_000)

  it('never lets an implementer of the version verify it: the recorded seat is re-staffed', async (): Promise<void> => {
    const f = await seed()
    const firstTask = f.taskIds[0] ?? ''
    await prisma.slaveRun.create({ data: { taskId: firstTask, slaveId: f.verifierId, status: 'succeeded', terminalAt: new Date() } })

    const runId = await dispatchVerification(depsFor(f.workspaceId, envEcho()), f.deliveryId)
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    expect(run.slaveId).not.toBe(f.verifierId)
    expect(run.slaveId).not.toBe(f.implementerId)
    expect(run.slaveId).toBe(f.reviewerId)
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
    expect(delivery.verifierSlaveId).toBe(f.reviewerId)
    const reviewer = await prisma.slave.findUniqueOrThrow({ where: { id: f.reviewerId } })
    expect(reviewer.runtimeRoles).toContain('verifier')
  }, 60_000)

  it('does not start a second run while the first holds the claim', async (): Promise<void> => {
    const f = await seed()
    const deps = depsFor(f.workspaceId, envEcho())
    const first = await dispatchVerification(deps, f.deliveryId)
    expect(first).not.toBeNull()

    expect(await dispatchVerification(deps, f.deliveryId)).toBeNull()
    await drainPumps()
    expect(await dispatchVerification(deps, f.deliveryId)).toBeNull()

    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)
  }, 60_000)

  it('waits silently, taking no claim, while the verifier is busy with another run', async (): Promise<void> => {
    const f = await seed()
    await prisma.slaveRun.create({ data: { taskId: f.taskIds[1] ?? '', slaveId: f.verifierId, kind: 'review', status: 'working' } })

    expect(await dispatchVerification(depsFor(f.workspaceId, envEcho()), f.deliveryId)).toBeNull()

    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
    expect(delivery).toMatchObject({ status: 'integrating', round: 0, activeRunId: null })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
  }, 60_000)

  // Fix round 1, ruling V4: a verifier that CREATES a missing source file through its shell must
  // not pass -- untracked, non-ignored files are part of the baseline. Ignored ones are not (a
  // test run's node_modules/ or build output), and whatever setup created is in the baseline.
  it('sees an untracked file the verifier created, and ignores what is gitignored or came from setup', async (): Promise<void> => {
    const f = await seed({ setupCommands: ["printf 'node_modules/\\n' > .gitignore && mkdir -p gen && echo from-setup > gen/setup.txt"] })
    const runId = await dispatchVerification(depsFor(f.workspaceId, envEcho()), f.deliveryId)
    await drainPumps()
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    const path = run.worktreePath ?? ''
    const stored = run.verificationBaseline as unknown as VerificationBaseline

    // What setup left untracked is recorded, so an untouched worktree still matches.
    expect(sameBaseline(stored, await worktreeBaseline(path))).toBe(true)

    // A gitignored file (a dependency install, a build) changes nothing.
    mkdirSync(join(path, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    expect(sameBaseline(stored, await worktreeBaseline(path))).toBe(true)

    // Changing the CONTENT of an untracked file setup created is seen.
    writeFileSync(join(path, 'gen', 'setup.txt'), 'rewritten\n')
    expect(sameBaseline(stored, await worktreeBaseline(path))).toBe(false)
    writeFileSync(join(path, 'gen', 'setup.txt'), 'from-setup\n')
    expect(sameBaseline(stored, await worktreeBaseline(path))).toBe(true)

    // A new, non-ignored file -- the missing feature written in by the verifier -- is seen.
    mkdirSync(join(path, 'src'), { recursive: true })
    writeFileSync(join(path, 'src', 'csv.ts'), 'export const csv = true\n')
    expect(sameBaseline(stored, await worktreeBaseline(path))).toBe(false)
  }, 60_000)

  // Fix round 2, ruling V4b: running a project's tests leaves well-known artifacts behind in a
  // repository that does not ignore them; those must not discard the verification. Any other new
  // untracked file still does, and is named for the discard reason. A TRACKED file under an
  // artifact directory is still a tracked change.
  it('lets test and build artifacts appear, names any other new untracked file, and still sees a tracked build/ file change', async (): Promise<void> => {
    const f = await seed({ setupCommands: ['mkdir -p build && echo built > build/out.txt && git add -f build/out.txt && git commit -q -m build'] })
    const runId = await dispatchVerification(depsFor(f.workspaceId, envEcho()), f.deliveryId)
    await drainPumps()
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    const path = run.worktreePath ?? ''
    const stored = run.verificationBaseline as unknown as VerificationBaseline

    for (const [file, content] of [
      ['__pycache__/x.pyc', 'bytecode'],
      ['pkg/__pycache__/y.cpython-312.pyc', 'bytecode'],
      ['.pytest_cache/v', 'cache'],
      ['coverage/index.html', '<html>'],
      ['.coverage', 'data'],
      ['.coverage.host.1234', 'data'],
      ['stray.pyc', 'bytecode'],
      ['my_pkg.egg-info/PKG-INFO', 'meta'],
      ['.DS_Store', 'x'],
    ] as const) {
      mkdirSync(dirname(join(path, file)), { recursive: true })
      writeFileSync(join(path, file), content)
    }
    const withArtifacts = await worktreeBaseline(path)
    expect(sameBaseline(stored, withArtifacts)).toBe(true)
    expect(newUntrackedPaths(stored, withArtifacts)).toEqual([])

    mkdirSync(join(path, 'src'), { recursive: true })
    writeFileSync(join(path, 'src', 'new_module.py'), 'FEATURE = True\n')
    const withSource = await worktreeBaseline(path)
    expect(sameBaseline(stored, withSource)).toBe(false)
    expect(newUntrackedPaths(stored, withSource)).toEqual(['src/new_module.py'])
    rmSync(join(path, 'src'), { recursive: true, force: true })

    writeFileSync(join(path, 'build', 'out.txt'), 'changed by the verifier\n')
    expect(sameBaseline(stored, await worktreeBaseline(path))).toBe(false)
  }, 60_000)

  it('recognises artifact paths by segment and suffix, and nothing else', (): void => {
    for (const artifact of ['__pycache__/a.pyc', 'a/b/node_modules/x.js', '.coverage', '.coverage.x', 'm.pyo', 'x.egg-info/PKG-INFO', 'a/.DS_Store', 'target/debug/app', '.venv/bin/python']) {
      expect(isVerificationArtifact(artifact), artifact).toBe(true)
    }
    for (const source of ['src/new_module.py', 'build.gradle', 'coverage.ts', 'docs/dist.md', 'src/targets.rs', 'egg-info.txt']) {
      expect(isVerificationArtifact(source), source).toBe(false)
    }
  })

  it('deletes its row and spawns nothing when it loses the claim', async (): Promise<void> => {
    const f = await seed()
    const adapter = envEcho()
    let spawns = 0
    const start = adapter.start.bind(adapter)
    adapter.start = async (input) => {
      spawns += 1
      return start(input)
    }
    // Another pass claims the delivery between this dispatch's row insert and its claim: the
    // wrapper takes the claim first, then lets the guarded updateMany run and find nothing.
    const original = prisma.goalDelivery.updateMany
    let raced = false
    prisma.goalDelivery.updateMany = (async (args: Parameters<typeof original>[0]) => {
      if (!raced) {
        raced = true
        await prisma.$executeRaw`UPDATE "GoalDelivery" SET "activeRunId" = 'someone-else' WHERE id = ${f.deliveryId}`
      }
      return original(args)
    }) as unknown as typeof original
    try {
      expect(await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)).toBeNull()
    } finally {
      prisma.goalDelivery.updateMany = original
    }

    expect(raced).toBe(true)
    expect(spawns).toBe(0)
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
    expect(delivery).toMatchObject({ status: 'integrating', round: 0, activeRunId: 'someone-else' })
  }, 60_000)

  it('retries the same round from verifying with no claim, and a spawn failure releases the claim, counts a run failure and removes the worktree', async (): Promise<void> => {
    const f = await seed()
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 2, roundRunFailures: 1 } })
    const failing = new ClaudeCodeAdapter({ command: '/nonexistent/claude-binary', extraArgs: [], hookPath: REAL_GATE })

    expect(await dispatchVerification(depsFor(f.workspaceId, failing), f.deliveryId)).toBeNull()

    const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'verification' } })
    expect(run.status).toBe('failed')
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
    expect(delivery).toMatchObject({ status: 'verifying', round: 2, activeRunId: null, roundRunFailures: 2 })
    expect(existsSync(join(worktreeRootFor(f.repoPath), verificationWorktreeKey(run.id)))).toBe(false)
    expect(await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_failed' } })).toBe(1)
  }, 60_000)
})

describe('removeVerificationWorktree', () => {
  it('refuses a path that is not a verify- directory under the worktree root', async (): Promise<void> => {
    const repo = makeRepo()
    await removeVerificationWorktree(repo, repo)
    await removeVerificationWorktree(repo, join(worktreeRootFor(repo), 'T-12345678'))
    await removeVerificationWorktree(repo, null)
    expect(existsSync(join(repo, 'README.md'))).toBe(true)
  })
})
