import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadLeadRoster } from '../../src/lead/roster.js'
import { goalSpend, goalWorkedMs } from '../../src/lead/spend.js'

const T0 = new Date('2026-10-04T10:00:00.000Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)

async function seed(): Promise<{ readonly workspaceId: string; readonly taskId: string; readonly deliveryId: string; readonly leadSeat: string; readonly verifierSeat: string }> {
  const ws = await prisma.workspace.create({ data: { name: `Spend ${String(Math.random()).slice(2)}`, repoPath: '/tmp/spend', verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Lead flow' } })
  const seat = async (name: string, role: string): Promise<string> =>
    (await prisma.slave.create({ data: { teamId: team.id, role, runtimeRoles: [role === 'Lead' ? 'implementer' : 'verifier'], personId: (await prisma.person.create({ data: { name } })).id } })).id
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'abc' } })
  return { workspaceId: ws.id, taskId: task.id, deliveryId: delivery.id, leadSeat: await seat('Lead s', 'Lead'), verifierSeat: await seat('Verifier s', 'Verifier') }
}

describe('what a goal version spent (lead-flow plan A L6/L7)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "ConductorCall", "WorkPackage", "GoalDelivery", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('takes each lead session\'s running total once, and sums the sessions, the proof runs and the conductor\'s calls of that version (C2)', async (): Promise<void> => {
    const f = await seed()
    await prisma.slaveRun.createMany({
      data: [
        // Session s1: the build reported 10; a continue crashed with no cost; the rework, resumed
        // on s1, reported the session's running total, 12.5 -- which covers the crashed turn too.
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'succeeded', leadTurn: 'build', sessionId: 's1', costUsd: 10, startedAt: at(0), endedAt: at(30) },
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'failed', leadTurn: 'continue', sessionId: 's1', costUsd: null, startedAt: at(31), endedAt: at(32) },
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'succeeded', leadTurn: 'rework', sessionId: 's1', costUsd: 12.5, startedAt: at(40), endedAt: at(50), pausedMs: 120_000 },
        // Session s2 (the transcript of s1 was lost): it reported 2, then a turn ended with no cost
        // and nothing after it on s2 says what it spent.
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'succeeded', leadTurn: 'continue', sessionId: 's2', costUsd: 2, startedAt: at(51), endedAt: at(53) },
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'failed', leadTurn: 'wrap_up', sessionId: 's2', costUsd: null, startedAt: at(54), endedAt: at(55) },
        { slaveId: f.verifierSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: f.deliveryId, costUsd: 3, startedAt: at(33), endedAt: at(39) },
      ],
    })
    await prisma.conductorCall.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'ok', modelCostUsd: 0.02 } })
    await prisma.conductorCall.create({ data: { workspaceId: f.workspaceId, goalVersion: 2, stage: 'requirements', outcome: 'ok', modelCostUsd: 9 } })

    expect(await goalSpend(f.workspaceId, 1)).toEqual({ totalUsd: 17.52, leadUsd: 14.5, proofUsd: 3, conductorUsd: 0.02, unmeasuredRuns: 1 })
    // 30 + 1 + (10 - 2 paused) + 2 + 1 + 6 minutes of work; the gaps between runs are not charged.
    expect(await goalWorkedMs(f.workspaceId, 1, at(60))).toBe(48 * 60_000)
  })

  it('counts a live run up to now, less the span it has sat paused', async (): Promise<void> => {
    const f = await seed()
    await prisma.slaveRun.create({ data: { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'paused', leadTurn: 'build', startedAt: at(0), pausedAt: at(10) } })
    expect(await goalWorkedMs(f.workspaceId, 1, at(25))).toBe(10 * 60_000)
  })

  it('builds a roster member from the person\'s profile and their persona\'s one line, in the roster\'s order', async (): Promise<void> => {
    await prisma.slaveTemplate.deleteMany({ where: { id: 't-lead-roster' } })
    await prisma.slaveTemplate.create({ data: { id: 't-lead-roster', name: 'Lead Roster Backend', role: 'backend', description: 'Builds and tests HTTP APIs', profile: 'You are a backend developer.', active: true } })
    const ada = await prisma.person.create({ data: { name: 'Ada', templateId: 't-lead-roster' } })
    const bo = await prisma.person.create({ data: { name: 'Bo', profile: 'You review security.' } })
    const gone = await prisma.person.create({ data: { name: 'Cy', releasedAt: at(0) } })
    const roster = await loadLeadRoster([bo.id, gone.id, ada.id])
    expect(roster).toEqual([
      { personId: bo.id, name: 'Bo', description: 'a specialist of this organisation', instructions: 'You review security.' },
      { personId: ada.id, name: 'Ada', description: 'Builds and tests HTTP APIs', instructions: 'You are a backend developer.' },
    ])
    await prisma.person.deleteMany({ where: { templateId: 't-lead-roster' } })
    await prisma.slaveTemplate.deleteMany({ where: { id: 't-lead-roster' } })
  })
})
