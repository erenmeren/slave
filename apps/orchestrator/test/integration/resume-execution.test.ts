import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestResume } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { runId as brandRunId, workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import { ClaudeCodeAdapter } from '@ai-team-os/providers'
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
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-resume-exec-'))
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
  readonly agentId: string
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
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
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
  return { workspaceId: workspace.id, taskId: task.id, agentId: agent.id, repoPath }
}

/** An adapter over the fake CLI, one fixture per spawn behaviour. */
function fakeAdapter(fixture: string): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', fixture] })
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
      adapter: fakeAdapter('hook-deny'),
      hookPath: REAL_GATE,
    })
    await drainPumps()
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('paused')
    await prisma.checkpoint.findUniqueOrThrow({ where: { runId: run.id } })
    return run.id
  }

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
    await tick({ workspaceId: brandWorkspaceId(fixture.workspaceId), adapter, hookPath: REAL_GATE })
    await drainPumps()

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(['working', 'succeeded']).toContain(after.status)
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

  it('leaves nothing to do on the tick after the one that claimed the intent', async (): Promise<void> => {
    const runId = await pauseARun()
    await requestResume(runId, MARKER, 'web')

    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      adapter: fakeAdapter('env-echo'),
      hookPath: REAL_GATE,
    })
    await drainPumps()
    await tick({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      adapter: fakeAdapter('env-echo'),
      hookPath: REAL_GATE,
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
      adapter: fakeAdapter('env-echo'),
      hookPath: REAL_GATE,
    })
    await drainPumps()

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    // A halt is raised by a gate failure; relaunching an agent whose gate may still be broken is
    // the recurrence the halt exists to bound.
    expect(after.status).toBe('paused')
    expect(after.resumeRequestedAt).not.toBeNull() // still visible, still waiting
    expect(after.queuedMessage).toBe(MARKER) // and the instruction is not consumed either
    expect(await prisma.executionEvent.count({ where: { runId, type: 'run_resumed' } })).toBe(0)
  }, 60_000)

  it('a paused run with an intent survives an orphan sweep untouched', async (): Promise<void> => {
    const runId = await pauseARun()
    await requestResume(runId, MARKER, 'web')

    // The orphan pass is startup-only and refuses to run once a tick has; this file's `pauseARun`
    // ticks, so the observation is reset to model the next process's startup rather than this one's.
    resetTickObservation()
    await reconcileOrphans({
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      adapter: fakeAdapter('env-echo'),
    })

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    // The whole point of intent-not-claim: had the web flipped this row to `resuming`, the sweep
    // would have found a non-terminal run with a dead pid and failed it -- checkpoint gone, task
    // released to a second agent -- for the crime of an operator clicking resume before a restart.
    expect(after.status).toBe('paused')
    expect(after.resumeRequestedAt).not.toBeNull()
    expect(after.terminalAt).toBeNull()
  }, 60_000)
})
