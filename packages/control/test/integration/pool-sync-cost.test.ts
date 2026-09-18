/**
 * Final review fix round 2, Important B: what one `syncPersonPool` pass actually COSTS, measured
 * against a real Postgres.
 *
 * Important 4 replaced a `findUnique` per (template, slot) with one prefetch of every managed row,
 * and then left `refreshManagedCapabilities` -- `BEGIN`, `SELECT … FOR UPDATE`, `findUnique`,
 * `COMMIT` -- being called for every occupied slot regardless of whether anything had changed. On
 * the installation this was measured against that is 834 transactions and 834 row locks per pass,
 * for a pass whose honest answer for all 834 was "unchanged": the reads got cheaper and the
 * expensive half did not move. The daemon runs this at startup and on every reconciliation, so it
 * is not a rare path.
 *
 * The prefetch now carries `capabilities` and `capabilityGrants`, the union is computed in memory
 * (`managedSlotNeedsRefresh`, unit-tested in `../personPool.test.ts`), and the locked function is
 * called only for a row that actually drifted.
 *
 * **How this file measures that without spying on Prisma.** `vi.spyOn` on a generated model method
 * is unreliable against this project's client (`../prisma-errors.test.ts`, and the Task 2 report:
 * `mockRestore()` left `prisma.person.create` permanently `undefined`), so nothing here mocks the
 * client. It uses the LOCK instead, which is the thing being claimed: an outside transaction holds
 * `FOR UPDATE` on one managed row and never lets go, and a pass that would have locked that row
 * blocks forever behind it. A pass that completes promptly is a pass that never asked for the lock.
 * The same lock, released at a chosen moment, is also what makes the concurrent-grant case
 * deterministic rather than a hopeful sleep.
 */
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { syncPersonPool } from '../../src/personPool.js'

const TRUNCATE = 'TRUNCATE TABLE "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

/** 278 active templates x 3 slots = 834 managed rows: the installation the requirements' own
 *  recheck names, and the number the old pass opened one transaction for each of. Seeded with two
 *  bulk inserts rather than by running the pass, because what is under test is what a pass does to a
 *  pool that is ALREADY full. */
const TEMPLATES = 278
const SLOTS = [1, 2, 3] as const

async function seedFullPool(): Promise<{ readonly templateIds: readonly string[]; readonly personIds: readonly string[] }> {
  const templates = Array.from({ length: TEMPLATES }, (_unused, index) => ({
    name: `Pool Cost Persona ${String(index).padStart(4, '0')}`,
    role: 'backend',
    description: 'x',
    active: true,
    capabilityKeys: ['backend.services', `backend.speciality-${String(index)}`],
  }))
  await prisma.slaveTemplate.createMany({ data: templates })
  const rows = await prisma.slaveTemplate.findMany({ select: { id: true, capabilityKeys: true }, orderBy: { name: 'asc' } })

  await prisma.person.createMany({
    data: rows.flatMap((row, index) =>
      SLOTS.map((poolSlot) => ({
        name: `Pool Cost Person ${String(index).padStart(4, '0')}-${String(poolSlot)}`,
        templateId: row.id,
        poolSlot,
        // Stored in the OTHER order than the template lists them, so a pass that compared
        // positionally would call all 834 drifted and this file would be measuring nothing.
        capabilities: [...row.capabilityKeys].reverse(),
      })),
    ),
  })
  const people = await prisma.person.findMany({ where: { poolSlot: { not: null } }, select: { id: true } })
  return { templateIds: rows.map((row) => row.id), personIds: people.map((person) => person.id) }
}

/**
 * Holds `FOR UPDATE` on one `Person` row until `release()` is called, and runs `whileHeld` (if
 * given) under that same lock just before committing.
 *
 * A second connection from Prisma's own pool, which is what makes this a real lock and not a
 * simulation of one: the pass under test runs on a different connection and either waits for this
 * row or does not.
 */
function holdPersonLock(
  personId: string,
  whileHeld?: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>,
): { readonly done: Promise<void>; readonly held: Promise<void>; release: () => void } {
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
      await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
      announce()
      await gate
      if (whileHeld !== undefined) await whileHeld(tx)
    },
    // Longer than any wait below, so a slow machine reports the assertion this file is making rather
    // than a Prisma transaction timeout that looks like an unrelated flake.
    { timeout: 30_000, maxWait: 10_000 },
  )
  return { done, held, release }
}

/** Rejects, rather than hanging the suite, when `work` is still waiting after `ms`. The message is
 *  the finding: a pass that is still waiting is a pass that took a lock it had no reason to take. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(what)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('syncPersonPool over a full pool (final review fix round 2, Important B)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('locks nothing on a no-op pass over 834 occupied slots: a row somebody else holds does not block it', async (): Promise<void> => {
    const { personIds } = await seedFullPool()
    expect(personIds).toHaveLength(834)
    const [victim] = personIds
    const lock = holdPersonLock(victim ?? '')
    await lock.held

    let report: Awaited<ReturnType<typeof syncPersonPool>>
    try {
      // The whole assertion. The old pass opened a transaction and took `FOR UPDATE` on every one of
      // the 834 rows, so it stopped dead on this one and only finished when the lock was released --
      // which is after this line. Ten seconds is far longer than the pass needs and far shorter than
      // the holding transaction's own 30-second budget.
      report = await withDeadline(
        syncPersonPool(),
        10_000,
        'syncPersonPool blocked on a managed row that nothing had changed: it is still taking a per-person FOR UPDATE on an unchanged slot',
      )
    } finally {
      lock.release()
      await lock.done
    }

    expect(report).toEqual({ templates: TEMPLATES, created: 0, updated: 0, unchanged: 834 })
    // And no writes: every row still holds exactly what it was seeded with, in the order it was
    // seeded with, because nothing rewrote it "harmlessly" into sorted order.
    const untouched = await prisma.person.findUniqueOrThrow({ where: { id: victim ?? '' } })
    expect(untouched.capabilities).toEqual([`backend.speciality-0`, 'backend.services'])
  })

  it('still refreshes the rows that DID drift, and only those', async (): Promise<void> => {
    const { templateIds } = await seedFullPool()
    const [drifted] = templateIds
    await prisma.slaveTemplate.update({
      where: { id: drifted ?? '' },
      data: { capabilityKeys: ['backend.services', 'backend.speciality-0', 'backend.api-design'] },
    })

    const report = await syncPersonPool()

    // Three rows -- one template's slots -- and the other 831 were decided in memory and left alone.
    expect(report).toEqual({ templates: TEMPLATES, created: 0, updated: 3, unchanged: 831 })
    for (const person of await prisma.person.findMany({ where: { templateId: drifted ?? '' } })) {
      expect([...person.capabilities].toSorted()).toEqual(['backend.api-design', 'backend.services', 'backend.speciality-0'])
    }
  })

  it('a drifted row IS locked, and the grants it unions are re-read under that lock, not off the prefetch', async (): Promise<void> => {
    // One template, one drift, so the pass has exactly one row to refresh and blocks on exactly the
    // row this test holds.
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Grant Race Persona', role: 'backend', description: 'x', active: true, capabilityKeys: ['a'] },
    })
    const person = await prisma.person.create({
      data: { name: 'Grant Race Person One', templateId: template.id, poolSlot: 1, capabilities: ['a'] },
    })
    await prisma.person.create({ data: { name: 'Grant Race Person Two', templateId: template.id, poolSlot: 2, capabilities: ['a'] } })
    await prisma.person.create({ data: { name: 'Grant Race Person Three', templateId: template.id, poolSlot: 3, capabilities: ['a'] } })
    // The template gains a key, so this row genuinely needs the locked refresh.
    await prisma.slaveTemplate.update({ where: { id: template.id }, data: { capabilityKeys: ['a', 'b'] } })

    // A grant committed AFTER the pass has prefetched this row and while it waits for the lock --
    // the exact interleaving `setPersonCapabilities` produces, and the one that erased a grant
    // before Important 2 put the re-read under the lock. The prefetched grants are `[]`; the
    // committed ones are not.
    const lock = holdPersonLock(person.id, async (tx) => {
      await tx.person.update({ where: { id: person.id }, data: { capabilityGrants: ['x.extra'] } })
    })
    await lock.held

    const syncing = syncPersonPool()
    // The pass is now past its prefetch (which takes no lock and cannot block) and waiting on this
    // row. Releasing the gate is what lets the grant commit and the pass proceed.
    await new Promise((resolve) => setTimeout(resolve, 300))
    lock.release()
    await lock.done
    const report = await withDeadline(syncing, 10_000, 'syncPersonPool never finished after the lock was released')

    expect(report).toEqual({ templates: 1, created: 0, updated: 3, unchanged: 0 })
    const after = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
    // `['a', 'b']` here would be the grant lost: the union computed off the stale prefetch rather
    // than off the row as it stands under the lock.
    expect([...after.capabilities].toSorted()).toEqual(['a', 'b', 'x.extra'])
    expect(after.capabilityGrants).toEqual(['x.extra'])
  })
})
