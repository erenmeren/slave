'use client'

import { useEffect, useState } from 'react'
import { PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import type { IntakePersona, PersonaPage } from '@slave-of-ai/control'
import type { IntakeDraft } from '@slave-of-ai/domain'
import { PersonaAvatar } from '@/components/people/bits'
import { divisionWord } from '@/components/people/words'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'

/** The most seats a draft's team may hold (`intakeDraftSchema`). */
export const TEAM_MAX = 12
/** How many personas the picker lists at a time; the search narrows it. */
const PICKER_ROWS = 30

type Team = IntakeDraft['team']

/** The personas a team names, each once, in the team's order: one helper per persona. */
export function helpersOf(team: Team): readonly string[] {
  return [...new Set(team.map((seat) => seat.templateId))]
}

/** The team without a persona: every seat of it goes. */
export function withoutHelper(team: Team, templateId: string): Team {
  return team.filter((seat) => seat.templateId !== templateId)
}

/** The team with one more persona at its end; unchanged when it names them already or is full. */
export function withHelper(team: Team, templateId: string): Team {
  return team.some((seat) => seat.templateId === templateId) || team.length >= TEAM_MAX ? team : [...team, { templateId, runtimeRoles: [] }]
}

/** The personas of the catalogue that can still be added: a search, and the matches to pick from. */
function PersonaSearch({ chosen, onChoose }: { readonly chosen: readonly string[]; readonly onChoose: (persona: IntakePersona) => void }): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [page, setPage] = useState<PersonaPage | null>(null)

  useEffect((): (() => void) => {
    let stale = false
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ limit: String(PICKER_ROWS), active: '1' })
        if (typed.trim() !== '') params.set('q', typed.trim())
        void api<PersonaPage>(`/api/personas?${params.toString()}`).then((result) => {
          if (!stale && result.ok) setPage(result.data)
        })
      },
      typed === '' ? 0 : 200,
    )
    return (): void => {
      stale = true
      clearTimeout(timer)
    }
  }, [typed])

  const offered = (page?.personas ?? []).filter((persona) => !chosen.includes(persona.id))
  return (
    <div className="flex flex-col">
      <div className="relative border-b">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus aria-label="Search people" placeholder="Search by name, role or what they do…" className="h-10 rounded-none border-0 pl-9 shadow-none focus-visible:ring-0" value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="draft-helper-search" />
      </div>
      <ul className="max-h-64 overflow-y-auto p-1" data-testid="draft-helper-options">
        {page === null ? (
          <li className="p-3 text-sm text-muted-foreground">Loading…</li>
        ) : offered.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">{page.personas.length === 0 ? 'Nobody matches.' : 'Everybody who matches is chosen already.'}</li>
        ) : (
          offered.map((persona) => (
            <li key={persona.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => onChoose({ templateId: persona.id, name: persona.name, role: persona.role, division: persona.division, description: persona.description })}
                data-testid="draft-helper-option"
              >
                <PersonaAvatar name={persona.name} division={persona.division} className="size-8" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{persona.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{persona.description !== '' ? persona.description : divisionWord(persona.division)}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      {page !== null && page.total > page.personas.length && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Showing {page.personas.length} of {page.total}. Search to narrow it.</p>}
    </div>
  )
}

/**
 * The Project card's "Who the lead can call on": the people the assistant proposed, as people --
 * a face, the persona's name, its division and one line -- each removable, and a search over the
 * catalogue to add others. What is listed when Start building is pressed is what the project's
 * lead is given (`acceptIntake` puts one person of each persona on the roster). `known` is what
 * the conversation read about the draft's own team; a persona added here is remembered by the card.
 */
export function HelpersField({ team, known, onChange }: { readonly team: Team; readonly known: readonly IntakePersona[]; readonly onChange: (team: Team) => void }): React.JSX.Element {
  const [added, setAdded] = useState<readonly IntakePersona[]>([])
  const [open, setOpen] = useState(false)
  const helpers = helpersOf(team)
  const personaOf = (templateId: string): IntakePersona | undefined => known.find((persona) => persona.templateId === templateId) ?? added.find((persona) => persona.templateId === templateId)
  const full = team.length >= TEAM_MAX

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" data-testid="draft-helpers">
      <legend className="mb-2 text-sm font-medium">Who the lead can call on</legend>
      {helpers.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="draft-helpers-empty">
          Nobody chosen. The lead will build with general helpers only.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {helpers.map((templateId) => {
            const persona = personaOf(templateId)
            const name = persona?.name ?? 'Somebody no longer in the catalogue'
            return (
              <li key={templateId} data-testid="draft-helper" className="flex min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2">
                <PersonaAvatar name={name} division={persona?.division ?? null} className="size-8" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {name}
                    {persona !== undefined && persona.division !== null && <span className="font-normal text-muted-foreground"> · {divisionWord(persona.division)}</span>}
                  </p>
                  {persona !== undefined && persona.description !== '' && (
                    <p className="truncate text-xs text-muted-foreground" title={persona.description}>
                      {persona.description}
                    </p>
                  )}
                </div>
                <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={`Remove ${name}`} onClick={() => onChange(withoutHelper(team, templateId))}>
                  <XIcon />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="w-fit" disabled={full} data-testid="draft-helper-add">
            <PlusIcon />
            {full ? `At most ${String(TEAM_MAX)} here` : 'Add somebody'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
          <PersonaSearch
            chosen={helpers}
            onChoose={(persona) => {
              setAdded((before) => [...before.filter((one) => one.templateId !== persona.templateId), persona])
              onChange(withHelper(team, persona.templateId))
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">The lead decides when to call them, and uses a general helper when nobody here fits. You can change this later on the project.</p>
    </fieldset>
  )
}
