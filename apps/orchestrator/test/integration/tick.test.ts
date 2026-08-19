import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import { ClaudeCodeAdapter } from '@ai-team-os/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, because `provisionWorktree` uses real git and this is the seam under test. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-tick-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly agentId: string
  readonly repoPath: string
}

async function seed(options: { readonly setupCommands?: readonly string[] } = {}): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [...(options.setupCommands ?? [])],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({
    data: { teamId: team.id, name: 'Alex', role: 'backend' },
  })
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

async function eventTypesFor(workspaceId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

const keyOf = (taskId: string): string => `T-${taskId.slice(0, 8)}`

describe('tick', () => {
  let fixture: Fixture
  let deps: TickDeps
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
    repos.push(fixture.repoPath)
    deps = {
      workspaceId: brandWorkspaceId(fixture.workspaceId),
      adapter: new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] }),
      hookPath: REAL_GATE,
    }
  })

  afterEach(async (): Promise<void> => {
    // The pumps outlive the tick by design, and a pump still writing while the next test truncates
    // is a cross-test failure that reads as a bug in whichever test runs second.
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('starts a run for a ready task and records its pid and worktree', async (): Promise<void> => {
    const report = await tick(deps)

    expect(report.started).toHaveLength(1)
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.pid).toBeGreaterThan(0)
    expect(run.worktreePath).toContain(join('.aiteamos', 'worktrees'))
  })

  it('writes the run its worktree and remembers the branch on the task', async (): Promise<void> => {
    await tick(deps)

    const run = await prisma.agentRun.findFirstOrThrow()
    const task = await prisma.task.findFirstOrThrow()

    // The key is derived from the task id rather than its title: a title is mutable and the key
    // has to be reproducible on the task's second run, or the rework case can never match its own
    // previous worktree.
    expect(run.worktreePath).toContain(keyOf(task.id))
    expect(task.branch).toBe(`aiteamos/${keyOf(task.id)}-add-the-thing`)
  })

  it('keeps the settings file and the pause flag out of the worktree', async (): Promise<void> => {
    await tick(deps)

    const run = await prisma.agentRun.findFirstOrThrow()
    const worktreePath = run.worktreePath ?? ''

    // Task 14 runs verify inside the worktree, and Task 11 already flagged `.aiteamos/` as
    // untracked content in the operator's own repository. A settings file or a flag written into
    // the worktree makes every verify run see a dirty tree it did not create.
    const inWorktree = readdirSync(worktreePath)
    expect(inWorktree).not.toContain('settings.json')
    expect(inWorktree).not.toContain('pause.flag')
    expect(git(['status', '--porcelain'], worktreePath)).toBe('')
  })

  it('emits guardrail.tripped and starts nothing when decide halts', async (): Promise<void> => {
    // Spend past the workspace's budget on a run that already concluded: money is spent whether or
    // not the run is still going, which is why `loadWorld` sums every run regardless of status.
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        costUsd: 999,
        terminalAt: new Date(),
      },
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    expect(report.halted).not.toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toContain('guardrail.tripped')
  })

  it('does not repeat guardrail.tripped on a second tick while still halted', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        costUsd: 999,
        terminalAt: new Date(),
      },
    })

    await tick(deps)
    const afterFirst = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length
    await tick(deps)
    const afterSecond = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length

    // `decide()` returns `halt` on every tick the condition holds, but the *news* is the
    // transition. At the default 1000ms period a halt waiting for an operator would otherwise
    // write one event per second, forever, into an append-only log.
    expect(afterSecond).toBe(afterFirst)
  })

  it('records a provisioning failure as a failed run that counts as an attempt', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['exit 3'] },
    })

    await tick(deps)

    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(1)
    expect(await eventTypesFor(fixture.workspaceId)).toContain('run.failed')
  })

  it('starts no second run on the next tick after a gate failure halted the workspace', async (): Promise<void> => {
    // The halt Task 12's pump writes on a gate failure is the same `Workspace.haltedReason` column
    // `decide()` reads as `stats.emergencyStopped` -- this is the tick's side of proving a halted
    // workspace stays uncontrollable-run-free.
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'gate failure', haltedAt: new Date() },
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
  })

  it('gives a reworked task a second run instead of burning its attempts on provisioning', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()

    // The first run's worktree and branch are still on disk -- §7.4 preserves them on purpose --
    // and `decide()` lists `rework` in STARTABLE, so the second run arrives at provisioning with
    // the same key. Treating that as a provisioning failure counts an attempt without a run, and
    // the task reaches its cap without a second agent ever starting.
    await prisma.agentRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, lastRejectionReason: 'verify failed: npm test' },
    })

    const report = await tick(deps)

    expect(report.started).toHaveLength(1)
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(1) // the failed verify's attempt, not a second one for provisioning
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).not.toBe('failed')
  })

  it('adopts the reworked worktree even when the task has been renamed since', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()
    const branchAfterFirst = (await prisma.task.findFirstOrThrow()).branch

    await prisma.agentRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, title: 'Completely different title now' },
    })

    const report = await tick(deps)

    // Re-deriving the slug from the title would compute a *different* branch, so the existing
    // worktree would report `directory` rather than `both` and an ordinary rework would escalate.
    // The branch is read back from the task, which is why it is persisted at all.
    expect(report.started).toHaveLength(1)
    expect((await prisma.task.findFirstOrThrow()).branch).toBe(branchAfterFirst)
  })

  it("escalates leftovers that are not this task's own previous attempt", async (): Promise<void> => {
    // A `ready` task -- never provisioned -- with a directory sitting at its worktree path. That
    // is wreckage §7.4 preserved for an operator, not a rework, and handing it to an agent would
    // give the run someone else's tree.
    mkdirSync(join(fixture.repoPath, '.aiteamos', 'worktrees', keyOf(fixture.taskId)), {
      recursive: true,
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(1)
    expect(await eventTypesFor(fixture.workspaceId)).toContain('run.failed')
  })

  it('refuses to adopt a valid worktree for a task that is not reworking', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()

    // A genuine, registered worktree on the right branch -- everything `adoptWorktree` verifies --
    // but the task is `ready`, not `rework`. Only a rework means "my own previous attempt left
    // this"; a ready task with a worktree is state nobody can account for, and §7.4 preserved it
    // for an operator to look at rather than for the next agent to inherit.
    //
    // The bare-directory case above cannot pin this: `adoptWorktree` rejects an unregistered path
    // on its own, so dropping the rework guard still fails there. This is the shape where adopting
    // would otherwise succeed.
    await prisma.agentRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'ready', activeRunId: null },
    })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
  })

  it('starts nothing while the workspace is already at its concurrency limit', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { maxConcurrentRuns: 1 },
    })
    const otherTask = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'already running',
        description: 'holds the only slot',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: 3,
      },
    })
    await prisma.agentRun.create({
      data: { taskId: otherTask.id, agentId: fixture.agentId, status: 'working' },
    })

    const report = await tick(deps)

    // `decide()` enforces this, and that is the point: the tick executes the command list rather
    // than iterating tasks itself, so it cannot start a run the scheduler did not ask for.
    expect(report.started).toEqual([])
  })

  it('returns before the run it started has finished', async (): Promise<void> => {
    const report = await tick(deps)

    // The pump outlives the tick by design (spec §5.6). Awaiting it would make one tick as long as
    // one run, and the sweep, the reconcile pass and every other workspace would wait behind it.
    expect(report.started).toHaveLength(1)
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(['starting', 'working']).toContain(run.status)
  })

  it('does not start a second run for the same task on the next tick', async (): Promise<void> => {
    const first = await tick(deps)
    expect(first.started).toHaveLength(1)

    // A second idle agent exists, and `decide()` treats `ready` and `rework` as startable -- so a
    // task the tick left in either would be handed straight to that agent one second later, and
    // the same work would be done twice on two branches.
    const team = await prisma.team.findFirstOrThrow()
    await prisma.agent.create({ data: { teamId: team.id, name: 'Blair', role: 'backend' } })

    const second = await tick(deps)

    expect(second.started).toEqual([])
    expect(await prisma.agentRun.count()).toBe(1)
  })

  it('counts a roleless task instead of dropping it, and still starts the rest', async (): Promise<void> => {
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'nobody can pick this up',
        description: 'no required role',
        status: 'ready',
        maxAttempts: 3,
      },
    })

    const report = await tick(deps)

    expect(report.skippedNoRole).toBe(1)
    expect(report.started).toHaveLength(1)
  })
})
