import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { admitRun } from '../../src/budget.js'
import { archiveWorkspace, restoreWorkspace } from '../../src/workspace.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-archive-'))
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
}

/** One project: two departments, one slave, one task, two finished runs. */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const engineering = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  const slave = await prisma.slave.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
  })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'succeeded' } })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'failed' } })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id }
}

async function eventsOfType(workspaceId: string, type: 'workspace_archived' | 'workspace_restored') {
  return prisma.executionEvent.findMany({ where: { workspaceId, type }, orderBy: { seq: 'asc' } })
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('archiveWorkspace', () => {
  it('sets archivedAt, keeps every row, reports the footprint and emits workspace.archived', async () => {
    const result = await archiveWorkspace(fixture.workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.footprint).toEqual({ departments: 2, slaves: 1, tasks: 1, runs: 2 })
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).not.toBeNull()
    expect(await prisma.slaveRun.count()).toBe(2)
    expect(await prisma.slave.count()).toBe(1)

    const events = await eventsOfType(fixture.workspaceId, 'workspace_archived')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ name: 'Checkout Platform', departments: 2, slaves: 1, tasks: 1, runs: 2 })
  })

  it('refuses while a run is live, changing nothing', async () => {
    await prisma.slaveRun.create({ data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working' } })

    const result = await archiveWorkspace(fixture.workspaceId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'live_runs', entity: 'workspace', id: fixture.workspaceId, runs: 1 })
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).toBeNull()
    expect(await eventsOfType(fixture.workspaceId, 'workspace_archived')).toHaveLength(0)
  })

  it('refuses an already archived project and an unknown one', async () => {
    await archiveWorkspace(fixture.workspaceId)
    const twice = await archiveWorkspace(fixture.workspaceId)
    expect(twice.ok).toBe(false)
    if (!twice.ok) expect(twice.error).toEqual({ kind: 'already_archived', workspaceId: fixture.workspaceId })

    const unknown = await archiveWorkspace(UNKNOWN)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'workspace_not_found', workspaceId: UNKNOWN })
  })

  it('leaves a halt in place: archive then restore keeps haltedReason', async () => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { haltedReason: 'emergency stop by test', haltedAt: new Date() } })
    await archiveWorkspace(fixture.workspaceId)
    const restored = await restoreWorkspace(fixture.workspaceId)
    expect(restored.ok).toBe(true)
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).toBeNull()
    expect(row.haltedReason).toBe('emergency stop by test')
  })
})

describe('restoreWorkspace', () => {
  it('clears archivedAt and emits workspace.restored', async () => {
    await archiveWorkspace(fixture.workspaceId)

    const result = await restoreWorkspace(fixture.workspaceId)

    expect(result.ok).toBe(true)
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).toBeNull()
    const events = await eventsOfType(fixture.workspaceId, 'workspace_restored')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ name: 'Checkout Platform' })
  })

  it('refuses a project that is not archived, and an unknown one', async () => {
    const notArchived = await restoreWorkspace(fixture.workspaceId)
    expect(notArchived.ok).toBe(false)
    if (!notArchived.ok) expect(notArchived.error).toEqual({ kind: 'not_archived', workspaceId: fixture.workspaceId })

    const unknown = await restoreWorkspace(UNKNOWN)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'workspace_not_found', workspaceId: UNKNOWN })
  })
})

describe('admitRun on an archived workspace', () => {
  it('refuses workspace_archived before any budget rule', () => {
    const refused = admitRun({
      workspace: { id: 'w1', budgetUsd: null, archivedAt: new Date() },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(refused).toEqual({ ok: false, refusal: { kind: 'workspace_archived', workspaceId: 'w1' } })

    const admitted = admitRun({
      workspace: { id: 'w1', budgetUsd: null, archivedAt: null },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(admitted).toEqual({ ok: true })
  })
})
