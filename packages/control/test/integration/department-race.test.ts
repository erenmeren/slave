/**
 * Final review fix round 2, Important A: `Team` is unique on `(workspaceId, name)`, and the two
 * verbs that write a project department NAME must serialise on the same row or one of them raises a
 * raw Prisma error out of a `Promise<Result<…>>`.
 *
 * `hireFromTemplate` finds-or-creates `functionalDepartmentFor(role, runtimeRoles)` INSIDE the
 * transaction whose value becomes its `Result`. It holds the `Workspace` row `FOR UPDATE` from its
 * first statement, so it serialises against every other writer that takes the same lock --
 * `seatMember`, `assignCompanyTx`, another hire. `createProjectTeam` and `renameTeam` did NOT take
 * it: they pre-checked the sibling name, created or renamed, and relied on
 * `Team_workspaceId_name_key` plus a `catch` to turn their OWN loser into a `duplicate_name`
 * refusal. That is a complete answer for two of them racing each other and no answer at all when
 * the loser is the hire: the hire's `tx.team.create` throws P2002 with nothing to catch it, the
 * whole hire transaction rolls back, and the caller -- the Supervisor's `hire_from_catalog` arm, or
 * intake's `staff` step -- gets a rejected promise where its contract promises a refusal value.
 *
 * So the `Workspace` row is now the ONE serialisation point for every project department-name
 * write, taken as the first statement of all three transactions. These cases race the real verbs
 * against each other on a real database rather than asserting about the lock: what they pin is the
 * OUTCOME the lock buys -- no raw error, one `Team`, a `Result` either way, and the person actually
 * seated in the department their role belongs to.
 */
import { prisma } from '@slave-of-ai/db/client'
import { functionalDepartmentFor } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { hireFromTemplate, syncCapabilityTaxonomy } from '../../src/capability.js'
import { createProjectTeam, renameTeam } from '../../src/org.js'
import { syncPersonPool } from '../../src/personPool.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

/**
 * How many times each case runs the same race. One pass proves nothing about an interleaving: the
 * two transactions may simply not overlap. Ten passes against a real connection pool is enough that
 * the unlocked code loses at least one of them -- measured, not assumed (see the fix report's red
 * evidence for this file).
 */
const RACES = 10

let seq = 0

/** `backend` is `Engineering` in the functional table, and this is read from the same function the
 *  verb calls rather than spelled here, so the department both racers aim at cannot drift apart from
 *  the one the hire actually picks. */
const DEPARTMENT = functionalDepartmentFor('backend', ['backend'])

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await syncCapabilityTaxonomy()
})

/** A project with NO department at all -- which is what a freshly created workspace is, and the
 *  state in which both racers want to create the same one. */
async function project(): Promise<string> {
  seq += 1
  const workspace = await prisma.workspace.create({
    data: {
      name: `Department Race ${String(seq)}`,
      repoPath: '/tmp/department-race',
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  return workspace.id
}

describe('a hire and a department create racing the same functional department', () => {
  it('never leaks a raw error, leaves exactly one Team, and seats the person in it', async (): Promise<void> => {
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Race Backend Developer', role: 'backend', description: 'x', active: true, capabilityKeys: ['backend.api-design'] },
    })
    // The pool exists BEFORE the races, so the hire has a managed candidate on its first attempt and
    // the only thing left to race is the department. Three managed people serve ten projects: a
    // person may hold a seat on several projects, just not two open seats on one.
    await syncPersonPool()

    for (let race = 0; race < RACES; race += 1) {
      const workspaceId = await project()

      const [hired, created] = await Promise.allSettled([
        hireFromTemplate(workspaceId, template.id, { rationale: 'raced against a department create' }),
        createProjectTeam(workspaceId, DEPARTMENT),
      ])

      // The whole point. A rejected hire is the P2002 leaking out of the Result contract, and the
      // rejection reason is printed rather than summarised so a failure names the constraint.
      if (hired.status === 'rejected') {
        throw new Error(`the hire rejected instead of returning a Result: ${String(hired.reason)}`)
      }
      if (created.status === 'rejected') {
        throw new Error(`createProjectTeam rejected instead of returning a Result: ${String(created.reason)}`)
      }
      expect(hired.value.ok).toBe(true)
      // The loser of the race is refused by NAME, which is the same refusal two concurrent
      // `createProjectTeam` calls have always given each other -- never a thrown error, and never a
      // second department.
      if (!created.value.ok) expect(created.value.error).toMatchObject({ kind: 'duplicate_name', name: DEPARTMENT })

      const teams = await prisma.team.findMany({ where: { workspaceId } })
      expect(teams.map((team) => team.name)).toEqual([DEPARTMENT])

      // Seated, in that one department, and MANAGED -- the hire did its whole job rather than
      // surviving the race by doing less of it.
      if (!hired.value.ok) return
      const seat = await prisma.slave.findFirstOrThrow({
        where: { personId: hired.value.value.personId, team: { workspaceId }, closedAt: null },
        include: { team: true, person: { select: { poolSlot: true } } },
      })
      expect(seat.team.name).toBe(DEPARTMENT)
      expect(seat.person.poolSlot).not.toBeNull()
    }
  })
})

describe('a hire and a department RENAME racing the same functional department name', () => {
  it('never leaks a raw error and never ends with two departments of one name', async (): Promise<void> => {
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Race Rename Developer', role: 'backend', description: 'x', active: true, capabilityKeys: ['backend.api-design'] },
    })
    await syncPersonPool()

    for (let race = 0; race < RACES; race += 1) {
      const workspaceId = await project()
      // A department the operator is about to rename INTO the name the hire wants. `renameTeam` took
      // the `Team` row and nothing above it, so its pre-check and the hire's could both read "no
      // Engineering here" and both write one.
      const design = await prisma.team.create({ data: { workspaceId, name: 'Design' } })

      const [hired, renamed] = await Promise.allSettled([
        hireFromTemplate(workspaceId, template.id, { rationale: 'raced against a department rename' }),
        renameTeam(design.id, DEPARTMENT),
      ])

      if (hired.status === 'rejected') {
        throw new Error(`the hire rejected instead of returning a Result: ${String(hired.reason)}`)
      }
      if (renamed.status === 'rejected') {
        throw new Error(`renameTeam rejected instead of returning a Result: ${String(renamed.reason)}`)
      }
      expect(hired.value.ok).toBe(true)
      if (!renamed.value.ok) expect(renamed.value.error).toMatchObject({ kind: 'duplicate_name', name: DEPARTMENT })

      // One department of that name, whichever verb wrote it. When the rename won there is exactly
      // one team in the project; when the hire won there are two, and only one of them is the
      // department both were aiming at.
      const named = await prisma.team.findMany({ where: { workspaceId, name: DEPARTMENT } })
      expect(named).toHaveLength(1)

      if (!hired.value.ok) return
      const seat = await prisma.slave.findFirstOrThrow({
        where: { personId: hired.value.value.personId, team: { workspaceId }, closedAt: null },
        include: { team: true },
      })
      expect(seat.team.name).toBe(DEPARTMENT)
    }
  })
})
