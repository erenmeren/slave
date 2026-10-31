'use client'

import Link from 'next/link'
import { useState } from 'react'
import { PencilIcon, UsersIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { BuildView, ProjectView } from '@slave-of-ai/control'
import { divisionWord } from '@/components/people/words'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { RosterField } from './RosterField'
import { initialsOf, toneOf } from './WhoIsWorking'

/** How many sessions the lead started for this roster person in the build (the people table's rows). */
export function callsOf(build: BuildView | null, personId: string): number {
  return (build?.people ?? []).filter((person) => person.kind === 'helper' && person.personId === personId).reduce((sum, person) => sum + person.sessions, 0)
}

/** "Called 3 times" in a few words; null when there is no build to have called anybody in. */
export function callsWord(build: BuildView | null, personId: string): string | null {
  if (build === null) return null
  const calls = callsOf(build, personId)
  return calls === 0 ? 'Not called yet' : calls === 1 ? 'Called once' : `Called ${String(calls)} times`
}

/** What somebody is, in one line: the persona they were hired from and its division. */
export function helperLine(member: ProjectView['roster'][number]): string {
  const what = member.persona ?? (member.role === null || member.role.trim() === '' ? null : divisionWord(member.role))
  const division = member.division === null ? null : divisionWord(member.division)
  if (what === null) return division ?? 'No persona'
  return division === null || division.toLowerCase() === what.toLowerCase() ? what : `${what} · ${division}`
}

/**
 * The helpers the project's lead can call on, on the Project screen itself: each roster person with
 * a link to their page in People and how often this build's lead called them, and Edit, which opens
 * the roster picker. With nobody chosen the card says what that means -- the lead can only start
 * general helpers -- and offers the picker, and the people the creating conversation proposed when
 * there are some. A lead-flow project only.
 */
export function HelpersCard({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element | null {
  const [editing, setEditing] = useState(false)
  const [filling, setFilling] = useState(false)
  if (project.flow !== 'lead') return null
  const build = project.build
  const called = project.roster.filter((member) => callsOf(build, member.id) > 0).length

  const useProposed = async (): Promise<void> => {
    setFilling(true)
    const result = await api<{ roster: readonly string[] }>(`/api/w/${project.id}/lead/roster`, { method: 'POST' })
    setFilling(false)
    if (result.ok) toast.success(`${String(result.data.roster.length)} helper(s) chosen. The lead can call on them from its next turn.`)
    else toast.error(result.error)
    await onDone()
  }

  return (
    <Card data-testid="helpers" className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">Helpers the lead can call on</CardTitle>
        {project.roster.length > 0 && (
          <CardDescription data-testid="helpers-summary">
            {project.roster.length} chosen{build === null ? '' : `, ${String(called)} called in this build`}. The lead decides when.
          </CardDescription>
        )}
        {project.roster.length > 0 && !project.archived && (
          <CardAction>
            <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" onClick={() => setEditing(true)} data-testid="helpers-edit">
              <PencilIcon />
              Edit
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {project.roster.length === 0 ? (
          <div data-testid="helpers-empty" className="flex flex-col items-start gap-2.5 rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning-foreground">
            <p>
              <span className="font-medium">No helpers chosen:</span> the lead can only start general helpers.
            </p>
            {!project.archived && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="bg-background text-foreground" onClick={() => setEditing(true)} data-testid="helpers-choose">
                  <UsersIcon />
                  Choose people
                </Button>
                {project.rosterProposed > 0 && (
                  <Button size="sm" variant="outline" className="h-auto min-h-8 bg-background py-1.5 text-left whitespace-normal text-foreground" disabled={filling} onClick={() => void useProposed()} data-testid="helpers-use-proposed">
                    Use the {project.rosterProposed === 1 ? 'person' : `${String(project.rosterProposed)} people`} proposed when the project was created
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5 text-sm">
            {project.roster.map((member) => {
              const calls = callsOf(build, member.id)
              return (
                <li key={member.id} data-testid="helper" data-calls={calls} className="flex min-w-0 items-center gap-2.5" title={member.description === '' ? undefined : member.description}>
                  <Avatar className="size-8 shrink-0">
                    <AvatarFallback className={cn('text-xs font-semibold', toneOf(member.name))}>{initialsOf(member.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <Link href={`/people?person=${member.id}`} className="block truncate font-medium hover:underline" data-testid="helper-link">
                      {member.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">{helperLine(member)}</p>
                  </div>
                  {build !== null && (
                    <span data-testid="helper-calls" className={cn('shrink-0 text-xs tabular-nums', calls === 0 ? 'text-muted-foreground' : 'font-medium')}>
                      {callsWord(build, member.id)}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent data-testid="helpers-dialog">
          <DialogHeader>
            <DialogTitle>Helpers the lead can call on</DialogTitle>
            <DialogDescription>The lead decides when to call them, and uses a general helper when nobody here fits. A change reaches it at its next turn.</DialogDescription>
          </DialogHeader>
          <RosterField project={project} onDone={onDone} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
