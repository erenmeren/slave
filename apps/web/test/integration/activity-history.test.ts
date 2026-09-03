import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildActivityHistory, buildActivityPage } from '../../src/server/activity.js'
import { EMPTY_ACTIVITY_FILTERS, type ActivityFilters } from '../../src/lib/activityFilters.js'
import { GET as getActivity } from '../../src/app/api/w/[workspaceId]/activity/route.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId1: string
  readonly agentId2: string
  readonly taskId1: string
  readonly taskId2: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/activity-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent1 = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const agent2 = await prisma.agent.create({ data: { teamId: team.id, name: 'Bianca', role: 'frontend' } })
  const task1 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'x',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  const task2 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Fix the other thing',
      description: 'y',
      status: 'running',
      requiredRole: 'frontend',
      maxAttempts: 3,
    },
  })
  return { workspaceId: workspace.id, agentId1: agent1.id, agentId2: agent2.id, taskId1: task1.id, taskId2: task2.id }
}

describe('buildActivityHistory', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('pages newest-first by seq cursor and reports nextBefore', async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId1,
        agentId: fixture.agentId1,
        actor: 'agent',
        payload: { name: 'Write', summary: `call ${i}` },
      })
    }

    const page1 = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, { limit: 10 })
    expect(page1?.events).toHaveLength(10)
    expect(page1!.events[0]!.seq).toBeGreaterThan(page1!.events[9]!.seq)

    const page2 = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, {
      before: page1!.nextBefore!,
      limit: 10,
    })
    expect(page2!.events[0]!.seq).toBeLessThan(page1!.events[9]!.seq)
  })

  it('reaches exhaustion with nextBefore null', async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId1,
        agentId: fixture.agentId1,
        actor: 'agent',
        payload: { name: 'Write', summary: `call ${i}` },
      })
    }

    const page1 = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, { limit: 10 })
    expect(page1?.events).toHaveLength(10)
    expect(page1?.nextBefore).not.toBeNull()

    const page2 = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, {
      before: page1!.nextBefore!,
      limit: 10,
    })
    expect(page2?.events).toHaveLength(2)
    expect(page2?.nextBefore).toBeNull()

    // Page past the oldest row: nothing left, but still a clean exhaustion signal.
    const page3 = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, {
      before: page2!.events.at(-1)!.seq,
      limit: 10,
    })
    expect(page3?.events).toHaveLength(0)
    expect(page3?.nextBefore).toBeNull()
  })

  it('applies the filter union — agent AND (types ∪ kinds)', async (): Promise<void> => {
    await appendEvent({
      type: 'task.created',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId1,
      agentId: fixture.agentId1,
      actor: 'human',
      payload: { title: 'Add the thing' },
    })
    await appendEvent({
      type: 'run.started',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId1,
      agentId: fixture.agentId1,
      actor: 'agent',
      payload: { sessionId: 'sess-1' },
    })
    // Wrong agent — excluded even though the type matches.
    await appendEvent({
      type: 'task.created',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId1,
      agentId: fixture.agentId2,
      actor: 'human',
      payload: { title: 'Wrong agent' },
    })
    // Right agent, wrong type — excluded even though the agent matches.
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId2,
      agentId: fixture.agentId1,
      actor: 'system',
      payload: { guardrail: 'budget', detail: 'over budget' },
    })

    const filters: ActivityFilters = {
      agents: [fixture.agentId1],
      tasks: [],
      types: ['task.created', 'run.started'],
    }
    const page = await buildActivityHistory(fixture.workspaceId, filters, { limit: 100 })

    expect(page?.events).toHaveLength(2)
    expect(page?.events.every((e) => e.agentId === fixture.agentId1)).toBe(true)
    expect(page?.events.map((e) => e.type).sort()).toEqual(['run.started', 'task.created'])
  })

  it('caps limit at 200 and defaults to 100', async (): Promise<void> => {
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        appendEvent({
          type: 'run.tool_call',
          workspaceId: fixture.workspaceId,
          taskId: fixture.taskId1,
          agentId: fixture.agentId1,
          actor: 'agent',
          payload: { name: 'Write', summary: `call ${i}` },
        }),
      ),
    )

    const capped = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, { limit: 999 })
    expect(capped?.events).toHaveLength(200)

    const defaulted = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, {})
    expect(defaulted?.events).toHaveLength(100)
  })

  it('returns null for an unknown workspace', async (): Promise<void> => {
    expect(await buildActivityHistory('00000000-0000-4000-8000-000000000000', EMPTY_ACTIVITY_FILTERS)).toBeNull()
  })

  it('every row carries a non-empty summary and dotted type', async (): Promise<void> => {
    await appendEvent({
      type: 'run.tool_call',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId1,
      agentId: fixture.agentId1,
      actor: 'agent',
      payload: { name: 'Write', summary: 'Write note.txt' },
    })

    const page = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, { limit: 10 })

    expect(page?.events).toHaveLength(1)
    expect(page?.events[0]?.type).toContain('.')
    expect(page?.events[0]?.summary).toBe('Write note.txt')
    expect(page?.events[0]?.summary).not.toHaveLength(0)
  })

  describe('sparkline', () => {
    it('buckets run.tool_call counts into 10 one-minute buckets, oldest first, zero-filled, non-tool-call types excluded', async (): Promise<void> => {
      // Mid-minute (:30), not the raw wall clock, so a row's `at(N)` timestamp can never straddle
      // a `date_trunc('minute', …)` boundary relative to `now` — the window, the SQL grouping, and
      // the bucket index all read this one instant.
      const now = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000)
      const at = (minutesAgo: number): Date => new Date(now.getTime() - minutesAgo * 60_000)
      await prisma.executionEvent.createMany({
        data: [
          // Current minute: two tool calls.
          { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId1, agentId: fixture.agentId1, actor: 'agent', payload: {}, ts: at(0) },
          { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId1, agentId: fixture.agentId1, actor: 'agent', payload: {}, ts: at(0) },
          // 3 minutes ago: one tool call.
          { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId1, agentId: fixture.agentId1, actor: 'agent', payload: {}, ts: at(3) },
          // 9 minutes ago: still inside the 10-minute window, one tool call.
          { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId1, agentId: fixture.agentId1, actor: 'agent', payload: {}, ts: at(9) },
          // 11 minutes ago: outside the window, must not count.
          { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId1, agentId: fixture.agentId1, actor: 'agent', payload: {}, ts: at(11) },
          // Same minute as the current bucket, but not a tool call — must not count.
          { type: 'task_created', workspaceId: fixture.workspaceId, taskId: fixture.taskId1, agentId: fixture.agentId1, actor: 'human', payload: {}, ts: at(0) },
        ],
      })

      const page = await buildActivityHistory(fixture.workspaceId, EMPTY_ACTIVITY_FILTERS, {}, now)

      expect(page?.sparkline).toHaveLength(10)
      expect(page?.sparkline[9]).toBe(2) // current minute
      expect(page?.sparkline[6]).toBe(1) // 3 minutes ago -> index 9 - 3
      expect(page?.sparkline[0]).toBe(1) // 9 minutes ago -> index 9 - 9
      expect(page?.sparkline.reduce((a, b) => a + b, 0)).toBe(4) // the 11-min-ago row and the task.created row excluded
    })

    it('composes the workspace snapshot with the unfiltered first history page and an all-zero sparkline when there are no tool calls', async (): Promise<void> => {
      await appendEvent({
        type: 'task.created',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId1,
        agentId: fixture.agentId1,
        actor: 'human',
        payload: { title: 'Add the thing' },
      })
      await prisma.workspace.update({
        where: { id: fixture.workspaceId },
        data: { haltedReason: 'budget exhausted', haltedAt: new Date() },
      })

      const page = await buildActivityPage(fixture.workspaceId)

      expect(page?.workspace.id).toBe(fixture.workspaceId)
      expect(page?.workspace.name).toBe('Checkout Platform')
      expect(page?.workspace.haltedReason).toBe('budget exhausted')
      expect(page?.events).toHaveLength(1)
      expect(page?.nextBefore).toBeNull()
      expect(page?.sparkline).toEqual(new Array(10).fill(0))
    })

    it('returns null for an unknown workspace', async (): Promise<void> => {
      expect(await buildActivityPage('00000000-0000-4000-8000-000000000000')).toBeNull()
    })

    it('reports 24-hour event volumes by kind prefix, busiest first, omitting silent kinds', async (): Promise<void> => {
      // 3 `run.*`, 1 `task.*`, and one `guardrail.*` older than 24 hours which must NOT be
      // counted -- a kind with nothing inside the window is omitted, never shown as a zero bar.
      for (let i = 0; i < 3; i += 1) {
        await appendEvent({
          type: 'run.tool_call',
          workspaceId: fixture.workspaceId,
          taskId: fixture.taskId1,
          agentId: fixture.agentId1,
          actor: 'agent',
          payload: { name: 'Write', summary: `call ${i}` },
        })
      }
      await appendEvent({
        type: 'task.started',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId1,
        agentId: fixture.agentId1,
        actor: 'agent',
        payload: { title: 'Add the thing' },
      })
      // `createMany`, not `appendEvent`: only a direct insert can backdate `ts`.
      await prisma.executionEvent.createMany({
        data: [
          {
            type: 'guardrail_tripped',
            workspaceId: fixture.workspaceId,
            taskId: fixture.taskId1,
            agentId: fixture.agentId1,
            actor: 'system',
            payload: {},
            ts: new Date(Date.now() - 25 * 60 * 60 * 1000),
          },
        ],
      })

      const page = await buildActivityPage(fixture.workspaceId)

      expect(page?.typeVolumes).toEqual([
        { prefix: 'run.*', count: 3 },
        { prefix: 'task.*', count: 1 },
      ])
    })

    it('carries the shell facts the page publishes to the global Sidebar', async (): Promise<void> => {
      const page = await buildActivityPage(fixture.workspaceId)

      expect(page?.shellFacts.workspace).toEqual({ id: fixture.workspaceId, name: 'Checkout Platform' })
      expect(page?.shellFacts.guardrails.budgetUsd).toBe(100)
      expect(page?.shellFacts.counts.tasksActive).toBe(2)
    })

    it('carries the workspace agent/task rosters for the FilterBar and card name resolution', async (): Promise<void> => {
      const page = await buildActivityPage(fixture.workspaceId)

      expect(page?.agents).toEqual([
        { id: fixture.agentId1, name: 'Alex' },
        { id: fixture.agentId2, name: 'Bianca' },
      ])
      expect(page?.tasks).toEqual([
        { id: fixture.taskId1, title: 'Add the thing' },
        { id: fixture.taskId2, title: 'Fix the other thing' },
      ])
    })

    it('carries every local account for resolving an event userId to a username (M23 F6)', async (): Promise<void> => {
      const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'irrelevant-for-this-test' } })
      await appendEvent({
        type: 'workspace.goal_set',
        workspaceId: fixture.workspaceId,
        actor: 'human',
        payload: { goal: 'Ship the checkout redesign' },
        userId: user.id,
      })

      const page = await buildActivityPage(fixture.workspaceId)

      expect(page?.users).toEqual([{ id: user.id, username: 'ada' }])
      const goalSet = page?.events.find((event) => event.type === 'workspace.goal_set')
      expect(goalSet?.userId).toBe(user.id)
    })
  })

  it('Finding 3: the history route response carries the workspace-wide 10-bucket sparkline, unaffected by an active filter', async (): Promise<void> => {
    await appendEvent({
      type: 'run.tool_call',
      workspaceId: fixture.workspaceId,
      taskId: fixture.taskId1,
      agentId: fixture.agentId1,
      actor: 'agent',
      payload: { name: 'Write', summary: 'call' },
    })

    const unfiltered = await getActivity(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    const unfilteredBody = (await unfiltered.json()) as { sparkline: number[] }
    expect(unfilteredBody.sparkline).toHaveLength(10)
    // Shape, not an exact bucket: the route reads the real clock (no injected `now` — an HTTP
    // handler has no clock to inject), so a minute boundary crossed between the `appendEvent`
    // above and this request could shift which index the one row lands in.
    expect(unfilteredBody.sparkline.reduce((a, b) => a + b, 0)).toBe(1)

    // A filter that excludes every event in the log still reports the true workspace-wide rate —
    // the sparkline is never filtered, only `events` is (review finding 3).
    const filtered = await getActivity(new Request('http://test/api?agents=' + fixture.agentId2), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    const filteredBody = (await filtered.json()) as { events: unknown[]; sparkline: number[] }
    expect(filteredBody.events).toHaveLength(0)
    expect(filteredBody.sparkline).toEqual(unfilteredBody.sparkline)
  })

  it('the route 400s malformed filters and 404s an unknown workspace', async (): Promise<void> => {
    const badFilters = await getActivity(new Request('http://test/api?kinds=bogus'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    expect(badFilters.status).toBe(400)
    expect((await badFilters.json()).error).toBeTruthy()

    const unknownWorkspace = await getActivity(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(unknownWorkspace.status).toBe(404)
    expect(await unknownWorkspace.text()).toContain('nope')
  })
})
