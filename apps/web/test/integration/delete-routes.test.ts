import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DELETE as deleteCompany } from '../../src/app/api/org/companies/[companyId]/route.js'
import { DELETE as leaveRoster } from '../../src/app/api/org/slaves/[personId]/route.js'
import { DELETE as deleteTemplate } from '../../src/app/api/org/templates/[templateId]/route.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-delete-routes-'))
afterAll(async () => { rmSync(repoPath, { recursive: true, force: true }); await prisma.$disconnect() })

const req = (): Request => new Request('http://test/api', { method: 'DELETE' })

interface Fixture {
  readonly workspaceId: string
  readonly companyId: string
  readonly templateId: string
  readonly companyTeamId: string
  readonly companySlaveId: string
}

// Task 2's control fixture (packages/control/test/integration/delete.test.ts), trimmed to just the
// catalog side plus the one assigned project these routes' cascades touch.
async function seed(): Promise<Fixture> {
  const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend', description: '' } })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const companySlave = await prisma.person.create({ data: { templateId: template.id, name: 'Sam', lifecycle: 'permanent', departments: { create: { companyTeamId: companyTeam.id } } } })
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [], companyId: company.id },
  })
  return { workspaceId: workspace.id, companyId: company.id, templateId: template.id, companyTeamId: companyTeam.id, companySlaveId: companySlave.id }
}

let f: Fixture
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  f = await seed()
})

describe('catalog delete routes', () => {
  // M58 R5: taking somebody off the roster is losing every membership -- the person keeps working.
  it('DELETE /api/org/slaves/[personId] takes them off every department, leaving them there', async () => {
    const res = await leaveRoster(req(), { params: Promise.resolve({ personId: f.companySlaveId }) })
    expect(res.status).toBe(200)
    expect(await prisma.companyTeamMember.count({ where: { personId: f.companySlaveId } })).toBe(0)
    expect(await prisma.person.findUnique({ where: { id: f.companySlaveId } })).not.toBeNull()
  })

  it('DELETE /api/org/templates/[templateId] removes the persona and unlinks everybody hired from it', async () => {
    const res = await deleteTemplate(req(), { params: Promise.resolve({ templateId: f.templateId }) })
    expect(res.status).toBe(200)
    expect(await prisma.slaveTemplate.findUnique({ where: { id: f.templateId } })).toBeNull()
    expect(await prisma.person.count({ where: { templateId: f.templateId } })).toBe(0)
    expect(await prisma.person.findUnique({ where: { id: f.companySlaveId } })).not.toBeNull()
  })

  it('DELETE /api/org/companies/[companyId] removes the company and clears the workspace\'s companyId', async () => {
    const res = await deleteCompany(req(), { params: Promise.resolve({ companyId: f.companyId }) })
    expect(res.status).toBe(200)
    expect(await prisma.company.findUnique({ where: { id: f.companyId } })).toBeNull()
    expect((await prisma.workspace.findUnique({ where: { id: f.workspaceId } }))?.companyId).toBeNull()
  })

  it('404s each on an unknown id with the refusal text', async () => {
    const person = await leaveRoster(req(), { params: Promise.resolve({ personId: 'nope' }) })
    expect(person.status).toBe(404)
    expect(((await person.json()) as { error: string }).error).toBe('no slave with id nope')

    const template = await deleteTemplate(req(), { params: Promise.resolve({ templateId: 'nope' }) })
    expect(template.status).toBe(404)
    expect(((await template.json()) as { error: string }).error).toBe('no template with id nope')

    const company = await deleteCompany(req(), { params: Promise.resolve({ companyId: 'nope' }) })
    expect(company.status).toBe(404)
    expect(((await company.json()) as { error: string }).error).toBe('no company with id nope')
  })
})
