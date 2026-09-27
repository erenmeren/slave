import { describe, expect, it } from 'vitest'
import {
  PROCESS_SKILL_NAMES,
  PROCESS_SKILL_WARNING,
  WORKING_DISCIPLINE_SKILL_NAMES,
  isProcessSkill,
  skillSourceOf,
} from '../../src/persons/processSkills.js'

describe('isProcessSkill', () => {
  it('flags every named process skill, from any provider', () => {
    for (const name of PROCESS_SKILL_NAMES) {
      expect(isProcessSkill({ name, providerName: 'personal' })).toBe(true)
    }
    expect(PROCESS_SKILL_NAMES).toHaveLength(10)
  })

  it('flags every skill the superpowers plugin carries, whatever it is called', () => {
    expect(isProcessSkill({ name: 'writing-skills', providerName: 'plugin:superpowers' })).toBe(true)
  })

  it('does not flag the working disciplines, even from the superpowers plugin', () => {
    for (const name of WORKING_DISCIPLINE_SKILL_NAMES) {
      expect(isProcessSkill({ name, providerName: 'plugin:superpowers' })).toBe(false)
      expect(isProcessSkill({ name: `superpowers:${name}`, providerName: 'plugin:superpowers' })).toBe(false)
    }
    expect(WORKING_DISCIPLINE_SKILL_NAMES).toEqual([
      'test-driven-development',
      'systematic-debugging',
      'verification-before-completion',
    ])
  })

  it('compares the bare name, case-insensitively, after any plugin prefix', () => {
    expect(isProcessSkill({ name: 'superpowers:Brainstorming', providerName: 'plugin:other' })).toBe(true)
  })

  it('leaves an ordinary skill alone', () => {
    expect(isProcessSkill({ name: 'pdf', providerName: 'personal' })).toBe(false)
    expect(isProcessSkill({ name: 'frontend-design', providerName: 'plugin:frontend' })).toBe(false)
  })

  it('says what the risk is in one sentence', () => {
    expect(PROCESS_SKILL_WARNING).toBe('Process skill: can make a worker plan and delegate instead of doing its task.')
  })
})

describe('skillSourceOf', () => {
  it('reads plugin:<name> as a plugin and names it', () => {
    expect(skillSourceOf('plugin:superpowers')).toEqual({ kind: 'plugin', plugin: 'superpowers' })
  })

  it('reads library:<source> as the skill library and names the source', () => {
    expect(skillSourceOf('library:trailofbits')).toEqual({ kind: 'library', library: 'trailofbits' })
    expect(skillSourceOf('library:')).toEqual({ kind: 'local' })
  })

  it('reads personal, project and anything unknown as local', () => {
    expect(skillSourceOf('personal')).toEqual({ kind: 'local' })
    expect(skillSourceOf('project')).toEqual({ kind: 'local' })
    expect(skillSourceOf('plugin:')).toEqual({ kind: 'local' })
  })
})
