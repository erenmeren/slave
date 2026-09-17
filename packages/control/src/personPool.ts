/**
 * Catalog Person Pool (Task 2): keeps exactly three MANAGED people per active `SlaveTemplate` --
 * `poolSlot` 1, 2 and 3 -- and picks one of them for a seat.
 *
 * `syncPersonPool` is the ONLY writer of a managed `Person` row after it is first created: it
 * creates a missing slot, and it keeps an existing slot's `capabilities` in step with its
 * template's current `capabilityKeys`. It never touches a row's `name` or `id` once written (Task
 * 2 brief: "existing managed rows keep names and ids forever"), and it never touches a person whose
 * `poolSlot` is `null` -- a manual hire, entirely outside this module's business.
 *
 * `selectPoolPerson` is a pure READ over that same table: it never creates, mutates or reserves
 * anybody (Task 2 brief). Choosing AMONG eligible candidates is `rankPoolCandidates`
 * (`@slave-of-ai/domain`), a pure function this module hands a plain list to -- the query is the
 * only part of "select" that belongs here.
 */
import { prisma } from '@slave-of-ai/db/client'
import { err, ok, rankPoolCandidates, randomEnglishName, type PoolCandidate, type Result } from '@slave-of-ai/domain'
import { isUniqueConstraintViolation, uniqueConstraintTarget } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

/** What one `syncPersonPool` pass did, across every active template. A no-op run (nothing to
 *  create, nothing whose capabilities drifted) still reports every slot as `unchanged` -- silence
 *  would leave an operator unable to tell "nothing needed doing" from "nothing ran". */
export interface PersonPoolSyncReport {
  /** How many active templates this pass considered. Three managed slots each, always. */
  readonly templates: number
  readonly created: number
  readonly updated: number
  readonly unchanged: number
}

/** The three managed slots every active template holds (Task 1's schema constraint; restated here
 *  as the one place this module's own loop bound comes from). */
const POOL_SLOTS = [1, 2, 3] as const

/**
 * How many different names one slot's create will try before giving up (Task 2 brief: "retry a
 * name collision with a bounded attempt count"). `FIRST_NAMES.length * LAST_NAMES.length` is 2,900
 * (`pool.ts`'s own docstring) -- twenty draws is far more than bad luck costs and far short of
 * exhausting a dictionary that size, so hitting the cap means something is actually wrong (a test
 * pinning `crypto.getRandomValues`, or a name space that has genuinely run out) rather than an
 * ordinary collision.
 */
export const NAME_COLLISION_MAX_ATTEMPTS = 20

type SlotOutcome = 'created' | 'updated' | 'unchanged'

/**
 * What `syncSlot`'s `catch` must do about an error a `Person.create` attempt threw, for exactly
 * one slot's one attempt: re-read the slot another process just won (`'slot_race'`), draw another
 * name (`'name_race'`), or leave it alone (`'rethrow'`) -- a REAL Prisma error this module never
 * anticipated (a dropped connection, a check constraint, a future third unique constraint on
 * `Person`) must surface exactly as it arrived (Task 2 brief: "never swallow unrelated Prisma
 * errors").
 */
export type PersonCreateErrorClassification = 'slot_race' | 'name_race' | 'rethrow'

/**
 * Pure classification of a `Person.create` error, extracted out of `syncSlot`'s `catch` so the
 * "rethrow anything unrelated" branch has a unit test that needs no database and nothing to spy
 * on (review fix round 1: `vi.spyOn` on a Prisma model method is unreliable against this
 * project's generated client -- see `prisma-errors.test.ts`'s docstring and the Task 2 report --
 * so this decision has to be reachable with plain object literals instead).
 *
 * Reads only `isUniqueConstraintViolation`/`uniqueConstraintTarget`'s answers; the two constraints
 * it distinguishes are `Person`'s only two today (`name`, `(templateId, poolSlot)`, Task 1). Any
 * P2002 on neither, and every non-P2002 error, classifies as `'rethrow'` -- not because this
 * function KNOWS those are safe, but because it knows exactly two things it is allowed to resolve
 * itself, and nothing else.
 */
export function classifyPersonCreateError(error: unknown): PersonCreateErrorClassification {
  if (!isUniqueConstraintViolation(error)) return 'rethrow'
  const target = uniqueConstraintTarget(error)
  if (target.some((column) => column.toLowerCase().includes('poolslot'))) return 'slot_race'
  if (target.some((column) => column.toLowerCase().includes('name'))) return 'name_race'
  return 'rethrow'
}

/** Whether a managed row's stored capabilities already match the template's, as SETS -- order
 *  never mattered to anything that reads `Person.capabilities`, and comparing it positionally
 *  would report a write every time an import re-orders `capabilityKeys` without changing it. */
function sameCapabilitySet(current: readonly string[], desired: readonly string[]): boolean {
  if (current.length !== desired.length) return false
  const want = new Set(desired)
  return current.every((key) => want.has(key))
}

/** Writes `capabilities` onto an existing managed row iff it drifted from the template's current
 *  set. Never touches `name`, `poolSlot` or anything else -- the one column this pass may ever
 *  move on a row that already exists (Task 2 brief). */
async function refreshManagedCapabilities(
  person: { readonly id: string; readonly capabilities: readonly string[] },
  capabilityKeys: readonly string[],
): Promise<'updated' | 'unchanged'> {
  if (sameCapabilitySet(person.capabilities, capabilityKeys)) return 'unchanged'
  await prisma.person.update({ where: { id: person.id }, data: { capabilities: [...capabilityKeys] } })
  return 'updated'
}

/**
 * Ensures ONE slot of ONE template holds a managed person, and that person's capabilities match.
 *
 * Read-then-write, not `upsert`: `@@unique([templateId, poolSlot])` (Task 1) is the concurrency
 * boundary, not a pre-check that closes it. Two processes racing this same slot both read `null`
 * and both attempt `create`; the database picks one, and the loser's `catch` re-reads exactly what
 * the winner wrote and syncs ITS capabilities instead of ever considering a second person for the
 * slot (Task 2 brief: "re-read a slot won by another process").
 *
 * `Person.name` is unique across the WHOLE installation (M58 R14), so a name collision is a
 * different race than the slot one and gets a different answer: retry with another name, up to
 * {@link NAME_COLLISION_MAX_ATTEMPTS}, never touching the slot this attempt owns.
 *
 * Only these two constraints are ever caught -- decided by {@link classifyPersonCreateError}. Any
 * other Prisma error -- a dropped connection, a check constraint this module did not anticipate --
 * is rethrown exactly as it arrived (Task 2 brief: "never swallow unrelated Prisma errors").
 */
async function syncSlot(
  templateId: string,
  capabilityKeys: readonly string[],
  poolSlot: (typeof POOL_SLOTS)[number],
): Promise<SlotOutcome> {
  const existing = await prisma.person.findUnique({
    where: { templateId_poolSlot: { templateId, poolSlot } },
    select: { id: true, capabilities: true },
  })
  if (existing !== null) return refreshManagedCapabilities(existing, capabilityKeys)

  for (let attempt = 0; attempt < NAME_COLLISION_MAX_ATTEMPTS; attempt += 1) {
    const name = randomEnglishName()
    try {
      await prisma.person.create({
        data: { name, templateId, poolSlot, capabilities: [...capabilityKeys] },
      })
      return 'created'
    } catch (error) {
      const classification = classifyPersonCreateError(error)
      if (classification === 'rethrow') throw error
      if (classification === 'slot_race') {
        const won = await prisma.person.findUniqueOrThrow({
          where: { templateId_poolSlot: { templateId, poolSlot } },
          select: { id: true, capabilities: true },
        })
        return refreshManagedCapabilities(won, capabilityKeys)
      }
      // classification === 'name_race': try another name, same slot, same attempt budget.
    }
  }
  throw new Error(
    `syncPersonPool: could not find a free name for template ${templateId} slot ${String(poolSlot)} ` +
      `after ${String(NAME_COLLISION_MAX_ATTEMPTS)} attempts`,
  )
}

/**
 * Ensures every ACTIVE template holds exactly three managed people, and that every existing one's
 * capabilities match its template's current set (Task 2 brief, global constraints).
 *
 * Inactive templates are never read here at all -- not "created for" and then left alone, simply
 * never considered -- which is the whole of "inactive templates create nothing" and "deactivation
 * deletes/releases nobody" (the row this pass would have synced is just not in its query).
 *
 * Idempotent: a second call with nothing changed underneath reports every slot `unchanged` and
 * writes nothing at all (Task 2 brief: "running sync twice is a no-op report on the second run").
 */
export async function syncPersonPool(): Promise<PersonPoolSyncReport> {
  const templates = await prisma.slaveTemplate.findMany({
    where: { active: true },
    select: { id: true, capabilityKeys: true },
  })

  let created = 0
  let updated = 0
  let unchanged = 0
  for (const template of templates) {
    for (const poolSlot of POOL_SLOTS) {
      const outcome = await syncSlot(template.id, template.capabilityKeys, poolSlot)
      if (outcome === 'created') created += 1
      else if (outcome === 'updated') updated += 1
      else unchanged += 1
    }
  }

  return { templates: templates.length, created, updated, unchanged }
}

/**
 * Picks a managed person for `templateId` to seat on `workspaceId`, without seating them.
 *
 * Eligible means: the template exists and is active, the person's `poolSlot` is managed (non-null)
 * and their engagement is not over (`releasedAt: null`), and they hold no OPEN seat anywhere on
 * THIS workspace -- a seat on another project is fine (Task 2 brief: "one person may hold seats on
 * multiple projects, but not two open seats in one workspace").
 *
 * Ranking is `rankPoolCandidates` (`@slave-of-ai/domain`), a pure function: this query only builds
 * the list it ranks. A read straight through -- no lock, no reservation -- because selection does
 * not create, mutate or reserve a person (Task 2 brief); the caller that actually seats them
 * (`hireFromTemplate`/`assignPerson`, Task 4) is what takes the write.
 */
export async function selectPoolPerson(
  templateId: string,
  workspaceId: string,
): Promise<Result<{ readonly personId: string; readonly name: string; readonly poolSlot: number }, ControlRefusal>> {
  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { active: true } })
  if (template === null || !template.active) return err({ kind: 'pool_unavailable', templateId })

  const managed = await prisma.person.findMany({
    where: { templateId, poolSlot: { not: null }, releasedAt: null },
    select: {
      id: true,
      name: true,
      poolSlot: true,
      seats: { where: { closedAt: null }, select: { team: { select: { workspaceId: true } } } },
    },
  })

  const candidates: PoolCandidate[] = []
  for (const person of managed) {
    if (person.seats.some((seat) => seat.team.workspaceId === workspaceId)) continue
    if (person.poolSlot === null) continue // unreachable under the `poolSlot: { not: null }` filter
    candidates.push({
      personId: person.id,
      name: person.name,
      poolSlot: person.poolSlot,
      openSeatCount: person.seats.length,
    })
  }
  if (candidates.length === 0) return err({ kind: 'pool_unavailable', templateId })

  const [chosen] = rankPoolCandidates(candidates)
  if (chosen === undefined) return err({ kind: 'pool_unavailable', templateId })
  return ok({ personId: chosen.personId, name: chosen.name, poolSlot: chosen.poolSlot })
}
