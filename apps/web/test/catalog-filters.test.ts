import { describe, expect, it } from 'vitest'
import {
  CATALOG_ACTIVATIONS,
  CATALOG_SEARCH_DEBOUNCE_MS,
  CATALOG_SOURCES,
  catalogFilterParams,
  parseCatalogFilters,
} from '../src/lib/catalogFilters.js'

describe('parseCatalogFilters', () => {
  it('reads the seven dimensions the catalog filters on', () => {
    const params = new URLSearchParams(
      'q=builder&division=engineering&capability=backend.api-design&source=imported&skill=writing-plans&active=active&duplicates=exact',
    )
    expect(parseCatalogFilters(params)).toEqual({
      q: 'builder',
      division: 'engineering',
      capability: 'backend.api-design',
      source: 'imported',
      skill: 'writing-plans',
      active: true,
      duplicates: 'exact',
    })
  })

  it('reads `inactive` as the other half of the same boolean', () => {
    expect(parseCatalogFilters(new URLSearchParams('active=inactive'))).toEqual({ active: false })
  })

  it('drops an activation word outside its vocabulary rather than refusing the link', () => {
    expect(parseCatalogFilters(new URLSearchParams('active=maybe&q=builder'))).toEqual({ q: 'builder' })
  })

  it('drops a duplicates facet outside its vocabulary, and keeps `none`, which IS one', () => {
    expect(parseCatalogFilters(new URLSearchParams('duplicates=sideways'))).toEqual({})
    expect(parseCatalogFilters(new URLSearchParams('duplicates=none'))).toEqual({ duplicates: 'none' })
  })

  it('offers exactly the two activations a template row can have', () => {
    expect(CATALOG_ACTIVATIONS).toEqual(['active', 'inactive'])
  })

  it('spells the search debounce once, where the filter bar reads it', () => {
    expect(CATALOG_SEARCH_DEBOUNCE_MS).toBe(250)
  })

  it('round-trips all seven, including the boolean, through catalogFilterParams', () => {
    const filters = {
      q: 'builder',
      division: 'engineering',
      capability: 'backend.api-design',
      source: 'imported' as const,
      skill: 'writing-plans',
      active: false,
      duplicates: 'none' as const,
    }
    expect(parseCatalogFilters(catalogFilterParams(filters))).toEqual(filters)
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
