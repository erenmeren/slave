'use client'

import { useEffect, useState } from 'react'
import { CheckIcon, SearchIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonaCard, PersonaPage, ProjectListItem } from '@slave-of-ai/control'
import type { ModelOption } from '@slave-of-ai/domain'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { PersonaAvatar } from './bits'
import { divisionWord } from './words'

/** A select's "nothing chosen": a real value, because the select cannot hold an empty one. */
const NONE = '__none__'
/** How many personas the picker lists at a time; the search narrows it. */
const PICKER_ROWS = 30

const PROVIDER_WORD: Readonly<Record<string, string>> = { claude_code: 'Claude Code', cursor: 'Cursor' }

function Part({ step, title, hint, children }: { readonly step: number; readonly title: string; readonly hint?: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <legend className="-ml-1 flex items-center gap-2 px-1 text-sm font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary tabular-nums">{step}</span>
        {title}
      </legend>
      {hint !== undefined && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  )
}

/** What the dialog needs to know of the persona somebody is made from. */
export type PersonaChoice = Pick<PersonaCard, 'id' | 'name' | 'role' | 'division' | 'description' | 'skillCount'>

/** The persona to start from: a search over the catalogue and the matches to pick one of. */
function PersonaPicker({ chosen, onChoose }: { readonly chosen: PersonaChoice | null; readonly onChoose: (persona: PersonaChoice | null) => void }): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [page, setPage] = useState<PersonaPage | null>(null)

  useEffect((): (() => void) => {
    let stale = false
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ limit: String(PICKER_ROWS) })
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

  if (chosen !== null) {
    return (
      <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3" data-testid="new-person-persona-chosen">
        <PersonaAvatar name={chosen.name} division={chosen.division} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{chosen.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {divisionWord(chosen.division)} · {plural(chosen.skillCount, 'default skill')}
          </p>
          {chosen.description !== '' && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{chosen.description}</p>}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => onChoose(null)} data-testid="new-person-persona-change">
          Change
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search personas" placeholder="Search personas by name, role or what they do…" className="pl-8" value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="new-person-persona-search" />
      </div>
      <ul className="max-h-56 overflow-y-auto rounded-md border" data-testid="new-person-persona-list">
        {page === null ? (
          <li className="p-3 text-sm text-muted-foreground">Loading…</li>
        ) : page.personas.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">{page.all === 0 ? 'The catalogue has no personas yet. Make the person from a name alone, or create a persona first.' : 'No persona matches.'}</li>
        ) : (
          page.personas.map((persona) => (
            <li key={persona.id}>
              <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => onChoose(persona)} data-testid="new-person-persona-option">
                <CheckIcon className="size-4 shrink-0 opacity-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{persona.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{persona.description !== '' ? persona.description : divisionWord(persona.role)}</span>
                </span>
                {persona.division !== null && <span className="shrink-0 text-xs text-muted-foreground">{divisionWord(persona.division)}</span>}
              </button>
            </li>
          ))
        )}
      </ul>
      {page !== null && page.total > page.personas.length && <p className="text-xs text-muted-foreground">Showing {page.personas.length} of {page.total}. Search to narrow it.</p>}
    </div>
  )
}

/**
 * A new person, in four parts: the persona to start from (or none), who they are, what runs them,
 * and optionally a project whose lead may call them. Opens the person afterwards.
 */
export function NewPersonDialog({ open, onOpenChange, preset, onCreated }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly preset: PersonaChoice | null; readonly onCreated: (personId: string) => void }): React.JSX.Element {
  const [persona, setPersona] = useState<PersonaChoice | null>(preset)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState(NONE)
  const [model, setModel] = useState(NONE)
  const [models, setModels] = useState<readonly ModelOption[] | null>(null)
  const [workspaceId, setWorkspaceId] = useState(NONE)
  const [projects, setProjects] = useState<readonly ProjectListItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect((): void => {
    if (!open) return
    setPersona(preset)
    setName('')
    setProvider(NONE)
    setModel(NONE)
    setWorkspaceId(NONE)
    setError(null)
    void api<{ projects: readonly ProjectListItem[] }>('/api/projects').then((result) => setProjects(result.ok ? result.data.projects.filter((project) => project.flow === 'lead' && !project.archived) : []))
  }, [open, preset])

  useEffect((): void => {
    setModel(NONE)
    setModels(null)
    if (provider === NONE) return
    void api<{ models: readonly ModelOption[] }>(`/api/providers/${provider}/models`).then((result) => setModels(result.ok ? result.data.models : []))
  }, [provider])

  const ready = (persona !== null || name.trim() !== '') && (provider === NONE || model !== NONE)
  const create = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const result = await api<{ personId: string; name: string }>('/api/people', {
      method: 'POST',
      body: {
        ...(persona === null ? {} : { templateId: persona.id }),
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        ...(provider === NONE || model === NONE ? {} : { provider, model }),
      },
    })
    if (!result.ok) {
      setBusy(false)
      setError(result.error)
      return
    }
    // The roster is a second act: when it is refused the person still exists, and is opened with
    // the refusal said, rather than the whole dialog failing with somebody already made.
    const project = projects.find((one) => one.id === workspaceId)
    const listed = project === undefined ? null : await api(`/api/people/${result.data.personId}/rosters`, { method: 'PUT', body: { workspaceId: project.id, listed: true } })
    setBusy(false)
    if (project !== undefined && listed !== null && !listed.ok) toast.warning(`Created ${result.data.name}, but not added to ${project.name}`, { description: listed.error })
    else toast.success(`Created ${result.data.name}`, project === undefined ? undefined : { description: `${project.name}'s lead may call them.` })
    onOpenChange(false)
    onCreated(result.data.personId)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[560px]" data-testid="new-person-dialog">
        <DialogHeader>
          <DialogTitle>New person</DialogTitle>
          <DialogDescription>Somebody a project&apos;s lead can call on. They take their profile and default skills from a persona.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Part step={1} title="Persona" hint="The kind of specialist they are. Leave it empty to make somebody from a name alone and write their instructions yourself.">
            <PersonaPicker chosen={persona} onChoose={setPersona} />
          </Part>

          <Part step={2} title="Identity">
            <div className="grid gap-2">
              <Label htmlFor="new-person-name">Name{persona !== null && ' (optional)'}</Label>
              <Input id="new-person-name" data-testid="new-person-name" autoComplete="off" placeholder={persona?.name ?? 'Ada Lovelace'} value={name} onChange={(event) => setName(event.target.value)} />
              <p className="text-xs text-muted-foreground">{persona !== null ? 'Left empty, they are named after the persona. A name already taken gets a number.' : 'A name already taken gets a number.'}</p>
            </div>
          </Part>

          <Part step={3} title="Runtime" hint="Optional. Used when they hold a seat in an older-style project; a lead's helper always runs on the lead's model.">
            <div className={cn('grid gap-3', provider !== NONE && 'sm:grid-cols-2')}>
              <div className="grid gap-2">
                <Label htmlFor="new-person-provider">Runs on</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="new-person-provider" className="w-full" data-testid="new-person-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>The project&apos;s default</SelectItem>
                    {Object.entries(PROVIDER_WORD).map(([kind, word]) => (
                      <SelectItem key={kind} value={kind}>
                        {word}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {provider !== NONE && (
                <div className="grid gap-2">
                  <Label htmlFor="new-person-model">Model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger id="new-person-model" className="w-full" data-testid="new-person-model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE} disabled>
                        {models === null ? 'Loading the models…' : models.length === 0 ? 'No models offered' : 'Choose a model'}
                      </SelectItem>
                      {(models ?? []).map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </Part>

          {projects.length > 0 && (
            <Part step={4} title="Project" hint="Optional. Put them on a project's helper list now; you can do it later from their page.">
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger aria-label="Project" className="w-full" data-testid="new-person-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not on a project yet</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Part>
          )}

          {error !== null && (
            <p role="alert" className="text-sm text-destructive" data-testid="new-person-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy} data-testid="new-person-submit">
              Create person
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
