'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CheckIcon, PlusIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { HelperRow, ProjectView } from '@slave-of-ai/control'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'

/** The most helpers a lead may be given (lead-flow plan A L16, `LEAD_ROSTER_MAX`). */
export const ROSTER_MAX = 15

/** What a save answered, said as a toast: "Saved", or the refusal's own words. */
export async function saved(result: Promise<{ readonly ok: boolean; readonly error?: string }>, onDone: () => Promise<void>): Promise<boolean> {
  const outcome = await result
  if (outcome.ok) toast.success('Saved')
  else toast.error('error' in outcome && outcome.error !== undefined ? outcome.error : 'Not saved')
  await onDone()
  return outcome.ok
}

/**
 * The roster picker: who the project's lead may call on, each removable, and a search over the
 * catalogue's people to add one. Every change is saved at once (`PATCH /api/w/:id/lead`). Shown in
 * the Settings sheet and behind the Project screen's helpers card.
 */
export function RosterField({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element {
  const [helpers, setHelpers] = useState<readonly HelperRow[] | null>(null)
  const [open, setOpen] = useState(false)
  useEffect((): void => {
    void api<{ helpers: readonly HelperRow[] }>('/api/helpers').then((result) => setHelpers(result.ok ? result.data.helpers : []))
  }, [])
  const ids = project.roster.map((member) => member.id)
  const save = (next: readonly string[]): void => {
    void saved(api(`/api/w/${project.id}/lead`, { method: 'PATCH', body: { roster: next } }), onDone)
  }
  return (
    <div className="flex flex-col gap-2">
      {project.roster.length === 0 ? (
        <p className="text-sm text-muted-foreground">With none, the lead uses general helpers.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" data-testid="roster">
          {project.roster.map((member) => (
            <Badge key={member.id} variant="secondary" className="gap-1 pr-1" data-testid="roster-member">
              <Link href={`/people?person=${member.id}`} className="hover:underline" title={`Open ${member.name}: profile, skills and instructions`} data-testid="roster-member-link">
                {member.name}
              </Link>
              {(member.persona ?? member.role) !== null && <span className="font-normal text-muted-foreground">· {member.persona ?? member.role}</span>}
              <button type="button" aria-label={`Remove ${member.name}`} className="rounded-sm p-0.5 hover:bg-background" onClick={() => save(ids.filter((id) => id !== member.id))}>
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-fit" disabled={ids.length >= ROSTER_MAX} data-testid="roster-add">
            <PlusIcon />
            {ids.length >= ROSTER_MAX ? `At most ${String(ROSTER_MAX)} helpers` : 'Add a helper'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search by name, persona or skill…" />
            <CommandList>
              <CommandEmpty>{helpers === null ? 'Loading…' : 'No specialist matches.'}</CommandEmpty>
              <CommandGroup>
                {(helpers ?? []).map((helper) => {
                  const chosen = ids.includes(helper.id)
                  return (
                    <CommandItem
                      key={helper.id}
                      value={`${helper.name} ${helper.persona ?? ''} ${helper.role ?? ''} ${helper.skills.join(' ')}`}
                      onSelect={() => {
                        setOpen(false)
                        save(chosen ? ids.filter((id) => id !== helper.id) : [...ids, helper.id])
                      }}
                    >
                      <CheckIcon className={chosen ? 'opacity-100' : 'opacity-0'} />
                      <span className="truncate">{helper.name}</span>
                      {(helper.persona ?? helper.role) !== null && <span className="ml-auto truncate text-xs text-muted-foreground">{helper.persona ?? helper.role}</span>}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">
        A helper knows what their profile and skills say.{' '}
        <Link href="/people" className="underline underline-offset-2" data-testid="roster-people-link">
          Create and edit people
        </Link>
      </p>
    </div>
  )
}
