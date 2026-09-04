import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildShellFacts } from '../../src/server/shell.js'

// A real directory, not a placeholder (M23 G3 idiom -- see `packages/control/test/integration/
// org-edit.test.ts`'s own comment): `Workspace.repoPath` needs to exist for anything that stats
// it, and a reboot clears /tmp.
const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-shell-facts-'))

afterAll(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
}

async function seed(overrides: { readonly goal?: string | null; readonly haltedReason?: string | null } = {}): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 2,
      goal: 'goal' in overrides ? overrides.goal ?? null : 'Ship it',
      haltedReason: overrides.haltedReason ?? null,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

describe('buildShellFacts status block', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "AgentRun", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('sums known spend, counts the unmeasured run, and carries the goal and halt state through', async (): Promise<void> => {
    const fixture = await seed()
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'claude_code', costUsd: 0.25 },
    })
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'claude_code', costUsd: null },
    })

    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.status).toEqual({ goal: 'Ship it', spentUsd: 0.25, unmeasuredRuns: 1, haltedReason: null })
  })

  it('carries a halted workspace with no goal through as null goal and the halt reason', async (): Promise<void> => {
    const fixture = await seed({ goal: null, haltedReason: 'emergency stop by t' })

    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.status).toEqual({ goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: 'emergency stop by t' })
  })
})
