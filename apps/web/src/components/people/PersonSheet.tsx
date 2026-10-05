'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { ExternalLinkIcon, Trash2Icon, Undo2Icon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonDetail, PersonSkillRow, SkillUse } from '@slave-of-ai/control'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DivisionChip, PersonAvatar, SectionNav, SheetSection, WorkingBadge } from './bits'
import { Instructions } from './Instructions'
import { ProfileView } from './ProfileView'
import { SkillPicker } from './SkillPicker'
import { SKILL_STATE_WORD, deleteConsequences, skillSourceWord } from './words'

const STATE_TONE: Readonly<Record<PersonSkillRow['state'], string>> = {
  persona: 'bg-muted text-muted-foreground',
  granted: 'bg-info-muted text-info-foreground',
  revoked: 'bg-warning-muted text-warning-foreground',
}

function SkillLine({ skill, onChange }: { readonly skill: PersonSkillRow; readonly onChange: (change: { grant?: string[]; revoke?: string[]; clear?: string[] }, done: string) => void }): React.JSX.Element {
  const revoked = skill.state === 'revoked'
  return (
    <li data-testid="person-skill" data-state={skill.state} className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium', revoked && 'text-muted-foreground')}>
          <span className={cn('truncate', revoked && 'line-through')}>{skill.name}</span>
          <span className="text-xs font-normal text-muted-foreground">{skillSourceWord(skill.providerName)}</span>
        </p>
        {!revoked && <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>}
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge className={STATE_TONE[skill.state]}>{SKILL_STATE_WORD[skill.state]}</Badge>
          {skill.missing && (
            <Badge className="bg-warning-muted text-warning-foreground" title="The skill's files are no longer on disk, so it is not handed to a session.">
              Files missing
            </Badge>
          )}
        </div>
      </div>
      {skill.state === 'persona' && (
        <Button size="xs" variant="ghost" onClick={() => onChange({ revoke: [skill.skillId] }, `${skill.name} taken away`)} data-testid="skill-revoke">
          <XIcon />
          Take away
        </Button>
      )}
      {skill.state === 'granted' && (
        <Button size="xs" variant="ghost" onClick={() => onChange({ clear: [skill.skillId] }, `${skill.name} removed`)} data-testid="skill-remove">
          <XIcon />
          Remove
        </Button>
      )}
      {revoked && (
        <Button size="xs" variant="ghost" onClick={() => onChange({ clear: [skill.skillId] }, skill.fromPersona ? `${skill.name} given back` : `${skill.name} is no longer blocked`)} data-testid="skill-restore">
          <Undo2Icon />
          {skill.fromPersona ? 'Give back' : 'Unblock'}
        </Button>
      )}
    </li>
  )
}

function DeletePersonDialog({ person, open, onOpenChange, onDeleted }: { readonly person: PersonDetail; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onDeleted: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await api(`/api/people/${person.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!result.ok) {
      setError(result.status === 409 ? `They are working right now. Stop that project, or wait for the run to end, then delete. (${result.error})` : result.error)
      return
    }
    toast.success(`Deleted ${person.name}`)
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
      <AlertDialogContent data-testid="delete-person-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {person.name}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone. With {person.name} go:</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="delete-person-consequences">
          {deleteConsequences(person).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {person.persona !== null && <p className="text-sm text-muted-foreground">The persona {person.persona.name} stays, and so does everybody else made from it.</p>}
        {error !== null && (
          <p role="alert" data-testid="delete-person-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep {person.name}</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()} data-testid="delete-person-confirm">
            <Trash2Icon />
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PersonBody({ person, skills, reload, onChanged, onOpenPersona, onDeleted }: { readonly person: PersonDetail; readonly skills: readonly SkillUse[] | null; readonly reload: () => Promise<void>; readonly onChanged: () => void; readonly onOpenPersona: (templateId: string) => void; readonly onDeleted: () => void }): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const effective = person.skills.filter((skill) => skill.state !== 'revoked')

  const after = async (result: { readonly ok: boolean; readonly error?: string }, done: string): Promise<boolean> => {
    if (result.ok) toast.success(done)
    else toast.error(result.error ?? 'Not saved')
    await reload()
    onChanged()
    return result.ok
  }
  const changeSkills = (change: { grant?: string[]; revoke?: string[]; clear?: string[] }, done: string): void => {
    void api(`/api/people/${person.id}/skills`, { method: 'PATCH', body: change }).then((result) => after(result, done))
  }
  const saveInstructions = async (text: string | null): Promise<string | null> => {
    const result = await api(`/api/people/${person.id}/profile`, { method: 'PUT', body: { profile: text } })
    if (!result.ok) return result.error
    await after(result, text === null || text.trim() === '' ? 'Own instructions cleared' : 'Own instructions saved')
    return null
  }
  const setListed = (project: { readonly id: string; readonly name: string }, listed: boolean): void => {
    void api(`/api/people/${person.id}/rosters`, { method: 'PUT', body: { workspaceId: project.id, listed } }).then((result) => after(result, listed ? `${person.name} may now be called by ${project.name}'s lead` : `${person.name} is off ${project.name}'s helper list`))
  }

  const spec = person.profile?.effective ?? null
  const personaText = person.profile?.markdown ?? null
  return (
    <>
      <SectionNav
        items={[
          { id: 'person-profile', label: 'Profile' },
          { id: 'person-skills', label: `Skills (${String(effective.length)})` },
          { id: 'person-instructions', label: 'Own instructions' },
          { id: 'person-projects', label: 'Projects' },
          { id: 'person-danger', label: 'Delete' },
        ]}
      />
      <div className="flex flex-col gap-6 px-4 pt-4 pb-8">
        <SheetSection
          testId="person-profile"
          title="Profile"
          hint={person.persona === null ? undefined : `From the persona ${person.persona.name}. Everybody made from it shares it.`}
          action={
            person.persona !== null && (
              <Button size="sm" variant="outline" onClick={() => onOpenPersona(person.persona?.id ?? '')} data-testid="person-open-persona">
                Open the persona
              </Button>
            )
          }
        >
          {person.ownInstructions !== null && person.persona !== null && (
            <p className="rounded-md bg-warning-muted px-3 py-2 text-xs text-warning-foreground" data-testid="person-profile-replaced">
              {person.name} has instructions of their own (below). A session is given those instead of this profile.
            </p>
          )}
          {person.persona === null ? (
            <p className="text-sm text-muted-foreground">Made from a name alone, with no persona. Write their instructions below.</p>
          ) : spec !== null ? (
            <ProfileView spec={spec} skip={spec.summary.trim() === person.description ? ['summary'] : []} />
          ) : personaText !== null && personaText !== '' ? (
            <pre className="max-h-72 overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{personaText}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">The persona has no instructions yet. Open it to write them.</p>
          )}
        </SheetSection>

        <Separator />

        <SheetSection
          testId="person-skills"
          title={`Skills (${String(effective.length)})`}
          hint="What a session of theirs is handed beside the profile. The persona's skills come with it; give more, or take one away, for this person only."
        >
          {person.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills yet. Add one, or give the persona default skills so everybody made from it has them.</p>
          ) : (
            <ul className="divide-y rounded-lg border px-3">
              {person.skills.map((skill) => (
                <SkillLine key={skill.skillId} skill={skill} onChange={changeSkills} />
              ))}
            </ul>
          )}
          <SkillPicker skills={skills} exclude={effective.map((skill) => skill.skillId)} label="Give a skill" testId="person-skill-add" onPick={(skill) => changeSkills({ grant: [skill.id] }, `${skill.name} given to ${person.name}`)} />
        </SheetSection>

        <Separator />

        <SheetSection
          testId="person-instructions"
          title="Own instructions"
          hint={person.persona === null ? 'What a session of theirs is told about who they are and how they work.' : 'Optional. When written, a session of theirs is given these instead of the persona\'s profile.'}
        >
          <Instructions
            testId="own-instructions"
            text={person.ownInstructions}
            emptyLine={person.persona === null ? 'Nothing written. A session is told only their name.' : 'None. They use the persona\'s profile as it is.'}
            writeLabel="Write instructions"
            startFrom={personaText !== null && personaText !== '' ? { label: 'Start from the persona\'s profile', text: personaText } : undefined}
            onSave={saveInstructions}
          />
        </SheetSection>

        <Separator />

        <SheetSection testId="person-projects" title="Projects" hint="A project's lead may call the people on its helper list. At most 15 per project.">
          {person.projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No project to add them to yet.{' '}
              <Link href="/new" className="underline underline-offset-2">
                Start a project
              </Link>
              , then come back.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border px-3">
              {person.projects.map((project) => (
                <li key={project.id} data-testid="person-project" data-listed={project.listed} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/w/${project.id}`} className="inline-flex max-w-full items-center gap-1 text-sm font-medium hover:underline">
                      <span className="truncate">{project.name}</span>
                      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
                    </Link>
                    <p className="text-xs text-muted-foreground">{project.listed ? 'On the helper list' : project.full ? 'Its helper list is full' : 'Not on the helper list'}</p>
                  </div>
                  <Switch aria-label={`${project.listed ? 'Take off' : 'Put on'} ${project.name}'s helper list`} checked={project.listed} disabled={project.full} onCheckedChange={(value) => setListed(project, value)} data-testid="person-project-switch" />
                </li>
              ))}
            </ul>
          )}
          {person.footprint.projects.length > 0 && <p className="text-xs text-muted-foreground">Holds a seat in {person.footprint.projects.join(', ')}.</p>}
        </SheetSection>

        {person.model !== null && (
          <>
            <Separator />
            <SheetSection testId="person-runtime" title="Runtime" hint="Used when they hold a seat in an older-style project. A lead's helper runs on the lead's model.">
              <p className="text-sm">
                <span className="font-mono text-xs">{person.model}</span>
                {person.provider !== null && <span className="text-muted-foreground"> · {person.provider === 'claude_code' ? 'Claude Code' : person.provider === 'cursor' ? 'Cursor' : person.provider}</span>}
              </p>
            </SheetSection>
          </>
        )}

        <Separator />

        <SheetSection testId="person-danger" title="Danger zone">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Removes them from every project, with their history.</p>
            <Button variant="destructive" size="sm" onClick={() => setDeleting(true)} data-testid="person-delete">
              <Trash2Icon />
              Delete…
            </Button>
          </div>
        </SheetSection>
        <DeletePersonDialog person={person} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
      </div>
    </>
  )
}

/**
 * One person, in a wide sheet: who they are and what they do (their persona's profile), their
 * skills with where each comes from, their own instructions, the projects whose lead may call
 * them, and Delete. Every change is saved on its own and said as a toast.
 */
export function PersonSheet({ personId, skills, onClose, onChanged, onOpenPersona, onDeleted }: { readonly personId: string | null; readonly skills: readonly SkillUse[] | null; readonly onClose: () => void; readonly onChanged: () => void; readonly onOpenPersona: (templateId: string) => void; readonly onDeleted: () => void }): React.JSX.Element {
  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (personId === null) return
    const result = await api<{ person: PersonDetail }>(`/api/people/${personId}`)
    if (result.ok) {
      setPerson(result.data.person)
      setError(null)
    } else {
      setError(result.status === 404 ? 'This person is no longer here. They may have been deleted.' : result.error)
    }
  }, [personId])

  useEffect((): void => {
    setPerson(null)
    setError(null)
    void reload()
  }, [reload])

  const shown = person !== null && person.id === personId ? person : null
  return (
    <Sheet open={personId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-[720px]" data-testid="person-sheet">
        <SheetHeader className="pr-12">
          {shown === null ? (
            <>
              <SheetTitle>{error === null ? 'Loading…' : 'Not found'}</SheetTitle>
              <SheetDescription>{error ?? 'Reading this person.'}</SheetDescription>
            </>
          ) : (
            <div className="flex items-start gap-3">
              <PersonAvatar name={shown.name} working={shown.working} className="size-12" />
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate text-lg" data-testid="person-name">
                  {shown.name}
                </SheetTitle>
                <SheetDescription className="truncate">{shown.persona?.name ?? 'No persona'}</SheetDescription>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <DivisionChip division={shown.division} />
                  {shown.working && <WorkingBadge />}
                </div>
                {shown.description !== '' && <p className="mt-2 text-sm text-muted-foreground">{shown.description}</p>}
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
          <PersonBody person={shown} skills={skills} reload={reload} onChanged={onChanged} onOpenPersona={onOpenPersona} onDeleted={onDeleted} />
        )}
      </SheetContent>
    </Sheet>
  )
}
