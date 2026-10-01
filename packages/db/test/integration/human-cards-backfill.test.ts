import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prisma } from '../../src/client.js'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const SQL = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20261002090000_human_cards_close/migration.sql', import.meta.url)), 'utf8')
const BACKFILL = SQL.slice(SQL.indexOf('-- BACKFILL BEGIN') + '-- BACKFILL BEGIN'.length, SQL.indexOf('-- BACKFILL END'))

afterAll(async () => {
  await prisma.$disconnect()
})

describe('the C5 backfill (human cards plan A D4)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  it('closes a done task\'s settled conductor report question, and nothing else', async () => {
    const ws = await prisma.workspace.create({ data: { name: 'Backfill', repoPath: '/x', verifyCommands: ['true'], setupCommands: [] } })
    const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
    const task = async (status: 'done' | 'rework') => (await prisma.task.create({ data: { workspaceId: ws.id, title: status, description: 'x', status, requiredRole: 'implementer', maxAttempts: 3 } })).id
    const done = await task('done')
    const live = await task('rework')
    let n = 0
    const question = async (taskId: string, parked = false) => {
      const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId, status: parked ? 'paused' : 'succeeded', ...(parked ? { pauseReason: 'waiting_for_answer' as const } : {}) } })
      n += 1
      return (await prisma.slaveMessage.create({ data: { id: `q${String(n)}`, threadId: `q${String(n)}`, workspaceId: ws.id, taskId, slaveId: seat.id, senderRunId: run.id, recipientRole: 'conductor', kind: 'question', body: 'which?', expectsReply: true, idempotencyKey: `send:report:${run.id}:0`, actor: 'slave' } })).id
    }
    const decide = (subjectId: string, status: 'rejected' | 'pending' | 'failed') =>
      prisma.supervisorDecision.create({ data: { workspaceId: ws.id, situationKind: 'conductor_question', subjectId, situation: {}, candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status, decidedBy: 'rules' } })
    const settled = await question(done)
    const pending = await question(done)
    const failed = await question(done)
    const running = await question(live)
    const undecided = await question(done)
    const parkedAsker = await question(done, true)
    await decide(settled, 'rejected')
    await decide(pending, 'pending')
    await decide(failed, 'failed')
    await decide(running, 'rejected')
    await decide(parkedAsker, 'rejected')
    await prisma.$executeRawUnsafe(BACKFILL)
    const closed = await prisma.slaveMessage.findMany({ where: { closedAt: { not: null } }, select: { id: true, closedReason: true, closedBy: true } })
    expect(closed).toEqual([{ id: settled, closedReason: 'decided', closedBy: 'system' }])
    expect(undecided).toBeDefined()
    await prisma.$executeRawUnsafe(BACKFILL)
    expect(await prisma.slaveMessage.count({ where: { closedAt: { not: null } } })).toBe(1)
  })
})
