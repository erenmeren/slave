import { prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec, type ProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { reconcileTemplateCapabilities, syncCapabilityTaxonomy } from '../../src/capability.js'

/**
 * Catalog Person Pool (Task 3): `reconcileTemplateCapabilities` re-derives every STRUCTURED
 * template's `capabilityKeys`/`unresolvedCapabilities` from its own `profileSpec.capabilities`
 * against the LIVE taxonomy, so a synonym added after a persona was imported repairs the row
 * without anybody re-importing it.
 *
 * The package's own truncate idiom (`backfill.test.ts`'s docstring): the `Capability` table is
 * SEEDED and shared with every other integration file in this database, so it is never
 * truncated here -- it is reconciled back to the checked-in list instead, which is also what
 * gives every case here the two Task 3 aliases (`production monitoring`, `critical css inlining`)
 * without hand-seeding a fixture taxonomy.
 */
const TRUNCATE = 'TRUNCATE TABLE "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await prisma.capability.deleteMany({ where: { createdBy: { not: 'seed' } } })
  await syncCapabilityTaxonomy()
})

/** A `profileSpec` a `reconcileTemplateCapabilities` call can parse -- every field {@link
 *  emptyProfileSpec} leaves blank, with only `capabilities` set to what the case is testing. */
const specWith = (capabilities: readonly string[]): ProfileSpec => ({
  ...emptyProfileSpec(),
  capabilities,
})

const structuredTemplate = async (
  name: string,
  capabilities: readonly string[],
  opts: {
    readonly active?: boolean
    readonly capabilityKeys?: readonly string[]
    readonly unresolvedCapabilities?: readonly string[]
  } = {},
): Promise<string> =>
  (
    await prisma.slaveTemplate.create({
      data: {
        name,
        role: 'backend',
        description: `${name} does one thing.`,
        active: opts.active ?? false,
        profileSpec: specWith(capabilities) as unknown as object,
        // The STALE state a row is in before this pass runs: what an old import (or a hand poke)
        // left behind, deliberately disagreeing with what a fresh `normaliseCapabilities` pass
        // over `capabilities` above would compute today -- which is the whole of what makes
        // "gets repaired" and "reports updated" a real assertion rather than a no-op.
        capabilityKeys: [...(opts.capabilityKeys ?? [])],
        unresolvedCapabilities: [...(opts.unresolvedCapabilities ?? [])],
      },
    })
  ).id

const handMadeTemplate = async (name: string): Promise<string> =>
  (await prisma.slaveTemplate.create({ data: { name, role: 'backend', description: 'hand made', active: false } })).id

const templateRow = (id: string) =>
  prisma.slaveTemplate.findUniqueOrThrow({ where: { id }, select: { capabilityKeys: true, unresolvedCapabilities: true } })

describe('reconcileTemplateCapabilities (Catalog Person Pool Task 3)', () => {
  it('repairs a stale row once a synonym exists, using the alias unchanged from the seed', async (): Promise<void> => {
    const id = await structuredTemplate('Task 3 Alias Persona', ['production monitoring', 'critical css inlining'], {
      capabilityKeys: [],
      unresolvedCapabilities: ['production monitoring', 'critical css inlining'],
    })

    const report = await reconcileTemplateCapabilities()

    expect(report.templates).toBe(1)
    expect(report.updated).toBe(1)
    expect(report.resolved).toBe(2)
    expect(report.unresolved).toBe(0)
    expect(report.malformed).toEqual([])
    const row = await templateRow(id)
    expect([...row.capabilityKeys].sort()).toEqual(['frontend.performance', 'operations.observability'])
    expect(row.unresolvedCapabilities).toEqual([])
  })

  it('never guesses a broad or ambiguous phrase into a key, and keeps it visibly unresolved', async (): Promise<void> => {
    const id = await structuredTemplate('Task 3 Ambiguous Persona', ['Performance Optimization'], {
      capabilityKeys: [],
      unresolvedCapabilities: ['Performance Optimization'],
    })

    const report = await reconcileTemplateCapabilities()

    expect(report.updated).toBe(0) // already exactly what a fresh pass computes: nothing to write
    expect(report.resolved).toBe(0)
    expect(report.unresolved).toBe(1)
    const row = await templateRow(id)
    expect(row.capabilityKeys).toEqual([])
    expect(row.unresolvedCapabilities).toEqual(['Performance Optimization'])
  })

  it('reports exact scanned/updated/resolved/unresolved counts across a full, a partial and a none mapping', async (): Promise<void> => {
    const full = await structuredTemplate('Task 3 Full Mapping', ['Code review'])
    const partial = await structuredTemplate('Task 3 Partial Mapping', ['backend.api-design', 'Modern Web Technologies'])
    const none = await structuredTemplate('Task 3 None Mapping', ['Pipeline Engineering'])

    const report = await reconcileTemplateCapabilities()

    expect(report.templates).toBe(3)
    expect(report.updated).toBe(3) // every row started stale: capabilityKeys: [], unresolvedCapabilities: []
    // Distinct SOURCE values across every scanned template, not template counts: "Code review" and
    // "backend.api-design" resolved (2), "Modern Web Technologies" and "Pipeline Engineering" did
    // not (2) -- four distinct source strings across three rows.
    expect(report.resolved).toBe(2)
    expect(report.unresolved).toBe(2)

    expect((await templateRow(full)).capabilityKeys).toEqual(['review.code-review'])
    expect((await templateRow(partial)).capabilityKeys).toEqual(['backend.api-design'])
    expect((await templateRow(partial)).unresolvedCapabilities).toEqual(['Modern Web Technologies'])
    expect((await templateRow(none)).capabilityKeys).toEqual([])
    expect((await templateRow(none)).unresolvedCapabilities).toEqual(['Pipeline Engineering'])
  })

  it('is idempotent: a second pass with nothing changed underneath reports zero updates and the same counts', async (): Promise<void> => {
    await structuredTemplate('Task 3 Idempotent Full', ['Code review'])
    await structuredTemplate('Task 3 Idempotent Partial', ['backend.api-design', 'Modern Web Technologies'])
    const first = await reconcileTemplateCapabilities()
    expect(first.updated).toBeGreaterThan(0)

    const second = await reconcileTemplateCapabilities()

    expect(second).toEqual({ ...first, updated: 0 })
  })

  it('never touches a hand-made template with no profileSpec at all: not scanned, not counted, not overwritten', async (): Promise<void> => {
    const id = await handMadeTemplate('Task 3 Hand Made')

    const report = await reconcileTemplateCapabilities()

    expect(report.templates).toBe(0)
    expect(report.malformed).toEqual([])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.profileSpec).toBeNull()
    expect(row.capabilityKeys).toEqual([])
  })

  it('identifies a malformed profileSpec without crashing the pass or overwriting the row', async (): Promise<void> => {
    const goodId = await structuredTemplate('Task 3 Good Neighbour', ['Code review'])
    const malformedId = (
      await prisma.slaveTemplate.create({
        data: {
          name: 'Task 3 Malformed Persona',
          role: 'backend',
          description: 'x',
          active: false,
          // Missing every required field `profileSpecSchema` demands -- the shape a hand-edited
          // row or a pre-M46 write-path bug could leave behind.
          profileSpec: { junk: true } as unknown as object,
          capabilityKeys: ['stale.key'],
          unresolvedCapabilities: ['stale text'],
        },
      })
    ).id

    const report = await reconcileTemplateCapabilities()

    expect(report.templates).toBe(1) // only the good neighbour
    expect(report.malformed).toEqual([malformedId])
    const malformedRow = await templateRow(malformedId)
    // Untouched -- neither guessed nor cleared.
    expect(malformedRow.capabilityKeys).toEqual(['stale.key'])
    expect(malformedRow.unresolvedCapabilities).toEqual(['stale text'])
    expect((await templateRow(goodId)).capabilityKeys).toEqual(['review.code-review'])
  })

  it("refreshes an ACTIVE template's managed pool people to the newly-reconciled keys, and leaves a manual person alone", async (): Promise<void> => {
    const id = await structuredTemplate('Task 3 Pool Refresh Persona', ['production monitoring'], {
      active: true,
      capabilityKeys: [],
      unresolvedCapabilities: ['production monitoring'],
    })
    const manual = await prisma.person.create({
      data: { name: 'Task 3 Manual Hire', templateId: id, capabilities: [] },
    })

    const report = await reconcileTemplateCapabilities()

    expect(report.updated).toBe(1)
    expect((await templateRow(id)).capabilityKeys).toEqual(['operations.observability'])

    // `syncPersonPool()` ran AFTER the template write, off the NEW keys -- not the stale ones this
    // template started with.
    const managed = await prisma.person.findMany({ where: { templateId: id, poolSlot: { not: null } }, orderBy: { poolSlot: 'asc' } })
    expect(managed).toHaveLength(3)
    for (const person of managed) expect(person.capabilities).toEqual(['operations.observability'])

    const untouched = await prisma.person.findUniqueOrThrow({ where: { id: manual.id } })
    expect(untouched.capabilities).toEqual([])
    expect(untouched.poolSlot).toBeNull()
  })

  it('never runs the pool sync for an INACTIVE template: no managed people appear', async (): Promise<void> => {
    const id = await structuredTemplate('Task 3 Inactive Persona', ['production monitoring'], {
      active: false,
      capabilityKeys: [],
      unresolvedCapabilities: ['production monitoring'],
    })

    await reconcileTemplateCapabilities()

    expect((await templateRow(id)).capabilityKeys).toEqual(['operations.observability'])
    expect(await prisma.person.count({ where: { templateId: id } })).toBe(0)
  })

  /**
   * Final review, Important 4. This pass has always ended with `syncPersonPool()` and has always
   * thrown that pass's report away, so every caller that wanted to tell an operator what the pool
   * did ran a SECOND, redundant `syncPersonPool()` -- an extra full scan of every active template,
   * whose only honest answer was "nothing changed", printed as if it were the news. The report is
   * nested here instead: one pass, and the numbers come back.
   */
  it('returns the pool pass it already ran, so no caller has to run a second one to see it', async (): Promise<void> => {
    const id = await structuredTemplate('Task 3 Nested Pool Report', ['production monitoring'], {
      active: true,
      capabilityKeys: [],
      unresolvedCapabilities: ['production monitoring'],
    })

    const report = await reconcileTemplateCapabilities()

    // Three slots created for the one active template, by the sync this pass ran itself.
    expect(report.pool).toEqual({ templates: 1, created: 3, updated: 0, unchanged: 0 })
    expect(await prisma.person.count({ where: { templateId: id, poolSlot: { not: null } } })).toBe(3)

    // And a second pass reports a pool that needed nothing -- the number the redundant follow-up
    // sync used to print, now available without running it.
    expect((await reconcileTemplateCapabilities()).pool).toEqual({ templates: 1, created: 0, updated: 0, unchanged: 3 })
  })

  it('reports an inactive-only installation as a pool with no templates in it', async (): Promise<void> => {
    await structuredTemplate('Task 3 Nested Pool Inactive', ['Code review'], { active: false })

    expect((await reconcileTemplateCapabilities()).pool).toEqual({ templates: 0, created: 0, updated: 0, unchanged: 0 })
  })

  it('a capability set that only reorders reports no write: comparison is by SET, not by array order', async (): Promise<void> => {
    const id = await structuredTemplate('Task 3 Reordered Persona', ['Code review', 'backend.api-design'], {
      capabilityKeys: ['backend.api-design', 'review.code-review'], // same set, opposite order
      unresolvedCapabilities: [],
    })

    const report = await reconcileTemplateCapabilities()

    expect(report.updated).toBe(0)
    expect((await templateRow(id)).capabilityKeys).toEqual(['backend.api-design', 'review.code-review'])
  })
})
