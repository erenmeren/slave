import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as createTeam } from '../../src/app/api/w/[workspaceId]/teams/route.js'
import { PUT as moveSlaveRoute } from '../../src/app/api/slaves/[slaveId]/team/route.js'
import { PUT as moveCompanySlaveRoute } from '../../src/app/api/org/slaves/[companySlaveId]/team/route.js'
import { PUT as renameTemplate } from '../../src/app/api/org/teams/[companyTeamId]/name/route.js'
import { DELETE as deleteTemplate } from '../../src/app/api/org/teams/[companyTeamId]/route.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-department-routes-'))
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

function json(body: unknown, method: 'POST' | 'PUT'): Request {
  return new Request('http://test/api', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

interface Fixture {
  readonly workspaceId: string
  readonly engineeringId: string
  readonly qaId: string
  readonly slaveId: string
  readonly templateTeamId: string
  readonly emptyTemplateTeamId: string
  readonly companySlaveId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const engineering = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const qa = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  const slave = await prisma.slave.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend', description: '' } })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const templateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const emptyTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
  const companySlave = await prisma.companySlave.create({
    data: { companyTeamId: templateTeam.id, templateId: template.id, name: 'Sam' },
  })
  return {
    workspaceId: workspace.id,
    engineeringId: engineering.id,
    qaId: qa.id,
    slaveId: slave.id,
    templateTeamId: templateTeam.id,
    emptyTemplateTeamId: emptyTemplateTeam.id,
    companySlaveId: companySlave.id,
  }
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('POST /api/w/[workspaceId]/teams', () => {
  it('creates the department and answers its id', async () => {
    const response = await createTeam(json({ name: 'Design' }, 'POST'), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: true; id: string }
    const row = await prisma.team.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.name).toBe('Design')
  })

  it('400s a body without a name and 409s a duplicate name with the refusal text', async () => {
    const bad = await createTeam(json({}, 'POST'), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
    expect(bad.status).toBe(400)

    const dup = await createTeam(json({ name: 'QA' }, 'POST'), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: string }).error).toContain('QA')
  })
})

describe('PUT /api/slaves/[slaveId]/team', () => {
  it('moves the slave', async () => {
    const response = await moveSlaveRoute(json({ teamId: fixture.qaId }, 'PUT'), { params: Promise.resolve({ slaveId: fixture.slaveId }) })
    expect(response.status).toBe(200)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId } })
    expect(row.teamId).toBe(fixture.qaId)
  })

  it('400s without a teamId', async () => {
    const response = await moveSlaveRoute(json({}, 'PUT'), { params: Promise.resolve({ slaveId: fixture.slaveId }) })
    expect(response.status).toBe(400)
  })
})

describe('PUT /api/org/slaves/[companySlaveId]/team', () => {
  it('moves the catalog slave', async () => {
    const response = await moveCompanySlaveRoute(json({ companyTeamId: fixture.emptyTemplateTeamId }, 'PUT'), {
      params: Promise.resolve({ companySlaveId: fixture.companySlaveId }),
    })
    expect(response.status).toBe(200)
    const row = await prisma.companySlave.findUniqueOrThrow({ where: { id: fixture.companySlaveId } })
    expect(row.companyTeamId).toBe(fixture.emptyTemplateTeamId)
  })
})

describe('PUT /api/org/teams/[companyTeamId]/name and DELETE /api/org/teams/[companyTeamId]', () => {
  it('renames the template', async () => {
    const response = await renameTemplate(json({ name: 'Platform' }, 'PUT'), { params: Promise.resolve({ companyTeamId: fixture.emptyTemplateTeamId }) })
    expect(response.status).toBe(200)
    const row = await prisma.companyTeam.findUniqueOrThrow({ where: { id: fixture.emptyTemplateTeamId } })
    expect(row.name).toBe('Platform')
  })

  it('409s deleting a template with members, 200s deleting an empty one', async () => {
    const full = await deleteTemplate(new Request('http://test/api', { method: 'DELETE' }), { params: Promise.resolve({ companyTeamId: fixture.templateTeamId }) })
    expect(full.status).toBe(409)

    const empty = await deleteTemplate(new Request('http://test/api', { method: 'DELETE' }), { params: Promise.resolve({ companyTeamId: fixture.emptyTemplateTeamId }) })
    expect(empty.status).toBe(200)
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.emptyTemplateTeamId } })).toBeNull()
  })
})
