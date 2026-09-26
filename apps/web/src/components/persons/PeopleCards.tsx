'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import type { PeoplePageView, PersonCardRow, SkillCatalogueRow } from '../../server/persons'
import { byCardOrder, type CardSkillRow } from '../../lib/cardSkills'
import { peopleFilterParams, withPeopleFilter, type PeopleFilters, type PeopleState } from '../../lib/peopleFilters'
import { plural } from '../../lib/plural'
import { usePeopleFilters } from '../../hooks/usePeopleFilters'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { EmptyState } from '../ui/EmptyState'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { LoadingState } from '../ui/LoadingState'
import { ScrollArea } from '../ui/ScrollArea'
import { Segmented } from '../ui/Segmented'
import type { StatusTone } from '../ui/StatusPill'
import { WorkforceCard, WorkforceCardGrid, type SkillWriteOutcome } from '../workforce/WorkforceCard'
import { WorkforceFilterBar } from '../workforce/WorkforceFilterBar'

type Segment = 'all' | PeopleState

/** "Everyone" first, and the default (controller ruling F4): absent `?state=` is everybody. */
const SEGMENTS: readonly { readonly id: Segment; readonly label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'pool', label: 'In the pool' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'released', label: 'Released' },
]

const TONE: Record<PeopleState, StatusTone> = { assigned: 'working', pool: 'idle', released: 'paused' }

const peopleUrl = (params: URLSearchParams): string => {
  const query = params.toString()
  return query === '' ? '/api/persons' : `/api/persons?${query}`
}

/**
 * Patches ONE person's chips from a successful `scope: 'person'` write (controller ruling F2): such
 * a write touched only this person's own record, so the row it targets is the whole of what changed.
 *
 * A removal is two different acts by the chip it removed: an INHERITED chip was revoked, so it
 * stays, struck through (the person cannot restore what they cannot see -- M58 R23); the person's
 * OWN grant was cleared, so it goes. Everything else replaces the chip for that skill.
 */
function patchedPersonSkills(current: readonly CardSkillRow[], outcome: SkillWriteOutcome): readonly CardSkillRow[] {
  if (outcome.kind === 'refused') return current
  if (outcome.kind === 'removed') {
    return current.flatMap((skill) =>
      skill.skillId !== outcome.skillId ? [skill] : skill.state === 'persona' ? [{ ...skill, state: 'revoked' as const }] : [],
    )
  }
  return [...current.filter((skill) => skill.skillId !== outcome.skill.skillId), outcome.skill].toSorted(byCardOrder)
}

/**
 * Workforce -> People as CARDS (workforce cards §1/§2): one card per person, filtered, faceted and
 * PAGED on the server (`listPeoplePage`, `GET /api/persons`) the way the catalog is -- the pool
 * keeps up to three people per persona, so this list is several hundred long, and filtering that
 * plus facets in the browser was the wrong place.
 *
 * Seeded by the page's own read of the SAME URL (`/workforce/page.tsx` parses it with
 * `parsePeopleFilters`), so a shared `?specialty=` link opens on the cards its bar says it is
 * showing. A filter change is a new question and reads page one again; "Show more" APPENDS. The
 * latest request wins, never merely the last to arrive -- the catalog's `latest` sequence.
 *
 * Nothing ELSE ever drops a loaded page (controller ruling F2). A person-scope card write patches
 * that one card in place; a persona-scope write (it reaches every person hired from that persona),
 * a refused write, a change made in the person sheet (`refreshKey`) and a new `initial` from the
 * server (a `?slave=` open re-renders the page) all re-read the SAME range -- page one, then the
 * cursor chain the "Show more" clicks already walked -- and swap it in only once it is whole.
 *
 * The person header (spec §2): avatar, name and division from the card, and WHERE THEY WORK in the
 * header slot -- one chip per project seat, or the pool / released word. Departments are a filter
 * here, no longer drawn on the card.
 *
 * The handles every People gate drives are kept on the card: `person-row-<id>` with its
 * `data-person-*` attributes, `person-open`, `person-pool-chip`, `person-seat-chip`, and
 * `people-rows` with a scrolling region inside it.
 */
export function PeopleCards({
  initial,
  departments,
  skillCatalogue,
  taxonomy,
  refreshKey = 0,
  onOpen,
}: {
  readonly initial: PeoplePageView
  readonly departments: readonly { readonly companyTeamId: string; readonly name: string }[]
  readonly skillCatalogue: readonly SkillCatalogueRow[]
  readonly taxonomy: readonly CapabilityRecord[]
  /** Moves when the person sheet changed somebody (a skill, a seat): re-read what is loaded. */
  readonly refreshKey?: number
  readonly onOpen: (personId: string) => void
}): React.JSX.Element {
  const { filters, setFilters } = usePeopleFilters()
  const [page, setPage] = useState<PeoplePageView>(initial)
  const [stale, setStale] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Read by the effects below, which must not re-run merely because the filters or the row count
  // moved -- each has its own trigger.
  const current = useRef({ filters, loaded: page.rows.length })
  current.current = { filters, loaded: page.rows.length }

  const latest = useRef(0)
  const reload = useCallback((next: PeopleFilters, cursor?: string): void => {
    const params = peopleFilterParams(next)
    // A position in an answer, not a filter: never written into the address bar.
    if (cursor !== undefined) params.set('cursor', cursor)
    const id = latest.current + 1
    latest.current = id
    setRefreshing(true)
    const failed = (): void => {
      if (id !== latest.current) return
      setRefreshing(false)
      setStale(true)
    }
    void fetch(peopleUrl(params))
      .then(async (response) => (response.ok ? ((await response.json()) as PeoplePageView) : null))
      .then((view) => {
        if (id !== latest.current) return
        if (view === null) {
          failed()
          return
        }
        setRefreshing(false)
        setStale(false)
        setPage((shown) => (cursor === undefined ? view : { ...view, rows: [...shown.rows, ...view.rows] }))
      })
      .catch(failed)
  }, [])

  /**
   * Re-reads the range already on screen (F2): page one, then the cursor chain onward until at
   * least `keep` rows are back or the pages run out -- the catalog's `resyncAfterRefusal`, for every
   * People trigger that must not drop a "Show more" page. Swapped in whole, so no card unmounts
   * part-way; on a failure (a non-OK answer, a rejected `fetch`, a body that will not parse) the
   * loaded pages stay exactly as they were and `people-stale` says so, with nothing rejecting
   * unhandled. Guarded by the same `latest` sequence as `reload`, so a newer filter wins.
   */
  const resync = useCallback((next: PeopleFilters, keep: number): void => {
    const id = latest.current + 1
    latest.current = id
    setRefreshing(true)
    const fetchPage = async (cursor?: string): Promise<PeoplePageView | null> => {
      const params = peopleFilterParams(next)
      if (cursor !== undefined) params.set('cursor', cursor)
      try {
        const response = await fetch(peopleUrl(params))
        return response.ok ? ((await response.json()) as PeoplePageView) : null
      } catch {
        return null
      }
    }
    const failed = (): void => {
      if (id !== latest.current) return
      setRefreshing(false)
      setStale(true)
    }
    void (async (): Promise<void> => {
      let view = await fetchPage()
      if (view === null) {
        failed()
        return
      }
      if (id !== latest.current) return
      let rows = view.rows
      while (rows.length < keep && view.nextCursor !== null) {
        const more = await fetchPage(view.nextCursor)
        if (more === null) {
          failed()
          return
        }
        if (id !== latest.current) return
        view = more
        rows = [...rows, ...more.rows]
      }
      if (id !== latest.current) return
      setRefreshing(false)
      setStale(false)
      setPage({ ...view, rows })
    })()
  }, [])

  // A NEW `initial` means the server re-rendered the page -- a `router.refresh()` after a new slave,
  // or `useSelectedId`'s `router.replace` opening/closing a person. It is page one of the same URL,
  // so it is taken as-is only when page one is all that is loaded; past that it would drop the
  // pages after it (F2), and the loaded range is re-read instead.
  const seeded = useRef(initial)
  useEffect(() => {
    if (seeded.current === initial) return
    seeded.current = initial
    if (current.current.loaded <= initial.rows.length) {
      setPage(initial)
      setStale(false)
      return
    }
    resync(current.current.filters, current.current.loaded)
  }, [initial, resync])

  // The first pass does not fetch: `initial` IS that answer (the catalog's rule).
  const firstPass = useRef(true)
  useEffect(() => {
    if (firstPass.current) {
      firstPass.current = false
      return
    }
    reload(filters)
  }, [filters, reload])

  const shownKey = useRef(refreshKey)
  useEffect(() => {
    if (shownKey.current === refreshKey) return
    shownKey.current = refreshKey
    resync(current.current.filters, current.current.loaded)
  }, [refreshKey, resync])

  const set = (key: Parameters<typeof withPeopleFilter>[1], value: string): void => setFilters(withPeopleFilter(filters, key, value))
  const filtered = Object.keys(filters).length > 0

  const onChanged = (personId: string, outcome: SkillWriteOutcome): void => {
    // A refusal leaves this row's cached skills untrustworthy; a persona-scope write changed every
    // person hired from that persona, which one row's patch cannot represent. Both re-read.
    if (outcome.kind === 'refused' || outcome.scope === 'persona') {
      resync(filters, page.rows.length)
      return
    }
    setPage((shown) => ({
      ...shown,
      rows: shown.rows.map((row) => (row.personId === personId ? { ...row, skills: patchedPersonSkills(row.skills, outcome) } : row)),
    }))
  }

  const card = (person: PersonCardRow): React.JSX.Element => (
    <WorkforceCard
      key={person.personId}
      variant="person"
      testId={`person-row-${person.personId}`}
      data={{
        'data-person-id': person.personId,
        // The raw state is an attribute; the WORD is the chip below (R28).
        'data-person-state': person.state,
        'data-released': person.releasedAt === null ? 'false' : 'true',
      }}
      dimmed={person.releasedAt !== null}
      tone={TONE[person.state]}
      name={person.name}
      subtitle={person.personaName}
      division={person.division}
      capabilityKeys={person.capabilities}
      taxonomy={taxonomy}
      skills={person.skills}
      workflow={person.workflowPreview}
      target={{ kind: 'person', personId: person.personId, personaId: person.personaId, personaName: person.personaName }}
      catalogue={skillCatalogue}
      openTestId="person-open"
      onOpen={() => onOpen(person.personId)}
      onChanged={(outcome) => onChanged(person.personId, outcome)}
      header={
        <span className="flex min-w-0 flex-wrap gap-1">
          {person.seats.length === 0 ? (
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
      }
    />
  )

  return (
    <div data-testid="people-table" className="flex min-h-0 flex-1 flex-col gap-3">
      <WorkforceFilterBar
        testIdPrefix="people"
        query={filters.q ?? ''}
        onQuery={(value) => set('q', value)}
        domains={page.facets.domains}
        specialty={filters.specialty}
        onSpecialty={(value) => set('specialty', value)}
        divisions={page.facets.divisions}
        division={filters.division}
        onDivision={(value) => set('division', value)}
        skillOptions={skillCatalogue.map((row) => ({ value: row.skillId, label: `${row.name} (${row.providerName})` }))}
        skill={filters.skillId}
        onSkill={(value) => set('skillId', value)}
        noSkills={filters.noSkills === true}
        onNoSkills={(next) => set('noSkills', next ? 'true' : '')}
        filtered={filtered}
        onClear={() => setFilters({})}
        searchPlaceholder="name, persona, capability, skill"
      >
        <Segmented
          options={SEGMENTS}
          value={filters.state ?? 'all'}
          onChange={(next) => set('state', next === 'all' ? '' : next)}
          ariaLabel="People"
          testIdPrefix="people-filter"
        />
        <label className="flex flex-col gap-1">
          <FieldLabel>Department</FieldLabel>
          <select
            data-testid="people-filter-department"
            aria-label="department"
            value={filters.department ?? ''}
            onChange={(event) => set('department', event.target.value)}
            className={`w-44 ${INPUT_SHELL}`}
          >
            <option value="">every department</option>
            {departments.map((row) => (
              <option key={row.companyTeamId} value={row.companyTeamId}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
      </WorkforceFilterBar>
      {stale && (
        <Alert variant="error" testId="people-stale">
          could not refresh the people — showing the last answer.
        </Alert>
      )}
      <span data-testid="people-count" className="text-xs text-text-3">
        {page.rows.length >= page.total
          ? plural(page.total, 'slave')
          : `showing ${String(page.rows.length)} of ${plural(page.total, 'slave')}`}
      </span>
      {refreshing && <LoadingState testId="people-loading" message="reading the people…" />}
      {page.rows.length === 0 ? (
        <EmptyState
          testId="people-empty"
          message="Nobody matches. Change the filters, or make a new slave — they do not need a project."
          action={
            filtered ? (
              <Button variant="ghost" size="sm" data-testid="people-empty-clear" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div data-testid="people-rows" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="flex flex-col gap-3">
            <WorkforceCardGrid>{page.rows.map(card)}</WorkforceCardGrid>
            {page.nextCursor !== null && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="people-more"
                disabled={refreshing}
                onClick={() => {
                  const cursor = page.nextCursor
                  if (cursor !== null) reload(filters, cursor)
                }}
              >
                Show more
              </Button>
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
