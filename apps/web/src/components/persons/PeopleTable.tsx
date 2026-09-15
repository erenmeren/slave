'use client'

import { useMemo, useState } from 'react'
import type { PersonRow } from '../../server/persons'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { Segmented } from '../ui/Segmented'
import { SelectField } from '../ui/FormControls'

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

  return (
    <div className="flex flex-col gap-3">
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
        <div data-testid="people-rows">
          <DataTable columns={COLUMNS} header={[...HEADER]}>
            {rows.map((person, index) => (
              <div
                key={person.personId}
                data-testid={`person-row-${person.personId}`}
                data-person-id={person.personId}
                data-person-state={person.state}
                data-released={person.releasedAt === null ? 'false' : 'true'}
                className={person.releasedAt === null ? undefined : 'opacity-60'}
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
                    onClick={() => onOpen(person.personId)}
                  >
                    ⋯
                  </button>
                </Row>
              </div>
            ))}
          </DataTable>
        </div>
      )}
    </div>
  )
}
