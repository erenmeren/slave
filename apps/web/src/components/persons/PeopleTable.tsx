'use client'

import { useEffect, useMemo, useState } from 'react'
import type { PersonRow } from '../../server/persons'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { Segmented } from '../ui/Segmented'
import { SelectField } from '../ui/FormControls'

/** The default `--row-h` (`globals.css`: `40px` simple, `34px` developer -- M61 R3), and jsdom's
 *  own fallback -- no stylesheet is loaded there, so `getComputedStyle` reads back an empty
 *  string. */
const DEFAULT_ROW_HEIGHT = 40

/** `--row-h`, read once on mount (never during SSR, where `getComputedStyle` does not exist) so
 *  the virtualized row height matches whichever mode was actually pinned. Read once rather than
 *  on every render -- the virtualizer's own `estimateSize` does not need to track a mode flip
 *  mid-session, and a session that switches mode already gets a fresh row height on its next page
 *  load. */
function rowHeightFromCss(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h')
  const parsed = Number.parseFloat(raw)
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_ROW_HEIGHT : parsed
}

type PeopleFilter = 'all' | 'pool' | 'assigned' | 'released'

const FILTERS: readonly { readonly id: PeopleFilter; readonly label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'pool', label: 'In the pool' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'released', label: 'Released' },
]

const COLUMNS = '160px 140px 1fr 70px 1fr 40px'
const HEADER = ['Name', 'Persona', 'Departments', 'Skills', 'Where they work', ''] as const

/**
 * Workforce -> People (M58 R22): one row per PERSON, and the column that matters is WHERE THEY
 * WORK -- one chip per seat, or "in the pool".
 *
 * This is not `AllSlavesTable` renamed. That table is one row per SEAT and stays exactly where it
 * is, on the project Team page, because "who is on THIS project" is a different question (R27).
 * Here a person appears once however many projects they are on, which is the whole milestone made
 * visible in one list.
 *
 * The words come from `USER_PERSON_LABEL` through the read model's `stateLabel` (R28); the raw state
 * is on `data-person-state` and nowhere in the visible text.
 *
 * Filtering is LOCAL: the page already holds every row (an installation's people are tens, not
 * thousands), and a round trip per filter click would make the three segments feel like navigation.
 *
 * Fix round 1 (Task 9 review, Important 2): the root is `flex min-h-0 flex-1 flex-col` and
 * `people-rows` (the virtualized table's own wrapper) is `flex min-h-0 flex-1 flex-col` too --
 * without a real, bounded height at every level between the viewport and the virtualizer's
 * `ScrollArea`, `DataTable`'s own `min-h-0 flex-1` on that `ScrollArea` has nothing to bound
 * ITSELF against, and flexbox's default "grow to fit content" behaviour wins instead of the
 * scroll region actually scrolling. `WorkforceClient`'s `slaves` tab body and `ui/PageShell`'s
 * own root complete the chain above this component.
 */
export function PeopleTable({
  initial,
  departments,
  skills,
  skillHolders,
  onOpen,
}: {
  readonly initial: readonly PersonRow[]
  readonly departments: readonly { readonly companyTeamId: string; readonly name: string }[]
  readonly skills: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
  /** Who holds each skill, by skill id -- the read model computes it once so this filter costs no
   *  query. Absent means the skill filter offers nothing, which is what an installation with no
   *  skills should see. */
  readonly skillHolders?: Readonly<Record<string, readonly string[]>>
  readonly onOpen: (personId: string) => void
}): React.JSX.Element {
  const [filter, setFilter] = useState<PeopleFilter>('all')
  const [departmentId, setDepartmentId] = useState('')
  const [skillId, setSkillId] = useState('')
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT)

  useEffect(() => {
    setRowHeight(rowHeightFromCss())
  }, [])

  const rows = useMemo(
    () =>
      initial.filter((person) => {
        if (filter !== 'all' && person.state !== filter) return false
        if (departmentId !== '' && !person.departments.some((row) => row.companyTeamId === departmentId)) return false
        if (skillId !== '' && !(skillHolders?.[skillId] ?? []).includes(person.personId)) return false
        return true
      }),
    [initial, filter, departmentId, skillId, skillHolders],
  )

  /** One row, drawn by index -- `DataTable`'s `virtualized.render` (M61 R16). Kept as a function
   *  rather than inlined `rows.map` so the same JSX serves the virtualized body below; `last` is
   *  passed explicitly, same as before virtualization, since only the rows near the scrolled
   *  viewport ever mount and `:last-child` cannot see a position among nodes that are not there. */
  const renderRow = (index: number): React.ReactNode => {
    const person = rows[index]
    if (person === undefined) return null
    return (
      // M61 R12, Task 11: "a row click opens `SlavePanel` inside a `Sheet`". The whole row is the
      // target now, not only the `⋯` -- a simple-mode operator reading a list of people expects
      // the person to open when they click the person. `person-open` stays exactly where it was
      // and keeps doing the same thing: it is the KEYBOARD path (a real `<button>` with its own
      // label, one tab stop per row) and the discoverable affordance, and its click simply
      // bubbles into this handler, which asks for the same person twice with no second effect.
      // The row itself deliberately takes no `tabIndex`: a second focusable per row in a
      // virtualized list is a tab order nobody can hold in their head.
      <div
        key={person.personId}
        data-testid={`person-row-${person.personId}`}
        data-person-id={person.personId}
        data-person-state={person.state}
        data-released={person.releasedAt === null ? 'false' : 'true'}
        onClick={() => onOpen(person.personId)}
        className={`cursor-pointer ${person.releasedAt === null ? '' : 'opacity-60'}`.trim()}
      >
        <Row columns={COLUMNS} last={index === rows.length - 1}>
          <span data-testid="person-name" className="truncate text-[12.5px] font-semibold text-text-1">
            {person.name}
          </span>
          <span data-testid="person-persona" className="truncate text-[11.5px] text-text-2">
            {person.personaName ?? '—'}
          </span>
          <span data-testid="person-departments" className="truncate text-[11.5px] text-text-2">
            {person.departments.length === 0 ? '—' : person.departments.map((row) => row.name).join(', ')}
          </span>
          <span data-testid="person-skill-count" className="font-mono text-[11px] text-text-2">
            {person.skillCount}
          </span>
          <span className="flex flex-wrap gap-1">
            {person.seats.length === 0 ? (
              // The WORD from the label table, lower-cased for a sentence-shaped chip; the raw
              // state is on the row's `data-person-state` above, never printed here.
              <Chip testId="person-pool-chip" title={person.state}>
                {person.stateLabel.toLowerCase()}
              </Chip>
            ) : (
              person.seats.map((seat) => (
                <Chip key={seat.slaveId} testId="person-seat-chip" title={seat.workspaceId}>
                  {seat.projectName}
                </Chip>
              ))
            )}
          </span>
          <button
            type="button"
            data-testid="person-open"
            aria-label={`open ${person.name}`}
            className="text-text-3 hover:text-text-1"
            // `stopPropagation` (M61 Task 11): the whole row opens the person now, and without
            // this a click on `⋯` would ask for the same person twice -- harmless in the product
            // (the second call sets the same id) and a lie in a test that counts calls.
            onClick={(event) => {
              event.stopPropagation()
              onOpen(person.personId)
            }}
          >
            ⋯
          </button>
        </Row>
      </div>
    )
  }

  return (
    <div data-testid="people-table" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          options={FILTERS}
          value={filter}
          onChange={setFilter}
          ariaLabel="People"
          testIdPrefix="people-filter"
        />
        <SelectField
          label="Department"
          selectProps={{
            'aria-label': 'department',
            'data-testid': 'people-filter-department',
            value: departmentId,
            onChange: (event) => setDepartmentId(event.target.value),
          } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">every department</option>
          {departments.map((row) => (
            <option key={row.companyTeamId} value={row.companyTeamId}>{row.name}</option>
          ))}
        </SelectField>
        <SelectField
          label="Skill"
          selectProps={{
            'aria-label': 'skill',
            'data-testid': 'people-filter-skill',
            value: skillId,
            onChange: (event) => setSkillId(event.target.value),
          } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">every skill</option>
          {skills.map((row) => (
            <option key={row.skillId} value={row.skillId}>{`${row.name} (${row.providerName})`}</option>
          ))}
        </SelectField>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          testId="people-empty"
          message="Nobody matches. Change the filters, or make a new slave — they do not need a project."
        />
      ) : (
        <div data-testid="people-rows" className="flex min-h-0 flex-1 flex-col">
          <DataTable
            columns={COLUMNS}
            header={[...HEADER]}
            virtualized={{ rowHeight, count: rows.length, render: renderRow }}
          />
        </div>
      )}
    </div>
  )
}
