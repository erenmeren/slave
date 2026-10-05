'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArchiveIcon, CheckIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { HelperRow, ProjectView } from '@slave-of-ai/control'
import type { ModelOption } from '@slave-of-ai/domain'
import { DeleteProjectDialog } from '@/components/app/DeleteProjectDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api, notifyProjectsChanged } from '@/lib/api'

/** The most helpers a lead may be given (lead-flow plan A L16, `LEAD_ROSTER_MAX`). */
const ROSTER_MAX = 15
/** "Default": the runtime picks (lead-flow C5). A model id cannot be this, so it never collides. */
const DEFAULT_MODEL = '__default__'

function Section({ title, children, testId }: { readonly title: string; readonly children: React.ReactNode; readonly testId: string }): React.JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

/** What a save answered, said as a toast: "Saved", or the refusal's own words. */
async function saved(result: Promise<{ readonly ok: boolean; readonly error?: string }>, onDone: () => Promise<void>): Promise<boolean> {
  const outcome = await result
  if (outcome.ok) toast.success('Saved')
  else toast.error('error' in outcome && outcome.error !== undefined ? outcome.error : 'Not saved')
  await onDone()
  return outcome.ok
}

function LimitsFields({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element {
  const [budget, setBudget] = useState(project.budgetUsd === null ? '' : String(project.budgetUsd))
  const [noBudget, setNoBudget] = useState(project.budgetUsd === null)
  const [minutes, setMinutes] = useState(project.timeLimitMs === null ? '' : String(project.timeLimitMs / 60_000))
  const [noLimit, setNoLimit] = useState(project.timeLimitMs === null)

  const saveBudget = (): void => {
    const value = noBudget ? null : Number(budget)
    if (value !== null && !(Number.isFinite(value) && value >= 0)) {
      toast.error('A budget is a number of dollars, 0 or more.')
      return
    }
    void saved(api(`/api/w/${project.id}/budget`, { method: 'PUT', body: { budgetUsd: value } }), onDone)
  }
  const saveTime = (): void => {
    void saved(api(`/api/w/${project.id}/lead`, { method: 'PATCH', body: { timeLimitMs: noLimit ? null : Math.round(Number(minutes) * 60_000) } }), onDone)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="settings-budget">Budget</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <Input id="settings-budget" data-testid="settings-budget" type="number" min={0} step="0.01" className="w-32" value={budget} disabled={noBudget} onChange={(event) => setBudget(event.target.value)} />
          <Label className="font-normal">
            <Checkbox checked={noBudget} onCheckedChange={(value) => setNoBudget(value === true)} data-testid="settings-no-budget" />
            No budget
          </Label>
          <Button size="sm" variant="outline" className="ml-auto" onClick={saveBudget} data-testid="settings-budget-save">
            Save
          </Button>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="settings-minutes">Time limit (working time)</Label>
        <div className="flex items-center gap-2">
          <Input id="settings-minutes" data-testid="settings-minutes" type="number" min={10} max={1440} step={1} className="w-24" value={minutes} disabled={noLimit} onChange={(event) => setMinutes(event.target.value)} />
          <span className="text-sm text-muted-foreground">minutes</span>
          <Label className="font-normal">
            <Checkbox checked={noLimit} onCheckedChange={(value) => setNoLimit(value === true)} data-testid="settings-no-limit" />
            No time limit
          </Label>
          <Button size="sm" variant="outline" className="ml-auto" onClick={saveTime} data-testid="settings-minutes-save">
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">10 to 1440 minutes. Waiting for the provider and time while paused are not counted.</p>
      </div>
      {noBudget && noLimit && <p className="text-xs text-warning-foreground">With no budget and no time limit, nothing caps what this project spends.</p>}
    </div>
  )
}

function ModelField({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element {
  const [models, setModels] = useState<readonly ModelOption[] | null>(null)
  useEffect((): void => {
    void api<{ models: readonly ModelOption[] }>('/api/providers/claude_code/models').then((result) => setModels(result.ok ? result.data.models : []))
  }, [])
  const options = [...(models ?? [])]
  if (project.leadModel !== null && !options.some((model) => model.id === project.leadModel)) options.unshift({ id: project.leadModel, label: project.leadModel })
  return (
    <div className="grid gap-2">
      <Label htmlFor="settings-model">Model</Label>
      <Select
        value={project.leadModel ?? DEFAULT_MODEL}
        onValueChange={(value) => {
          if (value === DEFAULT_MODEL) return
          void saved(api(`/api/w/${project.id}/lead`, { method: 'PATCH', body: { model: value } }), onDone)
        }}
      >
        <SelectTrigger id="settings-model" data-testid="settings-model" className="w-full">
          <SelectValue placeholder="Default (Claude Code chooses)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_MODEL} disabled={project.leadModel !== null}>
            Default (Claude Code chooses)
          </SelectItem>
          {options.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {models === null ? 'Loading the models Claude Code offers…' : 'The checkers use the same model. Once a model is named, it can be changed but not set back to Default here.'}
      </p>
    </div>
  )
}

function RosterField({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element {
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
              {member.name}
              {member.role !== null && <span className="font-normal text-muted-foreground">· {member.role}</span>}
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
            <CommandInput placeholder="Search specialists…" />
            <CommandList>
              <CommandEmpty>{helpers === null ? 'Loading…' : 'No specialist matches.'}</CommandEmpty>
              <CommandGroup>
                {(helpers ?? []).map((helper) => {
                  const chosen = ids.includes(helper.id)
                  return (
                    <CommandItem
                      key={helper.id}
                      value={`${helper.name} ${helper.role ?? ''} ${helper.skills.join(' ')}`}
                      onSelect={() => {
                        setOpen(false)
                        save(chosen ? ids.filter((id) => id !== helper.id) : [...ids, helper.id])
                      }}
                    >
                      <CheckIcon className={chosen ? 'opacity-100' : 'opacity-0'} />
                      <span className="truncate">{helper.name}</span>
                      {helper.role !== null && <span className="ml-auto truncate text-xs text-muted-foreground">{helper.role}</span>}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/**
 * Lead UX design section 6.3, the Settings sheet: the six settings the lead flow reads, each saved
 * on its own with a toast -- Limits, the lead's model, its helpers, delivery, how the project is
 * built, and the danger zone. An older project shows only how it is built and the danger zone.
 */
export function SettingsSheet({ project, open, onOpenChange, onDone }: { readonly project: ProjectView; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onDone: () => Promise<void> }): React.JSX.Element {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const lead = project.flow === 'lead'

  const archive = async (): Promise<void> => {
    const result = await api(`/api/w/${project.id}/archive`, { method: 'POST' })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${project.name} is archived. Restore it from Projects.`)
    notifyProjectsChanged()
    router.push('/')
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[480px]" data-testid="settings-sheet">
        <SheetHeader>
          <SheetTitle>Project settings</SheetTitle>
          <SheetDescription>{project.name}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          {lead && (
            <>
              <Section title="Limits" testId="settings-limits">
                <LimitsFields key={`${String(project.budgetUsd)}-${String(project.timeLimitMs)}`} project={project} onDone={onDone} />
              </Section>
              <Separator />
              <Section title="The lead" testId="settings-lead">
                <ModelField project={project} onDone={onDone} />
              </Section>
              <Separator />
              <Section title="Helpers the lead may call" testId="settings-roster">
                <RosterField project={project} onDone={onDone} />
              </Section>
              <Separator />
              <Section title="Delivery" testId="settings-delivery">
                <Label className="font-normal">
                  <Switch
                    data-testid="settings-auto-merge"
                    checked={project.autoMerge}
                    onCheckedChange={(value) => void saved(api(`/api/w/${project.id}/integration`, { method: 'PUT', body: { autoMerge: value } }), onDone)}
                  />
                  Merge automatically when everything is proven
                </Label>
              </Section>
              <Separator />
            </>
          )}
          <Section title="How it is built" testId="settings-flow">
            <RadioGroup
              value={project.flow}
              onValueChange={(value) => void saved(api(`/api/w/${project.id}/flow`, { method: 'POST', body: { flow: value } }), onDone)}
            >
              <Label className="items-start font-normal">
                <RadioGroupItem value="lead" data-testid="settings-flow-lead" />
                <span>
                  One lead builds everything
                  <span className="block text-xs text-muted-foreground">Recommended. One session builds the whole request; Slave checks the result.</span>
                </span>
              </Label>
              <Label className="items-start font-normal">
                <RadioGroupItem value="packages" data-testid="settings-flow-packages" />
                <span>
                  Older way: many separate tasks
                  <span className="block text-xs text-muted-foreground">Kept for old projects. Driven from the command line.</span>
                </span>
              </Label>
            </RadioGroup>
            <p className="text-xs text-muted-foreground">Switching is refused while a build is open or something runs.</p>
          </Section>
          <Separator />
          <Section title="Danger zone" testId="settings-danger">
            {!project.archived && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Hides it from the list; nothing is deleted.</p>
                <Button variant="outline" size="sm" onClick={() => void archive()} data-testid="settings-archive">
                  <ArchiveIcon />
                  Archive
                </Button>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Removes the project from Slave. The code stays.</p>
              <Button variant="destructive" size="sm" onClick={() => setDeleting(true)} data-testid="settings-delete">
                <Trash2Icon />
                Delete…
              </Button>
            </div>
          </Section>
        </div>
      </SheetContent>
      <DeleteProjectDialog project={project} open={deleting} onOpenChange={setDeleting} onDeleted={() => router.push('/')} />
    </Sheet>
  )
}
