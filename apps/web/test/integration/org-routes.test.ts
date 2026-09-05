import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as templatesPOST } from '../../src/app/api/org/templates/route.js'
import { POST as companiesPOST } from '../../src/app/api/org/companies/route.js'
import { POST as teamsPOST } from '../../src/app/api/org/teams/route.js'
import { POST as slavesPOST } from '../../src/app/api/org/slaves/route.js'
import { GET as workersGET } from '../../src/app/api/org/workers/route.js'
import { POST as companyPOST } from '../../src/app/api/w/[workspaceId]/company/route.js'
import { POST as modelPOST } from '../../src/app/api/slaves/[slaveId]/model/route.js'
import { PUT as permissionPUT } from '../../src/app/api/slaves/[slaveId]/permission/route.js'
import { PUT as slaveNamePUT } from '../../src/app/api/slaves/[slaveId]/name/route.js'
import { PUT as slaveRolePUT } from '../../src/app/api/slaves/[slaveId]/role/route.js'
import { DELETE as slaveDELETE } from '../../src/app/api/slaves/[slaveId]/route.js'
import { PUT as teamNamePUT } from '../../src/app/api/teams/[teamId]/name/route.js'
import { DELETE as teamDELETE } from '../../src/app/api/teams/[teamId]/route.js'
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

function slaveParams(slaveId: string): { params: Promise<{ slaveId: string }> } {
  return { params: Promise.resolve({ slaveId }) }
}

// M23 D3 fix round 1: the roster-editing routes' own `teamId` pair to `slaveParams` above.
function teamParams(teamId: string): { params: Promise<{ teamId: string }> } {
  return { params: Promise.resolve({ teamId }) }
}

function deleteRequest(): Request {
  return new Request('http://x', { method: 'DELETE' })
}

describe('the org routes', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
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

      const template = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Backend Engineer' } })
      expect(template.role).toBe('backend')
    })

    it('accepts an optional description with no model', async (): Promise<void> => {
      const response = await templatesPOST(
        jsonRequest({ name: 'Frontend Engineer', role: 'frontend', description: 'ships UI' }),
      )
      expect(response.status).toBe(200)
      const template = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Frontend Engineer' } })
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
      expect(await prisma.slaveTemplate.findFirst({ where: { name: 'Frontend Engineer' } })).toBeNull()
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
      const template = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Frontend Engineer' } })
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

  describe('POST /api/org/slaves', () => {
    it('creates a slave with no model and returns 200', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await slavesPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' }),
      )
      expect(response.status).toBe(200)
      const slave = await prisma.companySlave.findFirstOrThrow({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } })
      expect(slave.model).toBeNull()
    })

    // M12 Task 7: `addCompanySlave` now writes `model` and `provider` as one pair, and this route
    // does not carry a provider in its body yet (Task 13 owns widening it) -- so a `model` given
    // through this route always refuses. This test used to assert a successful create with a
    // model; it now asserts that refusal.
    it('409s with the model-without-provider refusal on a model given with no provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await slavesPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: 'opus' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must name the provider that runs it')
      expect(
        await prisma.companySlave.findFirst({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } }),
      ).toBeNull()
    })

    it('409s with the template-not-found refusal text on an unknown templateId', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })

      const response = await slavesPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: '00000000-0000-4000-8000-000000000000', name: 'Atlas' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no template with id 00000000-0000-4000-8000-000000000000')
    })

    it('409s with the company-team-not-found refusal text on an unknown companyTeamId', async (): Promise<void> => {
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await slavesPOST(
        jsonRequest({ companyTeamId: '00000000-0000-4000-8000-000000000000', templateId: template.id, name: 'Atlas' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no company team with id 00000000-0000-4000-8000-000000000000')
    })

    it('409s with the invalid-model refusal text on a whitespace-only model', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await slavesPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: '   ' }),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must be a non-empty text')
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await slavesPOST(malformedRequest())
      expect(response.status).toBe(400)
    })

    // M12 Task 13: this route now carries `provider` beside `model`, so the pair Task 7's guard
    // above always refused can now actually be written.
    it('creates a slave with a paired model and provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await slavesPOST(
        jsonRequest({ companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas', model: 'opus', provider: 'claude_code' }),
      )
      expect(response.status).toBe(200)
      const slave = await prisma.companySlave.findFirstOrThrow({ where: { companyTeamId: companyTeam.id, name: 'Atlas' } })
      expect(slave.model).toBe('opus')
      expect(slave.provider).toBe('claude_code')
    })

    it('409s with the invalid-provider refusal text on an unrecognized provider', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })

      const response = await slavesPOST(
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

  describe('POST /api/slaves/[slaveId]/model', () => {
    async function seedWorker(): Promise<{ slaveId: string }> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Atlas', role: 'backend' } })
      return { slaveId: slave.id }
    }

    // M12 Task 7: `setSlaveModel` now writes a model and its provider as one pair, and this route
    // does not carry a provider in its body yet (Task 13 owns widening it) -- so it can only ever
    // clear the pair, never set a real model, until that lands. This test used to assert a
    // successful set; it now asserts the refusal that guards against half a pair.
    it('409s with the model-without-provider refusal, since this route has no provider to pair it with', async (): Promise<void> => {
      const { slaveId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus' }), { params: Promise.resolve({ slaveId }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must name the provider that runs it')
      const slave = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
      expect(slave.model).toBeNull()
    })

    it('clears the model override with model: null', async (): Promise<void> => {
      const { slaveId } = await seedWorker()
      await prisma.slave.update({ where: { id: slaveId }, data: { model: 'opus', provider: 'claude_code' } })
      const response = await modelPOST(jsonRequest({ model: null }), { params: Promise.resolve({ slaveId }) })
      expect(response.status).toBe(200)
      const slave = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
      expect(slave.model).toBeNull()
      expect(slave.provider).toBeNull()
    })

    // `model: null` (not `'opus'`): a non-null model against this route always refuses
    // model-without-provider before it ever reaches the slave lookup (M12 Task 7's guard order),
    // so this exercises the not-found path the same way `setSlaveModel`'s own tests do -- via a
    // clear, the one shape this route can still send all the way to the DB write.
    it('409s with the slave-not-found refusal text on an unknown slaveId', async (): Promise<void> => {
      const response = await modelPOST(jsonRequest({ model: null }), {
        params: Promise.resolve({ slaveId: '00000000-0000-4000-8000-000000000000' }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no slave with id 00000000-0000-4000-8000-000000000000')
    })

    it('409s with the invalid-model refusal text on an empty-string model', async (): Promise<void> => {
      const { slaveId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: '' }), { params: Promise.resolve({ slaveId }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a model must be a non-empty text')
    })

    it('400s on a malformed body and on a missing model key', async (): Promise<void> => {
      const { slaveId } = await seedWorker()
      const malformed = await modelPOST(malformedRequest(), { params: Promise.resolve({ slaveId }) })
      expect(malformed.status).toBe(400)

      const missingKey = await modelPOST(jsonRequest({}), { params: Promise.resolve({ slaveId }) })
      expect(missingKey.status).toBe(400)
    })

    // M12 Task 13: this route now carries `provider` beside `model`, so the pair Task 7's guard
    // above always refused can now actually be written. `claude_code`, not `cursor`: `seed()`'s
    // workspace is budgeted by the schema default, and only `claude_code` reports cost.
    it('sets a paired model and provider', async (): Promise<void> => {
      const { slaveId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus', provider: 'claude_code' }), {
        params: Promise.resolve({ slaveId }),
      })
      expect(response.status).toBe(200)
      const slave = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
      expect(slave.model).toBe('opus')
      expect(slave.provider).toBe('claude_code')
    })

    it('409s with the invalid-provider refusal text on an unrecognized provider', async (): Promise<void> => {
      const { slaveId } = await seedWorker()
      const response = await modelPOST(jsonRequest({ model: 'opus', provider: 'not-a-provider' }), {
        params: Promise.resolve({ slaveId }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a provider must be a configured kind')
    })
  })

  describe('GET /api/org/workers', () => {
    it('returns the assigned workers', async (): Promise<void> => {
      const company = await prisma.company.create({ data: { name: 'Acme Robotics' } })
      const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Engineering' } })
      const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Engineer', role: 'backend' } })
      const companySlave = await prisma.companySlave.create({
        data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Atlas' },
      })
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      await prisma.slave.create({
        data: { teamId: team.id, name: 'Atlas (worker)', role: 'backend', companySlaveId: companySlave.id },
      })

      const response = await workersGET()
      expect(response.status).toBe(200)
      const body = (await response.json()) as { workers: readonly { name: string }[] }
      expect(body.workers).toHaveLength(1)
      expect(body.workers[0]?.name).toBe('Atlas (worker)')
    })

    // Renamed by the M14 fix wave (review I4): the route lists every slave now, so "empty" means
    // "this fixture created no slaves at all", not "none was roster-linked". The assertion is
    // unchanged -- `seed()` here creates a workspace and nothing else.
    it('returns an empty list when the database holds no slaves at all', async (): Promise<void> => {
      const response = await workersGET()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ workers: [] })
    })
  })

  describe('PUT /api/slaves/[slaveId]/permission', () => {
    async function seedPermissionSlave(): Promise<string> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Permissions' } })
      const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
      return slave.id
    }

    it('writes the cell and returns 200', async (): Promise<void> => {
      const slaveId = await seedPermissionSlave()
      const response = await permissionPUT(jsonPutRequest({ tool: 'repo read', mode: 'allow' }), slaveParams(slaveId))
      expect(response.status).toBe(200)
      expect(await prisma.slavePermission.count({ where: { slaveId } })).toBe(1)
    })

    it('409s with the verbatim refusal on a tool outside the six', async (): Promise<void> => {
      const response = await permissionPUT(jsonPutRequest({ tool: 'rm -rf', mode: 'allow' }), slaveParams(await seedPermissionSlave()))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'a permission must name one of the six tools' })
    })

    it('400s on a malformed body and on a missing mode', async (): Promise<void> => {
      const slaveId = await seedPermissionSlave()
      expect((await permissionPUT(malformedPutRequest(), slaveParams(slaveId))).status).toBe(400)
      expect((await permissionPUT(jsonPutRequest({ tool: 'repo read' }), slaveParams(slaveId))).status).toBe(400)
    })

    it('409s with the slave-not-found refusal on an unknown slave', async (): Promise<void> => {
      const response = await permissionPUT(jsonPutRequest({ tool: 'repo read', mode: 'allow' }), slaveParams('00000000-0000-4000-8000-000000000000'))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('no slave with id 00000000-0000-4000-8000-000000000000')
    })
  })

  // M23 D2/D3 fix round 1: route-level coverage for the five roster-editing routes, following the
  // model/permission routes' own trio (200 proving the verb ran, 409 carrying the refusal text,
  // 400 on a malformed body) -- component tests stub `fetch` and never import these modules, so
  // nothing else in the suite exercises the route handlers themselves (their `BODY_ERROR` branch
  // included).

  describe('PUT /api/slaves/[slaveId]/name', () => {
    async function seedTwoSlaves(): Promise<{ readonly aliceId: string; readonly bobId: string }> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const alice = await prisma.slave.create({ data: { teamId: team.id, name: 'Alice', role: 'backend' } })
      const bob = await prisma.slave.create({ data: { teamId: team.id, name: 'Bob', role: 'frontend' } })
      return { aliceId: alice.id, bobId: bob.id }
    }

    it('renames the slave and returns 200', async (): Promise<void> => {
      const { aliceId } = await seedTwoSlaves()
      const response = await slaveNamePUT(jsonPutRequest({ name: 'Alexis' }), slaveParams(aliceId))
      expect(response.status).toBe(200)
      const slave = await prisma.slave.findUniqueOrThrow({ where: { id: aliceId } })
      expect(slave.name).toBe('Alexis')
    })

    it('409s with the duplicate-name refusal text when renaming onto a sibling', async (): Promise<void> => {
      const { aliceId } = await seedTwoSlaves()
      const response = await slaveNamePUT(jsonPutRequest({ name: 'Bob' }), slaveParams(aliceId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('the name "Bob" is already taken')
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: aliceId } })).name).toBe('Alice')
    })

    it('400s on a malformed body and on a missing name key', async (): Promise<void> => {
      const { aliceId } = await seedTwoSlaves()
      const malformed = await slaveNamePUT(malformedPutRequest(), slaveParams(aliceId))
      expect(malformed.status).toBe(400)

      const missingKey = await slaveNamePUT(jsonPutRequest({}), slaveParams(aliceId))
      expect(missingKey.status).toBe(400)
    })
  })

  describe('PUT /api/slaves/[slaveId]/role', () => {
    async function seedSlave(): Promise<string> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alice', role: 'backend' } })
      return slave.id
    }

    it('sets the role and returns 200', async (): Promise<void> => {
      const slaveId = await seedSlave()
      const response = await slaveRolePUT(jsonPutRequest({ role: 'frontend' }), slaveParams(slaveId))
      expect(response.status).toBe(200)
      const slave = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
      expect(slave.role).toBe('frontend')
    })

    it('409s with the slave-run-active refusal text while a run is live', async (): Promise<void> => {
      const slaveId = await seedSlave()
      const task = await prisma.task.create({
        data: { workspaceId: fixture.workspaceId, title: 'Ship it', description: 'ship it', maxAttempts: 3 },
      })
      const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId, status: 'working' } })

      const response = await slaveRolePUT(jsonPutRequest({ role: 'frontend' }), slaveParams(slaveId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe(
        `slave ${slaveId} has a live run (${run.id}); change its role when the run has ended`,
      )
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })).role).toBe('backend')
    })

    it('400s on a malformed body and on a missing role key', async (): Promise<void> => {
      const slaveId = await seedSlave()
      const malformed = await slaveRolePUT(malformedPutRequest(), slaveParams(slaveId))
      expect(malformed.status).toBe(400)

      const missingKey = await slaveRolePUT(jsonPutRequest({}), slaveParams(slaveId))
      expect(missingKey.status).toBe(400)
    })
  })

  describe('DELETE /api/slaves/[slaveId]', () => {
    async function seedSlave(): Promise<string> {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alice', role: 'backend' } })
      return slave.id
    }

    it('deletes the slave and returns 200', async (): Promise<void> => {
      const slaveId = await seedSlave()
      const response = await slaveDELETE(deleteRequest(), slaveParams(slaveId))
      expect(response.status).toBe(200)
      expect(await prisma.slave.findUnique({ where: { id: slaveId } })).toBeNull()
    })

    // M27 §4.1: `deleteSlave` no longer refuses on run history -- it deletes the slave WITH its
    // runs, refused only while one of them is live.
    it('200s deleting a slave WITH its run history', async (): Promise<void> => {
      const slaveId = await seedSlave()
      const task = await prisma.task.create({
        data: { workspaceId: fixture.workspaceId, title: 'Ship it', description: 'ship it', maxAttempts: 3 },
      })
      await prisma.slaveRun.create({ data: { taskId: task.id, slaveId, status: 'succeeded' } })

      const response = await slaveDELETE(deleteRequest(), slaveParams(slaveId))
      expect(response.status).toBe(200)
      expect(await prisma.slave.findUnique({ where: { id: slaveId } })).toBeNull()
      expect(await prisma.slaveRun.count({ where: { slaveId } })).toBe(0)
    })

    it('409s with the live-runs refusal text while the slave holds a live run', async (): Promise<void> => {
      const slaveId = await seedSlave()
      const task = await prisma.task.create({
        data: { workspaceId: fixture.workspaceId, title: 'Ship it', description: 'ship it', maxAttempts: 3 },
      })
      await prisma.slaveRun.create({ data: { taskId: task.id, slaveId, status: 'working' } })

      const response = await slaveDELETE(deleteRequest(), slaveParams(slaveId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe(`slave ${slaveId} has 1 live run(s); wait for them to finish or stop them first`)
      expect(await prisma.slave.findUnique({ where: { id: slaveId } })).not.toBeNull()
    })
  })

  describe('PUT /api/teams/[teamId]/name', () => {
    async function seedTwoTeams(): Promise<{ readonly engineeringId: string; readonly designId: string }> {
      const engineering = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const design = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Design' } })
      return { engineeringId: engineering.id, designId: design.id }
    }

    it('renames the team and returns 200', async (): Promise<void> => {
      const { engineeringId } = await seedTwoTeams()
      const response = await teamNamePUT(jsonPutRequest({ name: 'Platform' }), teamParams(engineeringId))
      expect(response.status).toBe(200)
      const team = await prisma.team.findUniqueOrThrow({ where: { id: engineeringId } })
      expect(team.name).toBe('Platform')
    })

    it('409s with the duplicate-name refusal text when renaming onto a sibling', async (): Promise<void> => {
      const { engineeringId } = await seedTwoTeams()
      const response = await teamNamePUT(jsonPutRequest({ name: 'Design' }), teamParams(engineeringId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('the name "Design" is already taken')
      expect((await prisma.team.findUniqueOrThrow({ where: { id: engineeringId } })).name).toBe('Engineering')
    })

    it('400s on a malformed body and on a missing name key', async (): Promise<void> => {
      const { engineeringId } = await seedTwoTeams()
      const malformed = await teamNamePUT(malformedPutRequest(), teamParams(engineeringId))
      expect(malformed.status).toBe(400)

      const missingKey = await teamNamePUT(jsonPutRequest({}), teamParams(engineeringId))
      expect(missingKey.status).toBe(400)
    })
  })

  describe('DELETE /api/teams/[teamId]', () => {
    it('deletes an empty team and returns 200', async (): Promise<void> => {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const response = await teamDELETE(deleteRequest(), teamParams(team.id))
      expect(response.status).toBe(200)
      expect(await prisma.team.findUnique({ where: { id: team.id } })).toBeNull()
    })

    // M27 §4.2: `deleteTeam` no longer refuses a non-empty team -- it deletes the department WITH
    // its slaves, refused only while one of them holds a live run.
    it('200s deleting a team WITH its slaves', async (): Promise<void> => {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alice', role: 'backend' } })

      const response = await teamDELETE(deleteRequest(), teamParams(team.id))
      expect(response.status).toBe(200)
      expect(await prisma.team.findUnique({ where: { id: team.id } })).toBeNull()
      expect(await prisma.slave.findUnique({ where: { id: slave.id } })).toBeNull()
    })

    it('409s with the live-runs refusal text while one of its slaves holds a live run', async (): Promise<void> => {
      const team = await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Engineering' } })
      const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alice', role: 'backend' } })
      await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working' } })

      const response = await teamDELETE(deleteRequest(), teamParams(team.id))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe(`department ${team.id} has 1 live run(s); wait for them to finish or stop them first`)
      expect(await prisma.team.findUnique({ where: { id: team.id } })).not.toBeNull()
    })
  })

  describe('POST /api/dev/reseed', () => {
    function reseedRequest(): Request {
      return new Request('http://localhost:3000/api/dev/reseed', { method: 'POST' })
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

    // Cross-site refusal is now owned by the boundary middleware and `apps/web/test/boundary.test.ts`.
    // The middleware 403s any cross-site /api request before this handler runs.
  })
})
