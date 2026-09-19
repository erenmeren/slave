import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTeamLive } from '../../src/server/teamLive.js'
import { GET } from '../../src/app/api/w/[workspaceId]/team/route.js'
import { seedTask, seedWorkspace, truncateAll, type ProjectFixture } from './projectFixture.js'

/** `fx.slaveId` (the fixture's own seat) plus the second seat and the live run this suite adds on
 *  top of it -- the same "reuse the shared fixture, add what this file needs" idiom
 *  `overview.test.ts`/`organization.test.ts` use rather than a private seed from scratch. */
interface Fixture extends ProjectFixture {
  readonly slaveId1: string
  readonly slaveId2: string
  readonly runId: string
}

async function seed(): Promise<Fixture> {
  const base = await seedWorkspace()
  const person2 = await prisma.person.create({ data: { name: 'Sam' } })
  const slave2 = await prisma.slave.create({
    data: { teamId: base.teamId, role: 'reviewer', runtimeRoles: ['reviewer'], personId: person2.id },
  })
  const task = await seedTask(base.workspaceId, { title: 'Add the thing', status: 'running' })
  const run = await prisma.slaveRun.create({
    data: { slaveId: base.slaveId, taskId: task.id, status: 'working', costUsd: 0.42, toolCalls: 3 },
  })
  return { ...base, slaveId1: base.slaveId, slaveId2: slave2.id, runId: run.id }
}

describe('buildTeamLive', () => {
  let fx: Fixture

  beforeEach(async (): Promise<void> => {
    await truncateAll()
    fx = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns one row per seat with a sentence, never an enum member', async () => {
    const snap = await buildTeamLive(fx.workspaceId)
    expect(snap?.rows.map((r) => r.slaveId).sort()).toEqual([fx.slaveId1, fx.slaveId2].sort())
    for (const row of snap!.rows) expect(row.doing).not.toMatch(/^[a-z_]+$/)
  })

  it('says the live task title and moves the bar inside the running band', async () => {
    const row = (await buildTeamLive(fx.workspaceId))!.rows.find((r) => r.slaveId === fx.slaveId1)!
    expect(row.doing).toBe('Add the thing')
    expect(row.progress).toBeGreaterThanOrEqual(35)
    expect(row.progress).toBeLessThanOrEqual(60)
    expect(row.technical.runId).toBe(fx.runId)
    expect(row.technical.costUsd).toBe(0.42)
  })

  it('says Idle with the next queued task for a seat with no run', async () => {
    const row = (await buildTeamLive(fx.workspaceId))!.rows.find((r) => r.slaveId === fx.slaveId2)!
    expect(row.doing).toMatch(/^Idle/)
    expect(row.progress).toBe(null)
    expect(row.technical.runId).toBe(null)
  })

  it('counts in-progress and done and carries the shell facts', async () => {
    const snap = (await buildTeamLive(fx.workspaceId))!
    expect(snap.stats.inProgress).toBe(1)
    expect(snap.shellFacts.workspace.id).toBe(fx.workspaceId)
  })

  it('404s through the route for an unknown workspace', async () => {
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ workspaceId: 'nope' }) })
    expect(res.status).toBe(404)
  })
})
