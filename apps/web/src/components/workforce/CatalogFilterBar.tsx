'use client'

import type { WorkforceCatalogFacets, WorkforceCatalogFilters } from '@slave-of-ai/control'
import { CATALOG_SOURCES, type CatalogSource } from '../../lib/catalogFilters'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'

/** docs/ia.md rule 3 -- the chip says a word, `data-source` keeps the value. */
const SOURCE_LABEL: Record<CatalogSource, string> = {
  imported: 'Imported',
  local: 'Made here',
}

type FilterKey = 'q' | 'division' | 'capability' | 'source' | 'skill'

const asSource = (value: string): CatalogSource | undefined =>
  CATALOG_SOURCES.find((member) => member === value)

/**
 * One filter changed, the other four carried through -- and `''` means "drop this one" rather than
 * "match the empty string" (an `<option value="">any</option>` and a cleared search box both send
 * it).
 *
 * Written out key by key instead of a computed-key spread: under `exactOptionalPropertyTypes` an
 * optional key that is PRESENT and `undefined` is a different type from an absent one, and a
 * `{ [key]: value }` over a union of keys widens to an index signature that would let a sixth
 * filter through without anybody deciding what it means.
 */
function withFilter(
  filters: WorkforceCatalogFilters,
  key: FilterKey,
  value: string,
): WorkforceCatalogFilters {
  const q = key === 'q' ? value : filters.q
  const division = key === 'division' ? value : filters.division
  const capability = key === 'capability' ? value : filters.capability
  const source = key === 'source' ? asSource(value) : filters.source
  const skill = key === 'skill' ? value : filters.skill
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(capability !== undefined && capability !== '' ? { capability } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(skill !== undefined && skill !== '' ? { skill } : {}),
  }
}

/**
 * The catalog's filter row (M46 R6), shaped like `activity/FilterBar.tsx`: coarse chips for the
 * facet with two values, a `<select>` for each facet that is a list. No new dependency and no
 * combobox -- the facets come back sorted and a division list is short enough to scan.
 */
export function CatalogFilterBar({
  filters,
  facets,
  onChange,
}: {
  readonly filters: WorkforceCatalogFilters
  readonly facets: WorkforceCatalogFacets
  readonly onChange: (next: WorkforceCatalogFilters) => void
}): React.JSX.Element {
  const set = (key: FilterKey, value: string): void => onChange(withFilter(filters, key, value))
  const select = (key: 'division' | 'capability' | 'skill', label: string, options: readonly string[]): React.JSX.Element => (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        data-testid={`catalog-${key}-select`}
        aria-label={label}
        value={filters[key] ?? ''}
        onChange={(event) => set(key, event.target.value)}
        className={`w-44 ${INPUT_SHELL}`}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
  const filtered = Object.keys(filters).length > 0

  return (
    <div data-testid="catalog-filters" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <FieldLabel>Search</FieldLabel>
        <input
          data-testid="catalog-search"
          aria-label="search the catalog"
          value={filters.q ?? ''}
          placeholder="name, summary, capability, expertise"
          onChange={(event) => set('q', event.target.value)}
          className={`w-72 ${INPUT_SHELL}`}
        />
      </label>
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            data-testid={`catalog-source-chip-${source}`}
            data-source={source}
            aria-pressed={filters.source === source}
            onClick={() => set('source', filters.source === source ? '' : source)}
            className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
              filters.source === source ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
            }`}
          >
            {SOURCE_LABEL[source]}
          </button>
        ))}
      </div>
      {select('division', 'Division', facets.divisions)}
      {select('capability', 'Capability', facets.capabilities)}
      {select('skill', 'Skill', facets.skills)}
      {filtered && (
        <Button variant="ghost" size="sm" data-testid="catalog-clear-filters" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  )
}
