import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteAgent, deleteTeam, renameAgent, renameTeam, setAgentRole } from '../../src/org.js'

// A real directory, not a placeholder (M23 G3): runFilePaths' statSync preflight refuses a repo path that does not exist, and a reboot clears /tmp -- the trap emergency.test.ts fell into at ce48adc.
const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-org-edit-'))

afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly agentWithRun: { readonly id: string; readonly name: string; readonly role: string }
  readonly agentNoRuns: { readonly id: string; readonly name: string; readonly role: string }
  readonly runId: string
  readonly taskId: string
}

/**
 * One team, two agents: `agentWithRun` carries a `succeeded` (terminal) `AgentRun` against a real
 * task -- exercises `deleteAgent`'s `agent_has_runs` refusal, which fires on ANY run history, not
 * only a live one. `agentNoRuns` is the clean roster member every ordinary edit lands on.
 */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agentWithRunRow = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const agentNoRunsRow = await prisma.agent.create({ data: { teamId: team.id, name: 'Sam', role: 'frontend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'make it work',
      maxAttempts: workspace.maxAttempts,
    },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agentWithRunRow.id, status: 'succeeded' },
  })
  return {
    workspaceId: workspace.id,
    teamId: team.id,
    agentWithRun: { id: agentWithRunRow.id, name: agentWithRunRow.name, role: agentWithRunRow.role },
    agentNoRuns: { id: agentNoRunsRow.id, name: agentNoRunsRow.name, role: agentNoRunsRow.role },
    runId: run.id,
    taskId: task.id,
  }
}

async function orgChangedEvents(workspaceId: string): Promise<
  readonly { readonly agentId: string | null; readonly payload: Record<string, unknown>; readonly actor: string }[]
> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'org_changed' },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({ agentId: row.agentId, payload: row.payload as Record<string, unknown>, actor: row.actor }))
}

describe('org-edit verbs', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "AgentRun", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  describe('renameAgent', () => {
    it('renames the row and emits one org.changed event with the old and new name', async () => {
      const { agentNoRuns, workspaceId } = fixture

      const result = await renameAgent(agentNoRuns.id, 'Samantha')

      expect(result.ok).toBe(true)
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentNoRuns.id } })
      expect(row.name).toBe('Samantha')

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.agentId).toBe(agentNoRuns.id)
      expect(events[0]?.actor).toBe('human')
      expect(events[0]?.payload).toEqual({ entity: 'agent', id: agentNoRuns.id, field: 'name', from: 'Sam', to: 'Samantha' })
    })

    it('refuses a name already taken by a sibling in the same team, changing nothing', async () => {
      const { agentNoRuns, agentWithRun, workspaceId } = fixture

      const result = await renameAgent(agentNoRuns.id, agentWithRun.name)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: agentWithRun.name })
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentNoRuns.id } })
      expect(row.name).toBe('Sam')
      expect(await orgChangedEvents(workspaceId)).toHaveLength(0)
    })

    it('refuses a blank name, changing nothing', async () => {
      const { agentNoRuns } = fixture

      const result = await renameAgent(agentNoRuns.id, '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_name' })
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentNoRuns.id } })
      expect(row.name).toBe('Sam')
    })

    it('refuses an unknown agent', async () => {
      const result = await renameAgent(UNKNOWN, 'Whoever')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })
    })
  })

  describe('setAgentRole', () => {
    it('sets the role and emits one org.changed event with the old and new role', async () => {
      const { agentNoRuns, workspaceId } = fixture

      const result = await setAgentRole(agentNoRuns.id, 'qa')

      expect(result.ok).toBe(true)
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentNoRuns.id } })
      expect(row.role).toBe('qa')

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ entity: 'agent', id: agentNoRuns.id, field: 'role', from: 'frontend', to: 'qa' })
    })

    it('refuses a blank role, changing nothing', async () => {
      const { agentNoRuns } = fixture

      const result = await setAgentRole(agentNoRuns.id, '   ')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'invalid_role' })
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentNoRuns.id } })
      expect(row.role).toBe('frontend')
    })

    it('refuses while the agent has a live run, changing nothing', async () => {
      const { teamId } = fixture
      const agent = await prisma.agent.create({ data: { teamId, name: 'Wendy', role: 'backend' } })
      const run = await prisma.agentRun.create({ data: { agentId: agent.id, status: 'working' } })

      const result = await setAgentRole(agent.id, 'qa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'agent_run_active', agentId: agent.id, runId: run.id })
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })
      expect(row.role).toBe('backend')
    })

    it('a succeeded (terminal) run does not block a role change', async () => {
      const { agentWithRun } = fixture

      const result = await setAgentRole(agentWithRun.id, 'staff-backend')

      expect(result.ok).toBe(true)
    })

    it('refuses an unknown agent', async () => {
      const result = await setAgentRole(UNKNOWN, 'qa')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })
    })
  })

  describe('deleteAgent', () => {
    it('deletes a run-less agent and emits one org.changed event with to: null', async () => {
      const { agentNoRuns, workspaceId } = fixture

      const result = await deleteAgent(agentNoRuns.id)

      expect(result.ok).toBe(true)
      expect(await prisma.agent.findUnique({ where: { id: agentNoRuns.id } })).toBeNull()

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.agentId).toBe(agentNoRuns.id)
      expect(events[0]?.payload).toEqual({ entity: 'agent', id: agentNoRuns.id, field: 'deleted', from: 'Sam', to: null })
    })

    it('refuses an agent with run history, even terminal, leaving it in place', async () => {
      const { agentWithRun, workspaceId } = fixture

      const result = await deleteAgent(agentWithRun.id)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'agent_has_runs', agentId: agentWithRun.id, runs: 1 })
      expect(await prisma.agent.findUnique({ where: { id: agentWithRun.id } })).not.toBeNull()
      expect(await orgChangedEvents(workspaceId)).toHaveLength(0)
    })

    it('refuses an unknown agent', async () => {
      const result = await deleteAgent(UNKNOWN)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })
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
      expect(events[0]?.agentId).toBeNull()
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
    it('refuses a team that still has agents, deleting nothing', async () => {
      const { teamId, workspaceId } = fixture

      const result = await deleteTeam(teamId)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'team_not_empty', teamId, agents: 2 })
      expect(await prisma.team.findUnique({ where: { id: teamId } })).not.toBeNull()
      expect(await orgChangedEvents(workspaceId)).toHaveLength(0)
    })

    it('deletes an empty team and emits one org.changed event with to: null', async () => {
      const { workspaceId } = fixture
      const emptyTeam = await prisma.team.create({ data: { workspaceId, name: 'Design' } })

      const result = await deleteTeam(emptyTeam.id)

      expect(result.ok).toBe(true)
      expect(await prisma.team.findUnique({ where: { id: emptyTeam.id } })).toBeNull()

      const events = await orgChangedEvents(workspaceId)
      expect(events).toHaveLength(1)
      expect(events[0]?.agentId).toBeNull()
      expect(events[0]?.payload).toEqual({ entity: 'team', id: emptyTeam.id, field: 'deleted', from: 'Design', to: null })
    })

    it('refuses an unknown team', async () => {
      const result = await deleteTeam(UNKNOWN)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'team_not_found', teamId: UNKNOWN })
    })
  })
})
