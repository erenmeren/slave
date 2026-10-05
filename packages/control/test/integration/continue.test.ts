import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { continueWorkspace, resumePausedRuns } from '../../src/continue.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-continue-'))
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly resumable: string
  readonly noCheckpoint: string
}

/** A project a person stopped: halted, with one paused run that can resume and one that cannot. */
async function seed(): Promise<Fixture> {
  const ws = await prisma.workspace.create({
    data: { name: 'Stopped', repoPath, verifyCommands: ['true'], setupCommands: [], haltedReason: 'emergency stop by web operator', haltedAt: new Date() },
  })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Lead flow' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Lead x' } })).id } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', maxAttempts: 3 } })
  const paused = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: task.id, status: 'paused', pauseReason: 'emergency_stop', pausedAt: new Date(), provider: 'claude_code' } })
  await prisma.checkpoint.create({ data: { runId: paused.id, sessionId: 's1', worktreePath: '/tmp/w', pauseFlagPath: '/tmp/p', deniedToolUseIds: [], headCommit: 'a'.repeat(40), dirtyFiles: [], settingsPath: '/tmp/s', hookPath: '/tmp/h', gitAuthorName: 'Lead', gitAuthorEmail: 'lead@example.com' } })
  const bare = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: task.id, status: 'paused', pauseReason: 'emergency_stop', pausedAt: new Date(), provider: 'claude_code' } })
  return { workspaceId: ws.id, resumable: paused.id, noCheckpoint: bare.id }
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  fixture = await seed()
})

describe('continueWorkspace (lead UX design section 7)', () => {
  it('retracts the halt, then asks every paused run to resume, refusing the one with nothing to resume from', async () => {
    const result = await continueWorkspace(fixture.workspaceId, 'web operator')

    expect(result).toEqual({ ok: true, value: { cleared: true, requested: [fixture.resumable], refused: [fixture.noCheckpoint] } })
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).toMatchObject({ haltedReason: null, haltedAt: null })
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.resumable } })).resumeRequestedAt).not.toBeNull()
  })

  it('is idempotent on a project that is not halted and has nothing paused', async () => {
    await prisma.slaveRun.updateMany({ data: { status: 'succeeded' } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { haltedReason: null, haltedAt: null } })

    expect(await continueWorkspace(fixture.workspaceId, 'web operator')).toEqual({ ok: true, value: { cleared: false, requested: [], refused: [] } })
  })

  it('refuses an archived project, leaving its halt in place', async () => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

    expect(await continueWorkspace(fixture.workspaceId, 'web operator')).toEqual({ ok: false, error: { kind: 'workspace_archived', workspaceId: fixture.workspaceId } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })).haltedReason).not.toBeNull()
  })

  it('refuses a project that does not exist', async () => {
    expect(await continueWorkspace(UNKNOWN, 'web operator')).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: UNKNOWN } })
  })
})

describe('resumePausedRuns', () => {
  it('reaches only this project\'s paused runs', async () => {
    const other = await prisma.workspace.create({ data: { name: 'Other', repoPath, verifyCommands: ['true'], setupCommands: [] } })
    const team = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'x', personId: (await prisma.person.create({ data: { name: 'Other x' } })).id } })
    const elsewhere = await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'paused', pausedAt: new Date() } })
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { haltedReason: null, haltedAt: null } })

    const fanout = await resumePausedRuns(fixture.workspaceId, 'web operator')

    expect([...fanout.requested, ...fanout.refused].sort()).toEqual([fixture.resumable, fixture.noCheckpoint].sort())
    expect(fanout.requested).not.toContain(elsewhere.id)
    expect(fanout.refused).not.toContain(elsewhere.id)
  })
})
