import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'
import { TASK_STATUSES } from '../../src/enums.js'
import { seed } from '../../src/seed.js'

describe('seed data', () => {
  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('creates the Atlas organisation', async () => {
    await seed()

    const teams = await prisma.team.findMany({ include: { agents: true }, orderBy: { name: 'asc' } })
    expect(teams.map((t) => t.name)).toEqual(['Engineering', 'Management', 'Marketing', 'Product', 'Security'])

    const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } })
    expect(agents.map((a) => a.name)).toEqual([
      'Alex',
      'Atlas',
      'Daniel',
      'Emma',
      'John',
      'Maya',
      'Oliver',
      'Riley',
      'Sarah',
    ])
  })

  it('creates one task in every task status', async () => {
    await seed()

    const tasks = await prisma.task.findMany()
    expect(tasks).toHaveLength(TASK_STATUSES.length)
    expect(tasks.map((t) => t.status).sort()).toEqual([...TASK_STATUSES].sort())
  })

  it('copies maxAttempts from the workspace onto every task', async () => {
    await seed()

    const workspace = await prisma.workspace.findFirstOrThrow()
    const tasks = await prisma.task.findMany({ select: { maxAttempts: true } })

    expect(tasks.every((t) => t.maxAttempts === workspace.maxAttempts)).toBe(true)
  })

  it('is idempotent — running it twice leaves the same row counts', async () => {
    await seed()
    const first = {
      agents: await prisma.agent.count(),
      tasks: await prisma.task.count(),
      teams: await prisma.team.count(),
    }

    await seed()
    const second = {
      agents: await prisma.agent.count(),
      tasks: await prisma.task.count(),
      teams: await prisma.team.count(),
    }

    expect(second).toEqual(first)
  })
})
