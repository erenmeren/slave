import { describe, expect, it } from 'vitest'
import { personCardSkills } from '../src/lib/cardSkills.js'

const skill = (id: string, name: string, over: { readonly missing?: boolean; readonly provider?: string } = {}) => ({
  id,
  name,
  missingSince: over.missing === true ? new Date('2026-09-20T00:00:00.000Z') : null,
  provider: { name: over.provider ?? 'personal' },
})

describe('personCardSkills', () => {
  it('is the effective set with its origins, then the revoked inherited ones, struck', () => {
    const rows = personCardSkills({
      templateSkills: [skill('a', 'pdf'), skill('b', 'sql')],
      personSkills: [
        { ...skill('b', 'sql'), mode: 'revoked' },
        { ...skill('c', 'archived', { missing: true }), mode: 'granted' },
      ],
    })
    expect(rows.map((row) => [row.name, row.state, row.missing])).toEqual([
      ['archived', 'person', true],
      ['pdf', 'persona', false],
      ['sql', 'revoked', false],
    ])
  })

  it('calls a granted skill the persona also gives "persona": removing the grant would not remove it', () => {
    const rows = personCardSkills({
      templateSkills: [skill('a', 'pdf')],
      personSkills: [{ ...skill('a', 'pdf'), mode: 'granted' }],
    })
    expect(rows.map((row) => [row.name, row.state])).toEqual([['pdf', 'persona']])
  })

  it('marks a superpowers skill as a process skill', () => {
    const rows = personCardSkills({ templateSkills: [skill('a', 'brainstorming', { provider: 'plugin:superpowers' })], personSkills: [] })
    expect(rows[0]?.process).toBe(true)
  })
})
