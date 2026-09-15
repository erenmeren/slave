import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assignCompany,
  createProjectTeam,
  deleteCompanyTeam,
  moveSlave,
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
  readonly slaveId: string
  readonly companyId: string
  readonly otherCompanyId: string
  readonly templateId: string
  readonly backendTemplateTeamId: string
  readonly emptyTemplateTeamId: string
  readonly otherCompanyTeamId: string
  readonly memberPersonId: string
}

/** Two workspaces (one with two departments and one slave), two companies (one with a
 *  department template holding one catalog slave and an empty template), one slave template. */
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
  const slave = await prisma.slave.create({ data: { teamId: engineering.id, role: 'backend', personId: (await prisma.person.create({ data: { name: 'Alex' } })).id } })
  const template = await prisma.slaveTemplate.create({
    data: { name: 'Backend Developer', role: 'backend', description: 'ships services' },
  })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const otherCompany = await prisma.company.create({ data: { name: 'hhg' } })
  const backendTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const emptyTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
  const otherCompanyTeam = await prisma.companyTeam.create({ data: { companyId: otherCompany.id, name: 'Backend' } })
  const member = await prisma.person.create({ data: { templateId: template.id, name: 'Sam', lifecycle: 'permanent', departments: { create: { companyTeamId: backendTemplateTeam.id } } } })
  return {
    workspaceId: workspace.id,
    otherWorkspaceId: other.id,
    engineeringId: engineering.id,
    qaId: qa.id,
    otherTeamId: otherTeam.id,
    slaveId: slave.id,
    companyId: company.id,
    otherCompanyId: otherCompany.id,
    templateId: template.id,
    backendTemplateTeamId: backendTemplateTeam.id,
    emptyTemplateTeamId: emptyTemplateTeam.id,
    otherCompanyTeamId: otherCompanyTeam.id,
    memberPersonId: member.id,
  }
}

async function orgChangedEvents(workspaceId: string): Promise<
  readonly { readonly slaveId: string | null; readonly payload: Record<string, unknown> }[]
> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'org_changed' },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({ slaveId: row.slaveId, payload: row.payload as Record<string, unknown> }))
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
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
    expect(events[0]?.slaveId).toBeNull()
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

  // M34 t2: a sibling row created directly (`prisma.team.create`, not through this verb's own
  // pre-check) is still refused -- the `findFirst` pre-check above already catches this ONE case
  // (the sibling is already committed by the time it runs), so this alone is not proof the fix
  // below did anything; the `Promise.all` case right after is the one that needs the index and
  // catch, closing the window between the pre-check's read and its own write that this case does
  // not exercise.
  it('refuses a name a directly-created sibling row already holds', async () => {
    await prisma.team.create({ data: { workspaceId: fixture.workspaceId, name: 'Design' } })

    const result = await createProjectTeam(fixture.workspaceId, 'Design')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Design' })
    expect(await prisma.team.count({ where: { workspaceId: fixture.workspaceId, name: 'Design' } })).toBe(1)
  })

  it('two concurrent creates of the same name yield exactly one ok and one duplicate_name', async () => {
    const [first, second] = await Promise.all([
      createProjectTeam(fixture.workspaceId, 'Design'),
      createProjectTeam(fixture.workspaceId, 'Design'),
    ])

    const results = [first, second]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const refused = results.filter((r) => !r.ok)
    expect(refused).toHaveLength(1)
    if (!refused[0]?.ok) expect(refused[0]?.error).toEqual({ kind: 'duplicate_name', name: 'Design' })
    expect(await prisma.team.count({ where: { workspaceId: fixture.workspaceId, name: 'Design' } })).toBe(1)
  })
})

describe('moveSlave', () => {
  it('moves the slave to another department in the same workspace and emits one org.changed event', async () => {
    const result = await moveSlave(fixture.slaveId, fixture.qaId)

    expect(result.ok).toBe(true)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId }, include: { person: true } })
    expect(row.teamId).toBe(fixture.qaId)

    const events = await orgChangedEvents(fixture.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]?.slaveId).toBe(fixture.slaveId)
    expect(events[0]?.payload).toEqual({ entity: 'slave', id: fixture.slaveId, field: 'team', from: 'Engineering', to: 'QA' })
  })

  it('refuses a department in another workspace, changing nothing', async () => {
    const result = await moveSlave(fixture.slaveId, fixture.otherTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'team_workspace_mismatch', slaveId: fixture.slaveId, teamId: fixture.otherTeamId })
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId }, include: { person: true } })
    expect(row.teamId).toBe(fixture.engineeringId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('refuses while the slave holds a live run', async () => {
    const task = await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
    })
    const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: fixture.slaveId, status: 'working' } })

    const result = await moveSlave(fixture.slaveId, fixture.qaId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'slave_run_active', slaveId: fixture.slaveId, runId: run.id })
  })

  it('refuses an unknown slave and an unknown department', async () => {
    const slave = await moveSlave(UNKNOWN, fixture.qaId)
    expect(slave.ok).toBe(false)
    if (!slave.ok) expect(slave.error).toEqual({ kind: 'slave_not_found', slaveId: UNKNOWN })

    const team = await moveSlave(fixture.slaveId, UNKNOWN)
    expect(team.ok).toBe(false)
    if (!team.ok) expect(team.error).toEqual({ kind: 'team_not_found', teamId: UNKNOWN })
  })

  // M25 final review, item B: the one write path that skipped the sibling rule every other verb
  // enforces. M58 R2 restates the rule as `@@unique([personId, teamId])` -- one seat per person per
  // team -- so what a move into a department this person already sits in is refused with is
  // `already_assigned`, and the seat they were moving from is left exactly where it was.
  it('refuses a department this person already holds an open seat in, changing nothing', async () => {
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId }, select: { personId: true } })
    const clash = await prisma.slave.create({ data: { teamId: fixture.qaId, role: 'qa', personId: seat.personId } })

    const result = await moveSlave(fixture.slaveId, fixture.qaId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'already_assigned', personId: seat.personId, teamId: fixture.qaId })
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId }, include: { person: true } })
    expect(row.teamId).toBe(fixture.engineeringId)
    const clashRow = await prisma.slave.findUniqueOrThrow({ where: { id: clash.id }, include: { person: true } })
    expect(clashRow.teamId).toBe(fixture.qaId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('moving to the current department is a no-op with no event', async () => {
    const result = await moveSlave(fixture.slaveId, fixture.engineeringId)

    expect(result.ok).toBe(true)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId }, include: { person: true } })
    expect(row.teamId).toBe(fixture.engineeringId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })
})

// M25 final review, item A (Critical): `assignCompany`'s find-or-create used to look a worker up
// by `{ teamId: <the template's own copied department>, memberPersonId }` -- scoped to the ONE
// department that template first materialized into. A worker `moveSlave`d to a different
// department of the same project still carries the same `memberPersonId`, so the next
// `assignCompany` no longer found it there and created a second `Slave` with the same name and
// the same `memberPersonId` (no unique index on that column catches it). The lookup is now scoped
// to the workspace, not the department.
describe('assignCompany (item A: finds a moved worker anywhere in the project)', () => {
  it('does not duplicate a worker that moveSlave relocated to a second department', async () => {
    const first = await assignCompany(fixture.workspaceId, fixture.companyId)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.createdWorkers).toHaveLength(1)

    const worker = await prisma.slave.findFirstOrThrow({ where: { personId: fixture.memberPersonId }, include: { person: true } })
    const originalTeamId = worker.teamId
    expect(originalTeamId).not.toBe(fixture.qaId)

    const moved = await moveSlave(worker.id, fixture.qaId)
    expect(moved.ok).toBe(true)

    const second = await assignCompany(fixture.workspaceId, fixture.companyId)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.createdWorkers).toEqual([])

    const workers = await prisma.slave.findMany({ where: { personId: fixture.memberPersonId } })
    expect(workers).toHaveLength(1)
    expect(workers[0]?.id).toBe(worker.id)
    expect(workers[0]?.teamId).toBe(fixture.qaId)
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
  it('deletes a template with its membership; the member keeps working (M58 R5)', async () => {
    const result = await deleteCompanyTeam(fixture.backendTemplateTeamId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ catalogSlaves: 1 })
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.backendTemplateTeamId } })).toBeNull()
    expect(await prisma.companyTeamMember.count({ where: { personId: fixture.memberPersonId } })).toBe(0)
    expect(await prisma.person.findUnique({ where: { id: fixture.memberPersonId } })).not.toBeNull()
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
