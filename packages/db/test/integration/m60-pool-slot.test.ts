/**
 * M60 Catalog Person Pool: schema constraints for Person.poolSlot.
 *
 * Tests that:
 *   - poolSlot is nullable and defaults to NULL for ordinary people.
 *   - valid slots 1, 2, 3 are accepted.
 *   - slots outside [1, 2, 3] are rejected by the database check constraint.
 *   - a non-null poolSlot without a templateId is rejected.
 *   - (templateId, poolSlot) is unique across managed people.
 *   - existing people remain unmanaged with poolSlot = NULL.
 */
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

describe('Person.poolSlot schema constraints', () => {
  it('poolSlot is NULL for an ordinary unmanaged person', async () => {
    const person = await prisma.person.create({ data: { name: 'Alice' } })
    const found = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
    expect(found.poolSlot).toBeNull()
  })

  it('accepts poolSlot = 1, 2, 3 when templateId is set', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Dev', role: 'dev' } })
    for (const slot of [1, 2, 3] as const) {
      const person = await prisma.person.create({
        data: { name: `Person ${slot}`, templateId: template.id, poolSlot: slot },
      })
      const found = await prisma.person.findUniqueOrThrow({ where: { id: person.id } })
      expect(found.poolSlot).toBe(slot)
    }
  })

  it('rejects poolSlot = 0 (out of valid range)', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Frontend Dev', role: 'dev' } })
    await expect(
      prisma.person.create({ data: { name: 'Bad Slot Zero', templateId: template.id, poolSlot: 0 } }),
    ).rejects.toThrow()
  })

  it('rejects poolSlot = 4 (out of valid range)', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'QA Dev', role: 'dev' } })
    await expect(
      prisma.person.create({ data: { name: 'Bad Slot Four', templateId: template.id, poolSlot: 4 } }),
    ).rejects.toThrow()
  })

  it('rejects a non-null poolSlot without a templateId', async () => {
    await expect(
      prisma.person.create({ data: { name: 'No Template', poolSlot: 1 } }),
    ).rejects.toThrow()
  })

  it('rejects duplicate (templateId, poolSlot) combinations', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Data Eng', role: 'dev' } })
    await prisma.person.create({ data: { name: 'First Managed', templateId: template.id, poolSlot: 1 } })
    await expect(
      prisma.person.create({ data: { name: 'Duplicate Managed', templateId: template.id, poolSlot: 1 } }),
    ).rejects.toThrow()
  })

  it('allows two templates each having a person in slot 1', async () => {
    const t1 = await prisma.slaveTemplate.create({ data: { name: 'Template A', role: 'dev' } })
    const t2 = await prisma.slaveTemplate.create({ data: { name: 'Template B', role: 'dev' } })
    const p1 = await prisma.person.create({ data: { name: 'A Slot 1', templateId: t1.id, poolSlot: 1 } })
    const p2 = await prisma.person.create({ data: { name: 'B Slot 1', templateId: t2.id, poolSlot: 1 } })
    expect(p1.poolSlot).toBe(1)
    expect(p2.poolSlot).toBe(1)
  })

  it('allows multiple NULL-slot people linked to the same template (ordinary hires)', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Full Stack Dev', role: 'dev' } })
    const p1 = await prisma.person.create({ data: { name: 'Hire A', templateId: template.id } })
    const p2 = await prisma.person.create({ data: { name: 'Hire B', templateId: template.id } })
    expect(p1.poolSlot).toBeNull()
    expect(p2.poolSlot).toBeNull()
  })
})
