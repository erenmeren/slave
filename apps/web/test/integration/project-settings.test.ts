import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildProjectSettings } from '../../src/server/projectSettings.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
}

/** `name` unique per test so two workspaces in the same `it` never collide on `Workspace`'s
 *  implicit uniqueness-by-fixture assumptions the way `Overview`'s single-workspace fixture can. */
async function seed(name: string, over: Partial<{ goal: string | null; budgetUsd: number | null }> = {}): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      repoPath: `/tmp/project-settings-${name}`,
      verifyCommands: ['true'],
      setupCommands: [],
      goal: over.goal ?? null,
      budgetUsd: over.budgetUsd ?? null,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

describe('buildProjectSettings', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "SlavePermission", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "ProviderConfiguration", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildProjectSettings('nope')).toBeNull()
  })

  it('carries the goal, runtime, budget, limits and this workspace’s one permission section', async (): Promise<void> => {
    const fixture = await seed('Checkout Platform', { goal: 'ship checkout', budgetUsd: 1 })
    await prisma.providerConfiguration.create({
      data: { workspaceId: fixture.workspaceId, kind: 'cursor', settings: {} },
    })
    await prisma.slavePermission.create({
      data: { slaveId: fixture.slaveId, tool: 'repo read', mode: 'allow' },
    })

    const settings = await buildProjectSettings(fixture.workspaceId)

    expect(settings?.workspace.id).toBe(fixture.workspaceId)
    expect(settings?.workspace.name).toBe('Checkout Platform')
    expect(settings?.workspace.goal).toBe('ship checkout')
    expect(settings?.workspace.provider).toBe('cursor')
    expect(settings?.workspace.budgetUsd).toBe(1)
    // `capabilitiesOf('cursor').reportsCost` is false and the workspace is budgeted -- the exact
    // pair `admitRun` refuses at dispatch, mirrored here verbatim from `overview.ts`'s own rule.
    expect(settings?.workspace.costBlindBudgeted).toBe(true)
    // The schema's own defaults (`Workspace.maxConcurrentRuns`/`runTimeoutMs`/`maxAttempts`) --
    // this fixture never sets them, and a plain field read must carry them through unchanged.
    expect(settings?.workspace.maxConcurrentRuns).toBe(3)
    expect(settings?.workspace.runTimeoutMs).toBe(1_800_000)
    expect(settings?.workspace.maxAttempts).toBe(3)
    expect(settings?.workspace.haltedReason).toBeNull()

    expect(settings?.permissions?.workspaceId).toBe(fixture.workspaceId)
    expect(settings?.permissions?.rows[0]?.slaveId).toBe(fixture.slaveId)
    expect(settings?.permissions?.rows[0]?.cells.find((c) => c.tool === 'repo read')?.mode).toBe('allow')
  })

  it('never leaks a second workspace’s permissions into this one’s section', async (): Promise<void> => {
    const fixtureA = await seed('Checkout Platform')
    const fixtureB = await seed('Billing Platform')
    await prisma.slavePermission.create({ data: { slaveId: fixtureB.slaveId, tool: 'deploy prod', mode: 'deny' } })

    const settings = await buildProjectSettings(fixtureA.workspaceId)

    expect(settings?.permissions?.workspaceId).toBe(fixtureA.workspaceId)
    expect(settings?.permissions?.rows.map((r) => r.slaveId)).toEqual([fixtureA.slaveId])
    expect(settings?.permissions?.rows.some((r) => r.slaveId === fixtureB.slaveId)).toBe(false)
  })

  it('gives a workspace with no slaves an empty section, not a missing one', async (): Promise<void> => {
    // `sections[0] ?? null` in `buildProjectSettings` guards the case `buildPermissionMatrix`
    // finds no matching workspace row at all -- which cannot happen here, since this workspace
    // was just read successfully above it. An empty roster is a section with no rows, not null.
    const workspace = await prisma.workspace.create({
      data: { name: 'Empty Project', repoPath: '/tmp/project-settings-empty', verifyCommands: ['true'], setupCommands: [] },
    })

    const settings = await buildProjectSettings(workspace.id)

    expect(settings?.permissions?.workspaceId).toBe(workspace.id)
    expect(settings?.permissions?.rows).toEqual([])
  })
})
