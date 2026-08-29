import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PUT as providerPUT } from '../../src/app/api/w/[workspaceId]/provider/route.js'
import { PUT as budgetPUT } from '../../src/app/api/w/[workspaceId]/budget/route.js'

interface Fixture {
  readonly workspaceId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/workspace-settings-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  return { workspaceId: workspace.id }
}

function jsonRequest(body: unknown): Request {
  return new Request('http://x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function malformedRequest(): Request {
  return new Request('http://x', { method: 'PUT', body: 'not json', headers: { 'content-type': 'application/json' } })
}

function params(workspaceId: string): { params: Promise<{ workspaceId: string }> } {
  return { params: Promise.resolve({ workspaceId }) }
}

describe('the workspace settings routes', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('PUT /api/w/[workspaceId]/provider', () => {
    it('writes the row and returns 200', async (): Promise<void> => {
      const response = await providerPUT(jsonRequest({ provider: 'cursor' }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })

      const rows = await prisma.providerConfiguration.findMany({ where: { workspaceId: fixture.workspaceId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('cursor')
    })

    it('accepts an explicit null and deletes the row', async (): Promise<void> => {
      await providerPUT(jsonRequest({ provider: 'cursor' }), params(fixture.workspaceId))
      const response = await providerPUT(jsonRequest({ provider: null }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect(await prisma.providerConfiguration.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    })

    it('409s with the verbatim refusal on an unknown kind', async (): Promise<void> => {
      const response = await providerPUT(jsonRequest({ provider: 'gpt' }), params(fixture.workspaceId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a provider must be a configured kind')
    })

    it('400s when the body has no provider key at all', async (): Promise<void> => {
      // Distinct from `{ provider: null }`, which is a real instruction ("no default").
      const response = await providerPUT(jsonRequest({}), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })

    it('400s when provider is a non-string, non-null value', async (): Promise<void> => {
      // Exercises the route's second guard (wrong JS type for a present key), distinct from the
      // "key absent" 400 case above.
      const response = await providerPUT(jsonRequest({ provider: 42 }), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })

    it('400s on an unparseable JSON body', async (): Promise<void> => {
      // Exercises `request.json().catch(() => null)` itself, not just a wrong-shape-but-valid body.
      const response = await providerPUT(malformedRequest(), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })

    it('404s for an unknown workspace', async (): Promise<void> => {
      const response = await providerPUT(jsonRequest({ provider: 'cursor' }), params('00000000-0000-0000-0000-000000000000'))
      expect(response.status).toBe(404)
    })
  })

  describe('PUT /api/w/[workspaceId]/budget', () => {
    it('writes a number and returns 200', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: 12.5 }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).budgetUsd).toBe(12.5)
    })

    it('writes 0 and returns 200 -- not coerced to null or left at the schema default', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: 0 }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).budgetUsd).toBe(0)
    })

    it('accepts an explicit null -- "this workspace is not budgeted"', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: null }), params(fixture.workspaceId))
      expect(response.status).toBe(200)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).budgetUsd).toBeNull()
    })

    it('409s with the verbatim refusal on a negative amount', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: -3 }), params(fixture.workspaceId))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a budget must be a non-negative amount or absent')
    })

    it('400s when budgetUsd is neither a number nor null', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: '12' }), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })

    it('400s on an unparseable JSON body', async (): Promise<void> => {
      const response = await budgetPUT(malformedRequest(), params(fixture.workspaceId))
      expect(response.status).toBe(400)
    })

    it('404s for an unknown workspace', async (): Promise<void> => {
      const response = await budgetPUT(jsonRequest({ budgetUsd: 10 }), params('00000000-0000-0000-0000-000000000000'))
      expect(response.status).toBe(404)
    })
  })
})
