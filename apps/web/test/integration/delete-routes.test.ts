import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DELETE as deleteCompany } from '../../src/app/api/org/companies/[companyId]/route.js'
import { DELETE as deleteCompanySlave } from '../../src/app/api/org/slaves/[companySlaveId]/route.js'
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
  const companySlave = await prisma.companySlave.create({ data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' } })
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [], companyId: company.id },
  })
  return { workspaceId: workspace.id, companyId: company.id, templateId: template.id, companyTeamId: companyTeam.id, companySlaveId: companySlave.id }
}

let f: Fixture
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  f = await seed()
})

describe('catalog delete routes', () => {
  it('DELETE /api/org/slaves/[companySlaveId] removes the catalog slave', async () => {
    const res = await deleteCompanySlave(req(), { params: Promise.resolve({ companySlaveId: f.companySlaveId }) })
    expect(res.status).toBe(200)
    expect(await prisma.companySlave.findUnique({ where: { id: f.companySlaveId } })).toBeNull()
  })

  it('DELETE /api/org/templates/[templateId] removes the template and its catalog slaves', async () => {
    const res = await deleteTemplate(req(), { params: Promise.resolve({ templateId: f.templateId }) })
    expect(res.status).toBe(200)
    expect(await prisma.slaveTemplate.findUnique({ where: { id: f.templateId } })).toBeNull()
    expect(await prisma.companySlave.count({ where: { templateId: f.templateId } })).toBe(0)
  })

  it('DELETE /api/org/companies/[companyId] removes the company and clears the workspace\'s companyId', async () => {
    const res = await deleteCompany(req(), { params: Promise.resolve({ companyId: f.companyId }) })
    expect(res.status).toBe(200)
    expect(await prisma.company.findUnique({ where: { id: f.companyId } })).toBeNull()
    expect((await prisma.workspace.findUnique({ where: { id: f.workspaceId } }))?.companyId).toBeNull()
  })

  it('409s each on an unknown id with the refusal text', async () => {
    const companySlave = await deleteCompanySlave(req(), { params: Promise.resolve({ companySlaveId: 'nope' }) })
    expect(companySlave.status).toBe(409)
    expect(((await companySlave.json()) as { error: string }).error).toBe('no catalog slave with id nope')

    const template = await deleteTemplate(req(), { params: Promise.resolve({ templateId: 'nope' }) })
    expect(template.status).toBe(409)
    expect(((await template.json()) as { error: string }).error).toBe('no template with id nope')

    const company = await deleteCompany(req(), { params: Promise.resolve({ companyId: 'nope' }) })
    expect(company.status).toBe(409)
    expect(((await company.json()) as { error: string }).error).toBe('no company with id nope')
  })
})
