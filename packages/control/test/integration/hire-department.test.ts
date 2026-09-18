/**
 * Final review fix round 2, gap 5: `hireFromTemplate` must not leave a department behind when it
 * hires nobody, and must say so on the timeline when it creates one.
 *
 * The verb found-or-created `functionalDepartmentFor(role, runtimeRoles)` at the TOP of its create
 * branch, before it had re-verified the pool candidate under the person lock. Returning a value from
 * an interactive `$transaction` COMMITS whatever it wrote (`department.ts`'s `AssignmentRefused`
 * docstring says the same thing about the same fact), so the two branches that return without seating
 * anybody -- `needs_pool` when the chosen candidate raced away, and the `requirePool` refusal after
 * it -- committed an empty `Team`. On a project with no departments at all that is a department
 * created by a hire that was refused: visible in the Organization view, in the sidebar, and to
 * `formTeam`, with nobody in it and nothing that would ever clean it up.
 *
 * And when the hire DOES create one, nothing said so. `createProjectTeam` writes
 * `org.changed { entity: 'team', field: 'created' }` for exactly this, which is how intake's staff
 * step puts its departments on the timeline; a department that appeared because the Supervisor hired
 * a backend specialist appeared out of nowhere.
 *
 * The candidate race is reproduced without mocking anything: the `Workspace` row is held `FOR UPDATE`
 * from another transaction, which parks the hire's first attempt AFTER it has already chosen its
 * candidate (`selectPoolPerson` runs before the transaction opens, for lock order), and the pool is
 * then taken apart underneath it before the lock is released.
 */
import { prisma } from '@slave-of-ai/db/client'
import { functionalDepartmentFor } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { hireFromTemplate, syncCapabilityTaxonomy } from '../../src/capability.js'
import { syncPersonPool } from '../../src/personPool.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

const DEPARTMENT = functionalDepartmentFor('backend', ['backend'])

let seq = 0

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await syncCapabilityTaxonomy()
})

/** A project with NO department -- what `createWorkspace` and intake's own `create_workspace` step
 *  leave behind, and the state in which an empty department created by a refusal is unmistakable. */
async function project(): Promise<string> {
  seq += 1
  const workspace = await prisma.workspace.create({
    data: {
      name: `Hire Department ${String(seq)}`,
      repoPath: '/tmp/hire-department',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  return workspace.id
}

async function activeTemplate(name: string): Promise<{ readonly id: string }> {
  return prisma.slaveTemplate.create({
    data: { name, role: 'backend', description: 'x', active: true, capabilityKeys: ['backend.api-design'] },
  })
}

const teamEvents = async (workspaceId: string) =>
  (
    await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' }, orderBy: { seq: 'asc' } })
  ).filter((event) => (event.payload as { entity?: string }).entity === 'team')

/** Holds `FOR UPDATE` on the workspace row until `release()`. The hire's own transaction takes that
 *  same lock as its first statement, so this parks it precisely between "candidate chosen" and
 *  "candidate re-verified". */
function holdWorkspaceLock(workspaceId: string): { readonly done: Promise<void>; readonly held: Promise<void>; release: () => void } {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let announce = (): void => {}
  const held = new Promise<void>((resolve) => {
    announce = resolve
  })
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      announce()
      await gate
    },
    { timeout: 30_000, maxWait: 10_000 },
  )
  return { done, held, release }
}

describe('a hire that seats nobody', () => {
  it('leaves no department behind when the pool candidate races away and requirePool refuses', async (): Promise<void> => {
    const workspaceId = await project()
    const template = await activeTemplate('Vanishing Pool Backend Developer')
    await syncPersonPool()

    // The hire will choose one of these three before it can take the workspace lock.
    const lock = holdWorkspaceLock(workspaceId)
    await lock.held
    const hiring = hireFromTemplate(workspaceId, template.id, { rationale: 'automatic staffing', requirePool: true })
    // Long enough for the verb to have read its candidate and blocked on the workspace row.
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Everybody released and their slots freed -- what `releasePerson` writes -- so the candidate the
    // hire is holding is no longer eligible when it finally reads it under the person lock. And the
    // template DEACTIVATED, so the one sync the verb is allowed has nothing to create and the second
    // attempt finds no candidate either: the `requirePool` refusal is final.
    await prisma.person.updateMany({
      where: { templateId: template.id },
      data: { releasedAt: new Date(), releaseReason: 'released mid-hire', poolSlot: null },
    })
    await prisma.slaveTemplate.update({ where: { id: template.id }, data: { active: false } })
    lock.release()
    await lock.done

    const out = await hiring

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toMatchObject({ kind: 'pool_unavailable', templateId: template.id })
    // The finding. A refused hire that created `Engineering` leaves a department on the project, in
    // the Organization view and in `formTeam`'s roster, that nobody asked for and nothing removes.
    expect(await prisma.team.findMany({ where: { workspaceId } })).toEqual([])
    // And no event claiming one was created, because none was.
    expect(await teamEvents(workspaceId)).toEqual([])
  })
})

describe('a hire that creates the department it needs', () => {
  it('says so on the timeline, with the same org.changed createProjectTeam writes', async (): Promise<void> => {
    const workspaceId = await project()
    const template = await activeTemplate('First Hire Backend Developer')
    await syncPersonPool()

    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'the first hire on this project' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId } })
    expect(team.name).toBe(DEPARTMENT)

    const events = await teamEvents(workspaceId)
    expect(events).toHaveLength(1)
    // `createProjectTeam`'s payload exactly -- same entity, same field, same from/to -- so the
    // Activity card that already renders a department creation renders this one, and an operator
    // cannot tell from the timeline which verb made the department because it does not matter.
    expect(events[0]?.payload).toEqual({ entity: 'team', id: team.id, field: 'created', from: null, to: DEPARTMENT })
    // The department comes BEFORE the seat that went into it, which is the order they happened in.
    const created = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' }, orderBy: { seq: 'asc' } })
    expect((created[1]?.payload as { entity?: string; field?: string }).entity).toBe('slave')
    expect((created[1]?.payload as { entity?: string; field?: string }).field).toBe('created')
  })

  it('emits nothing for a department it merely REUSED: two hires into one department are one creation', async (): Promise<void> => {
    const workspaceId = await project()
    const backend = await activeTemplate('Reuse Department Backend Developer')
    const database = await prisma.slaveTemplate.create({
      // `database` is `Engineering` too, so this second hire lands in the department the first one
      // made -- a different persona, the same department, and no second creation event.
      data: { name: 'Reuse Department Database Developer', role: 'database', description: 'x', active: true, capabilityKeys: [] },
    })
    await syncPersonPool()

    expect((await hireFromTemplate(workspaceId, backend.id, { rationale: 'first' })).ok).toBe(true)
    expect((await hireFromTemplate(workspaceId, database.id, { rationale: 'second' })).ok).toBe(true)

    expect(await prisma.team.count({ where: { workspaceId } })).toBe(1)
    expect(await teamEvents(workspaceId)).toHaveLength(1)
  })
})
