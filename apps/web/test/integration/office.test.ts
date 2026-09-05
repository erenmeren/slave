import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEPT_COLORS, SLAVE_COLORS } from '../../src/lib/office/engine.js'
import { buildOfficeSnapshot } from '../../src/server/office.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-office-'))
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

let workspaceId = ''
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  const ws = await prisma.workspace.create({ data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] } })
  workspaceId = ws.id
  const product = await prisma.team.create({ data: { workspaceId, name: 'Product' } })
  const engineering = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  await prisma.team.create({ data: { workspaceId, name: 'QA' } })
  await prisma.slave.create({ data: { teamId: engineering.id, name: 'Maya', role: 'qa' } })
  await prisma.slave.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  await prisma.slave.create({ data: { teamId: product.id, name: 'John', role: 'analyst' } })
})

describe('buildOfficeSnapshot', () => {
  it('lists departments and their slaves in name order, with deterministic colours, and the overview', async () => {
    const snapshot = await buildOfficeSnapshot(workspaceId)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    expect(snapshot.workspace).toEqual({ id: workspaceId, name: 'Checkout Platform', archived: false })
    expect(snapshot.departments.map((d) => d.name)).toEqual(['Engineering', 'Product', 'QA'])
    expect(snapshot.departments.map((d) => d.color)).toEqual([DEPT_COLORS[0], DEPT_COLORS[1], DEPT_COLORS[2]])
    expect(snapshot.departments[0]?.slaves.map((s) => s.name)).toEqual(['Alex', 'Maya'])
    expect(snapshot.departments[0]?.slaves.map((s) => s.color)).toEqual([SLAVE_COLORS[0], SLAVE_COLORS[1]])
    expect(snapshot.departments[1]?.slaves[0]).toEqual(expect.objectContaining({ name: 'John', role: 'analyst', color: SLAVE_COLORS[2] }))
    expect(snapshot.departments[2]?.slaves).toEqual([])
    expect(snapshot.overview.workspace.id).toBe(workspaceId)
    expect(snapshot.overview.slaves).toHaveLength(3)
  })

  it('is null for an unknown project and flags an archived one', async () => {
    expect(await buildOfficeSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    expect((await buildOfficeSnapshot(workspaceId))?.workspace.archived).toBe(true)
  })
})
