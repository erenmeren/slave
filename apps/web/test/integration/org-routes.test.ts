import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as templatesPOST } from '../../src/app/api/org/templates/route.js'
import { POST as companiesPOST } from '../../src/app/api/org/companies/route.js'
import { POST as teamsPOST } from '../../src/app/api/org/teams/route.js'
import { POST as agentsPOST } from '../../src/app/api/org/agents/route.js'
import { GET as workersGET } from '../../src/app/api/org/workers/route.js'
import { POST as companyPOST } from '../../src/app/api/w/[workspaceId]/company/route.js'
import { POST as modelPOST } from '../../src/app/api/agents/[agentId]/model/route.js'
import { PUT as permissionPUT } from '../../src/app/api/agents/[agentId]/permission/route.js'
import { POST as reseedPOST } from '../../src/app/api/dev/reseed/route.js'

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

// M14 Task 14: the permission route is a PUT (a cell is set to a value, not appended to), so it
// needs its own trio rather than reusing the POST helpers above.
function jsonPutRequest(body: unknown): Request {
  return new Request('http://x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function malformedPutRequest(): Request {
  return new Request('http://x', { method: 'PUT', body: 'not json', headers: { 'content-type': 'application/json' } })
}

function agentParams(agentId: string): { params: Promise<{ agentId: string }> } {
  return { params: Promise.resolve({ agentId }) }
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

    it('accepts an optional description with no model', async (): Promise<void> => {
      const response = await templatesPOST(
        jsonRequest({ name: 'Frontend Engineer', role: 'frontend', description: 'ships UI' }),
      )
      expect(response.status).toBe(200)
      const template = await prisma.agentTemplate.findFirstOrThrow({ where: { name: 'Frontend Engineer' } })
      expect(template.description).toBe('ships UI')
      expect(template.defaultModel).toBeNull()
    })

    // M12 Task 7: `createTemplate` now writes `defaultModel` and `provider` as one pair, and this
    // route does not carry a provider in its body yet (Task 13 owns widening it) -- so a
    // `defaultModel` given through this route always refuses. This test used to assert a
    // successful create with a defaultModel; it now asserts that refusal.
    it('409s with the model-without-provider refusal on a defaultModel given with no provider', async (): Promise<void> => {
      const response = await templatesPOST(
        jsonRequest({ name: 'Frontend Engineer', role: 'frontend', description: 'ships UI', defaultModel: 'sonnet' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must name the provider that runs it')
      expect(await prisma.agentTemplate.findFirst({ where: { name: 'Frontend Engineer' } })).toBeNull()
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

    // M12 Task 13: this route now carries `defaultProvider` beside `defaultModel`, so the pair
    // that Task 7's guard above always refused can now actually be written.
    it('creates a template with a paired defaultModel and defaultProvider', async (): Promise<void> => {
      const response = await templatesPOST(
        jsonRequest({ name: 'Frontend Engineer', role: 'frontend', defaultModel: 'sonnet', defaultProvider: 'claude_code' }),
      )
      expect(response.status).toBe(200)
      const template = await prisma.agentTemplate.findFirstOrThrow({ where: { name: 'Frontend Engineer' } })
      expect(template.defaultModel).toBe('sonnet')
      expect(template.provider).toBe('claude_code')
    })

    it('409s with the invalid-provider refusal text on an unrecognized provider', async (): Promise<void> => {
      const response = await templatesPOST(
        jsonRequest({ name: 'Frontend Engineer', role: 'frontend', defaultModel: 'sonnet', defaultProvider: 'not-a-provider' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a provider must be a configured kind')
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
    it('creates an agent with no model and returns 200', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' }),
      )
      expect(response.status).toBe(200)
      const agent = await prisma.companyAgent.findFirstOrThrow({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } })
      expect(agent.model).toBeNull()
    })

    // M12 Task 7: `addCompanyAgent` now writes `model` and `provider` as one pair, and this route
    // does not carry a provider in its body yet (Task 13 owns widening it) -- so a `model` given
    // through this route always refuses. This test used to assert a successful create with a
    // model; it now asserts that refusal.
    it('409s with the model-without-provider refusal on a model given with no provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: 'opus' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must name the provider that runs it')
      expect(
        await prisma.companyAgent.findFirst({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } }),
      ).toBeNull()
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

    it('409s with the company-team-not-found refusal text on an unknown companyTeamId', async (): Promise<void> => {
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: '00000000-0000-4000-8000-000000000000', templateId: template.id, name: 'Atlas' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no company team with id 00000000-0000-4000-8000-000000000000')
    })

    it('409s with the invalid-model refusal text on a whitespace-only model', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: '   ' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must be a non-empty text')
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await agentsPOST(malformedRequest())
      expect(response.status).toBe(400)
    })

    // M12 Task 13: this route now carries `provider` beside `model`, so the pair Task 7's guard
    // above always refused can now actually be written.
    it('creates an agent with a paired model and provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: 'opus', provider: 'claude_code' }),
      )
      expect(response.status).toBe(200)
      const agent = await prisma.companyAgent.findFirstOrThrow({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } })
      expect(agent.model).toBe('opus')
      expect(agent.provider).toBe('claude_code')
    })

    it('409s with the invalid-provider refusal text on an unrecognized provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.agentTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await agentsPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: 'opus', provider: 'not-a-provider' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a provider must be a configured kind')
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

    // M12 Task 7: `setAgentModel` now writes a model and its provider as one pair, and this route
    // does not carry a provider in its body yet (Task 13 owns widening it) -- so it can only ever
    // clear the pair, never set a real model, until that lands. This test used to assert a
    // successful set; it now asserts the refusal that guards against half a pair.
    it('409s with the model-without-provider refusal, since this route has no provider to pair it with', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus' }), { params: Promise.resolve({ agentId }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must name the provider that runs it')
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
      expect(agent.model).toBeNull()
    })

    it('clears the model override with model: null', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      await prisma.agent.update({ where: { id: agentId }, data: { model: 'opus', provider: 'claude_code' } })
      const response = await modelPOST(jsonRequest({ model: null }), { params: Promise.resolve({ agentId }) })
      expect(response.status).toBe(200)
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
      expect(agent.model).toBeNull()
      expect(agent.provider).toBeNull()
    })

    // `model: null` (not `'opus'`): a non-null model against this route always refuses
    // model-without-provider before it ever reaches the agent lookup (M12 Task 7's guard order),
    // so this exercises the not-found path the same way `setAgentModel`'s own tests do -- via a
    // clear, the one shape this route can still send all the way to the DB write.
    it('409s with the agent-not-found refusal text on an unknown agentId', async (): Promise<void> => {
      const response = await modelPOST(jsonRequest({ model: null }), {
        params: Promise.resolve({ agentId: '00000000-0000-4000-8000-000000000000' }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no agent with id 00000000-0000-4000-8000-000000000000')
    })

    it('409s with the invalid-model refusal text on an empty-string model', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: '' }), { params: Promise.resolve({ agentId }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must be a non-empty text')
    })

    it('400s on a malformed body and on a missing model key', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const malformed = await modelPOST(malformedRequest(), { params: Promise.resolve({ agentId }) })
      expect(malformed.status).toBe(400)

      const missingKey = await modelPOST(jsonRequest({}), { params: Promise.resolve({ agentId }) })
      expect(missingKey.status).toBe(400)
    })

    // M12 Task 13: this route now carries `provider` beside `model`, so the pair Task 7's guard
    // above always refused can now actually be written. `claude_code`, not `cursor`: `seed()`'s
    // workspace is budgeted by the schema default, and only `claude_code` reports cost.
    it('sets a paired model and provider', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus', provider: 'claude_code' }), {
        params: Promise.resolve({ agentId }),
      })
      expect(response.status).toBe(200)
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
      expect(agent.model).toBe('opus')
      expect(agent.provider).toBe('claude_code')
    })

    it('409s with the invalid-provider refusal text on an unrecognized provider', async (): Promise<void> => {
      const { agentId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus', provider: 'not-a-provider' }), {
        params: Promise.resolve({ agentId }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a provider must be a configured kind')
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

    // Renamed by the M14 fix wave (review I4): the route lists every agent now, so "empty" means
    // "this fixture created no agents at all", not "none was roster-linked". The assertion is
    // unchanged -- `seed()` here creates a workspace and nothing else.
    it('returns an empty list when the database holds no agents at all', async (): Promise<void> => {
      const response = await workersGET()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ workers: [] })
    })
  })

  describe('PUT /api/agents/[agentId]/permission', () => {
    async function seedPermissionAgent(): Promise<string> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Permissions' } })
      const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
      return agent.id
    }

    it('writes the cell and returns 200', async (): Promise<void> => {
      const agentId = await seedPermissionAgent()
      const response = await permissionPUT(jsonPutRequest({ tool: 'repo read', mode: 'allow' }), agentParams(agentId))
      expect(response.status).toBe(200)
      expect(await prisma.agentPermission.count({ where: { agentId } })).toBe(1)
    })

    it('409s with the verbatim refusal on a tool outside the six', async (): Promise<void> => {
      const response = await permissionPUT(jsonPutRequest({ tool: 'rm -rf', mode: 'allow' }), agentParams(await seedPermissionAgent()))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'a permission must name one of the six tools' })
    })

    it('400s on a malformed body and on a missing mode', async (): Promise<void> => {
      const agentId = await seedPermissionAgent()
      expect((await permissionPUT(malformedPutRequest(), agentParams(agentId))).status).toBe(400)
      expect((await permissionPUT(jsonPutRequest({ tool: 'repo read' }), agentParams(agentId))).status).toBe(400)
    })

    it('409s with the agent-not-found refusal on an unknown agent', async (): Promise<void> => {
      const response = await permissionPUT(jsonPutRequest({ tool: 'repo read', mode: 'allow' }), agentParams('00000000-0000-4000-8000-000000000000'))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no agent with id 00000000-0000-4000-8000-000000000000')
    })
  })

  describe('POST /api/dev/reseed', () => {
    // Re-pointed by the M14 fix wave (review I8): the route takes the `Request` now, so it can
    // read `sec-fetch-site`. The assertion itself is unchanged.
    function reseedRequest(site?: string): Request {
      return new Request('http://localhost:3000/api/dev/reseed', {
        method: 'POST',
        ...(site === undefined ? {} : { headers: { 'sec-fetch-site': site } }),
      })
    }

    it('404s outside development, so a production build cannot reach it at all', async (): Promise<void> => {
      // `vi.stubEnv`, not a hand-rolled `Object.defineProperty` on `process.env`: Node's env
      // proxy rejects a descriptor that is not writable AND enumerable, and vitest's helper is
      // the one that restores the previous value on `unstubAllEnvs` even if the assertion throws.
      vi.stubEnv('NODE_ENV', 'production')
      try {
        expect((await reseedPOST(reseedRequest())).status).toBe(404)
      } finally {
        vi.unstubAllEnvs()
      }
    })

    // M14 fix wave, review I8: this is the first route on the branch whose unauthenticated
    // invocation destroys local state. A cross-site POST from any page in the developer's browser
    // could wipe the database; `sec-fetch-site` is browser-set and unforgeable from page JS.
    // These assert the REFUSAL only -- no case here is allowed to reach `npm run db:seed`.
    it.each(['cross-site', 'same-site'])('404s a %s POST without touching the database', async (site): Promise<void> => {
      const before = await prisma.workspace.count()
      expect((await reseedPOST(reseedRequest(site))).status).toBe(404)
      expect(await prisma.workspace.count()).toBe(before)
    })

    it('refuses before any side effect, with the same 404 production gets', async (): Promise<void> => {
      const response = await reseedPOST(reseedRequest('cross-site'))
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('not found')
    })
  })
})
