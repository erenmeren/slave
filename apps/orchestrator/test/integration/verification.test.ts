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
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { integrationBranchName, runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, permissionsFilePathFor, verifyDirPathFor } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runGoalPass } from '../../src/goal.js'
import { ensureIntegrationBranch, ensureIntegrationWorktree, integrationWorktreePath } from '../../src/goalBranch.js'
import { STRANDED_CLAIM_GRACE_MS } from '../../src/sweep.js'
import { activePumpRunIds, drainPumps, type TickDeps } from '../../src/tick.js'
import {
  concludeVerification,
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
import { provisionDetachedWorktree, worktreeRootFor } from '../../src/worktree.js'

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
  /** `csv` (owns R1), then `json` (owns R2). */
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
async function seed(options: { readonly setupCommands?: readonly string[]; readonly verificationRoundCap?: number; readonly autoMerge?: boolean } = {}): Promise<Fixture> {
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
      autoMerge: options.autoMerge ?? false,
      ...(options.verificationRoundCap === undefined ? {} : { verificationRoundCap: options.verificationRoundCap }),
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

/** The fake's verification arm (Q7): every requirement passes unless `items` scripts the verdict. */
const verifier = (items?: readonly object[]): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter({
    command: 'node',
    extraArgs: [
      FAKE,
      '--fixture',
      'm8-flow',
      ...(items === undefined ? [] : ['--verification-json-base64', Buffer.from(JSON.stringify({ items })).toString('base64')]),
    ],
    hookPath: REAL_GATE,
  })

/**
 * Wraps an adapter so `inspect` runs at spawn time, with the run's worktree as the dispatch left
 * it: the conclusion (which follows the pump) removes it, so a test that reads the checkout reads
 * it here.
 */
function spying(adapter: ClaudeCodeAdapter, inspect: (input: { readonly runId: string; readonly worktreePath: string }) => Promise<void>): ClaudeCodeAdapter {
  const start = adapter.start.bind(adapter)
  adapter.start = async (input) => {
    await inspect({ runId: input.runId, worktreePath: input.worktreePath })
    return start(input)
  }
  return adapter
}

/** A detached checkout of the integration branch with `setupCommands` run in it, as dispatch makes
 *  one, and its baseline -- for the baseline tests, which mutate the checkout by hand. */
async function detachedCheckout(f: Fixture, setupCommands: readonly string[]): Promise<{ readonly path: string; readonly stored: VerificationBaseline }> {
  const worktree = await provisionDetachedWorktree({ repoPath: f.repoPath, ref: f.branch, key: `verify-${randomKey()}`, setupCommands })
  return { path: worktree.path, stored: await worktreeBaseline(worktree.path) }
}

const randomKey = (): string => Math.random().toString(16).slice(2, 10)

interface Verdict {
  readonly allow: readonly { readonly tool: string }[]
  readonly ownership?: unknown
}

afterAll(async (): Promise<void> => {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
  await prisma.$disconnect()
}, 30_000)

describe('dispatchVerification', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "RunContext", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('starts a task-less verification run by the recorded verifier and claims the delivery for round 1', async (): Promise<void> => {
    const f = await seed()
    let atSpawn: unknown = null
    const adapter = spying(verifier(), async () => {
      atSpawn = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
    })

    const runId = await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)
    expect(runId).not.toBeNull()
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    expect(run).toMatchObject({ kind: 'verification', taskId: null, goalDeliveryId: f.deliveryId, slaveId: f.verifierId, status: 'succeeded' })
    expect(atSpawn).toMatchObject({ status: 'verifying', round: 1, activeRunId: run.id, roundRunFailures: 0 })

    const started = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_verification_started' } })
    expect(started.map((event) => event.payload)).toEqual([{ version: 1, round: 1, runId: run.id }])
    // Task 6: the pump's conclusion judged it -- every requirement passed, so the claim is gone.
    expect(await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })).toMatchObject({ status: 'accepted', activeRunId: null })
    // A replay of the conclusion changes nothing.
    await expect(verifyConcludedRun(brandRunId(run.id))).resolves.toBeUndefined()
  }, 60_000)

  it('checks out the integration tip detached in verify-<run8>, and records the tip and the post-setup baseline', async (): Promise<void> => {
    // Setup dirties a tracked file: the baseline must be recorded AFTER it (ruling Q5).
    const f = await seed({ setupCommands: ['echo from-setup >> a.txt'] })
    const tip = git(['rev-parse', f.branch], f.repoPath)
    const seen: { head?: string; detached?: boolean; baseline?: VerificationBaseline; row?: unknown } = {}
    const adapter = spying(verifier(), async ({ runId, worktreePath }) => {
      seen.head = git(['rev-parse', 'HEAD'], worktreePath)
      seen.detached = (() => {
        try {
          git(['symbolic-ref', '-q', 'HEAD'], worktreePath)
          return false
        } catch {
          return true
        }
      })()
      seen.baseline = await worktreeBaseline(worktreePath)
      seen.row = (await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).verificationBaseline
    })
    const runId = await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    const path = run.worktreePath ?? ''
    expect(dirname(path)).toBe(worktreeRootFor(f.repoPath))
    expect(basename(path)).toBe(verificationWorktreeKey(run.id))
    expect(basename(path)).toBe(`verify-${run.id.slice(0, 8)}`)
    expect(seen.head).toBe(tip)
    expect(seen.detached).toBe(true)

    expect(run.verificationTip).toBe(tip)
    expect(seen.row).toEqual(seen.baseline)
    expect(run.verificationBaseline).toMatchObject({ head: tip, status: ' M a.txt\n' })
    // Task 6: the conclusion removed the checkout.
    expect(existsSync(path)).toBe(false)
  }, 60_000)

  it('writes an owns-nothing permissions file and a 0700 scratch directory the child sees as SLAVEOFAI_VERIFY_DIR', async (): Promise<void> => {
    const f = await seed()
    let realWorktree = ''
    const adapter = spying(envEcho(), async ({ worktreePath }) => {
      realWorktree = realpathSync(worktreePath)
    })
    const runId = await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)
    await drainPumps()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId ?? '' } })
    const runDir = runDirPathFor(brandRunId(run.id))
    const verdict = JSON.parse(readFileSync(permissionsFilePathFor(runDir), 'utf8')) as Verdict
    expect(verdict.ownership).toEqual({ worktreeRoot: realWorktree, owned: [], excluded: [] })
    expect(verdict.allow.map((entry) => entry.tool)).toContain('Write')

    const verifyDir = verifyDirPathFor(runDir)
    expect(existsSync(verifyDir)).toBe(true)
    expect(statSync(verifyDir).mode & 0o777).toBe(0o700)
    const env = z.record(z.string(), z.string()).parse(adapter.rawTerminalPayload(brandRunId(run.id))?.['env'])
    expect(env['SLAVEOFAI_VERIFY_DIR']).toBe(verifyDir)
  }, 60_000)

  it('records a verification run context: profile, the goal and the protocol, nothing else', async (): Promise<void> => {
    const f = await seed()
    let injected: boolean | null = null
    const adapter = spying(verifier(), async ({ worktreePath }) => {
      injected = existsSync(join(worktreePath, '.claude'))
    })
    const runId = await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)
    await drainPumps()

    const context = await prisma.runContext.findUniqueOrThrow({ where: { runId: runId ?? '' } })
    const manifest = context.sections as unknown as { readonly kind: string; readonly sections: readonly { readonly kind: string }[] }
    expect(manifest.kind).toBe('verification')
    expect(manifest.sections.map((section) => section.kind)).toEqual(['profile', 'verification_goal', 'verification_protocol'])
    expect(manifest.sections[1]).toMatchObject({ kind: 'verification_goal', goalVersion: 1, round: 1, requirements: 2 })
    expect(context.prompt).toContain('Requirement keys: R1, R2')
    expect(context.prompt).toContain('a.txt')
    // D4: nothing was injected into the checkout being verified.
    expect(injected).toBe(false)
  }, 60_000)

  it('never lets an implementer of the version verify it: the recorded seat is re-staffed', async (): Promise<void> => {
    const f = await seed()
    const firstTask = f.taskIds[0] ?? ''
    await prisma.slaveRun.create({ data: { taskId: firstTask, slaveId: f.verifierId, status: 'succeeded', terminalAt: new Date() } })

    const runId = await dispatchVerification(depsFor(f.workspaceId, verifier()), f.deliveryId)
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
    const deps = depsFor(f.workspaceId, verifier())
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
    const f = await seed()
    const { path, stored } = await detachedCheckout(f, ["printf 'node_modules/\\n' > .gitignore && mkdir -p gen && echo from-setup > gen/setup.txt"])

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
    const f = await seed()
    const { path, stored } = await detachedCheckout(f, ['mkdir -p build && echo built > build/out.txt && git add -f build/out.txt && git commit -q -m build'])

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
    // Another pass claims the delivery after this dispatch read it and before its claim (taken
    // under the delivery's lock, Q1): the wrapper hands back the unclaimed row, then claims it.
    const original = prisma.goalDelivery.findUniqueOrThrow
    let raced = false
    prisma.goalDelivery.findUniqueOrThrow = (async (args: Parameters<typeof original>[0]) => {
      const row = await original(args)
      if (!raced) {
        raced = true
        await prisma.$executeRaw`UPDATE "GoalDelivery" SET "activeRunId" = 'someone-else' WHERE id = ${f.deliveryId}`
      }
      return row
    }) as unknown as typeof original
    try {
      expect(await dispatchVerification(depsFor(f.workspaceId, adapter), f.deliveryId)).toBeNull()
    } finally {
      prisma.goalDelivery.findUniqueOrThrow = original
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

interface Item {
  readonly key: string
  readonly status: 'pass' | 'fail' | 'unverifiable'
  readonly check: string
  readonly output: string
  readonly reason: string
}
const passes = (key: string): Item => ({ key, status: 'pass', check: `pytest -k ${key}`, output: '1 passed', reason: '' })
const fails = (key: string): Item => ({ key, status: 'fail', check: `pytest -k ${key}`, output: 'AssertionError: printed CSV', reason: 'the flag is ignored' })
const unverifiable = (key: string): Item => ({ key, status: 'unverifiable', check: '', output: '', reason: 'needs a real browser' })
const verdictText = (items: readonly Item[]): string => `All checked.\n<slave-verification>${JSON.stringify({ items })}</slave-verification>`

/**
 * A verification run of the fixture's delivery, claimed and checked out exactly as
 * `dispatchVerification` leaves it (row, detached worktree, tip, baseline, claim -- a new round
 * from `integrating`, the same round from `verifying`), concluded `succeeded` without a process:
 * the test writes its output with {@link say} and calls `concludeVerification`.
 */
async function claimRound(f: Fixture): Promise<{ readonly runId: string; readonly worktreePath: string }> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
  const run = await prisma.slaveRun.create({
    data: { slaveId: f.verifierId, kind: 'verification', status: 'succeeded', terminalAt: new Date(), goalDeliveryId: f.deliveryId },
  })
  const worktree = await provisionDetachedWorktree({ repoPath: f.repoPath, ref: f.branch, key: verificationWorktreeKey(run.id), setupCommands: [] })
  await prisma.slaveRun.update({
    where: { id: run.id },
    data: { worktreePath: worktree.path, verificationTip: worktree.refCommit, verificationBaseline: (await worktreeBaseline(worktree.path)) as never },
  })
  await prisma.goalDelivery.update({
    where: { id: f.deliveryId },
    data: delivery.status === 'integrating' ? { status: 'verifying', round: delivery.round + 1, roundRunFailures: 0, activeRunId: run.id } : { activeRunId: run.id },
  })
  return { runId: run.id, worktreePath: worktree.path }
}

async function say(f: Fixture, runId: string, text: string): Promise<void> {
  await appendEvent({ type: 'run.output', workspaceId: f.workspaceId, slaveId: f.verifierId, runId, actor: 'slave', payload: { text } })
}

/** One round, start to verdict: claimed, said, concluded. */
async function round(f: Fixture, text: string): Promise<{ readonly runId: string; readonly worktreePath: string }> {
  const claimed = await claimRound(f)
  await say(f, claimed.runId, text)
  await concludeVerification(brandRunId(claimed.runId))
  return claimed
}

const deliveryOf = async (f: Fixture) => prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })

async function eventsOfType(f: Fixture, types: readonly string[]): Promise<readonly { readonly type: string; readonly taskId: string | null; readonly payload: unknown }[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: { in: types as never } }, orderBy: { seq: 'asc' } })
  return rows.map((row) => ({ type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type, taskId: row.taskId, payload: row.payload }))
}

/** A reworked package done again and back on its integration branch, as the merge pass leaves it. */
async function reintegrate(taskId: string): Promise<void> {
  await prisma.task.update({ where: { id: taskId }, data: { status: 'done', integratedAt: new Date() } })
}

describe('the gate (concludeVerification)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "RunContext", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('accepts a version every requirement of which passes, records the evidence, and the next pass merges the verified tip', async (): Promise<void> => {
    const f = await seed({ autoMerge: true })
    const tip = git(['rev-parse', f.branch], f.repoPath)

    const { runId, worktreePath } = await round(f, verdictText([passes('R1'), passes('R2')]))

    const rows = await prisma.verificationResult.findMany({ where: { runId }, orderBy: { key: 'asc' } })
    expect(rows.map((row) => [row.key, row.status, row.round, row.check, row.output])).toEqual([
      ['R1', 'pass', 1, 'pytest -k R1', '1 passed'],
      ['R2', 'pass', 1, 'pytest -k R2', '1 passed'],
    ])
    expect(await deliveryOf(f)).toMatchObject({ status: 'accepted', activeRunId: null, verifiedCommit: tip, round: 1 })
    expect((await deliveryOf(f)).acceptedAt).not.toBeNull()
    expect(await eventsOfType(f, ['workspace_verified', 'workspace_goal_accepted'])).toEqual([
      { type: 'workspace.verified', taskId: null, payload: { version: 1, round: 1, runId, pass: 2, fail: 0, unverifiable: 0, failedKeys: [] } },
      { type: 'workspace.goal_accepted', taskId: null, payload: { version: 1, rounds: 1 } },
    ])
    expect(existsSync(worktreePath)).toBe(false)

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })

    expect((await deliveryOf(f)).mergedAt).not.toBeNull()
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(tip)
  }, 60_000)

  it('sends a failing requirement back to its own package, charging no attempt, and leaves the rest done', async (): Promise<void> => {
    const f = await seed()
    const [csv, json] = [f.taskIds[0] ?? '', f.taskIds[1] ?? '']
    await prisma.task.update({ where: { id: json }, data: { attempt: 2 } })

    const { runId, worktreePath } = await round(f, verdictText([passes('R1'), fails('R2')]))

    const reworked = await prisma.task.findUniqueOrThrow({ where: { id: json } })
    expect(reworked).toMatchObject({ status: 'rework', integratedAt: null, attempt: 2, activeRunId: null })
    expect(reworked.lastRejectionReason?.startsWith('Verification round 1')).toBe(true)
    expect(reworked.lastRejectionReason).toContain('pytest -k R2')
    expect(reworked.lastRejectionReason).toContain('AssertionError: printed CSV')
    expect(reworked.lastRejectionReason).toContain('the flag is ignored')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: csv } })).status).toBe('done')
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1, activeRunId: null, verifiedCommit: null })

    const events = await eventsOfType(f, ['workspace_verified', 'task_rework', 'workspace_goal_accepted', 'workspace_goal_needs_human'])
    expect(events).toEqual([
      { type: 'workspace.verified', taskId: null, payload: { version: 1, round: 1, runId, pass: 1, fail: 1, unverifiable: 0, failedKeys: ['R2'] } },
      { type: 'task.rework', taskId: json, payload: { reason: reworked.lastRejectionReason, attempt: 2, verificationRound: 1 } },
    ])
    expect(existsSync(worktreePath)).toBe(false)
  }, 60_000)

  it('loops: once the reworked package is integrated again, the pass starts round 2, and an all-pass round 2 is accepted', async (): Promise<void> => {
    const f = await seed()
    const json = f.taskIds[1] ?? ''
    await round(f, verdictText([passes('R1'), fails('R2')]))
    const deps = depsFor(f.workspaceId, verifier())

    // Not before the package is back on the branch.
    await runGoalPass(deps, { mayStartRuns: true })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)

    await reintegrate(json)
    await runGoalPass(deps, { mayStartRuns: true })
    await drainPumps()

    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(2)
    expect(await deliveryOf(f)).toMatchObject({ status: 'accepted', round: 2, activeRunId: null })
    expect((await eventsOfType(f, ['workspace_goal_accepted'])).map((event) => event.payload)).toEqual([{ version: 1, rounds: 2 }])
    expect(await prisma.verificationResult.count({ where: { goalDeliveryId: f.deliveryId, round: 2, status: 'pass' } })).toBe(2)
  }, 60_000)

  it('starts nothing while the scheduler has no room (mayStartRuns false)', async (): Promise<void> => {
    const f = await seed()

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: false })

    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 0 })
  }, 60_000)

  it('ends in needs_human at the round cap, naming the cap and what still fails, and dispatches nothing more', async (): Promise<void> => {
    const f = await seed({ verificationRoundCap: 2 })
    const json = f.taskIds[1] ?? ''
    await round(f, verdictText([passes('R1'), fails('R2')]))
    expect((await deliveryOf(f)).status).toBe('integrating')
    await reintegrate(json)

    await round(f, verdictText([passes('R1'), fails('R2')]))

    const delivery = await deliveryOf(f)
    expect(delivery).toMatchObject({ status: 'needs_human', round: 2, activeRunId: null })
    expect(delivery.needsHumanReason).toContain('round cap (2)')
    expect(delivery.needsHumanReason).toContain('R2')
    expect(delivery.needsHumanReason).toContain(`retry-goal --workspace ${f.workspaceId} --version 1`)
    expect(delivery.needsHumanReason).toContain(`abandon-goal --workspace ${f.workspaceId} --version 1`)
    expect(delivery.needsHumanReason).not.toContain('by hand')
    // The task is not reworked a second time: the loop is over.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: json } })).status).toBe('done')
    expect((await eventsOfType(f, ['workspace_goal_needs_human'])).map((event) => event.payload)).toEqual([
      { version: 1, reason: delivery.needsHumanReason },
    ])

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(2)
    expect((await deliveryOf(f)).status).toBe('needs_human')
  }, 60_000)

  it('ends in needs_human at once when a requirement is only unverifiable, naming it and why', async (): Promise<void> => {
    const f = await seed()

    await round(f, verdictText([passes('R1'), unverifiable('R2')]))

    const delivery = await deliveryOf(f)
    expect(delivery).toMatchObject({ status: 'needs_human', round: 1 })
    expect(delivery.needsHumanReason).toContain('R2 (needs a real browser)')
    expect(await prisma.verificationResult.count({ where: { goalDeliveryId: f.deliveryId, status: 'unverifiable' } })).toBe(1)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskIds[1] ?? '' } })).status).toBe('done')
  }, 60_000)

  it('reworks the failing package when a round has both a failure and an unverifiable item', async (): Promise<void> => {
    const f = await seed()

    const { runId } = await round(f, verdictText([unverifiable('R1'), fails('R2')]))

    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1 })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskIds[1] ?? '' } })).status).toBe('rework')
    expect((await eventsOfType(f, ['workspace_verified'])).map((event) => event.payload)).toEqual([
      { version: 1, round: 1, runId, pass: 0, fail: 1, unverifiable: 1, failedKeys: ['R2'] },
    ])
  }, 60_000)

  it('ends in needs_human, never looping, when a failing requirement belongs to a cancelled package', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    await prisma.task.update({ where: { id: f.taskIds[1] ?? '' }, data: { status: 'cancelled' } })
    await say(f, claimed.runId, verdictText([passes('R1'), fails('R2')]))

    await concludeVerification(brandRunId(claimed.runId))

    const delivery = await deliveryOf(f)
    expect(delivery.status).toBe('needs_human')
    expect(delivery.needsHumanReason).toContain('cannot be reworked: R2')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskIds[1] ?? '' } })).status).toBe('cancelled')
  }, 60_000)

  for (const variant of [
    { label: 'no block', text: 'I checked everything and it all works.', reason: 'has no' },
    { label: 'a block cut off mid-JSON', text: '<slave-verification>{"items": [{"key": "R1", "status": "pa', reason: 'not closed' },
    { label: 'a block missing a key', text: verdictText([passes('R1')]), reason: 'R2' },
  ]) {
    it(`fails a run with ${variant.label}, releases the claim and counts one run failure, the round unchanged`, async (): Promise<void> => {
      const f = await seed()

      const { runId, worktreePath } = await round(f, variant.text)

      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('failed')
      const failed = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
      expect(failed).toHaveLength(1)
      expect((failed[0]?.payload as { reason: string }).reason).toMatch(/^verification: /)
      expect((failed[0]?.payload as { reason: string }).reason).toContain(variant.reason)
      expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, activeRunId: null, roundRunFailures: 1 })
      expect(await prisma.verificationResult.count()).toBe(0)
      expect(await eventsOfType(f, ['workspace_verified'])).toEqual([])
      expect(existsSync(worktreePath)).toBe(false)
    }, 60_000)
  }

  it('ends in needs_human after three unusable verifications in one round', async (): Promise<void> => {
    const f = await seed()
    for (let i = 0; i < 3; i += 1) await round(f, 'no verdict here')
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, roundRunFailures: 3 })

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()

    const delivery = await deliveryOf(f)
    expect(delivery.status).toBe('needs_human')
    expect(delivery.needsHumanReason).toContain('the verifier could not produce a usable verification 3 times in round 1')
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(3)
    expect(await eventsOfType(f, ['workspace_goal_needs_human'])).toHaveLength(1)
  }, 60_000)

  it('throws away a verification whose verifier changed a tracked file, naming it', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    writeFileSync(join(claimed.worktreePath, 'README.md'), '# fixed by the verifier\n')
    await say(f, claimed.runId, verdictText([passes('R1'), passes('R2')]))

    await concludeVerification(brandRunId(claimed.runId))

    const failed = await prisma.executionEvent.findFirstOrThrow({ where: { runId: claimed.runId, type: 'run_failed' } })
    expect((failed.payload as { reason: string }).reason).toContain('README.md')
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', activeRunId: null, roundRunFailures: 1 })
    expect(await prisma.verificationResult.count()).toBe(0)
    expect(existsSync(claimed.worktreePath)).toBe(false)
  }, 60_000)

  it('throws away a verification whose verifier committed in its checkout (HEAD moved)', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    writeFileSync(join(claimed.worktreePath, 'a.txt'), 'the verifier fixed it\n')
    git(['-c', 'user.name=V', '-c', 'user.email=v@example.com', 'commit', '-qam', 'fix'], claimed.worktreePath)
    await say(f, claimed.runId, verdictText([passes('R1'), passes('R2')]))

    await concludeVerification(brandRunId(claimed.runId))

    const failed = await prisma.executionEvent.findFirstOrThrow({ where: { runId: claimed.runId, type: 'run_failed' } })
    expect((failed.payload as { reason: string }).reason).toContain('HEAD')
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', roundRunFailures: 1 })
  }, 60_000)

  it('throws away a verification whose verifier wrote a new source file in its checkout, naming it', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    mkdirSync(join(claimed.worktreePath, 'src'), { recursive: true })
    writeFileSync(join(claimed.worktreePath, 'src', 'csv.py'), 'FEATURE = True\n')
    await say(f, claimed.runId, verdictText([passes('R1'), passes('R2')]))

    await concludeVerification(brandRunId(claimed.runId))

    const failed = await prisma.executionEvent.findFirstOrThrow({ where: { runId: claimed.runId, type: 'run_failed' } })
    expect((failed.payload as { reason: string }).reason).toContain('src/csv.py')
    expect((await deliveryOf(f)).status).toBe('verifying')
  }, 60_000)

  it('keeps a verification whose checks only left test artifacts behind', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    mkdirSync(join(claimed.worktreePath, '__pycache__'), { recursive: true })
    writeFileSync(join(claimed.worktreePath, '__pycache__', 'a.pyc'), 'bytecode')
    await say(f, claimed.runId, verdictText([passes('R1'), passes('R2')]))

    await concludeVerification(brandRunId(claimed.runId))

    expect((await deliveryOf(f)).status).toBe('accepted')
  }, 60_000)

  it('is replay-safe: concluded twice, one set of rows, one verified event, one rework', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    await say(f, claimed.runId, verdictText([passes('R1'), fails('R2')]))

    await concludeVerification(brandRunId(claimed.runId))
    await concludeVerification(brandRunId(claimed.runId))

    expect(await prisma.verificationResult.count()).toBe(2)
    expect(await eventsOfType(f, ['workspace_verified'])).toHaveLength(1)
    expect(await eventsOfType(f, ['task_rework'])).toHaveLength(1)
  }, 60_000)

  it('does not accept a verdict on a tip the integration branch has since moved past: the next pass verifies the new tip', async (): Promise<void> => {
    const f = await seed()
    const claimed = await claimRound(f)
    const integrationPath = integrationWorktreePath(f.repoPath, 1, f.workspaceId)
    writeFileSync(join(integrationPath, 'late.txt'), 'late\n')
    git(['add', '-A'], integrationPath)
    git(['commit', '-q', '-m', 'late change'], integrationPath)
    await say(f, claimed.runId, verdictText([passes('R1'), passes('R2')]))

    await concludeVerification(brandRunId(claimed.runId))

    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', activeRunId: null, verifiedCommit: null })
    expect(await eventsOfType(f, ['workspace_goal_accepted'])).toEqual([])
    expect(existsSync(claimed.worktreePath)).toBe(false)
  }, 60_000)

  it('goes through verify.ts: a succeeded verification run is concluded, a failed one releases its claim', async (): Promise<void> => {
    const f = await seed()
    const first = await claimRound(f)
    await say(f, first.runId, 'nothing')
    await prisma.slaveRun.update({ where: { id: first.runId }, data: { status: 'failed' } })

    await verifyConcludedRun(brandRunId(first.runId))

    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', activeRunId: null, roundRunFailures: 1 })
    expect(existsSync(first.worktreePath)).toBe(false)

    const second = await claimRound(f)
    await say(f, second.runId, verdictText([passes('R1'), passes('R2')]))
    await verifyConcludedRun(brandRunId(second.runId))

    expect((await deliveryOf(f)).status).toBe('accepted')
  }, 60_000)
})

describe('stranded verification claims', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "RunContext", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  const longAgo = (): Date => new Date(Date.now() - STRANDED_CLAIM_GRACE_MS - 5_000)

  it('releases a claim whose run already failed (a daemon died mid-verification) and dispatches the round again', async (): Promise<void> => {
    const f = await seed()
    const stranded = await claimRound(f)
    // The orphan pass failed the run (taskId null: nothing released); nothing concluded the claim.
    await prisma.slaveRun.update({ where: { id: stranded.runId }, data: { status: 'failed', terminalAt: longAgo() } })

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })

    // Released (one run failure), the worktree removed, and the same round dispatched again.
    expect(existsSync(stranded.worktreePath)).toBe(false)
    const runs = await prisma.slaveRun.findMany({ where: { kind: 'verification' }, orderBy: { startedAt: 'asc' } })
    expect(runs).toHaveLength(2)
    const delivery = await deliveryOf(f)
    expect(delivery).toMatchObject({ round: 1, roundRunFailures: 1, activeRunId: runs[1]?.id })
    await drainPumps()
    expect((await deliveryOf(f)).status).toBe('accepted')
  }, 60_000)

  it('leaves a claim alone inside the grace, and while this process still pumps the run', async (): Promise<void> => {
    const f = await seed()
    const fresh = await claimRound(f)
    await prisma.slaveRun.update({ where: { id: fresh.runId }, data: { status: 'failed', terminalAt: new Date() } })

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    expect(await deliveryOf(f)).toMatchObject({ activeRunId: fresh.runId, roundRunFailures: 0 })

    await prisma.slaveRun.update({ where: { id: fresh.runId }, data: { terminalAt: longAgo() } })
    activePumpRunIds.add(fresh.runId)
    try {
      await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    } finally {
      activePumpRunIds.delete(fresh.runId)
    }
    expect(await deliveryOf(f)).toMatchObject({ activeRunId: fresh.runId, roundRunFailures: 0 })
    expect(existsSync(fresh.worktreePath)).toBe(true)
  }, 60_000)

  it('concludes a succeeded run nobody concluded', async (): Promise<void> => {
    const f = await seed()
    const stranded = await claimRound(f)
    await say(f, stranded.runId, verdictText([passes('R1'), passes('R2')]))
    await prisma.slaveRun.update({ where: { id: stranded.runId }, data: { terminalAt: longAgo() } })

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })

    expect(await deliveryOf(f)).toMatchObject({ status: 'accepted', activeRunId: null })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)
  }, 60_000)

  it('releases a claim naming a run that does not exist', async (): Promise<void> => {
    const f = await seed()
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeRunId: 'gone-run' } })

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: false })

    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', activeRunId: null, roundRunFailures: 1 })
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
