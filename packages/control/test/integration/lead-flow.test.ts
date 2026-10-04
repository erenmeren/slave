import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureLeadSeats, setFlow, setLeadSettings } from '../../src/lead/flow.js'
import { workspaceStats } from '../../src/stats.js'

async function workspace(data: { readonly budgetUsd?: number; readonly provider?: boolean } = {}): Promise<string> {
  const row = await prisma.workspace.create({
    data: { name: `Lead ${String(Math.random()).slice(2)}`, repoPath: '/tmp/lead', verifyCommands: ['true'], setupCommands: [], ...(data.budgetUsd === undefined ? {} : { budgetUsd: data.budgetUsd }) },
  })
  if (data.provider !== false) await prisma.providerConfiguration.create({ data: { workspaceId: row.id, kind: 'claude_code', settings: {} } })
  return row.id
}

describe('the lead flow switch (plan A L1/L2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "GoalDelivery", "SlaveRun", "Task", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('switches a project to the lead flow: conducted, automatic merge, three system seats with no model of their own (C5)', async (): Promise<void> => {
    const id = await workspace()
    const result = await setFlow(id, 'lead')
    expect(result).toEqual({ ok: true, value: { flow: 'lead', changed: true } })
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id } })
    expect([row.flow, row.delivery, row.autoMerge]).toEqual(['lead', 'conducted', true])
    const seats = await prisma.slave.findMany({ where: { team: { workspaceId: id, name: LEAD_TEAM_NAME } }, orderBy: { role: 'asc' }, include: { person: true } })
    expect(seats.map((s) => [s.role, s.runtimeRoles, s.model, s.provider, s.person.templateId])).toEqual([
      ['Confirmer', ['verifier'], null, null, null],
      ['Lead', ['implementer'], null, null, null],
      ['Verifier', ['verifier'], null, null, null],
    ])
    expect(await setFlow(id, 'lead')).toEqual({ ok: true, value: { flow: 'lead', changed: false } })
  })

  it('makes the seats once: a second call returns the same three ids, and a named model moves them', async (): Promise<void> => {
    const id = await workspace()
    const first = await ensureLeadSeats(id)
    const second = await ensureLeadSeats(id, 'claude-opus-5')
    expect(first.ok && second.ok && second.value).toEqual(first.ok ? first.value : null)
    expect(await prisma.slave.count({ where: { team: { workspaceId: id } } })).toBe(3)
    expect((await prisma.slave.findMany({ where: { team: { workspaceId: id } } })).every((s) => s.model === 'claude-opus-5' && s.provider === 'claude_code')).toBe(true)
  })

  it('keeps automatic merge off when asked, and refuses without a Claude Code provider, with an open goal version or a live run', async (): Promise<void> => {
    const off = await workspace()
    await setFlow(off, 'lead', { autoMerge: false })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: off } })).autoMerge).toBe(false)

    const bare = await workspace({ provider: false })
    expect(await setFlow(bare, 'lead')).toMatchObject({ ok: false, error: { kind: 'flow_refused' } })

    const open = await workspace()
    await prisma.goalDelivery.create({ data: { workspaceId: open, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'abc' } })
    expect(await setFlow(open, 'lead')).toMatchObject({ ok: false, error: { kind: 'flow_refused', reason: expect.stringContaining('goal v1') } })

    const live = await workspace()
    const team = await prisma.team.create({ data: { workspaceId: live, name: 'E' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
    await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'working', kind: 'planning' } })
    expect(await setFlow(live, 'lead')).toMatchObject({ ok: false, error: { kind: 'flow_refused', reason: expect.stringContaining('1 run') } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: live } })).flow).toBe('packages')
  })

  it('sets the time limit and the roster, and refuses a limit out of bounds, an unknown person and a project not in the lead flow', async (): Promise<void> => {
    const id = await workspace()
    expect(await setLeadSettings(id, { timeLimitMs: 3_600_000 })).toMatchObject({ ok: false, error: { kind: 'not_lead_flow' } })
    await setFlow(id, 'lead')
    const ada = await prisma.person.create({ data: { name: 'Ada' } })
    expect(await setLeadSettings(id, { timeLimitMs: 3_600_000, roster: [ada.id] })).toEqual({ ok: true, value: { timeLimitMs: 3_600_000, roster: [ada.id] } })
    expect(await setLeadSettings(id, { timeLimitMs: null })).toEqual({ ok: true, value: { timeLimitMs: null, roster: [ada.id] } })
    expect(await setLeadSettings(id, { timeLimitMs: 90_000 })).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'timeLimitMs' } })
    expect(await setLeadSettings(id, { roster: [ada.id, 'nobody'] })).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster', rule: expect.stringContaining('nobody') } })
    expect(await setLeadSettings(id, { roster: Array.from({ length: 16 }, () => ada.id) })).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster' } })
  })

  it('reports no workspace budget and no failure streak for a lead-flow project, and both for any other (L6/L9)', async (): Promise<void> => {
    const lead = await workspace({ budgetUsd: 30 })
    await setFlow(lead, 'lead')
    const other = await workspace({ budgetUsd: 30 })
    for (const id of [lead, other]) {
      const seat = await prisma.slave.findFirst({ where: { team: { workspaceId: id } } }) ??
        (await prisma.slave.create({ data: { teamId: (await prisma.team.create({ data: { workspaceId: id, name: 'E' } })).id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: `P ${id}` } })).id } }))
      for (let i = 0; i < 3; i += 1) await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'failed', kind: 'planning', failureClass: 'worker', terminalAt: new Date(), endedAt: new Date() } })
    }
    const a = await workspaceStats(lead)
    const b = await workspaceStats(other)
    expect([a.limits.budgetUsd, a.stats.consecutiveFailures]).toEqual([null, 0])
    expect([b.limits.budgetUsd, b.stats.consecutiveFailures]).toEqual([30, 3])
  })
})
