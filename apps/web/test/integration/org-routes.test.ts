import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as templatesPOST } from '../../src/app/api/org/templates/route.js'
import { POST as companiesPOST } from '../../src/app/api/org/companies/route.js'
import { POST as teamsPOST } from '../../src/app/api/org/teams/route.js'
import { POST as agentsPOST } from '../../src/app/api/org/agents/route.js'
import { GET as workersGET } from '../../src/app/api/org/workers/route.js'
import { POST as companyPOST } from '../../src/app/api/w/[workspaceId]/company/route.js'
import { POST as modelPOST } from '../../src/app/api/agents/[agentId]/model/route.js'

interface Fixture {
  readonly workspaceId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/org-routes-fixture', verifyCommands: ['true'], setupCommands: [] },
  })
  return { workspaceId: workspace.id }
}

function jsonRequest(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function malformedRequest(): Request {
  return new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })
}

describe('the org routes', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('POST /api/org/templates', () => {
    it('creates a template and returns 200', async (): Promise<void> => {
      const response = await templatesPOST(jsonRequest({ name: 'Backend Engineer', role: 'backend' }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })

      const template = await prisma.agentTemplate.findFirstOrThrow({ where: { name: 'Backend Engineer' } })
      expect(template.role).toBe('backend')
    })

    it('accepts optional description and defaultModel', async (): Promise<void> => {
      const response = await templatesPOST(
        jsonRequest({ name: 'Frontend Engineer', role: 'frontend', description: 'ships UI', defaultModel: 'sonnet' }),
      )
      expect(response.status).toBe(200)
      const template = await prisma.agentTemplate.findFirstOrThrow({ where: { name: 'Frontend Engineer' } })
      expect(template.description).toBe('ships UI')
      expect(template.defaultModel).toBe('sonnet')
    })

    it('409s with the duplicate-name refusal text on a repeated name', async (): Promise<void> => {
      await templatesPOST(jsonRequest({ name: 'Backend Engineer', role: 'backend' }))
      const response = await templatesPOST(jsonRequest({ name: 'Backend Engineer', role: 'backend' }))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('the name "Backend Engineer" is already taken')
    })

    it('400s on a malformed body and on a missing role', async (): Promise<void> => {
      const malformed = await templatesPOST(malformedRequest())
      expect(malformed.status).toBe(400)

      const missingRole = await templatesPOST(jsonRequest({ name: 'Backend Engineer' }))
      expect(missingRole.status).toBe(400)
    })
  })

  describe('POST /api/org/companies', () => {
    it('creates a company and returns 200', async (): Promise<void> => {
      const response = await companiesPOST(jsonRequest({ name: 'Acme Robotics' }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      await prisma.company.findFirstOrThrow({ where: { name: 'Acme Robotics' } })
    })

    it('409s with the duplicate-name refusal text on a repeated name', async (): Promise<void> => {
      await companiesPOST(jsonRequest({ name: 'Acme Robotics' }))
      const response = await companiesPOST(jsonRequest({ name: 'Acme Robotics' }))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('the name "Acme Robotics" is already taken')
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await companiesPOST(malformedRequest())
      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/org/teams', () => {
    it('creates a team and returns 200', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const response = await teamsPOST(jsonRequest({ companyId: company.id, name: 'Engineering' }))
      expect(response.status).toBe(200)
      await prisma.companyTeam.findFirstOrThrow({ where: { companyId: company.id, name: 'Engineering' } })
    })

    it('409s with the company-not-found refusal text on an unknown companyId', async (): Promise<void> => {
      const response = await teamsPOST(jsonRequest({ companyId: '00000000-0000-4000-8000-000000000000', name: 'Engineering' }))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no company with id 00000000-0000-4000-8000-000000000000')
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await teamsPOST(malformedRequest())
      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/org/agents', () => {
    it('creates an agent and returns 200', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: 'opus' }),
      )
      expect(response.status).toBe(200)
      const agent = await prisma.companyAgent.findFirstOrThrow({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } })
      expect(agent.model).toBe('opus')
    })

    it('409s with the template-not-found refusal text on an unknown templateId', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: '00000000-0000-4000-8000-000000000000', name: 'Atlas' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no template with id 00000000-0000-4000-8000-000000000000')
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await agentsPOST(malformedRequest())
      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/w/[workspaceId]/company', () => {
    it('assigns a company to a workspace and returns 200', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const response = await companyPOST(jsonRequest({ companyId: company.id }), {
        params: Promise.resolve({ workspaceId: fixture.workspaceId }),
      })
      expect(response.status).toBe(200)
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
      expect(workspace.companyId).toBe(company.id)
    })

    it('409s with "this workspace is already run by ..." when assigning a different company', async (): Promise<void> => {
      const first = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const second = await prisma.company.create({ data: { name: 'Globex' } })
      await companyPOST(jsonRequest({ companyId: first.id }), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })

      const response = await companyPOST(jsonRequest({ companyId: second.id }), {
        params: Promise.resolve({ workspaceId: fixture.workspaceId }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('this workspace is already run by Acme Robotics')
    })

    it('404s an unknown workspace', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const response = await companyPOST(jsonRequest({ companyId: company.id }), {
        params: Promise.resolve({ workspaceId: '00000000-0000-4000-8000-000000000000' }),
      })
      expect(response.status).toBe(404)
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await companyPOST(malformedRequest(), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/agents/[agentId]/model', () => {
    async function seedWorker(): Promise<{ agentId: string }> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Atlas', role: 'backend' } })
      return { agentId: agent.id }
    }

    it('sets the model override and returns 200', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus' }), { params: Promise.resolve({ agentId }) })
      expect(response.status).toBe(200)
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
      expect(agent.model).toBe('opus')
    })

    it('clears the model override with model: null', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      await prisma.agent.update({ where: { id: agentId }, data: { model: 'opus' } })
      const response = await modelPOST(jsonRequest({ model: null }), { params: Promise.resolve({ agentId }) })
      expect(response.status).toBe(200)
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
      expect(agent.model).toBeNull()
    })

    it('409s with the agent-not-found refusal text on an unknown agentId', async (): Promise<void> => {
      const response = await modelPOST(jsonRequest({ model: 'opus' }), {
        params: Promise.resolve({ agentId: '00000000-0000-4000-8000-000000000000' }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no agent with id 00000000-0000-4000-8000-000000000000')
    })

    it('400s on a malformed body and on a missing model key', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const malformed = await modelPOST(malformedRequest(), { params: Promise.resolve({ agentId }) })
      expect(malformed.status).toBe(400)

      const missingKey = await modelPOST(jsonRequest({}), { params: Promise.resolve({ agentId }) })
      expect(missingKey.status).toBe(400)
    })
  })

  describe('GET /api/org/workers', () => {
    it('returns the assigned workers', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      const companyAgent = await prisma.companyAgent.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      await prisma.agent.create({
        data: { teamId: team.id, name: 'Atlas (worker)', role: 'backend', companyAgentId: companyAgent.id },
      })

      const response = await workersGET()
      expect(response.status).toBe(200)
      const body = (await response.json()) as { workers: readonly { name: string }[] }
      expect(body.workers).toHaveLength(1)
      expect(body.workers[0]?.name).toBe('Atlas (worker)')
    })

    it('returns an empty list when no worker is roster-linked', async (): Promise<void> => {
      const response = await workersGET()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ workers: [] })
    })
  })
})
