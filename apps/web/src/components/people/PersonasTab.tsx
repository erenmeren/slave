'use client'

import { PlusIcon } from 'lucide-react'
import type { PersonaCard, PersonaPage } from '@slave-of-ai/control'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DivisionChip, PersonaAvatar } from './bits'
import { FilterSelect, ListFoot, SearchBox, divisionOptions } from './ListBits'
import { usePagedList } from './usePagedList'
import { EMPTY_PERSONA_QUERY, personaQueryString, roleLine, type PersonaQuery } from './words'

function PersonaCardView({ persona, onOpen }: { readonly persona: PersonaCard; readonly onOpen: () => void }): React.JSX.Element {
  const role = roleLine(persona.role, persona.division)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="persona-card"
        data-active={persona.active}
        className="flex h-full w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <div className="flex w-full items-center gap-3">
          <PersonaAvatar name={persona.name} division={persona.division} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{persona.name}</p>
            {role !== null && <p className="truncate text-xs text-muted-foreground">{role}</p>}
          </div>
          {!persona.active && <Badge className="bg-muted text-muted-foreground">Inactive</Badge>}
        </div>
        <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">{persona.description !== '' ? persona.description : 'No description yet.'}</p>
        <div className="mt-auto flex w-full flex-wrap gap-1">
          <DivisionChip division={persona.division} />
          <Badge variant={persona.skillCount === 0 ? 'outline' : 'secondary'} className={cn('font-normal', persona.skillCount === 0 && 'text-muted-foreground')}>
            {persona.skillCount === 0 ? 'No default skills' : plural(persona.skillCount, 'default skill')}
          </Badge>
          <Badge variant="outline" className={cn('font-normal', persona.personCount === 0 && 'text-muted-foreground')}>
            {persona.personCount === 0 ? 'Nobody yet' : plural(persona.personCount, 'person', 'people')}
          </Badge>
          {persona.customised && <Badge className="bg-info-muted font-normal text-info-foreground">Edited here</Badge>}
          {persona.handMade && (
            <Badge variant="outline" className="font-normal">
              Made here
            </Badge>
          )}
        </div>
      </button>
    </li>
  )
}

const STATUS_OPTIONS: readonly { readonly value: boolean | null; readonly label: string; readonly id: string }[] = [
  { value: null, label: 'All', id: 'all' },
  { value: true, label: 'Active', id: 'active' },
  { value: false, label: 'Inactive', id: 'inactive' },
]

/**
 * The catalogue of personas -- the kinds of specialist people are made from -- searched and
 * filtered by division and by being active. A card opens the persona to read and edit it.
 */
export function PersonasTab({ query, onQuery, reloadKey, onOpen, onNew }: { readonly query: PersonaQuery; readonly onQuery: (query: PersonaQuery) => void; readonly reloadKey: number; readonly onOpen: (templateId: string) => void; readonly onNew: () => void }): React.JSX.Element {
  const { rows, page, loading, error, more } = usePagedList<PersonaPage, PersonaCard>('/api/personas', personaQueryString(query), (data) => data.personas, { reloadKey })

  if (page !== null && page.all === 0) {
    return (
      <Card className="py-12 text-center" data-testid="personas-empty">
        <CardHeader>
          <CardTitle className="text-base">No personas yet.</CardTitle>
          <CardDescription>
            Import a catalogue from the command line (<code className="font-mono">import-catalog</code>), or write your first persona by hand.
          </CardDescription>
        </CardHeader>
        <Button className="mx-auto" onClick={onNew}>
          <PlusIcon />
          New persona
        </Button>
      </Card>
    )
  }

  const filtered = query.q.trim() !== '' || query.division !== null || query.active !== null
  return (
    <div className="flex flex-col gap-4" data-testid="personas-tab">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={query.q} onChange={(q) => onQuery({ ...query, q })} placeholder="Search by name, role or what they do…" label="Search personas" testId="personas-search" />
        <FilterSelect all="All divisions" value={query.division} options={divisionOptions(page?.divisions ?? [])} onChange={(division) => onQuery({ ...query, division })} testId="personas-division" searchPlaceholder="Search divisions…" />
        <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="Active or not">
          {STATUS_OPTIONS.map((option) => (
            <Button key={option.id} size="sm" variant={query.active === option.value ? 'secondary' : 'ghost'} aria-pressed={query.active === option.value} className="h-7 font-normal" onClick={() => onQuery({ ...query, active: option.value })} data-testid={`personas-status-${option.id}`}>
              {option.label}
              {page !== null && <span className="text-xs text-muted-foreground tabular-nums">{option.value === null ? page.all : option.value ? page.activeCount : page.all - page.activeCount}</span>}
            </Button>
          ))}
        </div>
      </div>

      {filtered && page !== null && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="tabular-nums">
            {page.total} of {page.all} personas
          </span>
          <Button size="xs" variant="ghost" onClick={() => onQuery(EMPTY_PERSONA_QUERY)} data-testid="personas-clear">
            Clear filters
          </Button>
        </div>
      )}

      {error !== null && (
        <Alert data-testid="personas-error">
          <AlertDescription>Could not load the personas. {error}</AlertDescription>
        </Alert>
      )}

      {page === null ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center" data-testid="personas-none">
          <p className="text-sm text-muted-foreground">No persona matches. Try fewer words, or clear the filters.</p>
          <Button variant="outline" size="sm" onClick={() => onQuery(EMPTY_PERSONA_QUERY)}>
            Clear filters
          </Button>
        </div>
      ) : (
        <ul className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', loading && 'opacity-70')} data-testid="personas-grid">
          {rows.map((persona) => (
            <PersonaCardView key={persona.id} persona={persona} onOpen={() => onOpen(persona.id)} />
          ))}
        </ul>
      )}
      {page !== null && <ListFoot shown={rows.length} total={page.total} noun="personas" loading={loading} onMore={() => void more()} />}
    </div>
  )
}
