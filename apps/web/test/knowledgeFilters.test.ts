import { describe, expect, it } from 'vitest'
import {
  knowledgeFilterParams,
  knowledgeQueryOf,
  parseKnowledgeFilters,
} from '../src/lib/knowledgeFilters'

/**
 * The Knowledge tab's URL vocabulary (M49 R6, t4 fix round 1 minor 4) -- the one parse the route,
 * the server render and the client hook all share, so a shared link means the same thing to all
 * three.
 */
describe('parseKnowledgeFilters', () => {
  it('reads the four dimensions a link can carry', () => {
    const filters = parseKnowledgeFilters(
      new URLSearchParams('scope=workspace&type=fact&status=removed&status=superseded&q=%20checkout%20'),
    )
    expect(filters.scope).toBe('workspace')
    expect(filters.type).toBe('fact')
    expect(filters.statuses).toEqual(['removed', 'superseded'])
    // Trimmed here, once, rather than in three readers of the same param.
    expect(filters.q).toBe('checkout')
  })

  it('is empty for a bare URL, so an unfiltered page asks for the route’s own default', () => {
    expect(parseKnowledgeFilters(new URLSearchParams(''))).toEqual({})
  })

  it('drops a member the union does not have rather than refusing the whole link', () => {
    const filters = parseKnowledgeFilters(new URLSearchParams('scope=elsewhere&type=not-a-type&q=%20%20'))
    expect(filters).toEqual({})
  })

  it('drops the unknown status tokens and keeps the known ones', () => {
    expect(parseKnowledgeFilters(new URLSearchParams('status=removed&status=nonsense')).statuses).toEqual(['removed'])
    // Every token unknown is NO status filter -- never "show nothing".
    expect(parseKnowledgeFilters(new URLSearchParams('status=nonsense')).statuses).toBeUndefined()
  })

  it('dedupes a repeated status: one `IN` member, not two', () => {
    expect(parseKnowledgeFilters(new URLSearchParams('status=removed&status=removed')).statuses).toEqual(['removed'])
  })

  it('round-trips through the params it writes', () => {
    const filters = { scope: 'worker' as const, type: 'lesson' as const, statuses: ['candidate' as const], q: 'index' }
    expect(parseKnowledgeFilters(knowledgeFilterParams(filters))).toEqual(filters)
  })

  it('writes nothing at all for an unfiltered page', () => {
    expect(knowledgeFilterParams({}).toString()).toBe('')
    expect(knowledgeFilterParams({ q: '   ' }).toString()).toBe('')
  })
})

describe('knowledgeQueryOf', () => {
  it('takes Next’s two shapes -- a string and a repeated param’s array -- and keeps every value', () => {
    const query = knowledgeQueryOf({ type: 'fact', status: ['removed', 'superseded'], missing: undefined })
    expect(query.getAll('status')).toEqual(['removed', 'superseded'])
    expect(query.get('type')).toBe('fact')
    expect(query.has('missing')).toBe(false)
  })
})
