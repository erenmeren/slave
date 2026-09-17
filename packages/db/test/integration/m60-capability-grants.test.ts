/**
 * Final review, Important 2: `Person.capabilityGrants` -- the EXPLICIT half of a managed person's
 * capability set, stored apart from the template baseline.
 *
 * `capabilities` alone could not carry both facts. `syncPersonPool` wrote the template's
 * `capabilityKeys` over it, so an explicit grant was erased by the next sync; keeping the union in
 * `capabilities` alone instead would have retained a key the template had since dropped, because
 * nothing could tell "the template used to say this" from "a person said this". Two columns, and
 * the stored `capabilities` is their union.
 *
 * These are the SCHEMA facts: the column exists, defaults to empty, round-trips, and is not
 * constrained against `poolSlot` in either direction (an unmanaged person may hold grants, and a
 * managed one need not). The behaviour that computes the union lives in
 * `packages/control/test/integration/personPool.test.ts` and `capability.test.ts`.
 */
import { Client } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Slave", "Team", "Workspace", "CompanyTeamMember", "Person", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('Person.capabilityGrants', () => {
  it('defaults to an empty array for an ordinary person nobody granted anything', async () => {
    const person = await prisma.person.create({ data: { name: 'Ungranted Person' } })
    expect((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).capabilityGrants).toEqual([])
  })

  it('round-trips a set of grants beside the effective capabilities, which are a different column', async () => {
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Grants Backend Dev', role: 'backend', capabilityKeys: ['backend.services'] },
    })
    const person = await prisma.person.create({
      data: {
        name: 'Granted Managed Person',
        templateId: template.id,
        poolSlot: 1,
        capabilities: ['backend.services', 'design.visual'],
        capabilityGrants: ['design.visual'],
      },
    })
    const found = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
    expect(found.capabilityGrants).toEqual(['design.visual'])
    expect([...found.capabilities].toSorted()).toEqual(['backend.services', 'design.visual'])
  })

  it('accepts grants on an UNMANAGED person too: the column is not tied to a pool slot', async () => {
    const person = await prisma.person.create({
      data: { name: 'Manual Granted Person', capabilities: ['qa.automation'], capabilityGrants: ['qa.automation'] },
    })
    expect((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).capabilityGrants).toEqual([
      'qa.automation',
    ])
  })
})

/**
 * Low-cost final-review minor: the CHECK constraints and unique index this feature's two
 * migrations installed are named, and a `prisma migrate dev` that re-generated the table from the
 * schema alone would silently drop the two CHECKs -- Prisma has no schema syntax for them. So the
 * drift test asks the LIVE database what it holds, by name, rather than trusting the .sql files to
 * still be the truth.
 */
describe('the pool-slot and capability-grant migrations, as the live database holds them', () => {
  let client: Client

  beforeEach(async (): Promise<void> => {
    const url = process.env['TEST_DATABASE_URL']
    if (url === undefined || url === '') throw new Error('TEST_DATABASE_URL is not set')
    client = new Client({ connectionString: url })
    await client.connect()
  })

  afterAll(async (): Promise<void> => {
    if (client !== undefined) await client.end().catch(() => {})
  })

  it('still holds both poolSlot CHECK constraints, by name and by definition', async () => {
    const rows = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = '"Person"'::regclass AND contype = 'c'
        ORDER BY conname`,
    )
    const byName = new Map(rows.rows.map((row) => [row.conname, row.def] as const))
    expect(byName.get('Person_poolSlot_range_check')).toContain('1, 2, 3')
    expect(byName.get('Person_poolSlot_requires_templateId')).toContain('templateId')
  })

  it('still holds the (templateId, poolSlot) unique index', async () => {
    const rows = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'Person' AND indexname = 'Person_templateId_poolSlot_key'`,
    )
    expect(rows.rows[0]?.indexdef).toContain('UNIQUE')
    expect(rows.rows[0]?.indexdef).toContain('templateId')
    expect(rows.rows[0]?.indexdef).toContain('poolSlot')
  })

  it('holds capabilityGrants as a NOT NULL text array defaulting to empty', async () => {
    const rows = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'Person' AND column_name = 'capabilityGrants'`,
    )
    expect(rows.rows[0]?.data_type).toBe('ARRAY')
    expect(rows.rows[0]?.is_nullable).toBe('NO')
    expect(rows.rows[0]?.column_default).toBe('ARRAY[]::text[]')
  })
})
