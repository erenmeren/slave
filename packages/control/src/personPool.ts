/**
 * Catalog Person Pool (Task 2): keeps exactly three MANAGED people per active `SlaveTemplate` --
 * `poolSlot` 1, 2 and 3 -- and picks one of them for a seat.
 *
 * `syncPersonPool` creates a missing slot and keeps an existing slot's stored `capabilities` in
 * step with the template's current `capabilityKeys`. It is NOT the only writer of a managed row --
 * it never was, and the module docstring used to claim it was (corrected, final review minor):
 * `hireFromTemplate` writes `selectionRationale` and merges capabilities when it seats a pool
 * person, `setPersonCapabilities` writes grants, `releasePerson` stamps `releasedAt` and clears
 * the slot, and `deleteSlaveTemplate` clears the slot too. What IS true, and is the invariant that
 * matters: this pass never touches a row's `name` or `id` once written (Task 2 brief: "existing
 * managed rows keep names and ids forever"), and it never touches a person whose `poolSlot` is
 * `null` -- a manual hire, entirely outside this module's business.
 *
 * Nor does it overwrite an explicit grant (final review, Important 2). A managed person's
 * capability set has TWO sources -- their template's baseline and whatever somebody granted them
 * on top of it -- and they are stored apart, in `capabilities` (the effective union, what every
 * reader reads) and `capabilityGrants` (the explicit half only). This pass recomputes the union,
 * so a template ADDITION arrives, a template REMOVAL disappears, and a grant survives both. The
 * recompute happens under a `FOR UPDATE` on the Person row, because otherwise a
 * `setPersonCapabilities` committing a grant between this pass's read and its write would have
 * that grant silently erased. That lock is taken only for a row whose union has actually MOVED
 * (`managedSlotNeedsRefresh`, final review fix round 2): a pass over a pool already in step -- which
 * is nearly every pass, on a daemon that runs one at startup and one per reconciliation -- opens no
 * transaction and locks nobody.
 *
 * `selectPoolPerson` is a pure READ over that same table: it never creates, mutates or reserves
 * anybody (Task 2 brief). Choosing AMONG eligible candidates is `rankPoolCandidates`
 * (`@slave-of-ai/domain`), a pure function this module hands a plain list to -- the query is the
 * only part of "select" that belongs here.
 */
import { prisma } from '@slave-of-ai/db/client'
import {
  FIRST_NAMES,
  LAST_NAMES,
  effectiveCapabilities,
  err,
  ok,
  rankPoolCandidates,
  randomEnglishName,
  type PoolCandidate,
  type Result,
} from '@slave-of-ai/domain'
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
 * name collision with a bounded attempt count"). The dictionaries offer over seven hundred
 * thousand combinations (`pool.ts`, final review Important 6), so twenty draws is far more than
 * bad luck costs and far short of exhausting a name space that size: hitting the cap means
 * something is actually wrong -- a test pinning `crypto.getRandomValues`, or a name space that has
 * genuinely run out -- rather than an ordinary collision.
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

/** Whether a managed row's stored capabilities already match the set this pass computed, as SETS
 *  -- order never mattered to anything that reads `Person.capabilities`, and comparing it
 *  positionally would report a write every time an import re-orders `capabilityKeys` without
 *  changing it. */
function sameCapabilitySet(current: readonly string[], desired: readonly string[]): boolean {
  if (current.length !== desired.length) return false
  const want = new Set(desired)
  return current.every((key) => want.has(key))
}

/** One managed row, as the prefetch reads it -- the two capability columns and nothing else, because
 *  these two are the whole of what {@link managedSlotNeedsRefresh} decides on. */
export interface ManagedCapabilityRow {
  readonly capabilities: readonly string[]
  readonly capabilityGrants: readonly string[]
}

/**
 * Whether one already-existing managed slot is worth a transaction -- the pass's per-slot decision,
 * pure (final review fix round 2, Important B).
 *
 * Important 4's prefetch replaced a `findUnique` per (template, slot) with one query, and then went
 * on calling the LOCKED {@link refreshManagedCapabilities} for every occupied slot regardless: one
 * `BEGIN` + `Person` `FOR UPDATE` + `findUnique` + `COMMIT` per person, 834 of them per pass on the
 * measured installation, whose honest answer for all 834 was "unchanged". It had made the reads
 * cheap and left the expensive half exactly where it was -- and the daemon runs this pass at startup
 * and on every reconciliation.
 *
 * So the prefetch carries both capability columns now and this answers, in memory, whether the row
 * has drifted from the union of its template's current baseline and its own grants. Only a `true`
 * costs a transaction.
 *
 * Pure and exported for `classifyPersonCreateError`'s own reason (its docstring above): the decision
 * deserves a test that needs no database and nothing to spy on. What it CANNOT promise is that the
 * grants it read are still the grants: they are a prefetched value, and a `setPersonCapabilities`
 * committing between the prefetch and the write is exactly the lost update Important 2 closed. That
 * is why a `true` still goes through the locked function, which re-reads the grant column under
 * `FOR UPDATE` before writing; this decision only ever moves a row from "definitely nothing to do"
 * to "look properly", and never the other way.
 */
export function managedSlotNeedsRefresh(row: ManagedCapabilityRow, capabilityKeys: readonly string[]): boolean {
  return !sameCapabilitySet(row.capabilities, effectiveCapabilities(capabilityKeys, row.capabilityGrants))
}

/**
 * Recomputes ONE existing managed row's effective capability set and writes it iff it drifted.
 *
 * `FOR UPDATE` on the Person row, and the grants re-read UNDER that lock (final review, Important
 * 2). The prefetched row this pass started from is only a work list; the grant column it would
 * union against is the one thing another writer can change while this pass runs, and computing the
 * union off a stale read is precisely how a concurrent `set-capabilities` gets erased. One
 * transaction per PERSON rather than one for the whole pass: a lock held across 834 rows would
 * block every other writer of the table for as long as the pass ran, and a partial pass is a
 * correct pass -- the next one finishes it.
 *
 * Reached only for a row {@link managedSlotNeedsRefresh} says has drifted (final review fix round 2,
 * Important B) -- so on an ordinary pass, for which every slot is in step, this function is not
 * called at all and no row is locked. The re-read below is unchanged and still load-bearing: the
 * decision to come here was made off a prefetched value, and this is where the grant column is read
 * as it actually stands.
 *
 * Never touches `name`, `poolSlot` or anything else. `capabilities` is the one column this pass
 * may ever move on a row that already exists (Task 2 brief).
 */
async function refreshManagedCapabilities(personId: string, capabilityKeys: readonly string[]): Promise<'updated' | 'unchanged'> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
    const person = await tx.person.findUnique({
      where: { id: personId },
      select: { capabilities: true, capabilityGrants: true },
    })
    // Deleted between the prefetch and this lock. Nothing to refresh, and nothing wrong: the next
    // pass finds the slot vacant and creates it.
    if (person === null) return 'unchanged'
    const desired = effectiveCapabilities(capabilityKeys, person.capabilityGrants)
    if (sameCapabilitySet(person.capabilities, desired)) return 'unchanged'
    await tx.person.update({ where: { id: personId }, data: { capabilities: desired } })
    return 'updated'
  })
}

/**
 * Creates the managed person for ONE vacant slot of ONE template.
 *
 * `@@unique([templateId, poolSlot])` (Task 1) is the concurrency boundary, not a pre-check that
 * closes it. Two processes racing this same slot both see it vacant and both attempt `create`; the
 * database picks one, and the loser's `catch` re-reads exactly what the winner wrote and syncs ITS
 * capabilities instead of ever considering a second person for the slot (Task 2 brief: "re-read a
 * slot won by another process"). That create/catch/re-read is deliberately retained as the
 * serialisation point for a missing slot even though the pass now PREFETCHES its work list (final
 * review, Important 4): the prefetch is an optimisation over N queries, not a promise about what
 * the table holds by the time the create runs.
 *
 * `Person.name` is unique across the WHOLE installation (M58 R14), so a name collision is a
 * different race than the slot one and gets a different answer: retry with another name, up to
 * {@link NAME_COLLISION_MAX_ATTEMPTS}, never touching the slot this attempt owns.
 *
 * Only these two constraints are ever caught -- decided by {@link classifyPersonCreateError}. Any
 * other Prisma error -- a dropped connection, a check constraint this module did not anticipate --
 * is rethrown exactly as it arrived (Task 2 brief: "never swallow unrelated Prisma errors").
 */
async function createSlot(
  templateId: string,
  capabilityKeys: readonly string[],
  poolSlot: (typeof POOL_SLOTS)[number],
): Promise<SlotOutcome> {
  for (let attempt = 0; attempt < NAME_COLLISION_MAX_ATTEMPTS; attempt += 1) {
    const name = randomEnglishName()
    try {
      // A brand-new managed person has no grants, so the effective set IS the template baseline.
      await prisma.person.create({
        data: { name, templateId, poolSlot, capabilities: effectiveCapabilities(capabilityKeys, []) },
      })
      return 'created'
    } catch (error) {
      const classification = classifyPersonCreateError(error)
      if (classification === 'rethrow') throw error
      if (classification === 'slot_race') {
        const won = await prisma.person.findUniqueOrThrow({
          where: { templateId_poolSlot: { templateId, poolSlot } },
          select: { id: true },
        })
        return refreshManagedCapabilities(won.id, capabilityKeys)
      }
      // classification === 'name_race': try another name, same slot, same attempt budget.
    }
  }
  // Says WHAT ran out, and how hard it tried (final review, Important 6). The old sentence --
  // "could not find a free name" -- read as a bug in this function; the honest fact is that the
  // name space is a finite curated dictionary, every draw in this budget landed on a name the
  // installation already holds, and nothing was silently degraded to get past it.
  throw new Error(
    `syncPersonPool: the finite English-name pool could not find a unique unused name for template ` +
      `${templateId} slot ${String(poolSlot)} after ${String(NAME_COLLISION_MAX_ATTEMPTS)} attempts ` +
      `(${String(FIRST_NAMES.length * LAST_NAMES.length)} combinations exist; every draw collided with a ` +
      `name already taken). No name was reused and no slot was left half-created.`,
  )
}

/**
 * Ensures every ACTIVE template holds exactly three managed people, and that every existing one's
 * effective capabilities match its template's current set unioned with its own grants (Task 2
 * brief, global constraints; final review Important 2).
 *
 * Inactive templates are never read here at all -- not "created for" and then left alone, simply
 * never considered -- which is the whole of "inactive templates create nothing" and "deactivation
 * deletes/releases nobody" (the row this pass would have synced is just not in its query).
 *
 * ONE query for the work list, and the work DECIDED off it (final review, Important 4; widened by
 * fix round 2's Important B). This pass used to run a `findUnique` per (template, slot) pair: 834
 * round trips on the installation it was measured against, every one of them a no-op on the
 * ordinary run. Important 4 replaced those reads with a single query -- and then went on opening a
 * locked transaction per occupied slot anyway, so the round trips came back as 834 `BEGIN` +
 * `FOR UPDATE` + `COMMIT` cycles and the pass was no cheaper than before. The prefetch therefore
 * reads both capability columns as well, {@link managedSlotNeedsRefresh} decides in memory whether a
 * slot has drifted at all, and {@link refreshManagedCapabilities} -- the locked half -- is reached
 * only for one that has. An ordinary pass over a pool in step now takes no lock and opens no
 * transaction.
 *
 * The database's own unique constraint is still the serialisation point for a slot this list says is
 * vacant (see {@link createSlot}), and the grant column is still re-read under `FOR UPDATE` before a
 * drifted row is written (see {@link refreshManagedCapabilities}). The prefetch narrows what has to
 * be attempted; it does not replace what makes either attempt safe.
 *
 * Idempotent: a second call with nothing changed underneath reports every slot `unchanged` and
 * writes nothing at all (Task 2 brief: "running sync twice is a no-op report on the second run").
 */
export async function syncPersonPool(): Promise<PersonPoolSyncReport> {
  const templates = await prisma.slaveTemplate.findMany({
    where: { active: true },
    select: { id: true, capabilityKeys: true },
  })
  if (templates.length === 0) return { templates: 0, created: 0, updated: 0, unchanged: 0 }

  const existing = await prisma.person.findMany({
    where: { templateId: { in: templates.map((template) => template.id) }, poolSlot: { not: null } },
    // Both capability columns, not just the id (final review fix round 2, Important B): the union
    // this pass would write is computable from them, so the question "does this row need a
    // transaction at all" is answerable here, in the query that was already being run.
    select: { id: true, templateId: true, poolSlot: true, capabilities: true, capabilityGrants: true },
  })
  // `${templateId}:${poolSlot}` -- the pair the unique constraint is on, which is what makes this
  // map a faithful stand-in for the `findUnique` it replaces.
  const occupied = new Map(existing.map((person) => [`${String(person.templateId)}:${String(person.poolSlot)}`, person] as const))

  let created = 0
  let updated = 0
  let unchanged = 0
  for (const template of templates) {
    for (const poolSlot of POOL_SLOTS) {
      const held = occupied.get(`${template.id}:${String(poolSlot)}`)
      let outcome: SlotOutcome
      if (held === undefined) {
        outcome = await createSlot(template.id, template.capabilityKeys, poolSlot)
      } else if (managedSlotNeedsRefresh(held, template.capabilityKeys)) {
        outcome = await refreshManagedCapabilities(held.id, template.capabilityKeys)
      } else {
        // Decided in memory, and that is the whole point: no transaction, no row lock, no round trip
        // for a slot that is already exactly what this pass would have written.
        outcome = 'unchanged'
      }
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
