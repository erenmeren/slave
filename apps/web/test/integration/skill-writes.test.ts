import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { createPerson } from '@slave-of-ai/control'
import { GET as templateSkillsRead, PATCH as templateSkillsRoute } from '../../src/app/api/org/templates/[templateId]/skills/route.js'
import { PATCH as personSkillsRoute } from '../../src/app/api/persons/[personId]/skills/route.js'
import { addSkillWrite, removeSkillWrite, restoreSkillWrite, type SkillTarget, type SkillWrite } from '../../src/lib/skillWrites.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
})

/** Sends one `SkillWrite` to the handler its URL names -- the card's own `sendControl`, minus the
 *  network. */
async function send(write: SkillWrite): Promise<Response> {
  const request = new Request(`http://localhost${write.url}`, { method: 'PATCH', body: JSON.stringify(write.body) })
  const template = /^\/api\/org\/templates\/([^/]+)\/skills$/.exec(write.url)?.[1]
  if (template !== undefined) return templateSkillsRoute(request, { params: Promise.resolve({ templateId: template }) })
  const person = /^\/api\/persons\/([^/]+)\/skills$/.exec(write.url)?.[1]
  if (person !== undefined) return personSkillsRoute(request, { params: Promise.resolve({ personId: person }) })
  throw new Error(`no route for ${write.url}`)
}

async function fixture(): Promise<{ pdf: string; sql: string; templateId: string; hired: SkillTarget & { kind: 'person' } }> {
  const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
  const pdf = await prisma.skill.create({ data: { providerId: provider.id, name: 'pdf', description: 'makes pdfs' } })
  const sql = await prisma.skill.create({ data: { providerId: provider.id, name: 'sql', description: 'writes sql' } })
  const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
  const person = await createPerson({ templateId: template.id, name: 'Atlas' })
  if (!person.ok) throw new Error('setup')
  return {
    pdf: pdf.id,
    sql: sql.id,
    templateId: template.id,
    hired: { kind: 'person', personId: person.value.personId, personaId: template.id, personaName: 'Builder' },
  }
}

const linked = async (templateId: string): Promise<string[]> =>
  (await prisma.templateSkill.findMany({ where: { templateId } })).map((row) => row.skillId).toSorted()

describe('persona skill writes from a card', () => {
  it('an add keeps the other links, and a remove keeps the others too', async () => {
    const { pdf, sql, templateId } = await fixture()
    const persona: SkillTarget = { kind: 'persona', templateId }

    expect((await send(addSkillWrite(persona, pdf, 'person'))).status).toBe(200)
    expect((await send(addSkillWrite(persona, sql, 'person'))).status).toBe(200)
    expect(await linked(templateId)).toEqual([pdf, sql].toSorted())
    expect((await send(removeSkillWrite(persona, { skillId: pdf, state: 'persona' }, 'person'))).status).toBe(200)
    expect(await linked(templateId)).toEqual([sql])
  })

  it('two cards adding at the same moment both keep their skill', async () => {
    const { pdf, sql, templateId } = await fixture()
    const persona: SkillTarget = { kind: 'persona', templateId }

    await Promise.all([send(addSkillWrite(persona, pdf, 'person')), send(addSkillWrite(persona, sql, 'person'))])
    expect(await linked(templateId)).toEqual([pdf, sql].toSorted())
  })

  it('still takes the whole set the drawer sends, and refuses a body that is neither', async () => {
    const { pdf, templateId } = await fixture()
    expect((await send({ url: `/api/org/templates/${templateId}/skills`, body: { skillIds: [pdf] } })).status).toBe(200)
    expect(await linked(templateId)).toEqual([pdf])
    expect((await send({ url: `/api/org/templates/${templateId}/skills`, body: {} })).status).toBe(400)
  })
})

/** The by-id read the drawer takes for a persona off the loaded page (Duplicates data-loss fix):
 *  it must answer the REAL linked set, since the editor's next save writes the whole of it back. */
describe('reading one persona\'s default skills by id', () => {
  const read = (templateId: string): Promise<Response> =>
    templateSkillsRead(new Request(`http://localhost/api/org/templates/${templateId}/skills`), {
      params: Promise.resolve({ templateId }),
    })

  it('answers the linked skill ids and the hired count, and 404 for a persona that does not exist', async () => {
    const { pdf, sql, templateId } = await fixture()
    await prisma.templateSkill.createMany({ data: [{ templateId, skillId: pdf }, { templateId, skillId: sql }] })

    const response = await read(templateId)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ defaultSkillIds: [pdf, sql].toSorted(), hiredCount: 1 })
    expect((await read('no-such-persona')).status).toBe(404)
  })
})

describe('person skill writes and their scope', () => {
  it('"only this person" writes PersonSkill and leaves the persona alone', async () => {
    const { pdf, templateId, hired } = await fixture()

    expect((await send(addSkillWrite(hired, pdf, 'person'))).status).toBe(200)
    expect(await prisma.personSkill.findMany({ where: { personId: hired.personId } })).toEqual([
      { personId: hired.personId, skillId: pdf, mode: 'granted' },
    ])
    expect(await linked(templateId)).toEqual([])
  })

  it('"everyone from the persona" writes TemplateSkill and no PersonSkill', async () => {
    const { pdf, templateId, hired } = await fixture()

    expect((await send(addSkillWrite(hired, pdf, 'persona'))).status).toBe(200)
    expect(await linked(templateId)).toEqual([pdf])
    expect(await prisma.personSkill.count()).toBe(0)
  })

  it('removing an inherited skill revokes it for this person; restore clears the revoke', async () => {
    const { pdf, templateId, hired } = await fixture()
    await send(addSkillWrite(hired, pdf, 'persona'))

    await send(removeSkillWrite(hired, { skillId: pdf, state: 'persona' }, 'person'))
    expect(await prisma.personSkill.findMany({ where: { personId: hired.personId } })).toEqual([
      { personId: hired.personId, skillId: pdf, mode: 'revoked' },
    ])
    expect(await linked(templateId)).toEqual([pdf])
    await send(restoreSkillWrite(hired, pdf))
    expect(await prisma.personSkill.count()).toBe(0)
  })

  it('a missing skill is refused on both routes, with a sentence that names it', async () => {
    const { pdf, templateId, hired } = await fixture()
    await prisma.skill.update({ where: { id: pdf }, data: { missingSince: new Date() } })

    for (const write of [addSkillWrite(hired, pdf, 'person'), addSkillWrite(hired, pdf, 'persona')]) {
      const response = await send(write)
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: string }).error).toBe(
        'the skill pdf is missing from disk; it can be linked again once a skills scan finds it',
      )
    }
    expect(await linked(templateId)).toEqual([])
    expect(await prisma.personSkill.count()).toBe(0)
  })
})
