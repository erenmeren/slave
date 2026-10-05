'use client'

import { useCallback, useEffect, useState } from 'react'
import { Trash2Icon, UserPlusIcon, UsersIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonaDetail, SkillUse } from '@slave-of-ai/control'
import type { ProfileOverridableField } from '@slave-of-ai/domain'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { plural } from '@/lib/format'
import { DivisionChip, PersonaAvatar, SectionNav, SheetSection } from './bits'
import { Instructions } from './Instructions'
import type { PersonaChoice } from './NewPersonDialog'
import { ProfileView, type ProfileEditing } from './ProfileView'
import { SkillPicker } from './SkillPicker'
import { FIELD_WORD, divisionWord, roleLine, skillSourceWord } from './words'

function DeletePersonaDialog({ persona, open, onOpenChange, onDeleted }: { readonly persona: PersonaDetail; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onDeleted: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await api(`/api/personas/${persona.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(`Deleted the persona ${persona.name}`)
    onOpenChange(false)
    onDeleted()
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent data-testid="delete-persona-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the persona {persona.name}?</AlertDialogTitle>
          <AlertDialogDescription data-testid="delete-persona-consequence">
            {persona.personCount === 0
              ? 'Nobody was made from it, so nobody else changes. Its profile and default skills are gone for good.'
              : `${plural(persona.personCount, 'person', 'people')} made from it ${persona.personCount === 1 ? 'stays' : 'stay'}, but without a persona: they lose this profile and its ${plural(persona.skills.length, 'default skill')} at once, and keep only instructions and skills of their own.`}
            {persona.handMade ? ' This cannot be undone.' : ' An import of the catalogue brings the persona back, not the links to those people.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()} data-testid="delete-persona-confirm">
            <Trash2Icon />
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PersonaBody({ persona, skills, reload, onChanged, onDeleted }: { readonly persona: PersonaDetail; readonly skills: readonly SkillUse[] | null; readonly reload: () => Promise<void>; readonly onChanged: () => void; readonly onDeleted: () => void }): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const base = `/api/personas/${persona.id}`

  const settle = async (result: { readonly ok: boolean; readonly error?: string }, done: string): Promise<string | null> => {
    if (result.ok) toast.success(done)
    await reload()
    onChanged()
    return result.ok ? null : (result.error ?? 'Not saved')
  }
  const editing: ProfileEditing = {
    overridden: persona.profile.overridden,
    save: async (field: ProfileOverridableField, value) => settle(await api(`${base}/overrides`, { method: 'PATCH', body: { patch: { [field]: value } } }), `${FIELD_WORD[field]} saved`),
    reset: async (field: ProfileOverridableField) => settle(await api(`${base}/overrides/${field}`, { method: 'DELETE' }), `${FIELD_WORD[field]} is back to the catalogue's`),
  }
  const changeSkills = (change: { add?: string[]; remove?: string[] }, done: string): void => {
    void api(`${base}/skills`, { method: 'PATCH', body: change }).then(async (result) => {
      const refusal = await settle(result, done)
      if (refusal !== null) toast.error(refusal)
    })
  }

  const spec = persona.profile.effective
  return (
    <>
      <SectionNav
        items={[
          { id: 'persona-profile', label: 'Profile' },
          { id: 'persona-skills', label: `Default skills (${String(persona.skills.length)})` },
          { id: 'persona-danger', label: 'Delete' },
        ]}
      />
      <div className="flex flex-col gap-6 px-4 pt-4 pb-8">
        <SheetSection
          testId="persona-profile"
          title="Profile"
          hint={spec === null ? 'What a session of anybody made from this persona is told.' : 'What a session of anybody made from this persona is told. Edit a field to change it here; Reset takes it back to the catalogue\'s.'}
        >
          {spec !== null && persona.profile.rawOverride && (
            <p className="rounded-md bg-warning-muted px-3 py-2 text-xs text-warning-foreground" data-testid="persona-raw-override">
              The stored instructions were rewritten as one text and no longer match these fields. Saving any field writes the instructions again from the fields.
            </p>
          )}
          {spec !== null ? (
            <ProfileView spec={spec} editing={editing} />
          ) : (
            <Instructions
              testId="persona-instructions"
              text={persona.profile.markdown}
              emptyLine="No instructions yet. Until some are written, a session is told only the person's name."
              writeLabel="Write instructions"
              onSave={async (text) => settle(await api(`${base}/profile`, { method: 'PUT', body: { profile: text } }), text === null || text.trim() === '' ? 'Instructions cleared' : 'Instructions saved')}
            />
          )}
        </SheetSection>

        <Separator />

        <SheetSection testId="persona-skills" title={`Default skills (${String(persona.skills.length)})`} hint="Everybody made from this persona has these at once, unless one was taken away from them.">
          {persona.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet. Add the skills this kind of specialist should always have.</p>
          ) : (
            <ul className="divide-y rounded-lg border px-3">
              {persona.skills.map((skill) => (
                <li key={skill.id} data-testid="persona-skill" className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                      <span className="truncate">{skill.name}</span>
                      <span className="text-xs font-normal text-muted-foreground">{skillSourceWord(skill.providerName)}</span>
                      {skill.missing && <Badge className="bg-warning-muted text-warning-foreground">Files missing</Badge>}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                  </div>
                  <Button size="xs" variant="ghost" onClick={() => changeSkills({ remove: [skill.id] }, `${skill.name} removed from ${persona.name}`)} data-testid="persona-skill-remove">
                    <XIcon />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <SkillPicker skills={skills} exclude={persona.skills.map((skill) => skill.id)} label="Add a default skill" testId="persona-skill-add" onPick={(skill) => changeSkills({ add: [skill.id] }, `${skill.name} added to ${persona.name}`)} />
        </SheetSection>

        <Separator />

        <SheetSection testId="persona-danger" title="Danger zone">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{persona.personCount === 0 ? 'Nobody was made from it.' : `${plural(persona.personCount, 'person', 'people')} would be left without a persona.`}</p>
            <Button variant="destructive" size="sm" onClick={() => setDeleting(true)} data-testid="persona-delete">
              <Trash2Icon />
              Delete…
            </Button>
          </div>
        </SheetSection>
        <DeletePersonaDialog persona={persona} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
      </div>
    </>
  )
}

/**
 * One persona, in a wide sheet: its profile field by field (each with its own Edit and, once
 * edited, Reset to catalogue -- the Workflow among them), its default skills, whether it is
 * active, the people made from it, and Delete.
 */
export function PersonaSheet({
  templateId,
  skills,
  onClose,
  onChanged,
  onCreatePerson,
  onShowPeople,
  onDeleted,
}: {
  readonly templateId: string | null
  readonly skills: readonly SkillUse[] | null
  readonly onClose: () => void
  readonly onChanged: () => void
  readonly onCreatePerson: (persona: PersonaChoice) => void
  readonly onShowPeople: (persona: { readonly id: string; readonly name: string }) => void
  readonly onDeleted: () => void
}): React.JSX.Element {
  const [persona, setPersona] = useState<PersonaDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (templateId === null) return
    const result = await api<{ persona: PersonaDetail }>(`/api/personas/${templateId}`)
    if (result.ok) {
      setPersona(result.data.persona)
      setError(null)
    } else {
      setError(result.status === 404 ? 'This persona is no longer here. It may have been deleted.' : result.error)
    }
  }, [templateId])

  useEffect((): void => {
    setPersona(null)
    setError(null)
    void reload()
  }, [reload])

  const shown = persona !== null && persona.id === templateId ? persona : null
  const setActive = async (active: boolean): Promise<void> => {
    if (shown === null) return
    const result = await api(`/api/personas/${shown.id}/activation`, { method: 'POST', body: { active } })
    if (result.ok) toast.success(active ? `${shown.name} is active` : `${shown.name} is inactive`)
    else toast.error(result.error)
    await reload()
    onChanged()
  }

  return (
    <Sheet open={templateId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-[720px]" data-testid="persona-sheet">
        <SheetHeader className="pr-12">
          {shown === null ? (
            <>
              <SheetTitle>{error === null ? 'Loading…' : 'Not found'}</SheetTitle>
              <SheetDescription>{error ?? 'Reading this persona.'}</SheetDescription>
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <PersonaAvatar name={shown.name} division={shown.division} className="size-12" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-lg" data-testid="persona-name">
                    {shown.name}
                  </SheetTitle>
                  <SheetDescription className="truncate">{roleLine(shown.role, shown.division) ?? divisionWord(shown.division)}</SheetDescription>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <DivisionChip division={shown.division} />
                    {shown.handMade && <Badge variant="outline">Made here</Badge>}
                    {shown.profile.overridden.length > 0 && <Badge className="bg-info-muted text-info-foreground">{plural(shown.profile.overridden.length, 'field')} edited here</Badge>}
                  </div>
                  {shown.description !== '' && <p className="mt-2 text-sm text-muted-foreground">{shown.description}</p>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => onCreatePerson({ id: shown.id, name: shown.name, role: shown.role, division: shown.division, description: shown.description, skillCount: shown.skills.length })} data-testid="persona-create-person">
                  <UserPlusIcon />
                  Create a person from this
                </Button>
                {shown.personCount > 0 && (
                  <Button size="sm" variant="outline" onClick={() => onShowPeople({ id: shown.id, name: shown.name })} data-testid="persona-show-people">
                    <UsersIcon />
                    {plural(shown.personCount, 'person', 'people')}
                  </Button>
                )}
                <Label className="ml-auto font-normal" title="An active persona is offered when Slave forms a team for an older-style project. People already made from it are not affected.">
                  <Switch checked={shown.active} onCheckedChange={(value) => void setActive(value)} data-testid="persona-active" />
                  {shown.active ? 'Active' : 'Inactive'}
                </Label>
              </div>
            </div>
          )}
        </SheetHeader>
        {shown === null ? (
          error === null && (
            <div className="flex flex-col gap-3 px-4">
              <Skeleton className="h-24" />
              <Skeleton className="h-40" />
            </div>
          )
        ) : (
          <PersonaBody persona={shown} skills={skills} reload={reload} onChanged={onChanged} onDeleted={onDeleted} />
        )}
      </SheetContent>
    </Sheet>
  )
}
