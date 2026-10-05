import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as analytics } from '../../src/app/api/analytics/route.js'
import { GET as happening } from '../../src/app/api/happening/route.js'

/**
 * The two reads behind Analytics and Home's feed are thin envelopes over control functions. Each
 * case pins the envelope -- the status, the body's shape, what the query string means -- and
 * leaves the figures to the control package's own tests.
 */
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "EvidenceRecord", "GoalDelivery", "SlaveRun", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE')
})

afterAll(async () => {
  await prisma.$disconnect()
})

const get = (url: string): Request => new Request(`http://test${url}`)

describe('GET /api/analytics', () => {
  it('answers thirty days of every project when asked for nothing', async () => {
    const response = await analytics(get('/api/analytics'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { analytics: { days: number | null; projectId: string | null; money: { byDay: unknown[] }; projects: unknown[] } }
    expect(body.analytics).toMatchObject({ days: 30, projectId: null, projects: [] })
    expect(body.analytics.money.byDay).toHaveLength(30)
  })

  it('reads the project and the period from the query string, and an unknown project as every project', async () => {
    const ws = await prisma.workspace.create({ data: { name: 'One', repoPath: '/tmp/one', verifyCommands: ['true'], setupCommands: [], flow: 'lead' } })
    const one = (await (await analytics(get(`/api/analytics?project=${ws.id}&days=7`))).json()) as { analytics: { days: number | null; projectId: string | null; money: { byDay: unknown[]; byProject: { name: string }[] } } }
    expect(one.analytics).toMatchObject({ days: 7, projectId: ws.id })
    expect(one.analytics.money.byDay).toHaveLength(7)
    expect(one.analytics.money.byProject.map((row) => row.name)).toEqual(['One'])
    const all = (await (await analytics(get('/api/analytics?project=nobody&days=all'))).json()) as { analytics: { days: number | null; projectId: string | null } }
    expect(all.analytics).toMatchObject({ days: null, projectId: null })
  })
})

describe('GET /api/happening', () => {
  it('answers the lines, none when nothing has happened', async () => {
    const response = await happening()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ lines: [] })
  })
})
