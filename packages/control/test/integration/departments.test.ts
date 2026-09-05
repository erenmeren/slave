import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assignCompany,
  createProjectTeam,
  deleteCompanyTeam,
  moveAgent,
  moveCompanyAgent,
  renameCompanyTeam,
} from '../../src/org.js'

// A real directory (M23 G3): a placeholder repo path fails runFilePaths' statSync preflight.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-departments-'))
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly otherWorkspaceId: string
  readonly engineeringId: string
  readonly qaId: string
  readonly otherTeamId: string
  readonly agentId: string
  readonly companyId: string
  readonly otherCompanyId: string
  readonly templateId: string
  readonly backendTemplateTeamId: string
  readonly emptyTemplateTeamId: string
  readonly otherCompanyTeamId: string
  readonly companyAgentId: string
}

/** Two workspaces (one with two departments and one agent), two companies (one with a
 *  department template holding one catalog agent and an empty template), one agent template. */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const other = await prisma.workspace.create({
    data: { name: 'Billing', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const engineering = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const qa = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  const template = await prisma.agentTemplate.create({
    data: { name: 'Backend Developer', role: 'backend', description: 'ships services' },
  })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const otherCompany = await prisma.company.create({ data: { name: 'hhg' } })
  const backendTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const emptyTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
  const otherCompanyTeam = await prisma.companyTeam.create({ data: { companyId: otherCompany.id, name: 'Backend' } })
  const companyAgent = await prisma.companyAgent.create({
    data: { companyTeamId: backendTemplateTeam.id, templateId: template.id, name: 'Sam' },
  })
  return {
    workspaceId: workspace.id,
    otherWorkspaceId: other.id,
    engineeringId: engineering.id,
    qaId: qa.id,
    otherTeamId: otherTeam.id,
    agentId: agent.id,
    companyId: company.id,
    otherCompanyId: otherCompany.id,
    templateId: template.id,
    backendTemplateTeamId: backendTemplateTeam.id,
    emptyTemplateTeamId: emptyTemplateTeam.id,
    otherCompanyTeamId: otherCompanyTeam.id,
    companyAgentId: companyAgent.id,
  }
}

async function orgChangedEvents(workspaceId: string): Promise<
  readonly { readonly agentId: string | null; readonly payload: Record<string, unknown> }[]
> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'org_changed' },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({ agentId: row.agentId, payload: row.payload as Record<string, unknown> }))
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('createProjectTeam', () => {
  it('creates a department with no template link and emits one org.changed event', async () => {
    const result = await createProjectTeam(fixture.workspaceId, 'Design')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.team.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row).toMatchObject({ workspaceId: fixture.workspaceId, name: 'Design', companyTeamId: null })

    const events = await orgChangedEvents(fixture.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]?.agentId).toBeNull()
    expect(events[0]?.payload).toEqual({ entity: 'team', id: result.value.id, field: 'created', from: null, to: 'Design' })
  })

  it('refuses a name already used in the same workspace, creating nothing', async () => {
    const result = await createProjectTeam(fixture.workspaceId, 'QA')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'QA' })
    expect(await prisma.team.count({ where: { workspaceId: fixture.workspaceId } })).toBe(2)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('refuses a blank name and an unknown workspace', async () => {
    const blank = await createProjectTeam(fixture.workspaceId, '   ')
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error).toEqual({ kind: 'invalid_name' })

    const unknown = await createProjectTeam(UNKNOWN, 'Design')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'workspace_not_found', workspaceId: UNKNOWN })
  })
})

describe('moveAgent', () => {
  it('moves the agent to another department in the same workspace and emits one org.changed event', async () => {
    const result = await moveAgent(fixture.agentId, fixture.qaId)

    expect(result.ok).toBe(true)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.qaId)

    const events = await orgChangedEvents(fixture.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]?.agentId).toBe(fixture.agentId)
    expect(events[0]?.payload).toEqual({ entity: 'agent', id: fixture.agentId, field: 'team', from: 'Engineering', to: 'QA' })
  })

  it('refuses a department in another workspace, changing nothing', async () => {
    const result = await moveAgent(fixture.agentId, fixture.otherTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'team_workspace_mismatch', agentId: fixture.agentId, teamId: fixture.otherTeamId })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.engineeringId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('refuses while the agent holds a live run', async () => {
    const task = await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
    })
    const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId: fixture.agentId, status: 'working' } })

    const result = await moveAgent(fixture.agentId, fixture.qaId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'agent_run_active', agentId: fixture.agentId, runId: run.id })
  })

  it('refuses an unknown agent and an unknown department', async () => {
    const agent = await moveAgent(UNKNOWN, fixture.qaId)
    expect(agent.ok).toBe(false)
    if (!agent.ok) expect(agent.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })

    const team = await moveAgent(fixture.agentId, UNKNOWN)
    expect(team.ok).toBe(false)
    if (!team.ok) expect(team.error).toEqual({ kind: 'team_not_found', teamId: UNKNOWN })
  })

  // M25 final review, item B: the one write path that skipped `renameAgent`'s own per-department
  // unique-name rule.
  it('refuses a department that already has an agent of that name, changing nothing', async () => {
    const clash = await prisma.agent.create({ data: { teamId: fixture.qaId, name: 'Alex', role: 'qa' } })

    const result = await moveAgent(fixture.agentId, fixture.qaId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Alex' })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.engineeringId)
    const clashRow = await prisma.agent.findUniqueOrThrow({ where: { id: clash.id } })
    expect(clashRow.teamId).toBe(fixture.qaId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('moving to the current department is a no-op with no event', async () => {
    const result = await moveAgent(fixture.agentId, fixture.engineeringId)

    expect(result.ok).toBe(true)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.engineeringId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })
})

// M25 final review, item A (Critical): `assignCompany`'s find-or-create used to look a worker up
// by `{ teamId: <the template's own copied department>, companyAgentId }` -- scoped to the ONE
// department that template first materialized into. A worker `moveAgent`d to a different
// department of the same project still carries the same `companyAgentId`, so the next
// `assignCompany` no longer found it there and created a second `Agent` with the same name and
// the same `companyAgentId` (no unique index on that column catches it). The lookup is now scoped
// to the workspace, not the department.
describe('assignCompany (item A: finds a moved worker anywhere in the project)', () => {
  it('does not duplicate a worker that moveAgent relocated to a second department', async () => {
    const first = await assignCompany(fixture.workspaceId, fixture.companyId)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.createdWorkers).toHaveLength(1)

    const worker = await prisma.agent.findFirstOrThrow({ where: { companyAgentId: fixture.companyAgentId } })
    const originalTeamId = worker.teamId
    expect(originalTeamId).not.toBe(fixture.qaId)

    const moved = await moveAgent(worker.id, fixture.qaId)
    expect(moved.ok).toBe(true)

    const second = await assignCompany(fixture.workspaceId, fixture.companyId)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.createdWorkers).toEqual([])

    const workers = await prisma.agent.findMany({ where: { companyAgentId: fixture.companyAgentId } })
    expect(workers).toHaveLength(1)
    expect(workers[0]?.id).toBe(worker.id)
    expect(workers[0]?.teamId).toBe(fixture.qaId)
  })
})

describe('moveCompanyAgent', () => {
  it('moves the catalog agent to another template of the same company and writes no event', async () => {
    const result = await moveCompanyAgent(fixture.companyAgentId, fixture.emptyTemplateTeamId)

    expect(result.ok).toBe(true)
    const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: fixture.companyAgentId } })
    expect(row.companyTeamId).toBe(fixture.emptyTemplateTeamId)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses a template of another company, changing nothing', async () => {
    const result = await moveCompanyAgent(fixture.companyAgentId, fixture.otherCompanyTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'company_mismatch',
        companyAgentId: fixture.companyAgentId,
        companyTeamId: fixture.otherCompanyTeamId,
      })
    }
    const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: fixture.companyAgentId } })
    expect(row.companyTeamId).toBe(fixture.backendTemplateTeamId)
  })

  it('refuses when the target template already has a member of that name', async () => {
    await prisma.companyAgent.create({
      data: { companyTeamId: fixture.emptyTemplateTeamId, templateId: fixture.templateId, name: 'Sam' },
    })

    const result = await moveCompanyAgent(fixture.companyAgentId, fixture.emptyTemplateTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Sam' })
  })

  it('refuses an unknown catalog agent and an unknown template', async () => {
    const agent = await moveCompanyAgent(UNKNOWN, fixture.emptyTemplateTeamId)
    expect(agent.ok).toBe(false)
    if (!agent.ok) expect(agent.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })

    const team = await moveCompanyAgent(fixture.companyAgentId, UNKNOWN)
    expect(team.ok).toBe(false)
    if (!team.ok) expect(team.error).toEqual({ kind: 'company_team_not_found', companyTeamId: UNKNOWN })
  })
})

describe('renameCompanyTeam', () => {
  it('renames the template and writes no event', async () => {
    const result = await renameCompanyTeam(fixture.emptyTemplateTeamId, 'Platform')

    expect(result.ok).toBe(true)
    const row = await prisma.companyTeam.findUniqueOrThrow({ where: { id: fixture.emptyTemplateTeamId } })
    expect(row.name).toBe('Platform')
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses a sibling name in the same company, a blank name and an unknown template', async () => {
    const taken = await renameCompanyTeam(fixture.emptyTemplateTeamId, 'Backend')
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.error).toEqual({ kind: 'duplicate_name', name: 'Backend' })

    const blank = await renameCompanyTeam(fixture.emptyTemplateTeamId, ' ')
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error).toEqual({ kind: 'invalid_name' })

    const unknown = await renameCompanyTeam(UNKNOWN, 'Platform')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'company_team_not_found', companyTeamId: UNKNOWN })
  })
})

describe('deleteCompanyTeam', () => {
  it('refuses a template that still has a member, deleting nothing', async () => {
    const result = await deleteCompanyTeam(fixture.backendTemplateTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'company_team_not_empty', companyTeamId: fixture.backendTemplateTeamId, agents: 1 })
    }
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.backendTemplateTeamId } })).not.toBeNull()
  })

  it('deletes an empty template; a project department copied from it survives with companyTeamId null', async () => {
    const copy = await prisma.team.create({
      data: { workspaceId: fixture.workspaceId, name: 'Design', companyTeamId: fixture.emptyTemplateTeamId },
    })

    const result = await deleteCompanyTeam(fixture.emptyTemplateTeamId)

    expect(result.ok).toBe(true)
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.emptyTemplateTeamId } })).toBeNull()
    const survivor = await prisma.team.findUniqueOrThrow({ where: { id: copy.id } })
    expect(survivor.companyTeamId).toBeNull()
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses an unknown template', async () => {
    const result = await deleteCompanyTeam(UNKNOWN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'company_team_not_found', companyTeamId: UNKNOWN })
  })
})
