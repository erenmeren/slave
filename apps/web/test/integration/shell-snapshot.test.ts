import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildShellFacts } from '../../src/server/shell.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/shell-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 20,
      maxConcurrentRuns: 3,
      runTimeoutMs: 1_800_000,
      maxAttempts: 3,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

describe('buildShellFacts', () => {
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
    expect(await buildShellFacts('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('carries the four guardrail columns verbatim', async (): Promise<void> => {
    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.guardrails).toEqual({ budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 })
  })

  it('carries a null budget through as null, not as a budget of zero', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: null } })
    expect((await buildShellFacts(fixture.workspaceId))?.guardrails.budgetUsd).toBeNull()
  })

  it('counts only agents the domain derives as working', async (): Promise<void> => {
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'working' } })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.agentsWorking).toBe(1)

    await prisma.agentRun.updateMany({ where: { agentId: fixture.agentId }, data: { status: 'paused' } })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.agentsWorking).toBe(0)
  })

  // M14 fix wave, review Minor 2: the badge says "agents working", and it counted live RUNS. One
  // agent that happens to hold two live rows is one agent working -- otherwise the same workspace
  // shows a different number depending on which page last published it.
  it('counts an agent with two live runs once, because the badge counts agents', async (): Promise<void> => {
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'working' } })
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'working' } })

    expect((await buildShellFacts(fixture.workspaceId))?.counts.agentsWorking).toBe(1)
  })

  it('still counts two DIFFERENT agents as two', async (): Promise<void> => {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const second = await prisma.agent.create({ data: { teamId: team.id, name: 'Bea', role: 'qa' } })
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'working' } })
    await prisma.agentRun.create({ data: { agentId: second.id, status: 'working' } })

    expect((await buildShellFacts(fixture.workspaceId))?.counts.agentsWorking).toBe(2)
  })

  it('counts a task under review and one in the merge queue as active', async (): Promise<void> => {
    for (const status of ['reviewing', 'merging', 'done'] as const) {
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
    expect((await buildShellFacts(fixture.workspaceId))?.counts.tasksActive).toBe(2)
  })

  it('does not leak another workspace tasks', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.task.create({
      data: { workspaceId: other.id, title: 'x', description: 'x', status: 'running', requiredRole: 'backend', maxAttempts: 3 },
    })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.tasksActive).toBe(0)
  })

  it('names the workspace it was asked about', async (): Promise<void> => {
    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.workspace).toEqual({ id: fixture.workspaceId, name: 'Checkout Platform' })
  })
})
