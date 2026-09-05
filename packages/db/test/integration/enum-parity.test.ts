import { executionEventSchema } from '@slave-of-ai/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'
import { ACTORS, EVENT_TYPE_BY_DOMAIN_TYPE, RUN_STATUSES, TASK_STATUSES } from '../../src/enums.js'

async function enumValues(name: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT unnest(enum_range(NULL::"${name}"))::text AS value`,
  )
  return rows.map((row) => row.value).sort()
}

describe('database enums match the domain unions', () => {
  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('TaskStatus matches, member for member', async () => {
    expect(await enumValues('TaskStatus')).toEqual([...TASK_STATUSES].sort())
  })

  it('RunStatus matches, member for member', async () => {
    expect(await enumValues('RunStatus')).toEqual([...RUN_STATUSES].sort())
  })

  it('Actor matches, member for member', async () => {
    expect(await enumValues('Actor')).toEqual([...ACTORS].sort())
  })

  it('EventType is exactly the domain union, never wider', async () => {
    const domainTypes = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort()
    expect(await enumValues('EventType')).toEqual(domainTypes)
  })

  // The test above pins the database enum to `EVENT_TYPE_BY_DOMAIN_TYPE`, a hand-maintained
  // map. That map is in turn pinned to the live Zod union only by the `satisfies` clause in
  // `enums.ts` — a compile-time check. Delete that one clause and the two tests above would
  // both stay green while the map silently drifted from the schema. This test reads the
  // discriminant values directly off `executionEventSchema` at runtime, so it pins the database
  // enum to the schema itself, independent of the map and independent of `tsc`.
  it('EventType matches the live Zod union directly, independent of the hand-maintained map', async () => {
    const schemaTypes = executionEventSchema.options.map((option) => option.shape.type.value).sort()
    expect(await enumValues('EventType')).toEqual(schemaTypes)
  })
})
