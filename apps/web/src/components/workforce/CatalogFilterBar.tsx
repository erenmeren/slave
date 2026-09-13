'use client'

import { useEffect, useRef, useState } from 'react'
import type { WorkforceCatalogFacets, WorkforceCatalogFilters } from '@slave-of-ai/control'
import {
  DUPLICATE_FACETS,
  DUPLICATE_FACET_LABEL,
  capabilityLabel,
  type CapabilityRecord,
  type DuplicateFacet,
} from '@slave-of-ai/domain'
import {
  ACTIVATION_LABEL,
  CATALOG_ACTIVATIONS,
  CATALOG_SEARCH_DEBOUNCE_MS,
  CATALOG_SOURCES,
  type CatalogActivation,
  type CatalogSource,
} from '../../lib/catalogFilters'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'

/**
 * ONE vocabulary (M46 fix round 1): the chip says exactly the word the catalog ROW says for the same
 * fact -- `imported` and `local`, `active` and `inactive` -- because a filter labelled `Made here`
 * beside rows labelled `local` is two names for one thing, and a person has to learn which is which
 * before they can use either. `data-source` and `data-active` still carry the values for a gate.
 */
const SOURCE_LABEL: Record<CatalogSource, string> = {
  imported: 'imported',
  local: 'local',
}

type FilterKey = 'q' | 'division' | 'capability' | 'source' | 'skill' | 'active' | 'duplicates'

const asSource = (value: string): CatalogSource | undefined => CATALOG_SOURCES.find((member) => member === value)
const asFacet = (value: string): DuplicateFacet | undefined => DUPLICATE_FACETS.find((member) => member === value)

/**
 * One filter changed, the other six carried through -- and `''` means "drop this one" rather than
 * "match the empty string" (an `<option value="">any</option>`, a cleared search box and a chip
 * clicked twice all send it).
 *
 * Written out key by key instead of a computed-key spread: under `exactOptionalPropertyTypes` an
 * optional key that is PRESENT and `undefined` is a different type from an absent one, and a
 * `{ [key]: value }` over a union of keys widens to an index signature that would let an eighth
 * filter through without anybody deciding what it means.
 */
function withFilter(filters: WorkforceCatalogFilters, key: FilterKey, value: string): WorkforceCatalogFilters {
  const q = key === 'q' ? value : filters.q
  const division = key === 'division' ? value : filters.division
  const capability = key === 'capability' ? value : filters.capability
  const source = key === 'source' ? asSource(value) : filters.source
  const skill = key === 'skill' ? value : filters.skill
  const active = key === 'active' ? (value === '' ? undefined : value === 'active') : filters.active
  const duplicates = key === 'duplicates' ? asFacet(value) : filters.duplicates
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(capability !== undefined && capability !== '' ? { capability } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(skill !== undefined && skill !== '' ? { skill } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(duplicates !== undefined ? { duplicates } : {}),
  }
}

/**
 * The catalog's filter row (M46 R6, seven controls since M55 R3), shaped like
 * `activity/FilterBar.tsx`: coarse chips for the two facets with two values, a `<select>` for each
 * facet that is a list. No new dependency and no combobox -- the facets come back sorted and a
 * division list is short enough to scan.
 *
 * The SEARCH BOX keeps its own state and pushes it up after {@link CATALOG_SEARCH_DEBOUNCE_MS}
 * (M53 section 6's carried item, taken here by M55 R3). It was cosmetic while the read model
 * filtered an array; it stopped being cosmetic the moment each keystroke became a scan over the
 * whole table plus a `count` over the same `where`. The input stays instant -- what waits is the
 * request.
 */
export function CatalogFilterBar({
  filters,
  facets,
  taxonomy = [],
  onChange,
}: {
  readonly filters: WorkforceCatalogFilters
  readonly facets: WorkforceCatalogFacets
  /** M55 R3: the capability facet's OPTIONS are taxonomy keys, and this is what turns each into a
   *  word. Defaults to empty, where every key prints as itself -- the `capabilityLabel` fallback,
   *  which is the honest thing to show for a key this bundle has never heard of. */
  readonly taxonomy?: readonly CapabilityRecord[]
  readonly onChange: (next: WorkforceCatalogFilters) => void
}): React.JSX.Element {
  const set = (key: FilterKey, value: string): void => onChange(withFilter(filters, key, value))

  // The search box's own state, so typing is never gated on a network round trip. Seeded from the
  // filters and re-seeded whenever they change from OUTSIDE this component -- Clear filters, or a
  // link opened with a `?q=` on it -- which is what the dependency on `filters.q` is for.
  const [query, setQuery] = useState(filters.q ?? '')
  useEffect(() => {
    setQuery(filters.q ?? '')
  }, [filters.q])
  /**
   * The push the timer makes, kept CURRENT (fix, found by `gate:m46-workforce-catalog` stage 2c).
   *
   * The wait below deliberately restarts on `query` alone, so the callback it arms closes over the
   * `filters` of the render that armed it. A source chip clicked during those 250 ms was then
   * silently REVERTED when the keystroke's own push landed carrying the older six -- the filter bar
   * undoing a click a person had already watched take effect. A ref refreshed after every render
   * fixes that without making the wait restart on every render, which is what a dependency would.
   */
  const push = useRef<(value: string) => void>(() => undefined)
  useEffect(() => {
    push.current = (value: string): void => {
      onChange(withFilter(filters, 'q', value))
    }
  })
  useEffect(() => {
    if (query === (filters.q ?? '')) return
    const timer = setTimeout(() => push.current(query), CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `filters.q` is read to decide whether there is anything to push at all; re-arming the wait
    // when it changes would restart it on the very push that ended it. `query` is the only thing
    // whose change should restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const select = (
    key: 'division' | 'capability' | 'skill',
    label: string,
    options: readonly string[],
    textOf: (option: string) => string = (option) => option,
  ): React.JSX.Element => (
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
            {textOf(option)}
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
          value={query}
          placeholder="name, summary, capability, expertise"
          onChange={(event) => setQuery(event.target.value)}
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
      {/* M55 R6: the activation chips, in the source chips' own two-value shape -- and clicking the
        * pressed one clears the filter, because "either" is a real third state and a two-chip
        * control with no way back to it is a trap. */}
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_ACTIVATIONS.map((activation: CatalogActivation) => {
          const pressed = filters.active === (activation === 'active')
          return (
            <button
              key={activation}
              type="button"
              data-testid={`catalog-active-chip-${activation}`}
              data-active={String(activation === 'active')}
              aria-pressed={pressed}
              onClick={() => set('active', pressed ? '' : activation)}
              className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
                pressed ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
              }`}
            >
              {ACTIVATION_LABEL[activation]}
            </button>
          )
        })}
      </div>
      {select('division', 'Division', facets.divisions)}
      {/* M55 R3: the OPTIONS are taxonomy keys and the TEXT is their labels -- `docs/ia.md` rule 3,
        * and the key is what a gate reads off `<option value>`. */}
      {select('capability', 'Capability', facets.capabilities, (key) => capabilityLabel(key, taxonomy))}
      {select('skill', 'Skill', facets.skills)}
      <label className="flex flex-col gap-1">
        <FieldLabel>Duplicates</FieldLabel>
        <select
          data-testid="catalog-duplicates-select"
          aria-label="Duplicates"
          value={filters.duplicates ?? ''}
          onChange={(event) => set('duplicates', event.target.value)}
          className={`w-44 ${INPUT_SHELL}`}
        >
          <option value="">any</option>
          {DUPLICATE_FACETS.map((facet) => (
            <option key={facet} value={facet}>
              {DUPLICATE_FACET_LABEL[facet]}
            </option>
          ))}
        </select>
      </label>
      {filtered && (
        <Button variant="ghost" size="sm" data-testid="catalog-clear-filters" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  )
}
