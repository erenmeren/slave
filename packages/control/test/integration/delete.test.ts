import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { readEventsSince } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteCompany, deleteCompanyTeam, deleteSlave, deleteSlaveTemplate, deleteTeam } from '../../src/org.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-delete-'))
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly slaveId: string
  readonly otherSlaveId: string
  readonly taskId: string
  readonly companyId: string
  readonly templateId: string
  readonly companyTeamId: string
  readonly memberPersonId: string
}

/** A company with one template and one department template holding one member; a project that has
 *  the company assigned, whose department copies the template and whose two seats (one held by that
 *  member, one by somebody in no department) share a task with three finished runs. */
async function seed(): Promise<Fixture> {
  const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend', description: '' } })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const member = await prisma.person.create({ data: { templateId: template.id, name: 'Sam', lifecycle: 'permanent', departments: { create: { companyTeamId: companyTeam.id } } } })
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [], companyId: company.id },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Backend', companyTeamId: companyTeam.id } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', personId: member.id } })
  const other = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', personId: (await prisma.person.create({ data: { name: 'Alex' } })).id } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
  })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'succeeded' } })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'failed' } })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: other.id, status: 'succeeded' } })
  return {
    workspaceId: workspace.id, teamId: team.id, slaveId: slave.id, otherSlaveId: other.id, taskId: task.id,
    companyId: company.id, templateId: template.id, companyTeamId: companyTeam.id, memberPersonId: member.id,
  }
}

async function orgChanged(workspaceId: string) {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' }, orderBy: { seq: 'asc' } })
  return rows.map((r) => r.payload as Record<string, unknown>)
}

let f: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  f = await seed()
})

describe('deleteSlave', () => {
  it('deletes a slave WITH its run history and says how many runs went', async () => {
    const result = await deleteSlave(f.slaveId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ runs: 2 })
    expect(await prisma.slave.findUnique({ where: { id: f.slaveId }, include: { person: true } })).toBeNull()
    expect(await prisma.slaveRun.count({ where: { slaveId: f.slaveId } })).toBe(0)
    expect(await prisma.slaveRun.count()).toBe(1)
    const events = await orgChanged(f.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ entity: 'slave', id: f.slaveId, field: 'deleted', from: 'Sam', to: null, runs: 2 })
  })

  it('refuses while the slave holds a live run', async () => {
    await prisma.slaveRun.create({ data: { taskId: f.taskId, slaveId: f.slaveId, status: 'working' } })
    const result = await deleteSlave(f.slaveId)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'live_runs', entity: 'slave', id: f.slaveId, runs: 1 })
    expect(await prisma.slave.findUnique({ where: { id: f.slaveId }, include: { person: true } })).not.toBeNull()
  })
})

describe('deleteTeam', () => {
  it('deletes a department with its slaves and their runs, and says the counts', async () => {
    const result = await deleteTeam(f.teamId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ slaves: 2, runs: 3 })
    expect(await prisma.team.findUnique({ where: { id: f.teamId } })).toBeNull()
    expect(await prisma.slave.count()).toBe(0)
    expect(await prisma.slaveRun.count()).toBe(0)
    expect(await prisma.task.count()).toBe(1) // tasks belong to the project, not the department
    const events = await orgChanged(f.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ entity: 'team', id: f.teamId, field: 'deleted', from: 'Backend', to: null, slaves: 2, runs: 3 })
  })

  it('refuses while any slave of the department holds a live run', async () => {
    await prisma.slaveRun.create({ data: { taskId: f.taskId, slaveId: f.otherSlaveId, status: 'starting' } })
    const result = await deleteTeam(f.teamId)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'live_runs', entity: 'team', id: f.teamId, runs: 1 })
    expect(await prisma.slave.count()).toBe(2)
  })
})

// M27 final review, ruling R16. Every other assertion in this file reads `ExecutionEvent.payload`
// straight off the row, which is the ONE path that cannot see the bug: the counts are written to
// the row either way. `readEventsSince` goes through `parseExecutionEvent`, and `z.object` strips
// every key the payload schema does not declare -- so before `org.changed` was widened, the
// timeline, the SSE stream and every other `ExecutionEvent`-typed reader got the event with the
// counts silently gone. This is the assertion that fails if the schema narrows again.
describe('the org.changed counts through the parsed reader', () => {
  it('survives parseExecutionEvent for both project deletes', async () => {
    await deleteSlave(f.slaveId)
    await deleteTeam(f.teamId)

    const payloads = (await readEventsSince(0)).flatMap((event) => (event.type === 'org.changed' ? [event.payload] : []))

    expect(payloads).toEqual([
      { entity: 'slave', id: f.slaveId, field: 'deleted', from: 'Sam', to: null, runs: 2 },
      // The department is down to `other` and its one run by the time it is deleted.
      { entity: 'team', id: f.teamId, field: 'deleted', from: 'Backend', to: null, slaves: 1, runs: 1 },
    ])
  })
})

describe('deleteCompanyTeam', () => {
  // M58 R5: what a department template holds is MEMBERSHIPS. They go with it; the people do not,
  // and neither does the project department copied from it.
  it('deletes a template WITH its memberships; the people and the project department survive', async () => {
    const result = await deleteCompanyTeam(f.companyTeamId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ catalogSlaves: 1 })
    expect(await prisma.companyTeamMember.count()).toBe(0)
    expect(await prisma.person.count()).toBe(2)
    const dept = await prisma.team.findUniqueOrThrow({ where: { id: f.teamId } })
    expect(dept.companyTeamId).toBeNull()
    expect(await prisma.slave.count()).toBe(2)
  })
})

describe('deleteSlaveTemplate', () => {
  // M58 R1: `Person.templateId` is `SetNull`, so a persona's deletion takes nobody with it -- what
  // the verb reports is how many people stopped naming it.
  it('deletes the persona and unlinks everybody hired from it; their seats keep their role', async () => {
    const result = await deleteSlaveTemplate(f.templateId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ personsUnlinked: 1 })
    expect(await prisma.slaveTemplate.findUnique({ where: { id: f.templateId } })).toBeNull()
    expect(await prisma.person.count()).toBe(2)
    expect((await prisma.person.findUniqueOrThrow({ where: { id: f.memberPersonId } })).templateId).toBeNull()
    const copy = await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId }, include: { person: true } })
    expect(copy.role).toBe('backend')
  })

  it('refuses an unknown template', async () => {
    const result = await deleteSlaveTemplate('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'template_not_found', templateId: '00000000-0000-4000-8000-000000000000' })
  })

  /**
   * Final review, Critical. `Person.templateId` is `ON DELETE SET NULL` and
   * `Person_poolSlot_requires_templateId` is a CHECK that a non-null `poolSlot` has a non-null
   * `templateId`. The database would therefore try to satisfy the FK by nulling `templateId` on
   * three managed rows that still hold slots 1, 2 and 3 -- and the CHECK would refuse it, so the
   * whole delete failed with a constraint violation out of a `Promise<Result<…>>` with nowhere to
   * put it. Deleting an imported persona is an ordinary operator act, so the verb clears the slots
   * itself, under the lock it already holds.
   *
   * Every OTHER fact about those three people survives: they are ordinary unmanaged people
   * afterwards, which is exactly what M58 R1 promises about a persona's deletion.
   */
  it('releases the three managed pool slots and leaves three ordinary people behind', async () => {
    const managed = await Promise.all(
      [1, 2, 3].map(async (slot) =>
        prisma.person.create({
          data: {
            name: `Managed Slot ${String(slot)}`,
            templateId: f.templateId,
            poolSlot: slot,
            capabilities: ['backend.services'],
          },
        }),
      ),
    )

    const result = await deleteSlaveTemplate(f.templateId)

    expect(result.ok).toBe(true)
    // The member seeded by the fixture plus these three: the count is what the verb reports.
    if (result.ok) expect(result.value).toEqual({ personsUnlinked: 4 })
    expect(await prisma.slaveTemplate.findUnique({ where: { id: f.templateId } })).toBeNull()
    for (const person of managed) {
      const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
      expect(after.templateId).toBeNull()
      expect(after.poolSlot).toBeNull()
      expect(after.name).toBe(person.name)
      expect(after.capabilities).toEqual(['backend.services'])
    }
    // The FK action and the CHECK no longer collide THROUGH THE SUPPORTED VERB, which is the whole
    // point: the same delete attempted with the slots left in place is what the database refuses.
    await expect(
      prisma.person.update({ where: { id: managed[0]?.id ?? '' }, data: { poolSlot: 1 } }),
    ).rejects.toThrow()
  })

  it('keeps seats, department memberships and history for a managed person whose template goes', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Pooled Persona', role: 'backend', description: '' } })
    const person = await prisma.person.create({
      data: {
        name: 'Managed And Seated',
        templateId: template.id,
        poolSlot: 1,
        capabilities: ['backend.api-design'],
        departments: { create: { companyTeamId: f.companyTeamId } },
      },
    })
    const seat = await prisma.slave.create({ data: { teamId: f.teamId, role: 'backend', personId: person.id } })
    await prisma.slaveRun.create({ data: { taskId: f.taskId, slaveId: seat.id, status: 'succeeded' } })

    const result = await deleteSlaveTemplate(template.id)

    expect(result.ok).toBe(true)
    const after = await prisma.person.findUniqueOrThrow({
      where: { id: person.id },
      include: { seats: { include: { runs: true } }, departments: true },
    })
    expect(after.poolSlot).toBeNull()
    expect(after.templateId).toBeNull()
    expect(after.capabilities).toEqual(['backend.api-design'])
    expect(after.seats).toHaveLength(1)
    expect(after.seats[0]?.runs).toHaveLength(1)
    expect(after.departments).toHaveLength(1)
  })
})

describe('deleteCompany', () => {
  it('deletes the company, its templates and their memberships; detaches the project; people and project rows survive', async () => {
    const result = await deleteCompany(f.companyId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ templates: 1, catalogSlaves: 1, projectsDetached: 1 })
    expect(await prisma.company.count()).toBe(0)
    expect(await prisma.companyTeam.count()).toBe(0)
    expect(await prisma.companyTeamMember.count()).toBe(0)
    expect(await prisma.person.count()).toBe(2)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(ws.companyId).toBeNull()
    expect(await prisma.team.count()).toBe(1)
    expect(await prisma.slave.count()).toBe(2)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses an unknown company', async () => {
    const result = await deleteCompany('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'company_not_found', companyId: '00000000-0000-4000-8000-000000000000' })
  })
})
