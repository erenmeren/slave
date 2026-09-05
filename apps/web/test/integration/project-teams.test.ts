import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listProjectTeams } from '../../src/server/org.js'

// A real directory, not a placeholder (M23 G3 idiom -- see `packages/control/test/integration/
// org-edit.test.ts`'s own comment): `Workspace.repoPath` needs to exist for anything that stats
// it, and a reboot clears /tmp.
const repoA = mkdtempSync(join(tmpdir(), 'slaveofai-project-teams-a-'))
const repoB = mkdtempSync(join(tmpdir(), 'slaveofai-project-teams-b-'))

afterAll(() => {
  rmSync(repoA, { recursive: true, force: true })
  rmSync(repoB, { recursive: true, force: true })
})

interface Fixture {
  readonly checkoutTeamId: string
  readonly checkoutEmptyTeamId: string
  readonly billingTeamId: string
}

/**
 * Two workspaces ("Checkout", "Billing" -- alphabetical by workspace name, exercising
 * `listProjectTeams`'s `orderBy: [{ workspace: { name: 'asc' } }, { name: 'asc' }]`): Checkout
 * gets two teams, one with two slaves and one empty, to prove `slaveCount` and the per-workspace
 * secondary sort both come out right; Billing gets one team with a single slave.
 */
async function seed(): Promise<Fixture> {
  const checkout = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: repoA, verifyCommands: ['true'], setupCommands: [] },
  })
  const billing = await prisma.workspace.create({
    data: { name: 'Billing', repoPath: repoB, verifyCommands: ['true'], setupCommands: [] },
  })
  // 'Widgets' sorts after 'Engineering' -- proves the name-ascending secondary sort within one
  // workspace, not just insertion order.
  const widgets = await prisma.team.create({ data: { workspaceId: checkout.id, name: 'Widgets' } })
  const engineering = await prisma.team.create({ data: { workspaceId: checkout.id, name: 'Engineering' } })
  const billingTeam = await prisma.team.create({ data: { workspaceId: billing.id, name: 'Finance' } })

  await prisma.slave.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  await prisma.slave.create({ data: { teamId: engineering.id, name: 'Sam', role: 'frontend' } })
  await prisma.slave.create({ data: { teamId: billingTeam.id, name: 'Riley', role: 'backend' } })

  return { checkoutTeamId: engineering.id, checkoutEmptyTeamId: widgets.id, billingTeamId: billingTeam.id }
}

describe('listProjectTeams', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists every team across every workspace, ordered by project then name, with each team\'s slave count', async (): Promise<void> => {
    const teams = await listProjectTeams()

    expect(teams.map((t) => ({ project: t.projectName, name: t.name, slaveCount: t.slaveCount }))).toEqual([
      { project: 'Billing', name: 'Finance', slaveCount: 1 },
      { project: 'Checkout Platform', name: 'Engineering', slaveCount: 2 },
      { project: 'Checkout Platform', name: 'Widgets', slaveCount: 0 },
    ])
  })

  it('carries the real teamId/workspaceId for each row', async (): Promise<void> => {
    const teams = await listProjectTeams()

    const engineering = teams.find((t) => t.teamId === fixture.checkoutTeamId)
    expect(engineering?.name).toBe('Engineering')
    expect(engineering?.slaveCount).toBe(2)

    const widgets = teams.find((t) => t.teamId === fixture.checkoutEmptyTeamId)
    expect(widgets?.slaveCount).toBe(0)

    const finance = teams.find((t) => t.teamId === fixture.billingTeamId)
    expect(finance?.slaveCount).toBe(1)
  })
})
