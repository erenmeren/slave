import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { createPerson } from '../../src/persons.js'
import { personEffectiveSkills, setPersonSkills, setTemplateSkills } from '../../src/personSkills.js'
import { truncateAll } from './helpers.js'

async function twoSkills(): Promise<{ pdf: string; sql: string }> {
  const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
  const pdf = await prisma.skill.create({ data: { providerId: provider.id, name: 'pdf', description: 'makes pdfs' } })
  const sql = await prisma.skill.create({ data: { providerId: provider.id, name: 'sql', description: 'writes sql' } })
  return { pdf: pdf.id, sql: sql.id }
}

beforeEach(async () => {
  await truncateAll()
})

describe('setTemplateSkills', () => {
  it('gives every person hired from the persona the skill AT ONCE, with no copy anywhere', async () => {
    const { pdf } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    const a = await createPerson({ templateId: template.id, name: 'Atlas' })
    const b = await createPerson({ templateId: template.id, name: 'Bruno' })
    if (!a.ok || !b.ok) throw new Error('setup')

    expect((await setTemplateSkills(template.id, [pdf])).ok).toBe(true)

    for (const person of [a.value.personId, b.value.personId]) {
      const effective = await personEffectiveSkills(person)
      expect(effective.ok).toBe(true)
      if (!effective.ok) return
      expect(effective.value.map((row) => [row.name, row.origin])).toEqual([['pdf', 'persona']])
    }
    // Nothing was copied: the only rows are the persona's own.
    expect(await prisma.personSkill.count()).toBe(0)
    expect(await prisma.templateSkill.count()).toBe(1)
  })

  it('is a SET: a second call replaces the list rather than adding to it', async () => {
    const { pdf, sql } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf, sql])
    await setTemplateSkills(template.id, [sql])
    const rows = await prisma.templateSkill.findMany({ where: { templateId: template.id } })
    expect(rows.map((row) => row.skillId)).toEqual([sql])
  })

  it('refuses an unknown skill and writes nothing', async () => {
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    const result = await setTemplateSkills(template.id, ['nope'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('skill_not_found')
    expect(await prisma.templateSkill.count()).toBe(0)
  })
})

describe('setPersonSkills', () => {
  it('a grant adds a skill the persona does not give', async () => {
    const { pdf, sql } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf])
    const person = await createPerson({ templateId: template.id, name: 'Atlas' })
    if (!person.ok) throw new Error('setup')

    const changed = await setPersonSkills(person.value.personId, { grant: [sql] })
    expect(changed.ok && [...changed.value.effective].toSorted()).toEqual([pdf, sql].toSorted())
    const effective = await personEffectiveSkills(person.value.personId)
    expect(effective.ok && effective.value.map((row) => [row.name, row.origin])).toEqual([
      ['pdf', 'persona'],
      ['sql', 'person'],
    ])
  })

  it('a revoke takes an inherited skill away from THIS person only', async () => {
    const { pdf } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf])
    const a = await createPerson({ templateId: template.id, name: 'Atlas' })
    const b = await createPerson({ templateId: template.id, name: 'Bruno' })
    if (!a.ok || !b.ok) throw new Error('setup')

    await setPersonSkills(a.value.personId, { revoke: [pdf] })
    const gone = await personEffectiveSkills(a.value.personId)
    const kept = await personEffectiveSkills(b.value.personId)
    expect(gone.ok && gone.value).toEqual([])
    expect(kept.ok && kept.value.map((row) => row.name)).toEqual(['pdf'])
  })

  it('clear takes back the person’s own adjustment and the persona speaks again', async () => {
    const { pdf } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf])
    const person = await createPerson({ templateId: template.id, name: 'Atlas' })
    if (!person.ok) throw new Error('setup')

    await setPersonSkills(person.value.personId, { revoke: [pdf] })
    await setPersonSkills(person.value.personId, { clear: [pdf] })
    const effective = await personEffectiveSkills(person.value.personId)
    expect(effective.ok && effective.value.map((row) => [row.name, row.origin])).toEqual([['pdf', 'persona']])
    expect(await prisma.personSkill.count()).toBe(0)
  })

  it('granting and revoking the same skill in one call is a refusal, and writes nothing', async () => {
    const { pdf } = await twoSkills()
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')
    const result = await setPersonSkills(person.value.personId, { grant: [pdf], revoke: [pdf] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_request')
    expect(await prisma.personSkill.count()).toBe(0)
  })

  it('refuses an unknown person', async () => {
    const { pdf } = await twoSkills()
    const result = await setPersonSkills('nope', { grant: [pdf] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('person_not_found')
  })
})
