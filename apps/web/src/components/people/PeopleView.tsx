'use client'

import { useCallback, useEffect, useState } from 'react'
import { PlusIcon, UserPlusIcon } from 'lucide-react'
import type { PeoplePage, SkillUse } from '@slave-of-ai/control'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { NewPersonaDialog } from './NewPersonaDialog'
import { NewPersonDialog, type PersonaChoice } from './NewPersonDialog'
import { PeopleTab } from './PeopleTab'
import { PersonaSheet } from './PersonaSheet'
import { PersonasTab } from './PersonasTab'
import { PersonSheet } from './PersonSheet'
import { SkillsTab } from './SkillsTab'
import { EMPTY_PEOPLE_QUERY, EMPTY_PERSONA_QUERY, peopleHref, peopleQueryString, type PeopleLocation, type PeopleQuery, type PeopleTabId, type PersonaQuery } from './words'

const TABS: readonly { readonly id: PeopleTabId; readonly label: string; readonly line: string }[] = [
  { id: 'people', label: 'People', line: 'Everybody a project\'s lead can call on. Open somebody to see who they are, give them skills or put them on a project.' },
  { id: 'personas', label: 'Personas', line: 'The kinds of specialist people are made from. Editing a persona changes everybody made from it.' },
  { id: 'skills', label: 'Skills', line: 'What can be handed to a session beside a profile, and who has each.' },
]

/**
 * The People area: everybody a lead can be given (People), the kinds of specialist they are made
 * from (Personas) and what they can be handed (Skills). A person and a persona each open in a wide
 * sheet over the list; what is open is kept in the address.
 */
export function PeopleView({ initial, location }: { readonly initial: PeoplePage | null; readonly location: PeopleLocation }): React.JSX.Element {
  const [tab, setTab] = useState<PeopleTabId>(location.tab)
  const [personId, setPersonId] = useState<string | null>(location.personId)
  const [personaId, setPersonaId] = useState<string | null>(location.personaId)
  const [peopleQuery, setPeopleQuery] = useState<PeopleQuery>({ ...EMPTY_PEOPLE_QUERY, skillId: location.skillId, templateId: location.templateId })
  const [initialQuery] = useState(() => peopleQueryString(peopleQuery))
  const [personaQuery, setPersonaQuery] = useState<PersonaQuery>(EMPTY_PERSONA_QUERY)
  const [skills, setSkills] = useState<readonly SkillUse[] | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [newPerson, setNewPerson] = useState<{ readonly preset: PersonaChoice | null } | null>(null)
  const [newPersona, setNewPersona] = useState(false)
  const [personaNames, setPersonaNames] = useState<Readonly<Record<string, string>>>({})

  const readSkills = useCallback(async (): Promise<void> => {
    const result = await api<{ skills: readonly SkillUse[] }>('/api/skills')
    if (result.ok) setSkills(result.data.skills)
  }, [])
  useEffect((): void => void readSkills(), [readSkills])

  /** Something was written: the lists and the skill counts are read again. */
  const changed = useCallback((): void => {
    setReloadKey((key) => key + 1)
    void readSkills()
  }, [readSkills])

  useEffect((): void => {
    const href = peopleHref({ tab, personId, personaId, skillId: peopleQuery.skillId, templateId: peopleQuery.templateId })
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.replaceState(null, '', href)
  }, [tab, personId, personaId, peopleQuery.skillId, peopleQuery.templateId])

  const current = TABS.find((one) => one.id === tab) ?? TABS[0]
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8 md:px-8" data-testid="people">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">People</h1>
          <p className="text-sm text-muted-foreground">{current?.line}</p>
        </div>
        {tab === 'personas' ? (
          <Button onClick={() => setNewPersona(true)} data-testid="new-persona">
            <PlusIcon />
            New persona
          </Button>
        ) : (
          <Button onClick={() => setNewPerson({ preset: null })} data-testid="new-person">
            <UserPlusIcon />
            New person
          </Button>
        )}
      </div>

      <div role="tablist" aria-label="People, personas and skills" className="flex gap-1 border-b">
        {TABS.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            aria-selected={tab === one.id}
            data-testid={`tab-${one.id}`}
            onClick={() => setTab(one.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              tab === one.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {one.label}
          </button>
        ))}
      </div>

      {tab === 'people' && (
        <PeopleTab
          initial={initial}
          initialQuery={initialQuery}
          query={peopleQuery}
          onQuery={setPeopleQuery}
          skills={skills}
          personaName={peopleQuery.templateId === null ? null : (personaNames[peopleQuery.templateId] ?? null)}
          reloadKey={reloadKey}
          onOpen={setPersonId}
          onNew={() => setNewPerson({ preset: null })}
        />
      )}
      {tab === 'personas' && <PersonasTab query={personaQuery} onQuery={setPersonaQuery} reloadKey={reloadKey} onOpen={setPersonaId} onNew={() => setNewPersona(true)} />}
      {tab === 'skills' && (
        <SkillsTab
          skills={skills}
          onShowPeople={(skillId) => {
            setPeopleQuery({ ...EMPTY_PEOPLE_QUERY, skillId })
            setTab('people')
          }}
        />
      )}

      <PersonSheet
        personId={personId}
        skills={skills}
        onClose={() => setPersonId(null)}
        onChanged={changed}
        onOpenPersona={(templateId) => {
          setPersonId(null)
          setPersonaId(templateId)
        }}
        onDeleted={() => {
          setPersonId(null)
          changed()
        }}
      />
      <PersonaSheet
        templateId={personaId}
        skills={skills}
        onClose={() => setPersonaId(null)}
        onChanged={changed}
        onCreatePerson={(persona) => {
          setPersonaId(null)
          setNewPerson({ preset: persona })
        }}
        onShowPeople={(persona) => {
          setPersonaNames((names) => ({ ...names, [persona.id]: persona.name }))
          setPersonaId(null)
          setPeopleQuery({ ...EMPTY_PEOPLE_QUERY, templateId: persona.id })
          setTab('people')
        }}
        onDeleted={() => {
          setPersonaId(null)
          changed()
        }}
      />
      <NewPersonDialog
        open={newPerson !== null}
        preset={newPerson?.preset ?? null}
        onOpenChange={(open) => !open && setNewPerson(null)}
        onCreated={(id) => {
          changed()
          setTab('people')
          setPersonId(id)
        }}
      />
      <NewPersonaDialog
        open={newPersona}
        onOpenChange={setNewPersona}
        onCreated={(id) => {
          changed()
          setPersonaId(id)
        }}
      />
    </div>
  )
}
