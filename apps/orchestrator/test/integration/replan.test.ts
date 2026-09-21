import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSupervisorWorld, setGoal } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { observe, workspaceId as brandWorkspaceId, type TaskStatus } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchPlanning } from '../../src/planning.js'
import { drainPumps, type TickDeps } from '../../src/tick.js'

/**
 * H5: a re-plan whose addition REDOES a task already on the board, and what that does to
 * everything waiting on the replaced task.
 *
 * Its own file rather than another `describe` in `planning.test.ts` because it is its own story:
 * the board here is built by hand, with the dependency shape the bug was found in (a research task
 * that failed while three tasks waited on it), which no plan fixture produces.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

const V1 = 'Ship the checkout redesign'
const V2 = 'Ship the checkout redesign, with the market research it was priced on'
/** The titles `fixtures/replan-replaces.ndjson` gives its two additions: the one that REPLACES the
 *  board task, and the one that waits on both that addition (by key) and the replaced task (by id). */
const RERUN = 'Competitive and market research (bounded rerun)'
const REVISION = 'Revise the positioning on the rerun'

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-replan-'))
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
  readonly teamId: string
  readonly repoPath: string
}

async function seed(): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [] },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id, repoPath }
}

async function addSlave(teamId: string, name: string, role: string, runtimeRole: string): Promise<string> {
  const person = await prisma.person.create({ data: { name } })
  const slave = await prisma.slave.create({
    data: { teamId, role, runtimeRoles: [runtimeRole], personId: person.id },
  })
  return slave.id
}

function singleAdapterRegistry(adapter: ClaudeCodeAdapter): AdapterRegistry {
  return { resolve: () => adapter }
}

/** What the delta under test says beyond `replaces`: one more board task the replacement waits on
 *  (fix round 1, I1 -- the shape that can close a cycle), and a task it also cancels outright. */
interface DeltaShape {
  readonly dependsOn?: string
  readonly cancel?: string
}

/** `deps` for the re-plan under test: the fake CLI's re-plan arm replays the REPLACES delta when
 *  `--replan-replaces <id>` names a row, which no static fixture can know (erratum E3/E6). */
function depsForReplan(workspaceId: string, replacesTaskId: string, shape: DeltaShape = {}): TickDeps {
  return {
    workspaceId: brandWorkspaceId(workspaceId),
    registry: singleAdapterRegistry(
      new ClaudeCodeAdapter({
        command: 'node',
        extraArgs: [
          FAKE,
          '--fixture',
          'm8-flow',
          '--replan-replaces',
          replacesTaskId,
          ...(shape.dependsOn === undefined ? [] : ['--replan-depends', shape.dependsOn]),
          ...(shape.cancel === undefined ? [] : ['--replan-cancel', shape.cancel]),
        ],
        hookPath: REAL_GATE,
      }),
    ),
  }
}

interface Board {
  readonly fixture: Fixture
  readonly replaced: { readonly id: string; readonly title: string }
  readonly dependents: readonly string[]
}

describe('a re-plan that replaces a task (H5)', () => {
  const repos: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  /**
   * The board the bug was found on: one research task in `status`, and three tasks that cannot
   * start until it is done. A required role on every row because `loadSupervisorWorld` drops a task
   * without one, and a task the world does not carry has no cancellation to propose.
   */
  async function boardWithDependents(status: TaskStatus): Promise<Board> {
    const fixture = await seed()
    repos.push(fixture.repoPath)
    await addSlave(fixture.teamId, 'Atlas', 'Engineering Lead', 'manager')
    await addSlave(fixture.teamId, 'Beryl', 'backend', 'backend')
    expect((await setGoal(fixture.workspaceId, V1)).ok).toBe(true)

    const replaced = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        title: 'Competitive and market research',
        description: 'Read the market and write down what it costs.',
        status,
        requiredRole: 'backend',
        maxAttempts: 3,
        goalVersion: 1,
      },
    })
    const dependents: string[] = []
    for (const title of ['Price the tiers', 'Write the positioning brief', 'Draft the launch plan']) {
      const task = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title,
          description: 'Waits on the research.',
          status: 'blocked',
          requiredRole: 'backend',
          maxAttempts: 3,
          goalVersion: 1,
        },
      })
      await prisma.taskDependency.create({ data: { taskId: task.id, dependsOnTaskId: replaced.id } })
      dependents.push(task.id)
    }
    return { fixture, replaced: { id: replaced.id, title: replaced.title }, dependents }
  }

  /** The goal moves and the re-plan runs; the run's id comes back for the tests that ask about it. */
  async function replanRun(board: Board, shape: DeltaShape = {}): Promise<string> {
    expect((await setGoal(board.fixture.workspaceId, V2)).ok).toBe(true)
    const runId = await dispatchPlanning(depsForReplan(board.fixture.workspaceId, board.replaced.id, shape))
    expect(runId).not.toBeNull()
    await drainPumps()
    return runId as string
  }

  /** {@link replanRun}, and the addition that REPLACES the board task comes back. */
  async function replan(board: Board, shape: DeltaShape = {}): Promise<{ readonly id: string; readonly title: string }> {
    await replanRun(board, shape)
    const added = await prisma.task.findFirstOrThrow({
      where: { workspaceId: board.fixture.workspaceId, title: RERUN },
    })
    return { id: added.id, title: added.title }
  }

  /** The delta's OTHER addition, the one that waits on the rerun and on the replaced task. */
  async function revisionOf(board: Board): Promise<string> {
    return (await prisma.task.findFirstOrThrow({ where: { workspaceId: board.fixture.workspaceId, title: REVISION } })).id
  }

  /** Who waits on a task, as the board itself says. */
  async function waitingOn(taskId: string): Promise<string[]> {
    const rows = await prisma.taskDependency.findMany({ where: { dependsOnTaskId: taskId } })
    return rows.map((row) => row.taskId).toSorted()
  }

  it('moves every dependent of the replaced task onto the task that redoes it', async (): Promise<void> => {
    const board = await boardWithDependents('failed')
    expect(await waitingOn(board.replaced.id)).toEqual([...board.dependents].toSorted())

    const added = await replan(board)

    // The three tasks that could never have started now wait on the rerun instead -- as does the
    // delta's own revision task, which named the replaced task too -- and NOTHING waits on the
    // replaced task any more, not even the rerun, whose own `dependsOn` named it.
    expect(await waitingOn(added.id)).toEqual([...board.dependents, await revisionOf(board)].toSorted())
    expect(await waitingOn(board.replaced.id)).toEqual([])
  }, 60_000)

  // Fix round 1, M1: a dependent told to wait on BOTH the replacement (by key) and the replaced task
  // (by id) ends with ONE edge to the replacement -- the re-point of its second edge would have
  // duplicated its first, so that edge is dropped rather than moved.
  it('leaves one edge, not two, on a dependent that named both the replacement and the replaced task', async (): Promise<void> => {
    const board = await boardWithDependents('failed')
    const added = await replan(board)
    const revision = await revisionOf(board)

    const edges = await prisma.taskDependency.findMany({ where: { taskId: revision } })
    expect(edges.map((edge) => edge.dependsOnTaskId)).toEqual([added.id])
  }, 60_000)

  // Fix round 1, I1: a board where a dependent waits on the replaced task, and a delta whose
  // replacement waits on that dependent, is `D -> new -> D` the moment D's edge is moved. The delta
  // is refused whole, the board is exactly as it was, and the run failed for a named reason.
  it('refuses the delta, board untouched, when the re-point would close a dependency cycle', async (): Promise<void> => {
    const board = await boardWithDependents('failed')
    const first = board.dependents[0] as string
    const runId = await replanRun(board, { dependsOn: first })

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    const failures = await prisma.executionEvent.findMany({ where: { runId, type: 'run_failed' } })
    expect(failures).toHaveLength(1)
    expect((failures[0]?.payload as { reason: string }).reason).toContain('cycle')
    expect((failures[0]?.payload as { reason: string }).reason).toContain(first)

    // Nothing was added, nothing moved, nothing was proposed, nothing was announced.
    expect(await prisma.task.count({ where: { workspaceId: board.fixture.workspaceId } })).toBe(4)
    expect(await waitingOn(board.replaced.id)).toEqual([...board.dependents].toSorted())
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: board.fixture.workspaceId } })).toBe(0)
    expect(
      await prisma.executionEvent.count({
        where: { workspaceId: board.fixture.workspaceId, type: { in: ['task_created', 'workspace_replanned'] } },
      }),
    ).toBe(0)
  }, 60_000)

  it('never leaves the addition depending on itself or on the work it redoes', async (): Promise<void> => {
    // The delta fixture deliberately says `dependsOn: [<the task it replaces>]` beside `replaces`
    // -- the one shape that would become a self-dependency if the re-point were applied blindly,
    // and a rerun waiting forever on the failed task if the row were simply left alone.
    const board = await boardWithDependents('failed')
    const added = await replan(board)

    expect(await prisma.taskDependency.findMany({ where: { taskId: added.id } })).toEqual([])
  }, 60_000)

  it('says on task.created which task the addition redoes', async (): Promise<void> => {
    const board = await boardWithDependents('failed')
    const added = await replan(board)

    const created = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: board.fixture.workspaceId, type: 'task_created', taskId: added.id },
    })
    expect(created.payload).toMatchObject({ title: RERUN, goalVersion: 2, replaces: board.replaced.id })
  }, 60_000)

  // M40 §3 / H5 ruling 3: `observe`'s `task_failed` rule counts DEPENDENTS, so a failed task whose
  // dependents have followed the replacement stops being a situation on its own -- no change to
  // `observe` was needed, and this is the test that says so.
  it('stops the Supervisor escalating the failed task it replaced, because nothing waits on it', async (): Promise<void> => {
    const board = await boardWithDependents('failed')

    const before = (await loadSupervisorWorld(board.fixture.workspaceId, new Date())).world
    expect(before.tasks.find((task) => task.id === board.replaced.id)?.dependents).toBe(3)
    expect(observe(before).filter((s) => s.kind === 'task_failed' && s.subjectId === board.replaced.id)).toHaveLength(1)

    const added = await replan(board)

    const after = (await loadSupervisorWorld(board.fixture.workspaceId, new Date())).world
    expect(after.tasks.find((task) => task.id === board.replaced.id)?.dependents).toBe(0)
    // The three board dependents and the delta's own revision task.
    expect(after.tasks.find((task) => task.id === added.id)?.dependents).toBe(4)
    // The rerun is startable, by the SAME predicate the scheduler gates on (fix round 1, M2):
    // nothing it was told to wait for is a dead end any more, because nothing it waits for is left.
    const rerun = after.tasks.find((task) => task.id === added.id)
    expect(rerun?.status).toBe('ready')
    expect(rerun?.dependenciesDone).toBe(true)
    expect(observe(after).filter((s) => s.kind === 'task_failed' && s.subjectId === board.replaced.id)).toEqual([])
  }, 60_000)

  it('proposes cancelling the replaced task when it had not finished, and says what replaced it', async (): Promise<void> => {
    const board = await boardWithDependents('ready')
    const added = await replan(board)

    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: board.fixture.workspaceId } })
    expect(decisions).toHaveLength(1)
    const decision = decisions[0]
    expect(decision?.situationKind).toBe('stale_task')
    expect(decision?.subjectId).toBe(board.replaced.id)
    expect(decision?.status).toBe('pending')
    expect(decision?.tier).toBe('proposed')
    // The proposal a person reads names the work that took its place.
    expect(decision?.action).toMatchObject({ kind: 'cancel_task', taskId: board.replaced.id })
    expect((decision?.action as unknown as { reason: string }).reason).toContain(`replaced by "${RERUN}"`)
    expect((decision?.situation as unknown as { facts: Record<string, unknown> }).facts).toMatchObject({
      reason: 'replan_cancel',
      replacedBy: added.id,
    })
    // The replaced task is exactly where it was: a cancellation is a proposal (M40 ruling R1).
    expect((await prisma.task.findUniqueOrThrow({ where: { id: board.replaced.id } })).status).toBe('ready')

    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: board.fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toMatchObject({
      added: [added.id, await revisionOf(board)],
      proposedCancellations: [board.replaced.id],
      droppedCancellations: [],
      failedProposals: [],
    })
  }, 60_000)

  // Fix round 1, M1: `replaces` and `cancel` naming the same task is ONE proposal, the model's own,
  // not a second decision row for the same subject.
  it('proposes once when the delta both replaces and cancels the same task', async (): Promise<void> => {
    const board = await boardWithDependents('ready')
    const added = await replan(board, { cancel: board.replaced.id })

    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: board.fixture.workspaceId } })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.subjectId).toBe(board.replaced.id)
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: board.fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toMatchObject({
      added: [added.id, await revisionOf(board)],
      proposedCancellations: [board.replaced.id],
      droppedCancellations: [],
      failedProposals: [],
    })
  }, 60_000)

  // Fix round 1, I2: `rework` may be REPLACED (its result was rejected, and redoing it is the
  // point) but `cancelTask` refuses it, so a proposal would be a decision nobody could apply.
  it('proposes nothing for a replaced rework task -- the verb would refuse it', async (): Promise<void> => {
    const board = await boardWithDependents('rework')
    const added = await replan(board)

    expect(await waitingOn(added.id)).toEqual([...board.dependents, await revisionOf(board)].toSorted())
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: board.fixture.workspaceId } })).toBe(0)
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: board.fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toMatchObject({ proposedCancellations: [], failedProposals: [] })
  }, 60_000)

  // Fix round 1, M1: the other terminal status a rerun replaces.
  it('proposes nothing for a replaced task that was already CANCELLED', async (): Promise<void> => {
    const board = await boardWithDependents('cancelled')
    const added = await replan(board)

    expect(await waitingOn(added.id)).toEqual([...board.dependents, await revisionOf(board)].toSorted())
    expect(await waitingOn(board.replaced.id)).toEqual([])
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: board.fixture.workspaceId } })).toBe(0)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: board.replaced.id } })).status).toBe('cancelled')
  }, 60_000)

  it('proposes nothing for a replaced task that had already FAILED -- it is history, not a decision', async (): Promise<void> => {
    const board = await boardWithDependents('failed')
    const added = await replan(board)

    expect(await prisma.supervisorDecision.count({ where: { workspaceId: board.fixture.workspaceId } })).toBe(0)
    const replanned = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: board.fixture.workspaceId, type: 'workspace_replanned' },
    })
    expect(replanned.payload).toMatchObject({
      added: [added.id, await revisionOf(board)],
      proposedCancellations: [],
      failedProposals: [],
    })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: board.replaced.id } })).status).toBe('failed')
  }, 60_000)
})
