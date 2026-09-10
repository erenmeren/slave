import { syncCapabilityTaxonomy } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOrganization, type OrganizationView } from '../../src/server/organization'
import { GET as organizationGET } from '../../src/app/api/w/[workspaceId]/organization/route'
import { seedWorkspace, truncateAll } from './projectFixture'

/** The one `next/headers` mock the route case needs (`workforce-catalog.test.ts`'s idiom). Inert
 *  without `SLAVEOFAI_SESSION_SECRET`: `requirePrincipal` short-circuits before `cookies()`. */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (): undefined => undefined }),
}))

/**
 * `buildOrganization` (M47 R6) against a real board: three workers who each got here a different
 * way, three ready tasks asking for three capabilities -- one covered, one a gap somebody can
 * fill, one nobody anywhere provides -- and one pending proposal about the gap.
 *
 * The taxonomy is a SEEDED reference table, not a fixture: `truncateAll` does not touch
 * `Capability`, and `syncCapabilityTaxonomy()` puts back anything a neighbouring suite edited, so
 * `Application security` and `iOS` are the labels this file asserts on.
 */
describe('buildOrganization', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await truncateAll()
    await syncCapabilityTaxonomy()
    const fixture = await seedWorkspace({ role: 'engineering' })
    workspaceId = fixture.workspaceId

    const platform = await prisma.slaveTemplate.create({
      data: { name: 'Gate Platform Builder', role: 'backend', capabilityKeys: ['backend.api-design'] },
    })
    const security = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    await prisma.collaborationHint.create({
      data: {
        templateId: security.id,
        text: 'Consult the Gate Platform Builder before changing an endpoint.',
        targetTemplateId: platform.id,
        capability: 'backend.api-design',
      },
    })

    // Alex came off a company roster: `seedWorkspace` already made the worker, so this attaches
    // the roster row it was materialised from and the company it belongs to.
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Platform' } })
    const rosterRow = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: platform.id, name: 'Alex' },
    })
    await prisma.workspace.update({ where: { id: workspaceId }, data: { companyId: company.id } })
    await prisma.slave.update({ where: { id: fixture.slaveId }, data: { companySlaveId: rosterRow.id } })

    // Rae predates all of this: no rationale, no roster row, and the `backend` role that makes
    // `backend.api-design` a covered capability rather than a gap.
    await prisma.slave.create({
      data: {
        teamId: fixture.teamId,
        name: 'Rae',
        role: 'backend',
        runtimeRoles: ['backend'],
        capabilities: ['backend.api-design'],
      },
    })
    // Hired for this project, and PROVIDES the missing capability without holding its role -- the
    // shape `formTeam` turns into an `assign_capability` proposal.
    await prisma.slave.create({
      data: {
        teamId: fixture.teamId,
        name: 'Security Reviewer',
        role: 'security',
        runtimeRoles: ['reviewer'],
        capabilities: ['security.application'],
        hiredFromTemplateId: security.id,
        selectionRationale: 'Hired for security.application because the board needs it',
      },
    })

    for (const [title, capability] of [
      ['Ship the checkout API', 'backend.api-design'],
      ['Review the checkout API', 'security.application'],
      ['Ship the phone app', 'mobile.ios'],
    ] as const) {
      await prisma.task.create({
        data: {
          workspaceId,
          title,
          description: 'seeded by the M47 organization fixture',
          status: 'ready',
          requiredRole: 'dev',
          requiredCapabilities: [capability],
          maxAttempts: 3,
        },
      })
    }

    await prisma.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'capability_unstaffed',
        subjectId: 'security.application',
        situation: {
          kind: 'capability_unstaffed',
          subjectId: 'security.application',
          summary: 'Nobody on this project can be dispatched for Application security.',
          facts: { capability: 'security.application', role: 'security', readyTasks: 1 },
        },
        candidates: [],
        chosenIndex: 0,
        action: {
          kind: 'hire_from_catalog',
          templateId: security.id,
          capability: 'security.application',
          name: 'Security Reviewer',
          rationale: 'Security Reviewer provides Application security and nobody here does.',
          temporary: false,
        },
        rationale: 'Security Reviewer provides Application security and nobody here does.',
        tier: 'proposed',
        status: 'pending',
        decidedBy: 'rules',
        modelCalled: false,
      },
    })
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('says who is here, how they got here and what they provide', async () => {
    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.workers.map((worker) => [worker.name, worker.kind, worker.why])).toEqual([
      ['Alex', 'company', 'Assigned from M47 Co'],
      ['Rae', 'project', 'Seeded'],
      ['Security Reviewer', 'project', 'Hired for security.application because the board needs it'],
    ])
    expect(view.workers[2]?.capabilities).toEqual([{ key: 'security.application', label: 'Application security' }])
  })

  it('shows what the board needs, the proposals waiting on a person, and what nobody can do', async () => {
    const view = await buildOrganization(workspaceId)
    if (view === null) return
    expect(view.needs.map((need) => need.capability)).toEqual(['security.application'])
    expect(view.needs[0]?.label).toBe('Application security')
    expect(view.needs[0]?.readyTasks).toBe(1)
    expect(view.needs[0]?.decisions.map((decision) => decision.action.kind)).toEqual(['hire_from_catalog'])
    expect(view.covered.map((one) => one.capability)).toEqual(['backend.api-design'])
    expect(view.unfillable.map((one) => one.capability)).toEqual(['mobile.ios'])
    expect(view.unfillable.map((one) => one.label)).toEqual(['iOS'])
  })

  it('carries the advisory edges, and never anything that dispatches', async () => {
    const view = await buildOrganization(workspaceId)
    if (view === null) return
    expect(view.hints).toEqual([
      {
        slaveId: expect.any(String),
        text: 'Consult the Gate Platform Builder before changing an endpoint.',
        targetTemplateName: 'Gate Platform Builder',
        capability: 'backend.api-design',
      },
    ])
  })

  it('is null for a workspace that is not there', async () => {
    expect(await buildOrganization('nope')).toBeNull()
  })

  it('answers the refetch route the page re-reads itself with, and 404s for a project that is not there', async () => {
    const answer = await organizationGET(new Request('http://test/organization'), {
      params: Promise.resolve({ workspaceId }),
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as OrganizationView
    expect(body.workers.map((worker) => worker.name)).toEqual(['Alex', 'Rae', 'Security Reviewer'])
    expect(body.needs.map((need) => need.capability)).toEqual(['security.application'])

    const missing = await organizationGET(new Request('http://test/organization'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(missing.status).toBe(404)
  })
})
