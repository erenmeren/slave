import { Prisma, prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSkillsPage } from '../../src/server/skills.js'
import { DELETE as assignDELETE, POST as assignPOST } from '../../src/app/api/skills/assign/route.js'

/**
 * The Skills DTO against the real database (M14 Task 15), plus the assign route's round trip —
 * the house pattern `settings-snapshot.test.ts` / `org-routes.test.ts` set.
 *
 * The point of seeding `AgentRun.skillCalls` here rather than stubbing it is Decision 3: the run
 * counts on this page are a SUM of a real column, and the only way to prove `0` is a measured
 * zero (and not a placeholder) is to read it back out of Postgres.
 */
let agentId: string
let skillId: string
let providerId: string

function jsonRequest(method: 'POST' | 'DELETE', body: unknown): Request {
  return new Request('http://x', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function malformedRequest(method: 'POST' | 'DELETE'): Request {
  return new Request('http://x', { method, body: 'not json', headers: { 'content-type': 'application/json' } })
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  const workspace = await prisma.workspace.create({
    data: { name: 'W', repoPath: '/tmp/skills-page', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
  agentId = (await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
  const provider = await prisma.skillProvider.create({ data: { name: 'plugin:superpowers' } })
  providerId = provider.id
  skillId = (await prisma.skill.create({ data: { providerId: provider.id, name: 'writing-plans', description: 'plans things' } })).id
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('buildSkillsPage', () => {
  it('groups skills under their provider and reports zero runs before any run has concluded', async (): Promise<void> => {
    const page = await buildSkillsPage()
    expect(page.providers.map((p) => p.name)).toEqual(['plugin:superpowers'])
    expect(page.providers[0]?.skills[0]?.runs).toBe(0)
    expect(page.providers[0]?.skills[0]?.state).toBe('ready')
  })

  it('sums the run tallies across every run that recorded one', async (): Promise<void> => {
    // The keys are what the pump really writes for a `plugin:superpowers` skill --
    // `{"skill": "superpowers:writing-plans"}` (`packages/providers/test/stream.test.ts:512`).
    // `brainstorming` is in the tally but not in the catalog, and simply has no row to land on.
    await prisma.agentRun.create({
      data: { agentId, status: 'succeeded', provider: 'claude_code', skillCalls: { 'superpowers:writing-plans': 2, brainstorming: 5 } },
    })
    await prisma.agentRun.create({
      data: { agentId, status: 'failed', provider: 'claude_code', skillCalls: { 'superpowers:writing-plans': 1 } },
    })
    // A run that reported nothing contributes nothing, and does not become a zero. `Prisma.DbNull`
    // is the sentinel the pump itself writes for exactly this (`apps/orchestrator/src/pump.ts:174`)
    // -- a nullable Json column rejects a bare `null` as ambiguous.
    await prisma.agentRun.create({ data: { agentId, status: 'succeeded', provider: 'cursor', skillCalls: Prisma.DbNull } })

    const page = await buildSkillsPage()
    expect(page.providers[0]?.skills.find((s) => s.name === 'writing-plans')?.runs).toBe(3)
  })

  it('prefers the plugin-qualified tally key over a bare one of the same trailing name', async (): Promise<void> => {
    // The measured shape of a `Skill` tool_use for a plugin skill (`{"skill":"<plugin>:<name>"}`,
    // `packages/providers/src/runtime/summary.ts:12`). A same-named PERSONAL skill's bare calls
    // sit in the same tally and must not be added to the plugin row's total.
    const personal = await prisma.skillProvider.create({ data: { name: 'personal' } })
    await prisma.skill.create({ data: { providerId: personal.id, name: 'writing-plans', description: 'mine' } })
    await prisma.agentRun.create({
      data: { agentId, status: 'succeeded', provider: 'claude_code', skillCalls: { 'superpowers:writing-plans': 4, 'writing-plans': 9 } },
    })

    const page = await buildSkillsPage()
    // Alphabetical by provider name, which is also the spec's order: personal, plugin:*, project.
    expect(page.providers.map((p) => p.name)).toEqual(['personal', 'plugin:superpowers'])
    expect(page.providers[0]?.skills[0]?.runs).toBe(9)
    expect(page.providers[1]?.skills[0]?.runs).toBe(4)
  })

  it('gives a never-invoked plugin skill a zero, not its personal namesake’s count', async (): Promise<void> => {
    // The live collision on this very machine: `code-review` exists both as a personal skill and
    // under the `code-review` plugin. Only the personal one has ever been called, and its tally
    // key is bare because a personal invocation is never colon-qualified. The plugin row must read
    // `0` -- a measured zero (Decision 3), not a number borrowed from a namesake.
    const personal = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const plugin = await prisma.skillProvider.create({ data: { name: 'plugin:code-review' } })
    await prisma.skill.create({ data: { providerId: personal.id, name: 'code-review', description: 'mine' } })
    await prisma.skill.create({ data: { providerId: plugin.id, name: 'code-review', description: 'theirs' } })
    await prisma.agentRun.create({
      data: { agentId, status: 'succeeded', provider: 'claude_code', skillCalls: { 'code-review': 9 } },
    })

    const page = await buildSkillsPage()
    const rowFor = (providerName: string): number | undefined =>
      page.providers.find((p) => p.name === providerName)?.skills.find((s) => s.name === 'code-review')?.runs
    expect(rowFor('personal')).toBe(9)
    expect(rowFor('plugin:code-review')).toBe(0)
  })

  it('reports a vanished skill as missing rather than dropping it', async (): Promise<void> => {
    await prisma.skill.update({ where: { id: skillId }, data: { missingSince: new Date() } })
    const page = await buildSkillsPage()
    expect(page.providers[0]?.skills[0]?.state).toBe('missing')
  })

  it('lists the agents a skill is assigned to', async (): Promise<void> => {
    await prisma.agentSkill.create({ data: { agentId, skillId } })
    const page = await buildSkillsPage()
    expect(page.providers[0]?.skills[0]?.agentIds).toEqual([agentId])
  })

  it('reports each agent with the status derived from its live run', async (): Promise<void> => {
    await prisma.agentRun.create({ data: { agentId, status: 'working', provider: 'claude_code' } })
    const page = await buildSkillsPage()
    expect(page.agents).toEqual([{ id: agentId, name: 'Alex', status: 'working' }])
  })

  it('names the three scanned roots without offering to change them', async (): Promise<void> => {
    const page = await buildSkillsPage()
    expect(page.scannedRoots).toHaveLength(3)
    expect(page.scannedRoots.some((root) => root.endsWith('.claude/skills'))).toBe(true)
  })
})

describe('the /api/skills/assign route', () => {
  it('assigns and unassigns, and the DTO shows both ends of the round trip', async (): Promise<void> => {
    const assigned = await assignPOST(jsonRequest('POST', { agentId, skillId }))
    expect(assigned.status).toBe(200)
    expect(await assigned.json()).toEqual({ ok: true })
    expect((await buildSkillsPage()).providers[0]?.skills[0]?.agentIds).toEqual([agentId])

    const removed = await assignDELETE(jsonRequest('DELETE', { agentId, skillId }))
    expect(removed.status).toBe(200)
    expect((await buildSkillsPage()).providers[0]?.skills[0]?.agentIds).toEqual([])
  })

  it('refuses an unknown skill with the control layer’s own words', async (): Promise<void> => {
    const response = await assignPOST(jsonRequest('POST', { agentId, skillId: 'nope' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'no skill with id nope' })
  })

  it('refuses an unknown agent on the DELETE too', async (): Promise<void> => {
    const response = await assignDELETE(jsonRequest('DELETE', { agentId: 'nope', skillId }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'no agent with id nope' })
  })

  it('calls a malformed body a 400, not a refusal', async (): Promise<void> => {
    expect((await assignPOST(malformedRequest('POST'))).status).toBe(400)
    expect((await assignDELETE(malformedRequest('DELETE'))).status).toBe(400)
    expect((await assignPOST(jsonRequest('POST', { agentId: 1, skillId }))).status).toBe(400)
    // `providerId` is seeded but never a valid body field — the guard is on shape, not on ids.
    expect((await assignPOST(jsonRequest('POST', { providerId }))).status).toBe(400)
  })
})
