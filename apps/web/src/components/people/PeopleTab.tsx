'use client'

import { useEffect, useState } from 'react'
import { LayoutGridIcon, ListIcon, UserPlusIcon } from 'lucide-react'
import type { PeoplePage, PersonCard as PersonCardRow, SkillUse } from '@slave-of-ai/control'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DivisionChip, PersonAvatar, WorkingBadge } from './bits'
import { FilterSelect, FilterToggle, ListFoot, SearchBox, divisionOptions } from './ListBits'
import { usePagedList } from './usePagedList'
import { EMPTY_PEOPLE_QUERY, activeFilterCount, divisionWord, peopleQueryString, rosterLine, skillSourceWord, type PeopleQuery } from './words'

/** Where the grid-or-list choice is remembered, per browser. */
const VIEW_KEY = 'people-view'
type ViewMode = 'grid' | 'list'

function Chips({ person }: { readonly person: PersonCardRow }): React.JSX.Element {
  const roster = rosterLine(person.projects)
  return (
    <div className="flex flex-wrap gap-1">
      <DivisionChip division={person.division} />
      <Badge variant={person.skillCount === 0 ? 'outline' : 'secondary'} className={cn('font-normal', person.skillCount === 0 && 'text-muted-foreground')}>
        {person.skillCount === 0 ? 'No skills' : plural(person.skillCount, 'skill')}
      </Badge>
      {person.ownInstructions && (
        <Badge variant="outline" className="font-normal" title="They have instructions of their own, which replace the persona's profile.">
          Own instructions
        </Badge>
      )}
      {roster !== null && (
        <Badge className="max-w-full bg-info-muted font-normal text-info-foreground" title={person.projects.map((project) => project.name).join(', ')}>
          <span className="truncate">{roster}</span>
        </Badge>
      )}
    </div>
  )
}

/** One person as a card: every card the same size, whoever it is. */
function PersonCardView({ person, onOpen }: { readonly person: PersonCardRow; readonly onOpen: () => void }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="person-card"
        className="flex h-full w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <div className="flex w-full items-start gap-3">
          <PersonAvatar name={person.name} working={person.working} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{person.name}</p>
            <p className="truncate text-xs text-muted-foreground">{person.personaName ?? 'No persona'}</p>
          </div>
          {person.working && <WorkingBadge />}
        </div>
        <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">{person.description !== '' ? person.description : person.personaName === null ? 'Made from a name alone. Open them to write their instructions.' : 'Their persona has no description.'}</p>
        <div className="mt-auto w-full">
          <Chips person={person} />
        </div>
      </button>
    </li>
  )
}

function PeopleTable({ people, onOpen }: { readonly people: readonly PersonCardRow[]; readonly onOpen: (personId: string) => void }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Who</TableHead>
            <TableHead className="hidden md:table-cell">Division</TableHead>
            <TableHead className="text-right">Skills</TableHead>
            <TableHead className="hidden lg:table-cell">Projects</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map((person) => (
            <TableRow key={person.id} data-testid="person-row" className="cursor-pointer" onClick={() => onOpen(person.id)}>
              <TableCell className="max-w-[360px]">
                <div className="flex min-w-0 items-center gap-3">
                  <PersonAvatar name={person.name} working={person.working} className="size-8" />
                  <div className="min-w-0">
                    <button type="button" className="block max-w-full truncate text-left font-medium hover:underline" onClick={() => onOpen(person.id)}>
                      {person.name}
                    </button>
                    <p className="truncate text-xs text-muted-foreground">{person.personaName ?? 'No persona'}</p>
                  </div>
                  {person.working && <WorkingBadge />}
                </div>
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{person.division === null ? '—' : divisionWord(person.division)}</TableCell>
              <TableCell className={cn('text-right tabular-nums', person.skillCount === 0 && 'text-muted-foreground')}>{person.skillCount}</TableCell>
              <TableCell className="hidden max-w-[260px] truncate text-sm text-muted-foreground lg:table-cell">{person.projects.length === 0 ? '—' : person.projects.map((project) => project.name).join(', ')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * Everybody a lead can be given, as cards or a dense list: searched by name, role and what they
 * do; filtered by division, by skill, by being on a project's helper list and by having no skills.
 * Read a page at a time -- there are hundreds.
 */
export function PeopleTab({
  initial,
  initialQuery,
  query,
  onQuery,
  skills,
  personaName,
  reloadKey,
  onOpen,
  onNew,
}: {
  readonly initial: PeoplePage | null
  /** The query string `initial` was read for. */
  readonly initialQuery: string
  readonly query: PeopleQuery
  readonly onQuery: (query: PeopleQuery) => void
  readonly skills: readonly SkillUse[] | null
  /** The name of the persona the list is narrowed to, when it is. */
  readonly personaName: string | null
  readonly reloadKey: number
  readonly onOpen: (personId: string) => void
  readonly onNew: () => void
}): React.JSX.Element {
  const [view, setView] = useState<ViewMode>('grid')
  // A browser that refuses storage (private mode, a blocked site) still gets both views; it only
  // forgets which one was chosen.
  useEffect((): void => {
    try {
      if (window.localStorage.getItem(VIEW_KEY) === 'list') setView('list')
    } catch {
      // Nothing remembered.
    }
  }, [])
  const choose = (next: ViewMode): void => {
    setView(next)
    try {
      window.localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Not remembered.
    }
  }

  const { rows, page, loading, error, more } = usePagedList<PeoplePage, PersonCardRow>('/api/people', peopleQueryString(query), (data) => data.people, { initial, initialQuery, reloadKey })
  const filters = activeFilterCount(query)
  const skillOptions = (skills ?? []).filter((skill) => skill.personCount > 0).map((skill) => ({ value: skill.id, label: skill.name, count: skill.personCount, detail: skillSourceWord(skill.providerName) }))

  if (page !== null && page.all === 0) {
    return (
      <Card className="py-12 text-center" data-testid="people-empty">
        <CardHeader>
          <CardTitle className="text-base">Nobody here yet.</CardTitle>
          <CardDescription>Create your first person from a persona, then put them on a project&apos;s helper list so its lead can call them.</CardDescription>
        </CardHeader>
        <Button className="mx-auto" onClick={onNew}>
          <UserPlusIcon />
          New person
        </Button>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="people-tab">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={query.q} onChange={(q) => onQuery({ ...query, q })} placeholder="Search by name, role or what they do…" label="Search people" testId="people-search" />
        <FilterSelect all="All divisions" value={query.division} options={divisionOptions(page?.divisions ?? [])} onChange={(division) => onQuery({ ...query, division })} testId="people-division" searchPlaceholder="Search divisions…" />
        <FilterSelect all="Any skill" value={query.skillId} options={skillOptions} onChange={(skillId) => onQuery({ ...query, skillId })} testId="people-skill" searchPlaceholder="Search skills…" />
        <FilterToggle on={query.onRoster} onChange={(onRoster) => onQuery({ ...query, onRoster })} testId="people-on-roster">
          On a project
        </FilterToggle>
        <FilterToggle on={query.noSkills} onChange={(noSkills) => onQuery({ ...query, noSkills, ...(noSkills ? { skillId: null } : {}) })} testId="people-no-skills">
          No skills
        </FilterToggle>
        <div className="ml-auto flex items-center rounded-md border p-0.5" role="group" aria-label="How the list is drawn">
          <Button size="icon-sm" variant={view === 'grid' ? 'secondary' : 'ghost'} aria-label="Cards" aria-pressed={view === 'grid'} className="size-7" onClick={() => choose('grid')} data-testid="people-view-grid">
            <LayoutGridIcon />
          </Button>
          <Button size="icon-sm" variant={view === 'list' ? 'secondary' : 'ghost'} aria-label="List" aria-pressed={view === 'list'} className="size-7" onClick={() => choose('list')} data-testid="people-view-list">
            <ListIcon />
          </Button>
        </div>
      </div>

      {(filters > 0 || query.templateId !== null) && page !== null && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="people-filter-line">
          <span className="tabular-nums">
            {page.total} of {page.all} people
          </span>
          {query.templateId !== null && (
            <Badge variant="secondary" className="font-normal">
              Made from {personaName ?? 'one persona'}
            </Badge>
          )}
          <Button size="xs" variant="ghost" onClick={() => onQuery(EMPTY_PEOPLE_QUERY)} data-testid="people-clear">
            Clear filters
          </Button>
        </div>
      )}

      {error !== null && (
        <Alert data-testid="people-error">
          <AlertDescription>Could not load people. {error}</AlertDescription>
        </Alert>
      )}

      {page === null ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center" data-testid="people-none">
          <p className="text-sm text-muted-foreground">Nobody matches. Try fewer words, or clear the filters.</p>
          <Button variant="outline" size="sm" onClick={() => onQuery(EMPTY_PEOPLE_QUERY)}>
            Clear filters
          </Button>
        </div>
      ) : view === 'grid' ? (
        <ul className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', loading && 'opacity-70')} data-testid="people-grid">
          {rows.map((person) => (
            <PersonCardView key={person.id} person={person} onOpen={() => onOpen(person.id)} />
          ))}
        </ul>
      ) : (
        <PeopleTable people={rows} onOpen={onOpen} />
      )}
      {page !== null && <ListFoot shown={rows.length} total={page.total} noun="people" loading={loading} onMore={() => void more()} />}
    </div>
  )
}
