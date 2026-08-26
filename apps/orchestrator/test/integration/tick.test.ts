import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refusalText } from '@ai-team-os/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId } from '@ai-team-os/domain'
import {
  ClaudeCodeAdapter,
  buildRegistry,
  type AdapterRegistry,
  type AgentRuntimeAdapter,
  type StartRunInput,
} from '@ai-team-os/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  // M12 Task 8: this fixture's agent names no model anywhere in the chain, so `resolveRuntime`
  // falls all the way to the workspace default -- which does not exist unless a
  // `ProviderConfiguration` row does. Without this, every dispatch in this file refuses
  // (`workspaceDefaultProvider` returns `null`) instead of starting the run under test.
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
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

/**
 * `deps.registry` for a test that only ever runs against one adapter instance (the ordinary case
 * pre-Task-8, when every run resolves to `'claude_code'` regardless of what `kind` is asked for).
 */
function singleAdapterRegistry(adapter: AgentRuntimeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

interface Recorder {
  readonly adapter: AgentRuntimeAdapter
  readonly starts: StartRunInput[]
  readonly cancelled: string[]
}

/**
 * The real adapter with the three methods the tick uses observed, and `events()` optionally made to
 * throw -- which is the cheapest way to reach the "something failed after the process was already
 * spawned" path deterministically. Only those methods are implemented because only those are
 * called; the cast is what says so out loud rather than stubbing four more to satisfy a type.
 */
function recordingAdapter(options: { readonly failEvents?: boolean } = {}): Recorder {
  const inner = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE })
  const starts: StartRunInput[] = []
  const cancelled: string[] = []
  const adapter = {
    id: inner.id,
    getCapabilities: () => inner.getCapabilities(),
    start: async (input: StartRunInput) => {
      starts.push(input)
      return inner.start(input)
    },
    events: (runId: string) => {
      if (options.failEvents === true) throw new Error('events exploded after the child was spawned')
      return inner.events(runId as never)
    },
    cancel: async (runId: string) => {
      cancelled.push(runId)
      return inner.cancel(runId as never)
    },
  } as unknown as AgentRuntimeAdapter
  return { adapter, starts, cancelled }
}

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
      registry: singleAdapterRegistry(
        new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE }),
      ),
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

  it('pauses every active run once the budget is exhausted, and does not re-pause on the next tick', async (): Promise<void> => {
    const activeRun = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: 999 },
    })

    await tick(deps)

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: activeRun.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')

    // The fan-out lives inside the halt's one-shot -- a second tick observing the same halt must
    // not try to pause an already-`pause_requested` run again.
    await tick(deps)
    const stillOnce = await prisma.agentRun.findUniqueOrThrow({ where: { id: activeRun.id } })
    expect(stillOnce.status).toBe('pause_requested')
  })

  it('announces the budget warning exactly once, and the durable check survives a restart', async (): Promise<void> => {
    // 85% of the default $20 budget: past BUDGET_WARNING_RATIO (0.8) but short of exhausted, so
    // this must not halt scheduling.
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        costUsd: 17,
        terminalAt: new Date(),
      },
    })

    const warningEvents = async (): Promise<number> => {
      const rows = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
      })
      return rows.filter((event) => (event.payload as { guardrail?: string }).guardrail === 'budget_warning').length
    }

    await tick(deps)
    await tick(deps)
    expect(await warningEvents()).toBe(1)

    // Restart semantics (spec §5): the one-shot must be a durable existence check, not ANY
    // in-memory latch. A real restart is simulated by discarding every module-level state:
    // `vi.resetModules()` plus a fresh import re-evaluates tick.ts and everything it pulls in,
    // so a Map-based latch would come back empty, re-announce, and fail the count below --
    // `resetTickObservation()` alone cannot falsify that implementation. The drain first: the
    // fresh module has its own pumps set, invisible to the static `drainPumps` in afterEach.
    await drainPumps()
    vi.resetModules()
    const fresh = await import('../../src/tick.js')
    await fresh.tick(deps)
    expect(await warningEvents()).toBe(1)
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

  it('refuses -- as an attempted run that failed, not a silent skip -- when the workspace has no configured default provider', async (): Promise<void> => {
    // `seed()` gives this workspace a `ProviderConfiguration` row; removing it reproduces a
    // workspace nothing has configured at all, and the fixture agent names no model/provider
    // anywhere in its own chain either -- so `resolveRuntime` has nothing to fall back to.
    await prisma.providerConfiguration.deleteMany({ where: { workspaceId: fixture.workspaceId } })

    const report = await tick(deps)

    expect(report.started).toEqual([])
    const run = await prisma.agentRun.findFirstOrThrow()
    // An ATTEMPTED run that failed (spec §13), exactly like a worktree that could not be
    // provisioned -- not the silent "nothing to attempt" `decide()` produces for an all-busy
    // roster, because unlike busyness this will not resolve itself on the next tick.
    expect(run.status).toBe('failed')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.attempt).toBe(1)
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain(
      'no configured default provider',
    )
  })

  it('refuses with the spec-verbatim invalid_provider text when the chain names a provider this process has no adapter for', async (): Promise<void> => {
    // A `ProviderKind` the type system accepts but this registry was never given an adapter for --
    // exactly Task 7's ledger gap: `isProviderKind` (write time) only checks union membership, so
    // writing this pair succeeds, and dispatch (this task) is the first thing that can tell the
    // difference between "known kind" and "configured kind".
    await prisma.agent.update({ where: { id: fixture.agentId }, data: { model: 'whatever', provider: 'cursor' } })
    // The REAL registry, not the test's own `singleAdapterRegistry` stub (which ignores `kind`
    // entirely and would silently paper over exactly the bug under test here) -- built with only
    // `claude_code` configured, matching production today (Cursor is Task 12's).
    const realRegistry = buildRegistry({ claudeCode: { command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath: REAL_GATE } })

    const report = await tick({ ...deps, registry: realRegistry })

    expect(report.started).toEqual([])
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      refusalText({ kind: 'invalid_provider', provider: 'cursor' }),
    )
  })

  it('refuses with the spec-verbatim unmeasurable_budget text when a budgeted workspace resolves a cost-blind runtime', async (): Promise<void> => {
    // Spec §6's dispatch-time half (M12 Task 9, ruling R9). The re-check exists because resolution
    // crosses four levels: a template edit can turn a workspace that was valid when it was
    // configured into one whose workers run on a runtime that reports no spend, and the write-time
    // refusal cannot see an edit made after it ran.
    //
    // The registry here DOES resolve `cursor`, unlike the `invalid_provider` test above -- with
    // no adapter registered for it, dispatch would refuse for that other reason first and this
    // check would never be reached, so a registry that stops at `invalid_provider` would prove
    // nothing about this one.
    await prisma.agent.update({ where: { id: fixture.agentId }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 20 } })
    const recorder = recordingAdapter()
    const costBlindRegistry: AdapterRegistry = { resolve: () => recorder.adapter }

    const report = await tick({ ...deps, registry: costBlindRegistry })

    expect(report.started).toEqual([])
    // Never spawned: the refusal has to land before the process, or the money is already spent.
    expect(recorder.starts).toEqual([])
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, runId: run.id, type: 'run_failed' },
    })
    expect(failures).toHaveLength(1)
    // Compared against `refusalText()` IMPORTED, never hand-copied, and asserted on the TEXT
    // rather than only on `status === 'failed'` -- a test that `throw new Error('boom')` would
    // pass is not a test (Task 8's fix round F3).
    expect((failures[0]?.payload as { reason: string }).reason).toBe(
      refusalText({ kind: 'unmeasurable_budget', workspaceId: fixture.workspaceId, provider: 'cursor' }),
    )
  })

  it('dispatches that same cost-blind runtime freely once the workspace has no budget', async (): Promise<void> => {
    // The other half of the ruling, and the half that makes §10's milestone gate buildable at all:
    // an unbudgeted workspace runs a cost-blind provider without complaint.
    await prisma.agent.update({ where: { id: fixture.agentId }, data: { model: 'whatever', provider: 'cursor' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: null } })
    const recorder = recordingAdapter()
    const costBlindRegistry: AdapterRegistry = { resolve: () => recorder.adapter }

    const report = await tick({ ...deps, registry: costBlindRegistry })

    expect(report.started).toHaveLength(1)
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.provider).toBe('cursor')
  })

  it('kills the agent it just spawned when the start fails after the spawn', async (): Promise<void> => {
    const recorder = recordingAdapter({ failEvents: true })

    const report = await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

    // The window between `adapter.start()` returning and the row being updated is the one place a
    // live child can be orphaned: the run row goes terminal with no pid, and §3.4's startup sweep
    // only looks at NON-terminal runs with dead pids, so nothing in the system can ever find it
    // again. Meanwhile the task goes back to the startable set and the next agent joins it in the
    // same worktree.
    expect(report.started).toEqual([])
    expect(recorder.starts).toHaveLength(1)
    expect(recorder.cancelled).toEqual([recorder.starts[0]?.runId])

    const run = await prisma.agentRun.findFirstOrThrow()
    expect(run.status).toBe('failed')
  })

  it('starts one run, not two, when two ticks overlap', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['sleep 1'] },
    })
    const team = await prisma.team.findFirstOrThrow()
    await prisma.agent.create({ data: { teamId: team.id, name: 'Blair', role: 'backend' } })

    // Spec §3.1 runs this on a 1000ms timer while provisioning is awaited inline and a setup
    // command may take minutes -- so overlapping ticks are the normal case on the first real
    // workspace, not an edge one. Both load the same world and `decide()` hands both the same
    // `start_run`.
    const [first, second] = await Promise.all([tick(deps), tick(deps)])

    expect([...first.started, ...second.started]).toHaveLength(1)
    const runs = await prisma.agentRun.findMany()
    expect(runs.filter((r) => r.status !== 'failed')).toHaveLength(1)

    // And the loser must not rewrite the winner's task. Asserted after the drain rather than at
    // the moment the ticks return, because the winner's pump may legitimately conclude and verify
    // at any point after -- `running` here would be a race, not a property. Every shape the loser
    // could leave is still visible in the final state: a rewrite to `ready`/`rework` makes
    // `advance` refuse and the task never reaches `done`, a burned attempt shows in the counter,
    // and a lingering `activeRunId` shows as the run `advance` would have cleared.
    await drainPumps()
    const task = await prisma.task.findFirstOrThrow()
    // The pipeline flip (M8a): a green verify hands the task to review, not to `done` -- so the
    // race's winner is visible here as `reviewing`, not `done`.
    expect(task.status).toBe('reviewing')
    expect(task.attempt).toBe(0)
    expect(task.activeRunId).toBeNull()

    // No reviewer-role agent exists in this fixture. `dispatchReviews` runs on every tick (it is
    // part of `tick()` itself, spec §3.2/Task 5) and escalates that once rather than trying forever
    // -- proving the task is not just parked in `reviewing` but visibly stuck for an operator.
    await tick(deps)
    const guardrails = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'guardrail_tripped' },
    })
    const noReviewerEvents = guardrails.filter(
      (event) => (event.payload as { guardrail?: string }).guardrail === 'no_reviewer',
    )
    expect(noReviewerEvents).toHaveLength(1)
  })

  it('does not turn the leftovers it refused into leftovers it will adopt', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()
    await prisma.agentRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'ready', activeRunId: null },
    })

    await tick(deps) // refuses: a `ready` task's worktree is unaccounted-for state

    // ...but if the refusal parks the task in `rework`, the next tick meets the guard's own
    // precondition and adopts the very tree it just called wreckage. The property has to survive
    // more than one tick to be a property at all.
    const report = await tick(deps)

    expect(report.started).toEqual([])
  })

  it('re-runs the setup commands when it adopts a worktree', async (): Promise<void> => {
    const log = join(fixture.repoPath, 'setup-log')
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: [`echo ran >> ${log}`] },
    })

    await tick(deps)
    await drainPumps()
    await prisma.agentRun.deleteMany({})
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, activeRunId: null },
    })

    await tick(deps)

    // The commonest route to adopt is a setup command that failed, because that is exactly what
    // leaves a half-provisioned worktree behind (§7.4). Adopting without re-running setup starts an
    // agent in a tree with no node_modules, which then fails verify for reasons that have nothing
    // to do with its work.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('keeps the verify feedback when an infrastructure failure interrupts a rework', async (): Promise<void> => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, lastRejectionReason: 'verify failed: 3 assertions in cart.spec.ts' },
    })
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['exit 3'] },
    })

    await tick(deps)

    // `lastRejectionReason` is the agent-facing channel: `buildPrompt` puts it in front of the next
    // run as the thing to fix first. An orchestrator-side failure overwriting it both destroys the
    // real feedback §8 requires and instructs the next agent to go and fix a setup command.
    const task = await prisma.task.findFirstOrThrow()
    expect(task.lastRejectionReason).toContain('cart.spec.ts')
  })

  it('puts the previous rejection in front of the next run', async (): Promise<void> => {
    const recorder = recordingAdapter()
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { status: 'rework', attempt: 1, lastRejectionReason: 'verify failed: cart totals are wrong' },
    })

    await tick({ ...deps, registry: singleAdapterRegistry(recorder.adapter) })

    // Spec §8's loop is the reason `lastRejectionReason` exists: a rework that does not tell the
    // agent what broke is a re-roll, not a fix.
    expect(recorder.starts[0]?.prompt).toContain('cart totals are wrong')
  })

  it('announces a halt again after the first one was cleared', async (): Promise<void> => {
    const exhaust = async (): Promise<void> => {
      await prisma.agentRun.create({
        data: {
          taskId: fixture.taskId,
          agentId: fixture.agentId,
          status: 'succeeded',
          costUsd: 999,
          terminalAt: new Date(),
        },
      })
    }

    await exhaust()
    await tick(deps)
    const afterFirst = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length

    // The operator raises the budget -- the §11 `clear-halt` shape of the same thing -- and the
    // workspace halts again later. Tracking only the `false -> true` edge without ever re-arming
    // means the second halt is never announced at all.
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 100_000 } })
    await tick(deps)
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: 1 } })
    await tick(deps)

    const afterThird = (await eventTypesFor(fixture.workspaceId)).filter((t) => t === 'guardrail.tripped').length
    expect(afterThird).toBe(afterFirst + 1)
  })

  it('fails a task that has used its last attempt, and says so', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { setupCommands: ['exit 3'] },
    })
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { attempt: 2, maxAttempts: 3 },
    })

    await tick(deps)

    // The attempt cap is what stops a permanently unprovisionable task being handed to an agent
    // every second forever. Off by one here gives every task one extra start and nothing notices.
    const task = await prisma.task.findFirstOrThrow()
    expect(task.attempt).toBe(3)
    expect(task.status).toBe('failed')
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.failed')
  })

  it("leaves the operator's own repository clean", async (): Promise<void> => {
    await tick(deps)

    // Everything the orchestrator writes lands under `.aiteamos/` in the workspace's repo -- the
    // worktrees, the per-run settings file, the pause flag -- and none of it belongs to the
    // operator. Left untracked it shows in every `git status` they run, and a routine
    // `git clean -fdx` deletes the worktree directories while `.git/worktrees/` metadata survives.
    expect(git(['status', '--porcelain'], fixture.repoPath)).toBe('')
  })

  it('records that the task started', async (): Promise<void> => {
    await tick(deps)

    // This is the only producer of `task.started` in the product, and M4 reads it.
    expect(await eventTypesFor(fixture.workspaceId)).toContain('task.started')
  })

  it('drainPumps waits for the run it started', async (): Promise<void> => {
    await tick(deps)
    await drainPumps()

    // The drain is the daemon's shutdown join point and the tests' guard against truncating a
    // table under a live write. A drain that returns immediately is worse than none, because
    // everything downstream believes it.
    const run = await prisma.agentRun.findFirstOrThrow()
    expect(['succeeded', 'failed']).toContain(run.status)
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
