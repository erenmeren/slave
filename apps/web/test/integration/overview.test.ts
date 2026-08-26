import { prisma } from '@ai-team-os/db/client'
import { requestResume } from '@ai-team-os/control'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildOverviewSnapshot } from '../../src/server/overview.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/overview-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
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
  return { workspaceId: workspace.id, agentId: agent.id, taskId: task.id }
}

describe('buildOverviewSnapshot', () => {
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
    expect(await buildOverviewSnapshot('nope')).toBeNull()
  })

  it('derives the agent status from its active run with the domain function', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'pause_requested' },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // 'pausing', not 'pause_requested': ADR 0002's derivation is the only translator, and the UI
    // rendering raw run statuses would drift the moment the domain adds a status.
    expect(snapshot?.agents[0]?.status).toBe('pausing')
    expect(snapshot?.agents[0]?.taskTitle).toBe('Add the thing')
    expect(snapshot?.agents[0]?.runId).toBe(run.id)
  })

  it('reports an agent with no live run as idle with no task', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // A finished run must not keep its agent looking busy — the derivation maps terminal to idle,
    // and the card must not resurrect the dead run's task title either.
    expect(snapshot?.agents[0]?.status).toBe('idle')
    expect(snapshot?.agents[0]?.taskTitle).toBeNull()
    expect(snapshot?.agents[0]?.actionLine).toBeNull()
  })

  it('sums budget spend across every run regardless of status', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: 1.5 },
    })
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'failed',
        costUsd: 2.5,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // loadWorld's rule (M3): money is spent whether or not the run is still going. A gauge that
    // forgot failed runs would show a workspace under budget while the bank account disagrees.
    expect(snapshot?.workspace.spentUsd).toBeCloseTo(4.0)
    expect(snapshot?.workspace.budgetUsd).toBe(100)
    expect(snapshot?.workspace.unmeasuredRuns).toBe(0)
  })

  it('reports known spend and the count of runs nobody could measure, never folding one into the other', async (): Promise<void> => {
    // M12 Task 9 / ruling R3. `?? 0` on a SUM is right for "no rows at all" and wrong for "rows
    // whose cost is unknown" -- and the old code could not tell those apart, so a workspace whose
    // every run went unmeasured looked identical to one that had spent nothing.
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'succeeded', costUsd: 1.5 },
    })
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'succeeded', costUsd: null },
    })
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'failed', costUsd: null },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace.spentUsd).toBeCloseTo(1.5)
    expect(snapshot?.workspace.unmeasuredRuns).toBe(2)
  })

  it('carries a null budget through as null, not as a budget of zero', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: null } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace.budgetUsd).toBeNull()
  })

  it('seeds the action line from the latest run.tool_call event', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working' },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })
    for (const summary of ['Read README.md', 'Write note1.txt']) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        runId: run.id,
        actor: 'agent',
        payload: { name: summary.split(' ')[0] ?? '', summary },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // The latest one, not the first: a card that opens on a stale line contradicts the live line
    // the stream is about to draw over it.
    expect(snapshot?.agents[0]?.actionLine).toBe('Write note1.txt')
  })

  it('counts tasks into the strip buckets', async (): Promise<void> => {
    for (const status of ['ready', 'blocked', 'done', 'failed', 'rework'] as const) {
      await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: status,
          description: 'x',
          status,
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // Active = ready/running/verifying/rework (spec §5). The seeded fixture task is `running`.
    expect(snapshot?.tasks).toEqual({ active: 3, blocked: 1, done: 1, failed: 1 })
  })

  it('counts a task under review and one in the merge queue as active, not vanished (M8a Task 12)', async () => {
    for (const status of ['reviewing', 'merging'] as const) {
      await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: status,
          description: 'x',
          status,
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // The seeded fixture task is `running`, plus the two just created: 3 active, none blocked/
    // done/failed.
    expect(snapshot?.tasks).toEqual({ active: 3, blocked: 0, done: 0, failed: 0 })
  })

  it('carries the halt verbatim', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open (PreToolUse:Write exited 127)', haltedAt: new Date() },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace.haltedReason).toContain('PreToolUse:Write')
    expect(snapshot?.workspace.haltedAt).not.toBeNull()
  })

  it('caps recentEvents at the last 20, oldest first, each with a non-empty summary', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working' },
    })
    for (let i = 0; i < 25; i += 1) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        runId: run.id,
        actor: 'agent',
        payload: { name: 'Write', summary: `Write note${i}.txt` },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    const recentEvents = snapshot?.agents[0]?.recentEvents ?? []

    // The oldest of the last 20 is event #5 (0-indexed: 25 events, keep the newest 20 -> #5..#24);
    // the newest is #24, and the list must already be oldest-first for the feed to render top-down.
    expect(recentEvents).toHaveLength(20)
    expect(recentEvents[0]?.summary).toBe('Write note5.txt')
    expect(recentEvents.at(-1)?.summary).toBe('Write note24.txt')
    expect(recentEvents.every((event) => event.summary.length > 0)).toBe(true)
    expect(recentEvents.every((event) => event.type === 'run.tool_call')).toBe(true)
    // Ascending by seq (oldest first): each event's seq strictly greater than the previous.
    for (let i = 1; i < recentEvents.length; i += 1) {
      expect(recentEvents[i]!.seq).toBeGreaterThan(recentEvents[i - 1]!.seq)
    }
  })

  it('exposes the queued message from the agent\'s live run', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'paused',
        queuedMessage: 'also update the README',
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents[0]?.queuedMessage).toBe('also update the README')
  })

  it('carries resumeRequestedAt once a resume intent is recorded, and null before/after', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'paused' },
    })
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: 'session-123',
        worktreePath: '/tmp/overview-fixture/.aiteamos/worktrees/T-abcdef12',
        pauseFlagPath: '/tmp/overview-fixture/.aiteamos/runs/pause.flag',
        settingsPath: '/tmp/overview-fixture/.aiteamos/runs/settings.json',
        hookPath: '/tmp/overview-fixture/scripts/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@aiteamos.local',
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      },
    })

    const before = await buildOverviewSnapshot(fixture.workspaceId)
    expect(before?.agents[0]?.resumeRequestedAt).toBeNull()

    const requested = await requestResume(run.id, null, 'meren')
    expect(requested.ok).toBe(true)

    const after = await buildOverviewSnapshot(fixture.workspaceId)
    expect(after?.agents[0]?.resumeRequestedAt).not.toBeNull()
  })

  it("exposes cost so far, tool calls, and paused-at step from the agent's live run", async (): Promise<void> => {
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'paused',
        costUsd: 1.25,
        toolCalls: 7,
        pausedAtStep: 4,
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents[0]?.costUsd).toBe(1.25)
    expect(snapshot?.agents[0]?.toolCalls).toBe(7)
    expect(snapshot?.agents[0]?.pausedAtStep).toBe(4)
  })

  it("keeps a live run's unknown cost unknown rather than reporting it as zero", async (): Promise<void> => {
    // M12 Task 9 / ruling R3, the per-run half. A run on a runtime that reports no spend has a
    // null `costUsd`, and `$0.00` would be a measurement it never made.
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: null, toolCalls: 3 },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents[0]?.costUsd).toBeNull()
    expect(snapshot?.agents[0]?.toolCalls).toBe(3)
  })

  it("reports the live run's OWN provider, not a hardcoded one", async (): Promise<void> => {
    // M12 Task 9 / ruling R10. This field was `'claude-code' as const` -- the adapter ID, not even
    // the `ProviderKind` spelling -- from before a run had a provider column to read.
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', provider: 'cursor' },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents[0]?.provider).toBe('cursor')
  })

  it('reports zero cost, zero tool calls, and no paused-at step for an idle agent with no live run', async (): Promise<void> => {
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents[0]?.costUsd).toBe(0)
    expect(snapshot?.agents[0]?.toolCalls).toBe(0)
    expect(snapshot?.agents[0]?.pausedAtStep).toBeNull()
    // No live run means no runtime has been resolved for this agent yet -- we do not know one
    // until a run resolves it, so `null` rather than a guess (M12 Task 9, ruling R10).
    expect(snapshot?.agents[0]?.provider).toBeNull()
  })

  it('gives each agent its own 10-minute tool-call sparkline from a single grouped query, zero-filled for an idle agent', async (): Promise<void> => {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const agent2 = await prisma.agent.create({ data: { teamId: team.id, name: 'Bianca', role: 'frontend' } })
    const agent3 = await prisma.agent.create({ data: { teamId: team.id, name: 'Cy', role: 'qa' } })

    const now = new Date()
    const at = (minutesAgo: number): Date => new Date(now.getTime() - minutesAgo * 60_000)
    await prisma.executionEvent.createMany({
      data: [
        // fixture.agentId: two tool calls in the current minute.
        { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId, agentId: fixture.agentId, actor: 'agent', payload: {}, ts: at(0) },
        { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId, agentId: fixture.agentId, actor: 'agent', payload: {}, ts: at(0) },
        // agent2: one tool call, 5 minutes ago.
        { type: 'run_tool_call', workspaceId: fixture.workspaceId, taskId: fixture.taskId, agentId: agent2.id, actor: 'agent', payload: {}, ts: at(5) },
        // Non-tool-call event on fixture.agentId in the current minute — must not count.
        { type: 'task_created', workspaceId: fixture.workspaceId, taskId: fixture.taskId, agentId: fixture.agentId, actor: 'human', payload: {}, ts: at(0) },
      ],
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    const byName = new Map(snapshot?.agents.map((a) => [a.name, a] as const))

    expect(byName.get('Alex')?.sparkline).toHaveLength(10)
    expect(byName.get('Alex')?.sparkline[9]).toBe(2)
    expect(byName.get('Alex')?.sparkline.reduce((a, b) => a + b, 0)).toBe(2)
    expect(byName.get('Bianca')?.sparkline[4]).toBe(1) // 5 minutes ago -> index 9 - 5
    expect(byName.get('Bianca')?.sparkline.reduce((a, b) => a + b, 0)).toBe(1)
    expect(byName.get('Cy')?.sparkline).toEqual(new Array(10).fill(0))
  })

  it('does not leak another workspace\'s agents or tasks', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'backend' } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents.map((a) => a.name)).toEqual(['Alex'])
  })
})
