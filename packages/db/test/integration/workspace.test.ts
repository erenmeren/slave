import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

describe('workspace persistence', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('round-trips a workspace with its guardrail defaults', async () => {
    const created = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
    })

    const found = await prisma.workspace.findUniqueOrThrow({ where: { id: created.id } })

    expect(found.name).toBe('Checkout Platform')
    expect(found.baseBranch).toBe('main')
    expect(found.maxConcurrentRuns).toBe(3)
    expect(found.maxAttempts).toBe(3)
    expect(found.budgetUsd).toBe(20)
  })

  it('cascades team and agent deletion from the workspace', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })

    await prisma.workspace.delete({ where: { id: workspace.id } })

    expect(await prisma.agent.count()).toBe(0)
    expect(await prisma.team.count()).toBe(0)
  })
})
