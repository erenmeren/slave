import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildShellFacts } from '../../src/server/shell.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
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
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

describe('buildShellFacts', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
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

  it('counts only slaves the domain derives as working', async (): Promise<void> => {
    await prisma.slaveRun.create({ data: { slaveId: fixture.slaveId, status: 'working' } })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.slavesWorking).toBe(1)

    await prisma.slaveRun.updateMany({ where: { slaveId: fixture.slaveId }, data: { status: 'paused' } })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.slavesWorking).toBe(0)
  })

  // M14 fix wave, review Minor 2: the badge says "slaves working", and it counted live RUNS. One
  // slave that happens to hold two live rows is one slave working -- otherwise the same workspace
  // shows a different number depending on which page last published it.
  it('counts a slave with two live runs once, because the badge counts slaves', async (): Promise<void> => {
    await prisma.slaveRun.create({ data: { slaveId: fixture.slaveId, status: 'working' } })
    await prisma.slaveRun.create({ data: { slaveId: fixture.slaveId, status: 'working' } })

    expect((await buildShellFacts(fixture.workspaceId))?.counts.slavesWorking).toBe(1)
  })

  it('still counts two DIFFERENT slaves as two', async (): Promise<void> => {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    const second = await prisma.slave.create({ data: { teamId: team.id, name: 'Bea', role: 'qa' } })
    await prisma.slaveRun.create({ data: { slaveId: fixture.slaveId, status: 'working' } })
    await prisma.slaveRun.create({ data: { slaveId: second.id, status: 'working' } })

    expect((await buildShellFacts(fixture.workspaceId))?.counts.slavesWorking).toBe(2)
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
