import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as archive } from '../../src/app/api/w/[workspaceId]/archive/route.js'
import { POST as restore } from '../../src/app/api/w/[workspaceId]/restore/route.js'
import { POST as setGoalRoute } from '../../src/app/api/w/[workspaceId]/goal/route.js'
import { listProjects, listWorkspaceNames } from '../../src/server/org.js'
import { buildProjectSettings } from '../../src/server/projectSettings.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-archive-routes-'))
afterAll(async () => { rmSync(repoPath, { recursive: true, force: true }); await prisma.$disconnect() })

const req = (method: 'POST', body?: unknown): Request =>
  new Request('http://test/api', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })

let workspaceId = ''
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  const ws = await prisma.workspace.create({ data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] } })
  await prisma.team.create({ data: { workspaceId: ws.id, name: 'Engineering' } })
  workspaceId = ws.id
})

describe('archive and restore routes', () => {
  it('archives, hides the project from the default lists, blocks writes, then restores', async () => {
    const archived = await archive(req('POST'), { params: Promise.resolve({ workspaceId }) })
    expect(archived.status).toBe(200)
    expect(((await archived.json()) as { footprint: { departments: number } }).footprint.departments).toBe(1)

    expect((await listProjects()).length).toBe(0)
    expect((await listProjects({ includeArchived: true }))[0]?.archived).toBe(true)
    expect((await listWorkspaceNames()).length).toBe(0)
    const settings = await buildProjectSettings(workspaceId)
    expect(settings?.workspace.archived).toBe(true)
    expect(settings?.footprint).toEqual({ departments: 1, slaves: 0, tasks: 0, runs: 0 })

    const write = await setGoalRoute(req('POST', { goal: 'Ship it' }), { params: Promise.resolve({ workspaceId }) })
    expect(write.status).toBe(409)
    expect(((await write.json()) as { error: string }).error).toContain('archived')

    const restored = await restore(req('POST'), { params: Promise.resolve({ workspaceId }) })
    expect(restored.status).toBe(200)
    expect((await listProjects()).length).toBe(1)
  })

  it('409s a second archive and a restore of a live project', async () => {
    expect((await restore(req('POST'), { params: Promise.resolve({ workspaceId }) })).status).toBe(409)
    await archive(req('POST'), { params: Promise.resolve({ workspaceId }) })
    expect((await archive(req('POST'), { params: Promise.resolve({ workspaceId }) })).status).toBe(409)
  })
})
