import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PUT as providerPUT } from '../../src/app/api/w/[workspaceId]/provider/route.js'
import { PUT as budgetPUT } from '../../src/app/api/w/[workspaceId]/budget/route.js'
import { PUT as integrationPUT } from '../../src/app/api/w/[workspaceId]/integration/route.js'
import { PATCH as limitsPATCH } from '../../src/app/api/w/[workspaceId]/limits/route.js'
import { PATCH as supervisorPATCH } from '../../src/app/api/w/[workspaceId]/supervisor/settings/route.js'

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

function patchRequest(body: unknown): Request {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
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
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
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

  /** E R7: the switch the Settings panel flips. `{ autoMerge: boolean }` and nothing else -- the
   *  route's whole job is the boolean, and the count the verb returns is for the CLI, which can
   *  print the caveat where somebody is reading a terminal. */
  describe('PUT /api/w/[workspaceId]/integration', () => {
    it('turns auto-merge on, then off, and returns 200 both times', async (): Promise<void> => {
      const on = await integrationPUT(jsonRequest({ autoMerge: true }), params(fixture.workspaceId))
      expect(on.status).toBe(200)
      expect(await on.json()).toEqual({ ok: true })
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).autoMerge).toBe(true)

      const off = await integrationPUT(jsonRequest({ autoMerge: false }), params(fixture.workspaceId))
      expect(off.status).toBe(200)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).autoMerge).toBe(false)
    })

    it('400s a missing key, a non-boolean and an unparseable body', async (): Promise<void> => {
      expect((await integrationPUT(jsonRequest({}), params(fixture.workspaceId))).status).toBe(400)
      expect((await integrationPUT(jsonRequest({ autoMerge: 'yes' }), params(fixture.workspaceId))).status).toBe(400)
      expect((await integrationPUT(malformedRequest(), params(fixture.workspaceId))).status).toBe(400)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).autoMerge).toBe(false)
    })

    it('404s for an unknown workspace', async (): Promise<void> => {
      const response = await integrationPUT(jsonRequest({ autoMerge: true }), params('00000000-0000-0000-0000-000000000000'))
      expect(response.status).toBe(404)
    })
  })

  /** H9 F8: the three dispatch limits the Runtime panel now edits. The bounds are the verb's; the
   *  route's own business is the JS type and the archived guard. */
  describe('PATCH /api/w/[workspaceId]/limits', () => {
    const stored = async (workspaceId: string): Promise<readonly number[]> => {
      const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
      return [row.runTimeoutMs, row.maxConcurrentRuns, row.maxAttempts]
    }

    it('writes any of the three and records who moved them', async (): Promise<void> => {
      const response = await limitsPATCH(patchRequest({ runTimeoutMs: 3_600_000, maxAttempts: 5 }), params(fixture.workspaceId))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(await stored(fixture.workspaceId)).toEqual([3_600_000, 3, 5])
      const events = await prisma.executionEvent.findMany({ where: { workspaceId: fixture.workspaceId, type: 'workspace_settings_changed' }, orderBy: { seq: 'asc' } })
      expect(events.map((event) => event.payload)).toEqual([
        { field: 'runTimeoutMs', from: 1_800_000, to: 3_600_000 },
        { field: 'maxAttempts', from: 3, to: 5 },
      ])
    })

    it('409s a figure out of range with the verb s sentence, writing nothing', async (): Promise<void> => {
      const response = await limitsPATCH(patchRequest({ maxConcurrentRuns: 4, runTimeoutMs: 181 * 60_000 }), params(fixture.workspaceId))

      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: string }).error).toBe('a run timeout must be a whole number of minutes from 5 to 180')
      expect(await stored(fixture.workspaceId)).toEqual([1_800_000, 3, 3])
    })

    it('400s a limit of the wrong JS type and an unparseable body', async (): Promise<void> => {
      expect((await limitsPATCH(patchRequest({ maxAttempts: '5' }), params(fixture.workspaceId))).status).toBe(400)
      expect((await limitsPATCH(malformedRequest(), params(fixture.workspaceId))).status).toBe(400)
    })

    it('409s an archived project and 404s an unknown one', async (): Promise<void> => {
      await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })
      expect((await limitsPATCH(patchRequest({ maxAttempts: 5 }), params(fixture.workspaceId))).status).toBe(409)
      expect(await stored(fixture.workspaceId)).toEqual([1_800_000, 3, 3])

      const missing = await limitsPATCH(patchRequest({ maxAttempts: 5 }), params('00000000-0000-0000-0000-000000000000'))
      expect(missing.status).toBe(404)
    })
  })

  /** F R4 (E10): WHICH runtime answers this project's conversation with the Supervisor -- today
   *  the conversation alone. The pair joins the three settings this route already patched. */
  describe('PATCH /api/w/[workspaceId]/supervisor/settings', () => {
    const stored = async (workspaceId: string): Promise<{ provider: string | null; model: string | null }> => {
      const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
      return { provider: row.supervisorProvider, model: row.supervisorModel }
    }

    it('writes the provider and the model together', async (): Promise<void> => {
      const response = await supervisorPATCH(
        patchRequest({ provider: 'cursor', model: 'auto' }),
        params(fixture.workspaceId),
      )

      expect(response.status).toBe(200)
      expect(await stored(fixture.workspaceId)).toEqual({ provider: 'cursor', model: 'auto' })
    })

    it('accepts an explicit null on each -- "the installation default"', async (): Promise<void> => {
      await supervisorPATCH(patchRequest({ provider: 'cursor', model: 'auto' }), params(fixture.workspaceId))

      const response = await supervisorPATCH(patchRequest({ provider: null, model: null }), params(fixture.workspaceId))

      expect(response.status).toBe(200)
      expect(await stored(fixture.workspaceId)).toEqual({ provider: null, model: null })
    })

    it('leaves the pair alone on a patch that does not carry it', async (): Promise<void> => {
      await supervisorPATCH(patchRequest({ provider: 'cursor', model: 'auto' }), params(fixture.workspaceId))

      expect((await supervisorPATCH(patchRequest({ enabled: false }), params(fixture.workspaceId))).status).toBe(200)

      expect(await stored(fixture.workspaceId)).toEqual({ provider: 'cursor', model: 'auto' })
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).supervisorEnabled).toBe(false)
    })

    it('400s a provider this installation does not have, with the control refusal s own sentence', async (): Promise<void> => {
      const response = await supervisorPATCH(patchRequest({ provider: 'gpt' }), params(fixture.workspaceId))

      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('a provider must be a configured kind')
      expect(await stored(fixture.workspaceId)).toEqual({ provider: null, model: null })
    })

    it('writes NEITHER field when the provider is unknown and the model is fine', async (): Promise<void> => {
      const response = await supervisorPATCH(
        patchRequest({ provider: 'gpt', model: 'sonnet' }),
        params(fixture.workspaceId),
      )

      expect(response.status).toBe(400)
      expect(await stored(fixture.workspaceId)).toEqual({ provider: null, model: null })
    })

    it('409s a model that is not one word -- the verb s own shape check, not a second one here', async (): Promise<void> => {
      const response = await supervisorPATCH(patchRequest({ model: 'gpt 4o' }), params(fixture.workspaceId))

      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: string }).error).toContain('one word')
    })

    it('400s a provider or a model of the wrong JS type', async (): Promise<void> => {
      expect((await supervisorPATCH(patchRequest({ provider: 42 }), params(fixture.workspaceId))).status).toBe(400)
      expect((await supervisorPATCH(patchRequest({ model: 42 }), params(fixture.workspaceId))).status).toBe(400)
    })

    it('404s for an unknown workspace', async (): Promise<void> => {
      const response = await supervisorPATCH(patchRequest({ provider: 'cursor' }), params('00000000-0000-0000-0000-000000000000'))
      expect(response.status).toBe(404)
    })
  })
})
