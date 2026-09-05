import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteSlave, deleteTeam, renameSlave, renameTeam, setSlaveRole } from '../../src/org.js'

// A real directory, not a placeholder (M23 G3): runFilePaths' statSync preflight refuses a repo path that does not exist, and a reboot clears /tmp -- the trap emergency.test.ts fell into at ce48adc.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-org-edit-'))

afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly slaveWithRun: { readonly id: string; readonly name: string; readonly role: string }
  readonly slaveNoRuns: { readonly id: string; readonly name: string; readonly role: string }
  readonly runId: string
  readonly taskId: string
}

/**
 * One team, two slaves: `slaveWithRun` carries a `succeeded` (terminal) `SlaveRun` against a real
 * task -- exercises `deleteSlave`'s cascade of a terminal run into the delete (M27 §4.1);
 * `deleteSlave` refuses only a LIVE run, so this history goes with the row. `slaveNoRuns` is the
 * clean roster member every ordinary edit lands on.
 */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slaveWithRunRow = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const slaveNoRunsRow = await prisma.slave.create({ data: { teamId: team.id, name: 'Sam', role: 'frontend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slaveWithRunRow.id, status: 'succeeded' },
  })
  return {
    workspaceId: workspace.id,
    teamId: team.id,
    slaveWithRun: { id: slaveWithRunRow.id, name: slaveWithRunRow.name, role: slaveWithRunRow.role },
    slaveNoRuns: { id: slaveNoRunsRow.id, name: slaveNoRunsRow.name, role: slaveNoRunsRow.role },
    runId: run.id,
    taskId: task.id,
  }
}

async function orgChangedEvents(workspaceId: string): Promise<
  readonly { readonly slaveId: string | null; readonly payload: Record<string, unknown>; readonly actor: string }[]
> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'org_changed' },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({ slaveId: row.slaveId, payload: row.payload as Record<string, unknown>, actor: row.actor }))
}

describe('org-edit verbs', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlaveRun", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  describe('renameSlave', () => {
    it('renames the row and emits one org.changed event with the old and new name', async () => {
      const { slaveNoRuns, workspaceId } = fixture

      const result = await renameSlave(slaveNoRuns.id, 'Samantha')

      expect(result.ok).toBe(true)
      const row = await prisma.slave.findUniqueOrThrow({ where: { id: slaveNoRuns.id } })
      expect(row.name).toBe('Samantha')

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.slaveId).toBe(slaveNoRuns.id)
      expect(events[0]?.actor).toBe('human')
      expect(events[0]?.payload).toEqual({ entity: 'slave', id: slaveNoRuns.id, field: 'name', from: 'Sam', to: 'Samantha' })
    })

    it('refuses a name already taken by a sibling in the same team, changing nothing', async () => {
      const { slaveNoRuns, slaveWithRun, workspaceId } = fixture

      const result = await renameSlave(slaveNoRuns.id, slaveWithRun.name)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: slaveWithRun.name })
      const row = await prisma.slave.findUniqueOrThrow({ where: { id: slaveNoRuns.id } })
      expect(row.name).toBe('Sam')
      expect(await orgChangedEvents(workspaceId)).toHaveLength(0)
    })

    it('refuses a blank name, changing nothing', async () => {
      const { slaveNoRuns } = fixture

      const result = await renameSlave(slaveNoRuns.id, '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      const row = await prisma.slave.findUniqueOrThrow({ where: { id: slaveNoRuns.id } })
      expect(row.name).toBe('Sam')
    })

    it('refuses an unknown slave', async () => {
      const result = await renameSlave(UNKNOWN, 'Whoever')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'slave_not_found', slaveId: UNKNOWN })
    })
  })

  describe('setSlaveRole', () => {
    it('sets the role and emits one org.changed event with the old and new role', async () => {
      const { slaveNoRuns, workspaceId } = fixture

      const result = await setSlaveRole(slaveNoRuns.id, 'qa')

      expect(result.ok).toBe(true)
      const row = await prisma.slave.findUniqueOrThrow({ where: { id: slaveNoRuns.id } })
      expect(row.role).toBe('qa')

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ entity: 'slave', id: slaveNoRuns.id, field: 'role', from: 'frontend', to: 'qa' })
    })

    it('refuses a blank role, changing nothing', async () => {
      const { slaveNoRuns } = fixture

      const result = await setSlaveRole(slaveNoRuns.id, '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_role' })
      const row = await prisma.slave.findUniqueOrThrow({ where: { id: slaveNoRuns.id } })
      expect(row.role).toBe('frontend')
    })

    it('refuses while the slave has a live run, changing nothing', async () => {
      const { teamId } = fixture
      const slave = await prisma.slave.create({ data: { teamId, name: 'Wendy', role: 'backend' } })
      const run = await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working' } })

      const result = await setSlaveRole(slave.id, 'qa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'slave_run_active', slaveId: slave.id, runId: run.id })
      const row = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
      expect(row.role).toBe('backend')
    })

    it('a succeeded (terminal) run does not block a role change', async () => {
      const { slaveWithRun } = fixture

      const result = await setSlaveRole(slaveWithRun.id, 'staff-backend')

      expect(result.ok).toBe(true)
    })

    it('refuses an unknown slave', async () => {
      const result = await setSlaveRole(UNKNOWN, 'qa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'slave_not_found', slaveId: UNKNOWN })
    })
  })

  describe('deleteSlave', () => {
    it('deletes a run-less slave and emits one org.changed event with to: null', async () => {
      const { slaveNoRuns, workspaceId } = fixture

      const result = await deleteSlave(slaveNoRuns.id)

      expect(result.ok).toBe(true)
      expect(await prisma.slave.findUnique({ where: { id: slaveNoRuns.id } })).toBeNull()

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.slaveId).toBe(slaveNoRuns.id)
      expect(events[0]?.payload).toEqual({ entity: 'slave', id: slaveNoRuns.id, field: 'deleted', from: 'Sam', to: null, runs: 0 })
    })

    it('deletes a slave with terminal run history and says how many runs went', async () => {
      const { slaveWithRun, runId, workspaceId } = fixture

      const result = await deleteSlave(slaveWithRun.id)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual({ runs: 1 })
      expect(await prisma.slave.findUnique({ where: { id: slaveWithRun.id } })).toBeNull()
      expect(await prisma.slaveRun.findUnique({ where: { id: runId } })).toBeNull()

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ entity: 'slave', id: slaveWithRun.id, field: 'deleted', from: 'Alex', to: null, runs: 1 })
    })

    it('refuses an unknown slave', async () => {
      const result = await deleteSlave(UNKNOWN)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'slave_not_found', slaveId: UNKNOWN })
    })
  })

  describe('renameTeam', () => {
    it('renames the row and emits one org.changed event with the old and new name', async () => {
      const { teamId, workspaceId } = fixture

      const result = await renameTeam(teamId, 'Platform')

      expect(result.ok).toBe(true)
      const row = await prisma.team.findUniqueOrThrow({ where: { id: teamId } })
      expect(row.name).toBe('Platform')

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.slaveId).toBeNull()
      expect(events[0]?.payload).toEqual({ entity: 'team', id: teamId, field: 'name', from: 'Engineering', to: 'Platform' })
    })

    it('refuses a name already taken by a sibling team in the same workspace, changing nothing', async () => {
      const { teamId, workspaceId } = fixture
      await prisma.team.create({ data: { workspaceId, name: 'Design' } })

      const result = await renameTeam(teamId, 'Design')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Design' })
      const row = await prisma.team.findUniqueOrThrow({ where: { id: teamId } })
      expect(row.name).toBe('Engineering')
    })

    it('refuses a blank name, changing nothing', async () => {
      const { teamId } = fixture

      const result = await renameTeam(teamId, '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      const row = await prisma.team.findUniqueOrThrow({ where: { id: teamId } })
      expect(row.name).toBe('Engineering')
    })

    it('refuses an unknown team', async () => {
      const result = await renameTeam(UNKNOWN, 'Whatever')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'team_not_found', teamId: UNKNOWN })
    })
  })

  describe('deleteTeam', () => {
    it('deletes the department with its slaves and their runs, and says the counts', async () => {
      const { teamId, workspaceId } = fixture

      const result = await deleteTeam(teamId)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toEqual({ slaves: 2, runs: 1 })
      expect(await prisma.team.findUnique({ where: { id: teamId } })).toBeNull()
      expect(await prisma.slave.count()).toBe(0)
      expect(await prisma.slaveRun.count()).toBe(0)

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ entity: 'team', id: teamId, field: 'deleted', from: 'Engineering', to: null, slaves: 2, runs: 1 })
    })

    it('deletes an empty team and emits one org.changed event with to: null', async () => {
      const { workspaceId } = fixture
      const emptyTeam = await prisma.team.create({ data: { workspaceId, name: 'Design' } })

      const result = await deleteTeam(emptyTeam.id)

      expect(result.ok).toBe(true)
      expect(await prisma.team.findUnique({ where: { id: emptyTeam.id } })).toBeNull()

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.slaveId).toBeNull()
      expect(events[0]?.payload).toEqual({ entity: 'team', id: emptyTeam.id, field: 'deleted', from: 'Design', to: null, slaves: 0, runs: 0 })
    })

    it('refuses an unknown team', async () => {
      const result = await deleteTeam(UNKNOWN)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'team_not_found', teamId: UNKNOWN })
    })
  })
})
