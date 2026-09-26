'use client'

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
  CATALOG_SOURCES,
  type CatalogActivation,
  type CatalogSource,
} from '../../lib/catalogFilters'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { CHIP_BUTTON, WorkforceFilterBar, chipTone } from './WorkforceFilterBar'

/**
 * ONE vocabulary (M46 fix round 1): the chip says exactly the word the catalog ROW says for the same
 * fact -- `imported` and `local`, `active` and `inactive` -- because a filter labelled `Made here`
 * beside rows labelled `local` is two names for one thing, and a person has to learn which is which
 * before they can use either. `data-source` and `data-activation` still carry the values for a gate.
 *
 * `data-activation` and NOT `data-active` (final wave, minor 7): the catalog ROW beside these chips
 * carries `data-active` for its own boolean, so one page had `[data-active="true"]` meaning both "a
 * template that is hirable" and "the chip that filters for one". The chip now carries the WORD, the
 * way its `data-source` sibling does, and the two selectors cannot collide.
 */
const SOURCE_LABEL: Record<CatalogSource, string> = {
  imported: 'imported',
  local: 'local',
}

type FilterKey =
  | 'q'
  | 'division'
  | 'capability'
  | 'source'
  | 'skill'
  | 'active'
  | 'duplicates'
  | 'specialty'
  | 'noSkills'

const asSource = (value: string): CatalogSource | undefined => CATALOG_SOURCES.find((member) => member === value)
const asFacet = (value: string): DuplicateFacet | undefined => DUPLICATE_FACETS.find((member) => member === value)

/**
 * One filter changed, the other eight carried through -- and `''` means "drop this one". Written
 * out key by key instead of a computed-key spread: under `exactOptionalPropertyTypes` an optional
 * key that is PRESENT and `undefined` is a different type from an absent one.
 */
function withFilter(filters: WorkforceCatalogFilters, key: FilterKey, value: string): WorkforceCatalogFilters {
  const q = key === 'q' ? value : filters.q
  const division = key === 'division' ? value : filters.division
  const capability = key === 'capability' ? value : filters.capability
  const source = key === 'source' ? asSource(value) : filters.source
  const skill = key === 'skill' ? value : filters.skill
  const active = key === 'active' ? (value === '' ? undefined : value === 'active') : filters.active
  const duplicates = key === 'duplicates' ? asFacet(value) : filters.duplicates
  const specialty = key === 'specialty' ? value : filters.specialty
  const noSkills = key === 'noSkills' ? value === 'true' : filters.noSkills
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(capability !== undefined && capability !== '' ? { capability } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(skill !== undefined && skill !== '' ? { skill } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(duplicates !== undefined ? { duplicates } : {}),
    ...(specialty !== undefined && specialty !== '' ? { specialty } : {}),
    ...(noSkills === true ? { noSkills } : {}),
  }
}

/**
 * The catalog's filter row (M46 R6, nine controls since workforce cards): the shared
 * {@link WorkforceFilterBar} plus the four controls only a persona list has -- source, activation,
 * capability and duplicates. Every testid a gate drives (`catalog-search`, `catalog-*-select`,
 * `catalog-source-chip-*`, `catalog-active-chip-*`, `catalog-clear-filters`) is unchanged.
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
   *  word. Defaults to empty, where every key prints as itself. */
  readonly taxonomy?: readonly CapabilityRecord[]
  readonly onChange: (next: WorkforceCatalogFilters) => void
}): React.JSX.Element {
  const set = (key: FilterKey, value: string): void => onChange(withFilter(filters, key, value))

  return (
    <WorkforceFilterBar
      testIdPrefix="catalog"
      query={filters.q ?? ''}
      onQuery={(value) => set('q', value)}
      domains={facets.domains}
      specialty={filters.specialty}
      onSpecialty={(value) => set('specialty', value)}
      divisions={facets.divisions}
      division={filters.division}
      onDivision={(value) => set('division', value)}
      skillOptions={facets.skills.map((one) => ({ value: one, label: one }))}
      skill={filters.skill}
      onSkill={(value) => set('skill', value)}
      noSkills={filters.noSkills === true}
      onNoSkills={(next) => set('noSkills', next ? 'true' : '')}
      filtered={Object.keys(filters).length > 0}
      onClear={() => onChange({})}
      searchPlaceholder="name, summary, capability, skill"
    >
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            data-testid={`catalog-source-chip-${source}`}
            data-source={source}
            aria-pressed={filters.source === source}
            onClick={() => set('source', filters.source === source ? '' : source)}
            className={`${CHIP_BUTTON} ${chipTone(filters.source === source)}`}
          >
            {SOURCE_LABEL[source]}
          </button>
        ))}
      </div>
      {/* M55 R6: clicking the pressed activation chip clears it -- "either" is a real third state. */}
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_ACTIVATIONS.map((activation: CatalogActivation) => {
          const pressed = filters.active === (activation === 'active')
          return (
            <button
              key={activation}
              type="button"
              data-testid={`catalog-active-chip-${activation}`}
              data-activation={activation}
              aria-pressed={pressed}
              onClick={() => set('active', pressed ? '' : activation)}
              className={`${CHIP_BUTTON} ${chipTone(pressed)}`}
            >
              {ACTIVATION_LABEL[activation]}
            </button>
          )
        })}
      </div>
      {/* M55 R3: the OPTIONS are taxonomy keys and the TEXT is their labels (`docs/ia.md` rule 3). */}
      <label className="flex flex-col gap-1">
        <FieldLabel>Capability</FieldLabel>
        <select
          data-testid="catalog-capability-select"
          aria-label="Capability"
          value={filters.capability ?? ''}
          onChange={(event) => set('capability', event.target.value)}
          className={`w-44 ${INPUT_SHELL}`}
        >
          <option value="">any</option>
          {facets.capabilities.map((key) => (
            <option key={key} value={key}>
              {capabilityLabel(key, taxonomy)}
            </option>
          ))}
        </select>
      </label>
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
    </WorkforceFilterBar>
  )
}
