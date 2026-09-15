import { prisma } from '@slave-of-ai/db/client'
import { clearHalt } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resumeActiveRuns } from '../../src/server/runFanout.js'
import { truncateAll } from './projectFixture.js'

/** `Workspace.name` is unique (brief erratum: the second `seed()` of the cross-workspace case
 *  collided on the literal 'Fanout'), so each project names itself. */
let seedCount = 0

async function seed(): Promise<{ workspaceId: string; slaveId: string }> {
  seedCount += 1
  const workspace = await prisma.workspace.create({
    data: {
      name: `Fanout ${String(seedCount)}`,
      repoPath: '/tmp/m57-fanout',
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  // M58 R1: `Person.name` is unique across the installation, and this helper seeds one project per
  // call -- the counter its workspace name already carries keeps the people apart too.
  const slave = await prisma.slave.create({
    data: { teamId: team.id, role: 'dev', runtimeRoles: ['dev'], personId: (await prisma.person.create({ data: { name: `Alex ${String(seedCount)}` } })).id },
  })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

/**
 * A run, and -- when it is `paused` -- the CHECKPOINT `requestResume` refuses without (plan
 * erratum: the brief's `seedRun` created the row alone, and `requestResume` answers `no_checkpoint`
 * for a paused run that has none, so every run in the fan-out would have landed in `refused`).
 * `attempt` is not a `SlaveRun` column and is gone with it, and the live status is `working`:
 * `running` is not a member of the `RunStatus` enum.
 */
async function seedRun(slaveId: string, status: string): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: { slaveId, status: status as never, provider: 'claude_code' },
  })
  if (status === 'paused') {
    await prisma.checkpoint.create({
      data: {
        runId: run.id,
        sessionId: `session-${run.id}`,
        worktreePath: '/tmp/m57-fanout/.slaveofai/worktrees/T-abcdef12',
        pauseFlagPath: '/tmp/m57-fanout/.slaveofai/runs/pause.flag',
        settingsPath: '/tmp/m57-fanout/.slaveofai/runs/settings.json',
        hookPath: '/tmp/m57-fanout/scripts/pause-gate.sh',
        gitAuthorName: 'Alex',
        gitAuthorEmail: 'alex@slaveofai.local',
        headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      },
    })
  }
  return run.id
}

describe('resumeActiveRuns', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('asks every paused run of this workspace to resume, and reports which', async (): Promise<void> => {
    const { workspaceId, slaveId } = await seed()
    const a = await seedRun(slaveId, 'paused')
    const b = await seedRun(slaveId, 'paused')
    await seedRun(slaveId, 'working')

    const report = await resumeActiveRuns(workspaceId, 'a test')

    expect([...report.requested].sort()).toEqual([a, b].sort())
    expect(report.refused).toEqual([])
  })

  it('touches no run of another workspace', async (): Promise<void> => {
    const mine = await seed()
    const theirs = await seed()
    const ours = await seedRun(mine.slaveId, 'paused')
    await seedRun(theirs.slaveId, 'paused')

    const report = await resumeActiveRuns(mine.workspaceId, 'a test')

    expect(report.requested).toEqual([ours])
  })

  it('answers an empty report on a workspace with nothing paused, rather than throwing', async (): Promise<void> => {
    const { workspaceId } = await seed()
    expect(await resumeActiveRuns(workspaceId, 'a test')).toEqual({ requested: [], refused: [] })
  })
})

describe('clearHalt', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  it('clears a halted workspace and says it did', async (): Promise<void> => {
    const { workspaceId } = await seed()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { haltedReason: 'stopped', haltedAt: new Date() } })

    const result = await clearHalt(workspaceId)

    expect(result.ok && result.value.cleared).toBe(true)
    const after = await prisma.workspace.findUnique({ where: { id: workspaceId } })
    expect(after?.haltedReason).toBeNull()
    expect(after?.haltedAt).toBeNull()
  })

  it('is idempotent: a workspace that was not halted is not a refusal', async (): Promise<void> => {
    const { workspaceId } = await seed()
    const result = await clearHalt(workspaceId)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.cleared).toBe(false)
  })

  it('refuses a workspace that does not exist', async (): Promise<void> => {
    const result = await clearHalt('no-such-workspace')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.kind).toBe('workspace_not_found')
  })

  it('appends no event -- the CLI appends none, and this milestone changes no history', async (): Promise<void> => {
    const { workspaceId } = await seed()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { haltedReason: 'stopped', haltedAt: new Date() } })
    await clearHalt(workspaceId)
    expect(await prisma.executionEvent.count({ where: { workspaceId } })).toBe(0)
  })
})
