import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSkillGraph, SKILL_GRAPH_RUN_LIMIT } from '../../src/server/skillGraph.js'
import { GET as skillGraphGET } from '../../src/app/api/w/[workspaceId]/skill-graph/route.js'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly agentAId: string
  readonly agentBId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/skill-graph-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agentA = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const agentB = await prisma.agent.create({ data: { teamId: team.id, name: 'Sam', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'x',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  return { workspaceId: workspace.id, teamId: team.id, agentAId: agentA.id, agentBId: agentB.id, taskId: task.id }
}

/** A `run.tool_call` event whose summary is a Skill call (`Skill <name>`) or, for the unparsable
 *  case, the bare word the parser could not fill in. */
async function skillCall(opts: {
  readonly workspaceId: string
  readonly agentId: string
  readonly runId: string
  readonly taskId?: string
  readonly summary: string
}): Promise<void> {
  await appendEvent({
    type: 'run.tool_call',
    workspaceId: opts.workspaceId,
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    agentId: opts.agentId,
    runId: opts.runId,
    actor: 'agent',
    payload: { name: 'Skill', summary: opts.summary },
  })
}

async function noiseCall(opts: {
  readonly workspaceId: string
  readonly agentId: string
  readonly runId: string
  readonly taskId?: string
}): Promise<void> {
  await appendEvent({
    type: 'run.tool_call',
    workspaceId: opts.workspaceId,
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    agentId: opts.agentId,
    runId: opts.runId,
    actor: 'agent',
    payload: { name: 'Write', summary: 'Write a.txt' },
  })
}

describe('buildSkillGraph', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildSkillGraph('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('returns the empty shape for a workspace with no Skill calls at all', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentAId, status: 'working' },
    })
    await noiseCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: run.id, taskId: fixture.taskId })

    expect(await buildSkillGraph(fixture.workspaceId)).toEqual({ skills: [], edges: [], runs: [] })
  })

  it(
    'orders each run\'s chain by seq, collapses consecutive repeats, and aggregates skills/edges across runs',
    async (): Promise<void> => {
      // Run A is live (non-terminal), attached to the fixture task. Run B is a finished,
      // task-less run (a planning-style run has none) on a second agent -- exercising both the
      // `live` boolean and a null `taskTitle` in the same fixture.
      const runA = await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: fixture.agentAId, status: 'working' },
      })
      const runB = await prisma.agentRun.create({
        data: { agentId: fixture.agentBId, status: 'succeeded' },
      })

      // Interleaved seq, on purpose: the two-step query orders `[runId asc, seq asc]`, not
      // insertion order, so this proves the per-run chain comes out right even though the calls
      // arrived interleaved across runs, with a non-Skill call mixed in to prove it's excluded.
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: runA.id, taskId: fixture.taskId, summary: 'Skill alpha' })
      await noiseCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentBId, runId: runB.id })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: runA.id, taskId: fixture.taskId, summary: 'Skill alpha' })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentBId, runId: runB.id, summary: 'Skill beta' })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: runA.id, taskId: fixture.taskId, summary: 'Skill beta' })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentBId, runId: runB.id, summary: 'Skill beta' })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentBId, runId: runB.id, summary: 'Skill alpha' })

      const graph = await buildSkillGraph(fixture.workspaceId)

      // Run A's raw call order is alpha, alpha, beta -> collapses to alpha x2, beta x1.
      const runAOut = graph?.runs.find((r) => r.runId === runA.id)
      expect(runAOut?.chain).toEqual([{ name: 'alpha', count: 2 }, { name: 'beta', count: 1 }])
      expect(runAOut?.live).toBe(true)
      expect(runAOut?.taskTitle).toBe('Add the thing')
      expect(runAOut?.agentName).toBe('Alex')
      expect(typeof runAOut?.startedAt).toBe('string')

      // Run B's raw call order (Skill events only, the Write noise excluded) is beta, beta, alpha
      // -> collapses to beta x2, alpha x1.
      const runBOut = graph?.runs.find((r) => r.runId === runB.id)
      expect(runBOut?.chain).toEqual([{ name: 'beta', count: 2 }, { name: 'alpha', count: 1 }])
      expect(runBOut?.live).toBe(false)
      expect(runBOut?.taskTitle).toBeNull()
      expect(runBOut?.agentName).toBe('Sam')

      // Aggregate `skills`: alpha = 2 (run A) + 1 (run B) = 3; beta = 1 (run A) + 2 (run B) = 3.
      expect(graph?.skills).toEqual([{ name: 'alpha', calls: 3 }, { name: 'beta', calls: 3 }])

      // `edges`: adjacent distinct pairs after collapse, directed, summed across runs -- run A
      // contributes alpha->beta once, run B contributes beta->alpha once. Two runs of two
      // collapsed links each produce exactly one edge apiece, never a self-loop (collapse already
      // ruled that out).
      expect(graph?.edges).toEqual([
        { from: 'alpha', to: 'beta', count: 1 },
        { from: 'beta', to: 'alpha', count: 1 },
      ])
    },
  )

  it(
    'collapses an unparsable Skill summary into the UNKNOWN_SKILL_NAME sentinel, never the literal word "Skill"',
    async (): Promise<void> => {
      // A pre-Task-4 event, or a call whose arguments the parser could not read: the tool fired,
      // but nothing on the row says WHICH skill. The DTO's `chain[].name` is a non-nullable
      // `string` (unlike `overview.ts`'s nullable `skill` chip), so the server itself must decide
      // what unparsable becomes -- the em dash the chip already renders for the same case, `—`,
      // written directly into the chain rather than the tool's own name (`'Skill'`) standing in
      // for it.
      const run = await prisma.agentRun.create({
        data: { taskId: fixture.taskId, agentId: fixture.agentAId, status: 'working' },
      })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: run.id, taskId: fixture.taskId, summary: 'Skill' })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: run.id, taskId: fixture.taskId, summary: 'Skill' })
      await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: run.id, taskId: fixture.taskId, summary: 'Skill gamma' })

      const graph = await buildSkillGraph(fixture.workspaceId)
      const runOut = graph?.runs.find((r) => r.runId === run.id)

      expect(runOut?.chain).toEqual([{ name: '—', count: 2 }, { name: 'gamma', count: 1 }])
      // `skills`/`edges` sort by name (`localeCompare`); the em dash sorts before `gamma`.
      expect(graph?.skills).toEqual([{ name: '—', calls: 2 }, { name: 'gamma', calls: 1 }])
      expect(graph?.edges).toEqual([{ from: '—', to: 'gamma', count: 1 }])
    },
  )

  it('does not leak another workspace\'s Skill calls', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other-skill-graph', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    const otherAgent = await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'backend' } })
    const otherRun = await prisma.agentRun.create({ data: { agentId: otherAgent.id, status: 'working' } })
    await skillCall({ workspaceId: other.id, agentId: otherAgent.id, runId: otherRun.id, summary: 'Skill delta' })

    expect(await buildSkillGraph(fixture.workspaceId)).toEqual({ skills: [], edges: [], runs: [] })
  })

  // The LIMIT (M17 §4: bound before the event fetch, no full-table scan): seeding 51 runs with
  // Skill events just to prove a `take` clause is honored would be an expensive way to assert
  // arithmetic vitest already trusts Postgres to do -- instead this pins the QUERY SHAPE the
  // bound rides on, so a change that drops or loosens the `take` fails this test without needing
  // fifty-plus fixture rows.
  it('bounds the run-selection query to SKILL_GRAPH_RUN_LIMIT, newest by each run\'s latest Skill call', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentAId, status: 'working' },
    })
    await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: run.id, taskId: fixture.taskId, summary: 'Skill alpha' })

    // Prisma's `groupBy` overload set is too intricate to name from outside the client, and
    // `vi.spyOn`'s callthrough does not survive the model delegate's own Proxy indirection (the
    // spied call returns `undefined` instead of running) -- so this captures the call by
    // reassigning the method directly, through a narrow `unknown` escape hatch, to a wrapper that
    // still forwards to the real implementation. It runs against Postgres exactly like every
    // other test in this file; only the call's OWN arguments are intercepted.
    const delegate = prisma.executionEvent as unknown as { groupBy: (args: unknown) => unknown }
    const originalGroupBy = delegate.groupBy.bind(prisma.executionEvent)
    let capturedArgs: unknown
    delegate.groupBy = (args: unknown): unknown => {
      capturedArgs = args
      return originalGroupBy(args)
    }
    try {
      await buildSkillGraph(fixture.workspaceId)
    } finally {
      delegate.groupBy = originalGroupBy
    }

    expect(capturedArgs).toEqual(
      expect.objectContaining({
        by: ['runId'],
        take: SKILL_GRAPH_RUN_LIMIT,
        orderBy: { _max: { seq: 'desc' } },
      }),
    )
  })

  it('the route serves the graph and 404s an unknown workspace', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentAId, status: 'working' },
    })
    await skillCall({ workspaceId: fixture.workspaceId, agentId: fixture.agentAId, runId: run.id, taskId: fixture.taskId, summary: 'Skill alpha' })

    const ok = await skillGraphGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { skills: readonly { name: string }[] }
    expect(body.skills).toEqual([{ name: 'alpha', calls: 1 }])

    const missing = await skillGraphGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('nope')
  })
})
