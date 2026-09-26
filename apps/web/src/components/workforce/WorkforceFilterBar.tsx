'use client'

import { useEffect, useRef, useState } from 'react'
import type { CapabilityDomainFacet } from '@slave-of-ai/control'
import { domainLabel } from '@slave-of-ai/domain'
import { CATALOG_SEARCH_DEBOUNCE_MS } from '../../lib/catalogFilters'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'

/** How many Specialty chips show before the rest fold behind `+N` (spec §1: "the first ~8"). */
export const SPECIALTY_CHIPS = 8

/** The two-state chip every filter chip on this page wears -- the catalog's source and activation
 *  chips, the Specialty chips and "No skills" -- so one pressed state looks like one thing. */
export const CHIP_BUTTON = 'rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors'

/** The two colours a {@link CHIP_BUTTON} wears -- pressed (filled) or not -- read by every chip on
 *  this bar and by `CatalogFilterBar`'s own source/activation chips, so both sides of one boolean
 *  are spelled once. */
export function chipTone(pressed: boolean): string {
  return pressed ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
}

/**
 * The Workforce filter bar (workforce cards §1): ONE component for the Catalog and People tabs.
 *
 * It owns the controls both tabs share -- search, Specialty chips, Division, Skill, "No skills",
 * Clear -- and takes each tab's own controls as `children` (the catalog's source, activation,
 * capability and duplicates; People's segments and department). It owns no filter STATE: every
 * control reports one change and the caller folds it into its own filters and its own URL, which is
 * what keeps a catalog `skill` (a recommended-skill word) and a People `skillId` (a linked skill)
 * two different params on one bar.
 *
 * The search box keeps its own text and pushes it up after {@link CATALOG_SEARCH_DEBOUNCE_MS} (M55
 * R3), through a ref refreshed after every render -- so a chip clicked during the wait is not
 * reverted when the push lands carrying older filters (`gate:m46-workforce-catalog` stage 2c found
 * exactly that bug once).
 *
 * Specialty is single-select: a click chooses, a click on the pressed chip clears. A specialty that
 * is not among the chips shown -- folded behind `+N`, or unknown because a shared link outlived its
 * domain -- is still drawn, pressed, so the filter that is emptying the list can be seen and undone.
 */
export function WorkforceFilterBar({
  testIdPrefix,
  query,
  onQuery,
  domains,
  specialty,
  onSpecialty,
  divisions,
  division,
  onDivision,
  skillOptions,
  skill,
  onSkill,
  noSkills,
  onNoSkills,
  filtered,
  onClear,
  searchPlaceholder,
  children,
}: {
  readonly testIdPrefix: 'catalog' | 'people'
  readonly query: string
  readonly onQuery: (next: string) => void
  readonly domains: readonly CapabilityDomainFacet[]
  readonly specialty: string | undefined
  /** `''` clears. */
  readonly onSpecialty: (next: string) => void
  readonly divisions: readonly string[]
  readonly division: string | undefined
  readonly onDivision: (next: string) => void
  readonly skillOptions: readonly { readonly value: string; readonly label: string }[]
  readonly skill: string | undefined
  readonly onSkill: (next: string) => void
  readonly noSkills: boolean
  readonly onNoSkills: (next: boolean) => void
  readonly filtered: boolean
  readonly onClear: () => void
  readonly searchPlaceholder: string
  readonly children?: React.ReactNode
}): React.JSX.Element {
  const p = testIdPrefix
  const [text, setText] = useState(query)
  // Re-seeded when the query changes from OUTSIDE -- Clear filters, or a link opened with a `?q=`.
  useEffect(() => {
    setText(query)
  }, [query])
  const push = useRef(onQuery)
  useEffect(() => {
    push.current = onQuery
  })
  useEffect(() => {
    if (text === query) return
    const timer = setTimeout(() => push.current(text), CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `query` is read to decide whether there is anything to push at all; re-arming the wait when
    // it changes would restart it on the very push that ended it (CatalogFilterBar's original rule).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? domains : domains.slice(0, SPECIALTY_CHIPS)
  const pinned: readonly CapabilityDomainFacet[] =
    specialty === undefined || shown.some((facet) => facet.domain === specialty)
      ? []
      : [domains.find((facet) => facet.domain === specialty) ?? { domain: specialty, count: 0 }]

  const specialtyChip = (facet: CapabilityDomainFacet): React.JSX.Element => {
    const pressed = specialty === facet.domain
    return (
      <button
        key={facet.domain}
        type="button"
        data-testid={`${p}-specialty-${facet.domain}`}
        data-count={String(facet.count)}
        aria-pressed={pressed}
        onClick={() => onSpecialty(pressed ? '' : facet.domain)}
        className={`${CHIP_BUTTON} ${chipTone(pressed)}`}
      >
        {domainLabel(facet.domain)}
        <span className="ml-1 text-text-3">{facet.count}</span>
      </button>
    )
  }

  const select = (
    key: 'division' | 'skill',
    label: string,
    value: string | undefined,
    options: readonly { readonly value: string; readonly label: string }[],
    onPick: (next: string) => void,
  ): React.JSX.Element => (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        data-testid={`${p}-${key}-select`}
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onPick(event.target.value)}
        className={`w-44 ${INPUT_SHELL}`}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div data-testid={`${p}-filters`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <FieldLabel>Search</FieldLabel>
          <input
            data-testid={`${p}-search`}
            aria-label={p === 'catalog' ? 'search the catalog' : 'search people'}
            value={text}
            placeholder={searchPlaceholder}
            onChange={(event) => setText(event.target.value)}
            className={`w-72 max-w-full ${INPUT_SHELL}`}
          />
        </label>
        {select('division', 'Division', division, divisions.map((one) => ({ value: one, label: one })), onDivision)}
        {select('skill', 'Skill', skill, skillOptions, onSkill)}
        <div className="flex items-center pb-1">
          <button
            type="button"
            data-testid={`${p}-no-skills`}
            aria-pressed={noSkills}
            onClick={() => onNoSkills(!noSkills)}
            className={`${CHIP_BUTTON} ${chipTone(noSkills)}`}
          >
            No skills
          </button>
        </div>
        {children}
        {filtered && (
          <Button variant="ghost" size="sm" data-testid={`${p}-clear-filters`} onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
      {(shown.length > 0 || pinned.length > 0) && (
        <div data-testid={`${p}-specialties`} role="group" aria-label="Specialty" className="flex flex-wrap items-center gap-1">
          {shown.map(specialtyChip)}
          {pinned.map(specialtyChip)}
          {domains.length > SPECIALTY_CHIPS && (
            <button
              type="button"
              data-testid={`${p}-specialty-more`}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] text-text-3 hover:text-text-2"
            >
              {expanded ? 'fewer' : `+${String(domains.length - SPECIALTY_CHIPS)}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
