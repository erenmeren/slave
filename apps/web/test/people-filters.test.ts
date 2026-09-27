import { describe, expect, it } from 'vitest'
import { PEOPLE_STATES, parsePeopleFilters, peopleFilterParams, withPeopleFilter } from '../src/lib/peopleFilters.js'

describe('parsePeopleFilters', () => {
  it('reads the seven dimensions People filters on', () => {
    const params = new URLSearchParams('q=atlas&specialty=frontend&division=engineering&skillId=s1&skills=none&state=pool&department=ct1')
    expect(parsePeopleFilters(params)).toEqual({
      q: 'atlas',
      specialty: 'frontend',
      division: 'engineering',
      skillId: 's1',
      noSkills: true,
      state: 'pool',
      department: 'ct1',
    })
  })

  it('drops a segment or a skills value outside its vocabulary rather than refusing the link', () => {
    expect(parsePeopleFilters(new URLSearchParams('state=sleeping&skills=all&q=%20'))).toEqual({})
  })

  it('offers exactly the three segments a person can be in', () => {
    expect(PEOPLE_STATES).toEqual(['pool', 'assigned', 'released'])
  })

  it('round-trips through peopleFilterParams', () => {
    const filters = { q: 'atlas', specialty: 'qa', noSkills: true, state: 'released' as const }
    expect(parsePeopleFilters(peopleFilterParams(filters))).toEqual(filters)
    expect(peopleFilterParams({}).toString()).toBe('')
  })
})

describe('withPeopleFilter', () => {
  it('sets one dimension and keeps the others', () => {
    expect(withPeopleFilter({ q: 'atlas' }, 'specialty', 'qa')).toEqual({ q: 'atlas', specialty: 'qa' })
  })

  it('reads an empty value as "drop this one"', () => {
    expect(withPeopleFilter({ q: 'atlas', state: 'pool' }, 'state', '')).toEqual({ q: 'atlas' })
    expect(withPeopleFilter({ noSkills: true }, 'noSkills', '')).toEqual({})
  })

  it('ignores a segment word it does not know', () => {
    expect(withPeopleFilter({}, 'state', 'sleeping')).toEqual({})
  })
})
