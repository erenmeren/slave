import { prisma } from '@slave-of-ai/db/client'
import { isGeneratedEnglishName } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NAME_COLLISION_MAX_ATTEMPTS, selectPoolPerson, syncPersonPool } from '../../src/personPool.js'

const TRUNCATE = 'TRUNCATE TABLE "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

const template = async (
  name: string,
  active: boolean,
  capabilityKeys: readonly string[] = ['backend.services'],
): Promise<string> =>
  (
    await prisma.slaveTemplate.create({
      data: { name, role: 'backend', description: `${name} does one thing.`, active, capabilityKeys: [...capabilityKeys] },
    })
  ).id

const workspaceWithTeam = async (name: string): Promise<{ readonly workspaceId: string; readonly teamId: string }> => {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: '/tmp/person-pool-test', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

const managedPeople = async (templateId: string) =>
  prisma.person.findMany({ where: { templateId, poolSlot: { not: null } }, orderBy: { poolSlot: 'asc' } })

describe('syncPersonPool (Catalog Person Pool Task 2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('creates exactly three managed people for a fresh active template, named and capable', async (): Promise<void> => {
    const templateId = await template('Backend Specialist', true, ['backend.services', 'backend.data'])

    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 1, created: 3, updated: 0, unchanged: 0 })
    const people = await managedPeople(templateId)
    expect(people).toHaveLength(3)
    expect(people.map((person) => person.poolSlot)).toEqual([1, 2, 3])
    // Every one is a real generated name, and no two share it (`Person.name` is globally unique).
    const names = people.map((person) => person.name)
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(isGeneratedEnglishName(name)).toBe(true)
    for (const person of people) expect([...person.capabilities].sort()).toEqual(['backend.data', 'backend.services'])
  })

  it('considers every active template independently, three slots each', async (): Promise<void> => {
    const a = await template('Template A', true)
    const b = await template('Template B', true)

    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 2, created: 6, updated: 0, unchanged: 0 })
    expect(await managedPeople(a)).toHaveLength(3)
    expect(await managedPeople(b)).toHaveLength(3)
  })

  it('never looks at an inactive template: nothing is created for it', async (): Promise<void> => {
    const templateId = await template('Inert Persona', false)

    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 0, created: 0, updated: 0, unchanged: 0 })
    expect(await managedPeople(templateId)).toHaveLength(0)
  })

  it('is a no-op the second time: same rows, everything reported unchanged', async (): Promise<void> => {
    const templateId = await template('Idempotent Persona', true)
    await syncPersonPool()
    const before = await managedPeople(templateId)

    const second = await syncPersonPool()

    expect(second).toEqual({ templates: 1, created: 0, updated: 0, unchanged: 3 })
    const after = await managedPeople(templateId)
    expect(after.map((person) => ({ id: person.id, name: person.name, poolSlot: person.poolSlot }))).toEqual(
      before.map((person) => ({ id: person.id, name: person.name, poolSlot: person.poolSlot })),
    )
  })

  it("refreshes an existing managed person's capabilities to the template's CURRENT set, never touching name or id", async (): Promise<void> => {
    const templateId = await template('Drifting Persona', true, ['a'])
    await syncPersonPool()
    const before = await managedPeople(templateId)

    await prisma.slaveTemplate.update({ where: { id: templateId }, data: { capabilityKeys: ['a', 'b'] } })
    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 1, created: 0, updated: 3, unchanged: 0 })
    const after = await managedPeople(templateId)
    expect(after.map((person) => person.id)).toEqual(before.map((person) => person.id))
    expect(after.map((person) => person.name)).toEqual(before.map((person) => person.name))
    for (const person of after) expect([...person.capabilities].sort()).toEqual(['a', 'b'])
  })

  it('a capability set that only reorders reports unchanged: comparison is by SET, not by array order', async (): Promise<void> => {
    const templateId = await template('Reordered Persona', true, ['a', 'b'])
    await syncPersonPool()

    await prisma.slaveTemplate.update({ where: { id: templateId }, data: { capabilityKeys: ['b', 'a'] } })
    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 1, created: 0, updated: 0, unchanged: 3 })
  })

  it('leaves a manual person (poolSlot null) on the same template completely untouched', async (): Promise<void> => {
    const templateId = await template('Has A Manual Hire Too', true, ['a'])
    const manual = await prisma.person.create({
      data: { name: 'Hand Picked Manual Hire', templateId, capabilities: [] },
    })

    await syncPersonPool()

    const untouched = await prisma.person.findUniqueOrThrow({ where: { id: manual.id } })
    expect(untouched.poolSlot).toBeNull()
    expect(untouched.capabilities).toEqual([])
    expect(untouched.name).toBe('Hand Picked Manual Hire')
    // And the three managed slots exist BESIDE them, not in place of them.
    expect(await managedPeople(templateId)).toHaveLength(3)
  })

  it('deactivating a template deletes and releases nobody: the three managed rows stay exactly as they were', async (): Promise<void> => {
    const templateId = await template('Going Inactive', true)
    await syncPersonPool()
    const before = await managedPeople(templateId)

    await prisma.slaveTemplate.update({ where: { id: templateId }, data: { active: false } })
    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 0, created: 0, updated: 0, unchanged: 0 })
    const after = await managedPeople(templateId)
    expect(after).toHaveLength(3)
    expect(after.map((person) => person.id)).toEqual(before.map((person) => person.id))
    expect(after.every((person) => person.releasedAt === null)).toBe(true)
  })

  it('concurrent syncs create exactly one row per slot, never two', async (): Promise<void> => {
    await template('Raced Persona', true)

    const [first, second] = await Promise.all([syncPersonPool(), syncPersonPool()])

    // Across both racing passes, the three slots were created exactly once in total -- one pass's
    // loser re-read the winner's row and reported it `updated` or `unchanged`, never `created`
    // again and never thrown.
    expect(first.created + second.created).toBe(3)
    const rows = await prisma.person.findMany({ where: { poolSlot: { not: null } } })
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.poolSlot))).toEqual(new Set([1, 2, 3]))
  })

  it('retries a name collision with another random name, bounded, and still creates the row', async (): Promise<void> => {
    // `randomEnglishName`'s production default draws through `crypto.getRandomValues`
    // (`packages/domain/src/persons/pool.ts`). A raw Uint32 value below a dictionary's length is
    // its own remainder (`v % n === v` for `v < n`), so feeding controlled small values selects an
    // exact (first, last) pair without needing to know either dictionary's length.
    // Every slot draws through the SAME queue, in call order -- only the FIRST attempt (slot 1's)
    // is engineered to collide; slots 2 and 3 must each succeed on their own first attempt, so
    // they need their own (non-colliding, mutually distinct) pair of draws too.
    const draws = [
      0,
      0, // slot 1, attempt 1: (Alice, Adams) -- collides with the pre-seeded name below
      1,
      1, // slot 1, attempt 2: (Arthur, Baker) -- succeeds
      2,
      2, // slot 2, attempt 1: (Benjamin, Bennett) -- succeeds
      3,
      3, // slot 3, attempt 1: (Charlotte, Brooks) -- succeeds
    ]
    // biome-ignore lint/suspicious/noExplicitAny: matching `Crypto.getRandomValues`'s own generic
    // `TypedArray` signature exactly is not worth it for a test-only stub of one call site.
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array: any) => {
      // biome-ignore lint/style/noNonNullAssertion: the test drives exactly as many draws as it queues
      array[0] = draws.shift()!
      return array
    })
    try {
      const [firstName, lastName] = ['Alice', 'Adams'] // FIRST_NAMES[0], LAST_NAMES[0] (pool.ts)
      await prisma.person.create({ data: { name: `${firstName} ${lastName}`, capabilities: [] } })
      const templateId = await template('Collision Persona', true)

      const report = await syncPersonPool()

      expect(report.created).toBe(3)
      const people = await managedPeople(templateId)
      // None of the three managed names collides with the pre-seeded name: the retry moved past it.
      expect(people.every((person) => person.name !== `${firstName} ${lastName}`)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('gives up after the bounded attempt count rather than looping forever on an exhausted draw', async (): Promise<void> => {
    // Every draw maps to the SAME (first, last) pair -- attempt after attempt collides with the
    // one name this test seeds, so the loop must stop at `NAME_COLLISION_MAX_ATTEMPTS` rather than
    // spin.
    // biome-ignore lint/suspicious/noExplicitAny: matching `Crypto.getRandomValues`'s own generic
    // `TypedArray` signature exactly is not worth it for a test-only stub of one call site.
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array: any) => {
      array[0] = 0
      return array
    })
    try {
      await prisma.person.create({ data: { name: 'Alice Adams', capabilities: [] } })
      await template('Exhausted Persona', true)

      await expect(syncPersonPool()).rejects.toThrow(new RegExp(String(NAME_COLLISION_MAX_ATTEMPTS)))
    } finally {
      spy.mockRestore()
    }
  })

  // `syncSlot`'s catch only ever resolves a P2002 (`isUniqueConstraintViolation`) on one of the
  // two constraints it knows -- `(templateId, poolSlot)` or `name` -- and rethrows anything else
  // completely unexamined. This is NOT exercised against a real database call here: `pump.test.ts`
  // already documents why (`apps/orchestrator/test/integration/pump.test.ts`, "applies the tally
  // exactly once...") -- `vi.spyOn` on a generated Prisma Client model method does not call
  // through, and its `mockRestore` does not reliably put the ORIGINAL method back either (Task 2
  // self-review: confirmed here, empirically, against this exact `@prisma/adapter-pg`-backed
  // client -- restoring left `prisma.person.create` `undefined` for every later test in the
  // process). The two branches this rethrow guards are unit-tested exhaustively instead, at the
  // level that actually varies: `prisma-errors.test.ts`'s `isUniqueConstraintViolation` (any
  // non-P2002 code) and `uniqueConstraintTarget` (a P2002 on neither known constraint) -- both of
  // which `syncSlot`'s own two `if` checks read straight through with no logic of their own to
  // separately re-verify against a live database.

  it('is a no-op for a template with an empty capabilityKeys list too: nothing to synchronize is not an error', async (): Promise<void> => {
    const templateId = await template('No Capabilities Yet', true, [])

    const report = await syncPersonPool()

    expect(report).toEqual({ templates: 1, created: 3, updated: 0, unchanged: 0 })
    const people = await managedPeople(templateId)
    for (const person of people) expect(person.capabilities).toEqual([])
  })
})

describe('selectPoolPerson (Catalog Person Pool Task 2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('refuses a template id nobody wrote', async (): Promise<void> => {
    const { workspaceId } = await workspaceWithTeam('Nobody Home')

    const result = await selectPoolPerson(UNKNOWN, workspaceId)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'pool_unavailable', templateId: UNKNOWN })
  })

  it('refuses an inactive template even when it has a synced pool', async (): Promise<void> => {
    const templateId = await template('Inactive But Pooled', true)
    await syncPersonPool()
    await prisma.slaveTemplate.update({ where: { id: templateId }, data: { active: false } })
    const { workspaceId } = await workspaceWithTeam('Some Project')

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'pool_unavailable', templateId })
  })

  it('refuses an active template with no managed people at all', async (): Promise<void> => {
    const templateId = await template('Never Synced', true)
    const { workspaceId } = await workspaceWithTeam('Some Project')

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'pool_unavailable', templateId })
  })

  it('picks a managed person when nobody holds any seat yet', async (): Promise<void> => {
    const templateId = await template('Fresh Pool', true)
    await syncPersonPool()
    const { workspaceId } = await workspaceWithTeam('Some Project')

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const managed = await managedPeople(templateId)
    expect(managed.map((person) => person.id)).toContain(result.value.personId)
  })

  it('excludes a RELEASED managed person', async (): Promise<void> => {
    const templateId = await template('One Released', true)
    await syncPersonPool()
    const [first, second, third] = await managedPeople(templateId)
    await prisma.person.updateMany({
      where: { id: { in: [first!.id, second!.id] } },
      data: { releasedAt: new Date(), releaseReason: 'test' },
    })
    const { workspaceId } = await workspaceWithTeam('Some Project')

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.personId).toBe(third!.id)
  })

  it('excludes a managed person who already holds an OPEN seat on the SAME workspace', async (): Promise<void> => {
    const templateId = await template('Same Workspace Seated', true)
    await syncPersonPool()
    const [first, second, third] = await managedPeople(templateId)
    const { workspaceId, teamId } = await workspaceWithTeam('Home Project')
    await prisma.slave.create({ data: { teamId, personId: first!.id, role: 'backend' } })

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.personId).not.toBe(first!.id)
    expect([second!.id, third!.id]).toContain(result.value.personId)
  })

  it('a CLOSED seat on the same workspace does not exclude the person: they are not counted as open there', async (): Promise<void> => {
    const templateId = await template('Closed Seat Same Workspace', true)
    await syncPersonPool()
    const [first] = await managedPeople(templateId)
    const { workspaceId, teamId } = await workspaceWithTeam('Home Project')
    await prisma.slave.create({
      data: { teamId, personId: first!.id, role: 'backend', closedAt: new Date() },
    })

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Eligible again: a closed seat on this workspace is history, not an open seat.
    expect([first!.id]).toContain(result.value.personId)
  })

  it('permits a managed person who holds an open seat on ANOTHER workspace', async (): Promise<void> => {
    const templateId = await template('Multi Project Person', true)
    await syncPersonPool()
    const [first] = await managedPeople(templateId)
    const elsewhere = await workspaceWithTeam('Elsewhere')
    await prisma.slave.create({ data: { teamId: elsewhere.teamId, personId: first!.id, role: 'backend' } })
    const { workspaceId } = await workspaceWithTeam('Home Project')

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Everybody is still eligible for the home project; the busier person (one open seat
    // elsewhere) is simply ranked behind the two with none.
    expect(result.value.personId).not.toBe(first!.id)
  })

  it('balances by total open-seat count: the least busy candidate wins, breaking ties by poolSlot', async (): Promise<void> => {
    const templateId = await template('Balanced Pool', true)
    await syncPersonPool()
    const [first, second] = await managedPeople(templateId)
    const busyElsewhere = await workspaceWithTeam('Busy Elsewhere A')
    const busyElsewhereToo = await workspaceWithTeam('Busy Elsewhere B')
    // `first` (poolSlot 1) picks up TWO other-workspace seats; `second` (poolSlot 2) picks up ONE.
    await prisma.slave.create({ data: { teamId: busyElsewhere.teamId, personId: first!.id, role: 'backend' } })
    await prisma.slave.create({ data: { teamId: busyElsewhereToo.teamId, personId: first!.id, role: 'backend' } })
    await prisma.slave.create({ data: { teamId: busyElsewhere.teamId, personId: second!.id, role: 'backend' } })
    const { workspaceId } = await workspaceWithTeam('Home Project')

    const result = await selectPoolPerson(templateId, workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // poolSlot 3 has zero open seats anywhere: least busy, wins outright.
    const [, , third] = await managedPeople(templateId)
    expect(result.value.personId).toBe(third!.id)
  })

  it('does not create, mutate or reserve anybody: a read has zero side effects', async (): Promise<void> => {
    const templateId = await template('Read Only', true)
    await syncPersonPool()
    const before = await prisma.person.findMany({ orderBy: { id: 'asc' } })
    const { workspaceId } = await workspaceWithTeam('Some Project')

    await selectPoolPerson(templateId, workspaceId)
    await selectPoolPerson(templateId, workspaceId)

    const after = await prisma.person.findMany({ orderBy: { id: 'asc' } })
    expect(after).toEqual(before)
    expect(await prisma.slave.count()).toBe(0)
  })
})
