import { describe, expect, it } from 'vitest'
import { CATALOG_SOURCES, catalogFilterParams, parseCatalogFilters } from '../src/lib/catalogFilters.js'

describe('parseCatalogFilters', () => {
  it('reads the five dimensions the catalog filters on', () => {
    const params = new URLSearchParams(
      'q=builder&division=engineering&capability=Design%20the%20boundary&source=imported&skill=writing-plans',
    )
    expect(parseCatalogFilters(params)).toEqual({
      q: 'builder',
      division: 'engineering',
      capability: 'Design the boundary',
      source: 'imported',
      skill: 'writing-plans',
    })
  })

  it('drops a blank value and an unknown source rather than refusing the whole request', () => {
    expect(parseCatalogFilters(new URLSearchParams('q=%20%20&source=sideways'))).toEqual({})
  })

  it('drops an unknown source but keeps every other dimension of the same link', () => {
    expect(parseCatalogFilters(new URLSearchParams('q=builder&source=SIDEWAYS&skill=writing-plans'))).toEqual({
      q: 'builder',
      skill: 'writing-plans',
    })
  })

  it('offers exactly the two sources a template row can have', () => {
    expect(CATALOG_SOURCES).toEqual(['imported', 'local'])
  })

  it('round-trips through catalogFilterParams, and writes nothing for an empty filter', () => {
    const filters = { q: 'builder', source: 'local' as const }
    expect(parseCatalogFilters(catalogFilterParams(filters))).toEqual(filters)
    expect(catalogFilterParams({}).toString()).toBe('')
  })

  it('round-trips a value with spaces and punctuation through the encoding', () => {
    const filters = { capability: 'Design the module boundary', division: 'engineering' }
    expect(parseCatalogFilters(catalogFilterParams(filters))).toEqual(filters)
  })
})
