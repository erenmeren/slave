import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestResume } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { reconcileOrphans, resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

/** The instruction under test, distinctive enough that finding it in the child's argv proves it
 * travelled the whole way rather than matching something the adapter emits anyway. */
const MARKER = 'MARKER-42'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-resume-exec-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly slaveId: string
  readonly repoPath: string
}

async function seed(): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  // M12 Task 8: no slave in this file names a model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which needs a `ProviderConfiguration` row to
  // exist at all, or every dispatch here refuses instead of starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  return { workspaceId: workspace.id, taskId: task.id, slaveId: slave.id, repoPath }
}

/** An adapter over the fake CLI, one fixture per spawn behaviour. */
function fakeAdapter(fixture: string): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', fixture], hookPath: REAL_GATE })
}

/**
 * `deps.registry` for a test that only ever runs against one adapter instance (the ordinary case
 * pre-Task-8, when every run resolves to `'claude_code'` regardless of what `kind` is asked for).
 */
function singleAdapterRegistry(adapter: ClaudeCodeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

describe('executing a resume intent from the daemon', () => {
  let fixture: Fixture
  const repos: string[] = []

  /**
   * A genuinely paused run, produced the only honest way: a tick starts one, the real pause gate
   * denies its first tool call, and the pump records the pause and writes the `Checkpoint` row.
   * Seeding `paused` by hand would leave a checkpoint invented by this file rather than the one
   * `executeResume` actually has to spawn from -- the session id, the worktree and the git identity
   * would all be fictions, and the resume would be proving nothing about the real path.
   */
  async function pauseARun(): Promise<string> {
    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('hook-deny')),
    })
    await drainPumps()
    const run = await prisma.slaveRun.findFirstOrThrow()
    expect(run.status).toBe('paused')
    await prisma.checkpoint.findUniqueOrThrow({ where: { runId: run.id } })
    return run.id
  }

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    repos.push(fixture.repoPath)
  })

  afterEach(async (): Promise<void> => {
    // The pumps outlive the tick that started them by design, and a pump still writing while the
    // next test truncates is a cross-test failure that reads as a bug in whichever test runs second.
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  }, 30_000)

  it('a paused run with an intent resumes on tick, with the queued message injected', async (): Promise<void> => {
    const runId = await pauseARun()
    expect((await requestResume(runId, MARKER, 'web')).ok).toBe(true)

    // `env-echo` rather than `complete`: it echoes the child's own argv back through the adapter's
    // raw-payload seam, which is how `adapter-resume.test.ts` proves an injected message reached
    // the spawned process. Ground truth is the child, not this test's memory of what it asked for.
    const adapter = fakeAdapter('env-echo')
    await tick({ workspaceId: brandWorkspaceId(fixture.workspaceId), registry: singleAdapterRegistry(adapter) })
    await drainPumps()

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    // Exact, not a union: `env-echo` always succeeds (gate-fix B review round 1, Critical 1) --
    // a union of `['working', 'succeeded']` passed even while a regression stranded every resumed
    // run in `resuming` for its entire life, because the pump's terminal-outcome write overwrites
    // whatever status it finds regardless, and this assertion never looked at the state in between.
    expect(after.status).toBe('succeeded')
    // Consumed exactly once: the claim clears both columns, so a second tick finds nothing to do.
    expect(after.resumeRequestedAt).toBeNull()
    expect(after.queuedMessage).toBeNull()
    expect(after.pid).toBeGreaterThan(0)

    const resumed = await prisma.executionEvent.findFirst({ where: { runId, type: 'run_resumed' } })
    expect(resumed).not.toBeNull()
    // Still exactly one `run_started`: the pump is told this is a continuation, so it does not
    // announce the resumed process as a fresh spawn (Task 12's carry).
    expect(await prisma.executionEvent.count({ where: { runId, type: 'run_started' } })).toBe(1)

    const payload = adapter.rawTerminalPayload(brandRunId(runId))
    const argv = z.array(z.string()).parse(payload?.['argv'])
    const promptIndex = argv.indexOf('-p')
    expect(promptIndex).toBeGreaterThanOrEqual(0)
    expect(argv[promptIndex + 1]).toBe(MARKER)
  }, 60_000)

  it('rewrites permissions.json with a fresh resolved deny list on resume (M18 Task 5)', async (): Promise<void> => {
    const runId = await pauseARun()
    const checkpointBefore = await prisma.checkpoint.findUniqueOrThrow({ where: { runId } })
    // `runFilePaths`'s own contract: `permissions.json` sits beside `pause.flag` in the run's own
    // scratch directory -- the same derivation `executeResume` itself uses.
    const permissionsPath = join(dirname(checkpointBefore.pauseFlagPath), 'permissions.json')
    expect(JSON.parse(readFileSync(permissionsPath, 'utf8'))).toEqual({ version: 1, deny: [] })

    // The matrix edit happens BETWEEN pause and resume -- exactly the window the file must be
    // rewritten across, not merely written once at the original dispatch.
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, tool: 'run tests', mode: 'deny' } })

    expect((await requestResume(runId, MARKER, 'web')).ok).toBe(true)
    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('env-echo')),
    })
    await drainPumps()

    expect(JSON.parse(readFileSync(permissionsPath, 'utf8'))).toEqual({
      version: 1,
      deny: [{ tool: 'Bash', capability: 'run tests' }],
    })
  }, 60_000)

  it('leaves nothing to do on the tick after the one that claimed the intent', async (): Promise<void> => {
    const runId = await pauseARun()
    await requestResume(runId, MARKER, 'web')

    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('env-echo')),
    })
    await drainPumps()
    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('env-echo')),
    })
    await drainPumps()

    // One resume, not one per tick. A pass that claimed on the status alone would re-resume the
    // run every second for as long as the daemon ran.
    expect(await prisma.executionEvent.count({ where: { runId, type: 'run_resumed' } })).toBe(1)
  }, 60_000)

  it('does not pick up an intent in a halted workspace', async (): Promise<void> => {
    const runId = await pauseARun()
    await requestResume(runId, MARKER, 'web')
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open', haltedAt: new Date() },
    })

    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('env-echo')),
    })
    await drainPumps()

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    // A halt is raised by a gate failure; relaunching an slave whose gate may still be broken is
    // the recurrence the halt exists to bound.
    expect(after.status).toBe('paused')
    expect(after.resumeRequestedAt).not.toBeNull() // still visible, still waiting
    expect(after.queuedMessage).toBe(MARKER) // and the instruction is not consumed either
    expect(await prisma.executionEvent.count({ where: { runId, type: 'run_resumed' } })).toBe(0)
  }, 60_000)

  it('concludes a resumed run whose spawn rejects, instead of stranding it in resuming', async (): Promise<void> => {
    const runId = await pauseARun()
    expect((await requestResume(runId, MARKER, 'web')).ok).toBe(true)

    // Force `adapter.resume()` to reject: swap the real pause flag file for a directory at the
    // same path, tripping the exact EISDIR refusal `adapter-resume.test.ts` pins directly against
    // the adapter ("refuses to resume while the pause flag still exists"). This is the least
    // contrived seam available -- a real checkpoint, written by a real pause, whose spawn genuinely
    // fails -- rather than an invented throw.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId } })
    rmSync(checkpoint.pauseFlagPath, { force: true })
    mkdirSync(checkpoint.pauseFlagPath)

    const loggedErrors: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]): void => {
      loggedErrors.push(args)
    }
    try {
      await tick({ workspaceId: brandWorkspaceId(fixture.workspaceId), registry: singleAdapterRegistry(fakeAdapter('env-echo')) })
      await drainPumps()
    } finally {
      console.error = originalConsoleError
    }

    // Logged for the operator, not silent.
    expect(loggedErrors.length).toBeGreaterThan(0)

    // Concluded, not stranded: `resuming` with a dead pid would otherwise hold the task and make
    // the slave look busy until the daemon restarts.
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(after.status).toBe('failed')
    expect(after.terminalAt).not.toBeNull()

    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.activeRunId).toBeNull()

    expect(await prisma.executionEvent.count({ where: { runId, type: 'run_resumed' } })).toBe(0)
    const failedEvent = await prisma.executionEvent.findFirst({ where: { runId, type: 'run_failed' } })
    expect(failedEvent).not.toBeNull()
  }, 60_000)

  it('a paused run with an intent survives an orphan sweep untouched', async (): Promise<void> => {
    const runId = await pauseARun()
    await requestResume(runId, MARKER, 'web')

    // The orphan pass is startup-only and refuses to run once a tick has; this file's `pauseARun`
    // ticks, so the observation is reset to model the next process's startup rather than this one's.
    resetTickObservation()
    await reconcileOrphans({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      registry: singleAdapterRegistry(fakeAdapter('env-echo')),
    })

    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    // The whole point of intent-not-claim: had the web flipped this row to `resuming`, the sweep
    // would have found a non-terminal run with a dead pid and failed it -- checkpoint gone, task
    // released to a second slave -- for the crime of an operator clicking resume before a restart.
    expect(after.status).toBe('paused')
    expect(after.resumeRequestedAt).not.toBeNull()
    expect(after.terminalAt).toBeNull()
  }, 60_000)

  describe('a resume that fails to spawn', () => {
    /** An adapter whose configured command is not on disk, so `resume()` throws at spawn. */
    function brokenAdapter(): ClaudeCodeAdapter {
      return new ClaudeCodeAdapter({
        command: join(tmpdir(), 'slaveofai-no-such-binary-m13'),
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

      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
      expect(run.status).toBe('failed')

      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      // The whole point of Decision 4: no path re-dispatches a paid run without counting it.
      expect(task.attempt).toBe(1)
      expect(task.status).toBe('rework')
      expect(task.activeRunId).toBeNull()
      // The slave-facing channel is untouched -- an orchestrator-side failure is not feedback.
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

      const runsBefore = await prisma.slaveRun.count({ where: { taskId: fixture.taskId } })
      await tick({
        workspaceId: brandWorkspaceId(fixture.workspaceId),
        registry: singleAdapterRegistry(fakeAdapter('complete')),
      })
      await drainPumps()
      // A `failed` task is not startable: the next tick must not hand it to an slave again.
      expect(await prisma.slaveRun.count({ where: { taskId: fixture.taskId } })).toBe(runsBefore)
    }, 60_000)
  })
})
