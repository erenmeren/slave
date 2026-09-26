import { describe, expect, it } from 'vitest'
import { addSkillWrite, removeSkillWrite, restoreSkillWrite, type SkillTarget } from '../src/lib/skillWrites.js'

const persona: SkillTarget = { kind: 'persona', templateId: 't1' }
const hired: SkillTarget & { kind: 'person' } = { kind: 'person', personId: 'p1', personaId: 't1', personaName: 'Builder' }
const madeFromNothing: SkillTarget & { kind: 'person' } = { kind: 'person', personId: 'p2', personaId: null, personaName: null }

describe('addSkillWrite', () => {
  it('a persona card always writes the persona, as a delta', () => {
    expect(addSkillWrite(persona, 's1', 'person')).toEqual({ url: '/api/org/templates/t1/skills', body: { add: ['s1'] } })
  })

  it('a person card writes the person by default, the persona when asked', () => {
    expect(addSkillWrite(hired, 's1', 'person')).toEqual({ url: '/api/persons/p1/skills', body: { grant: ['s1'] } })
    expect(addSkillWrite(hired, 's1', 'persona')).toEqual({ url: '/api/org/templates/t1/skills', body: { add: ['s1'] } })
  })

  it('a person made from nothing has no persona to write, whatever the scope says', () => {
    expect(addSkillWrite(madeFromNothing, 's1', 'persona')).toEqual({ url: '/api/persons/p2/skills', body: { grant: ['s1'] } })
  })
})

describe('removeSkillWrite', () => {
  it('a persona card removes from the persona', () => {
    expect(removeSkillWrite(persona, { skillId: 's1', state: 'persona' }, 'person')).toEqual({
      url: '/api/org/templates/t1/skills',
      body: { remove: ['s1'] },
    })
  })

  it('an inherited skill is REVOKED for this person, or removed from the persona for everyone', () => {
    expect(removeSkillWrite(hired, { skillId: 's1', state: 'persona' }, 'person')).toEqual({
      url: '/api/persons/p1/skills',
      body: { revoke: ['s1'] },
    })
    expect(removeSkillWrite(hired, { skillId: 's1', state: 'persona' }, 'persona')).toEqual({
      url: '/api/org/templates/t1/skills',
      body: { remove: ['s1'] },
    })
  })

  it("a person's own grant is CLEARED, whatever the scope -- the persona never had it", () => {
    expect(removeSkillWrite(hired, { skillId: 's1', state: 'person' }, 'persona')).toEqual({
      url: '/api/persons/p1/skills',
      body: { clear: ['s1'] },
    })
  })
})

describe('restoreSkillWrite', () => {
  it('takes back the revoke, so the persona speaks again', () => {
    expect(restoreSkillWrite(hired, 's1')).toEqual({ url: '/api/persons/p1/skills', body: { clear: ['s1'] } })
  })
})
