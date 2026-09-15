import { describe, expect, it } from 'vitest'
import { effectiveSkillIds, effectiveSkills } from '../../src/persons/effectiveSkills.js'

describe('effectiveSkills', () => {
  it('is the persona default when the person has said nothing', () => {
    expect(effectiveSkills({ templateSkillIds: ['b', 'a'], granted: [], revoked: [] })).toEqual([
      { skillId: 'a', origin: 'persona' },
      { skillId: 'b', origin: 'persona' },
    ])
  })

  it('adds a grant and marks it as the person’s own', () => {
    expect(effectiveSkills({ templateSkillIds: ['a'], granted: ['c'], revoked: [] })).toEqual([
      { skillId: 'a', origin: 'persona' },
      { skillId: 'c', origin: 'person' },
    ])
  })

  it('a revoke removes an inherited skill', () => {
    expect(effectiveSkillIds({ templateSkillIds: ['a', 'b'], granted: [], revoked: ['a'] })).toEqual(['b'])
  })

  it('a revoke beats a grant of the same skill: the person said no last', () => {
    expect(effectiveSkillIds({ templateSkillIds: [], granted: ['a'], revoked: ['a'] })).toEqual([])
  })

  it('a grant that repeats the persona default is not a second row', () => {
    expect(effectiveSkills({ templateSkillIds: ['a'], granted: ['a'], revoked: [] })).toEqual([
      { skillId: 'a', origin: 'persona' },
    ])
  })

  it('a revoke of a skill nobody has is not an error and changes nothing', () => {
    expect(effectiveSkillIds({ templateSkillIds: ['a'], granted: [], revoked: ['zzz'] })).toEqual(['a'])
  })

  it('duplicates in any input collapse, and the answer is sorted', () => {
    expect(
      effectiveSkillIds({ templateSkillIds: ['b', 'b'], granted: ['a', 'a'], revoked: [] }),
    ).toEqual(['a', 'b'])
  })
})
