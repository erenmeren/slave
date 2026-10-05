'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, Loader2Icon, PlusIcon, RocketIcon, SendIcon, XIcon } from 'lucide-react'
import {
  INTAKE_STEP_LABEL,
  VERIFY_SOURCE_LABEL,
  intakeRepositoryPath,
  intakeRepositorySlug,
  type IntakeDraft,
  type IntakeFacts,
  type IntakeStatus,
  type IntakeStep,
  type IntakeStepEntry,
  type VerifySource,
} from '@slave-of-ai/domain'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** How often the conversation is re-read while the assistant thinks. */
const POLL_MS = 1_500

interface IntakeMessageView {
  readonly seq: number
  readonly role: 'human' | 'assistant' | 'fact'
  readonly text: string
  readonly facts: IntakeFacts | null
}

interface IntakeView {
  readonly id: string
  readonly status: IntakeStatus
  readonly draft: IntakeDraft | null
  readonly messages: readonly IntakeMessageView[]
  readonly stepLog: readonly IntakeStepEntry[]
  readonly workspaceId: string | null
  readonly failureReason: string | null
  readonly callsLeft: number
  readonly facts: IntakeFacts | null
}

const THINKING: readonly IntakeStatus[] = ['awaiting_reply', 'replying']

/** Lead UX design U-5: how much a project may spend -- a budget, a time limit, both, or no limit. */
export const CAP_CHOICES = ['budget', 'time', 'both', 'none'] as const
export type CapChoice = (typeof CAP_CHOICES)[number]

const CAP_WORDS: Readonly<Record<CapChoice, { readonly title: string; readonly hint: string }>> = {
  budget: { title: 'Budget', hint: 'Stop when this much has been spent.' },
  time: { title: 'Time limit', hint: 'Stop after this much working time.' },
  both: { title: 'Both', hint: 'Stop at whichever comes first.' },
  none: { title: 'No limit', hint: 'Let it run until it is proven.' },
}

/** The cap the card was given, as the draft's two fields; null when the card is not ready to send. */
export function capFields(choice: CapChoice, budgetText: string, minutesText: string): { readonly budgetUsd: number | null; readonly timeLimitMs: number | null } | null {
  const budget = Number(budgetText)
  const minutes = Number(minutesText)
  const wantsBudget = choice === 'budget' || choice === 'both'
  const wantsTime = choice === 'time' || choice === 'both'
  if (wantsBudget && !(budgetText.trim() !== '' && Number.isFinite(budget) && budget > 0)) return null
  if (wantsTime && !(Number.isInteger(minutes) && minutes >= 10 && minutes <= 1440)) return null
  return { budgetUsd: wantsBudget ? budget : null, timeLimitMs: wantsTime ? minutes * 60_000 : null }
}

type RepoChoice = 'existing' | 'new-root' | 'new-path'

function Bubble({ message }: { readonly message: IntakeMessageView }): React.JSX.Element {
  if (message.role === 'fact') {
    return (
      <div data-testid="intake-fact" className="self-stretch rounded-lg border border-dashed bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">What we found: </span>
        <span className="whitespace-pre-wrap">{message.text}</span>
      </div>
    )
  }
  return (
    <p
      data-testid="intake-message"
      data-role={message.role}
      className={cn(
        'max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
        message.role === 'human' ? 'self-end rounded-br-sm bg-primary text-primary-foreground' : 'self-start rounded-bl-sm bg-muted',
      )}
    >
      {message.text}
    </p>
  )
}

/**
 * Lead UX design section 6.2: what do I want built, and how much may it spend? The conversation on
 * the left; on the right the Project card, which fills in once the assistant has a draft and stays
 * editable -- name, where the code lives, the spending cap chosen explicitly (U-5), automatic merge,
 * and the rest under More options. Start building accepts the card and opens the new project.
 */
export function NewProject(): React.JSX.Element {
  const router = useRouter()
  const [intakeId, setIntakeId] = useState<string | null>(null)
  const [view, setView] = useState<IntakeView | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [starting, setStarting] = useState(false)
  const [keepTalking, setKeepTalking] = useState(false)
  const [edited, setEdited] = useState<IntakeDraft | null>(null)
  const [repoChoice, setRepoChoice] = useState<RepoChoice>('existing')
  const [cap, setCap] = useState<CapChoice>('both')
  const [budget, setBudget] = useState('20')
  const [minutes, setMinutes] = useState('90')
  const [unlimitedOk, setUnlimitedOk] = useState(false)
  const [addition, setAddition] = useState('')
  const [root, setRoot] = useState<string | null>(null)
  const takenFrom = useRef<string | null>(null)
  const opened = useRef(false)
  const bottom = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (id: string): Promise<void> => {
    const result = await api<{ intake: IntakeView }>(`/api/intakes/${id}`)
    if (result.ok) setView(result.data.intake)
  }, [])

  const open = useCallback(async (): Promise<void> => {
    setError(null)
    const result = await api<{ id: string }>('/api/intakes', { method: 'POST' })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setIntakeId(result.data.id)
    await refresh(result.data.id)
  }, [refresh])

  useEffect((): void => {
    if (opened.current) return
    opened.current = true
    void open()
    void api<{ resolved: string }>('/api/installation').then((result) => setRoot(result.ok ? result.data.resolved : null))
  }, [open])

  const thinking = view !== null && THINKING.includes(view.status)
  useEffect((): (() => void) | undefined => {
    if (intakeId === null || !(thinking || view?.status === 'creating')) return undefined
    const timer = setInterval((): void => void refresh(intakeId), POLL_MS)
    return (): void => clearInterval(timer)
  }, [intakeId, thinking, view?.status, refresh])

  useEffect((): void => {
    bottom.current?.scrollIntoView?.({ block: 'end' })
  }, [view?.messages.length, thinking])

  // A new draft from the assistant replaces the card; the person's edits to the previous one go.
  useEffect((): void => {
    const draft = view?.draft ?? null
    if (draft === null) return
    const stamp = JSON.stringify(draft)
    if (takenFrom.current === stamp) return
    takenFrom.current = stamp
    setEdited(draft)
    setKeepTalking(false)
    setRepoChoice(draft.repo.mode === 'existing' ? 'existing' : draft.repo.path === null ? 'new-root' : 'new-path')
    if (draft.budgetUsd !== null && draft.budgetUsd > 0) setBudget(String(draft.budgetUsd))
  }, [view?.draft])

  const send = async (): Promise<void> => {
    if (intakeId === null || text.trim() === '') return
    setSending(true)
    setError(null)
    const result = await api(`/api/intakes/${intakeId}/messages`, { method: 'POST', body: { text } })
    setSending(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setText('')
    await refresh(intakeId)
  }

  const facts = view?.facts ?? null
  const chosenPath = edited?.repo.mode === 'existing' ? facts?.paths.find((path) => path.path === edited.repo.path) : undefined
  const foundRepositories = facts?.paths.filter((path) => path.isRepository) ?? []
  const newRootPath = useMemo(() => {
    const base = facts?.reposRoot ?? root
    return base === null ? null : intakeRepositoryPath(base, intakeRepositorySlug(edited?.name ?? ''))
  }, [facts?.reposRoot, root, edited?.name])
  const candidates = useMemo(() => {
    const own = edited?.verifyCommands ?? []
    const detected = (chosenPath?.verify ?? []).map((finding) => finding.command).filter((command) => !own.some((entry) => entry.command === command))
    return [...own, ...detected.map((command) => ({ command, source: 'detected' as VerifySource }))]
  }, [edited?.verifyCommands, chosenPath])
  const lead = (edited?.provider ?? 'claude_code') === 'claude_code'
  const effectiveCap: CapChoice = lead ? cap : cap === 'time' || cap === 'both' ? 'budget' : cap
  const capped = capFields(effectiveCap, budget, minutes)
  const needsCheck = edited?.repo.mode === 'existing' && edited.verifyCommands.length === 0
  const ready =
    edited !== null &&
    edited.name.trim() !== '' &&
    capped !== null &&
    (effectiveCap !== 'none' || unlimitedOk) &&
    !needsCheck &&
    (repoChoice !== 'new-root' || newRootPath !== null) &&
    (edited.repo.path === null ? repoChoice === 'new-root' : edited.repo.path.trim() !== '')

  const start = async (): Promise<void> => {
    if (intakeId === null || edited === null || capped === null) return
    setStarting(true)
    setError(null)
    const result = await api<{ workspaceId: string }>(`/api/intakes/${intakeId}/accept`, {
      method: 'POST',
      body: { draft: { ...edited, budgetUsd: capped.budgetUsd, timeLimitMs: lead ? capped.timeLimitMs : null, delivery: 'conducted' } },
    })
    if (result.ok) {
      router.push(`/w/${result.data.workspaceId}`)
      router.refresh()
      return
    }
    setStarting(false)
    setError(result.error)
    await refresh(intakeId)
  }

  const showComposer = view === null || view.draft === null || keepTalking
  const outOfTurns = view !== null && view.callsLeft === 0 && view.draft === null
  const steps = (view?.stepLog ?? []).filter((entry) => entry.step !== 'staff')

  return (
    <div className="mx-auto grid w-full max-w-[1200px] gap-6 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_400px]" data-testid="new-project">
      <section aria-label="Conversation" className="flex min-h-[60vh] flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
          <p className="text-sm text-muted-foreground">Describe what you want built. The assistant asks what it needs, then fills in the project card.</p>
        </div>
        <Card className="flex-1 gap-0 py-0">
          <div className="flex max-h-[60vh] min-h-[320px] flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="intake-conversation">
            <p className="max-w-[85%] self-start rounded-2xl rounded-bl-sm bg-muted px-4 py-2 text-sm">
              What do you want built? Say it the way you would to a person -- what it does, who uses it, and where the code is if it exists.
            </p>
            {(view?.messages ?? []).map((message) => (
              <Bubble key={message.seq} message={message} />
            ))}
            {thinking && (
              <p data-testid="intake-thinking" className="flex items-center gap-2 self-start text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                Thinking…
              </p>
            )}
            <div ref={bottom} />
          </div>
          {showComposer && !outOfTurns && (
            <form
              data-testid="intake-composer"
              className="flex items-end gap-2 border-t p-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (!sending && !thinking) void send()
              }}
            >
              <Textarea
                aria-label="What do you want built"
                placeholder="Describe what you want built…"
                rows={2}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    if (!sending && !thinking) void send()
                  }
                }}
                disabled={intakeId === null || thinking}
                className="min-h-0 resize-none"
              />
              <Button type="submit" data-testid="intake-send" disabled={intakeId === null || sending || thinking || text.trim() === ''}>
                <SendIcon />
                Send
              </Button>
            </form>
          )}
        </Card>
        {outOfTurns && (
          <Alert>
            <AlertDescription>
              This conversation has used all its turns without a draft.{' '}
              <Button variant="link" className="h-auto p-0" onClick={() => window.location.reload()}>
                Start a new one
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {error !== null && (
          <Alert variant="destructive" data-testid="intake-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>

      <aside aria-label="Project card" className="flex flex-col gap-4">
        <Card data-testid="project-card-draft">
          <CardHeader>
            <CardTitle className="text-base">Project card</CardTitle>
            {edited === null && <CardDescription>The details appear here once there is enough to go on.</CardDescription>}
          </CardHeader>
          {edited !== null && (
            <CardContent className="flex flex-col gap-5">
              <div className="grid gap-2">
                <Label htmlFor="draft-name">Name</Label>
                <Input id="draft-name" data-testid="draft-name" value={edited.name} onChange={(event) => setEdited({ ...edited, name: event.target.value })} />
              </div>

              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Where the code lives</legend>
                <RadioGroup
                  value={repoChoice}
                  onValueChange={(value) => {
                    const choice = value as RepoChoice
                    setRepoChoice(choice)
                    setEdited({
                      ...edited,
                      repo: choice === 'existing' ? { mode: 'existing', path: edited.repo.path ?? foundRepositories[0]?.path ?? '' } : { mode: 'new', path: choice === 'new-root' ? null : (edited.repo.path ?? '') },
                    })
                  }}
                >
                  <Label className="font-normal">
                    <RadioGroupItem value="existing" data-testid="repo-existing" />A folder I already have
                  </Label>
                  <Label className="items-start font-normal">
                    <RadioGroupItem value="new-root" data-testid="repo-new-root" />
                    <span>
                      A new folder in the repositories folder
                      {repoChoice === 'new-root' && <span className="block font-mono text-xs text-muted-foreground">{newRootPath ?? 'Finding the repositories folder…'}</span>}
                    </span>
                  </Label>
                  <Label className="font-normal">
                    <RadioGroupItem value="new-path" data-testid="repo-new-path" />A new folder at…
                  </Label>
                </RadioGroup>
                {repoChoice !== 'new-root' && (
                  <>
                    <Input
                      aria-label="Repository path"
                      data-testid="draft-repo-path"
                      className="font-mono text-xs"
                      list="found-repositories"
                      value={edited.repo.path ?? ''}
                      placeholder="/home/you/projects/app"
                      onChange={(event) => setEdited({ ...edited, repo: repoChoice === 'existing' ? { mode: 'existing', path: event.target.value } : { mode: 'new', path: event.target.value } })}
                    />
                    <datalist id="found-repositories">
                      {foundRepositories.map((path) => (
                        <option key={path.path} value={path.path} />
                      ))}
                    </datalist>
                    {repoChoice === 'existing' && <p className="text-xs text-muted-foreground">Mention the folder in the conversation first, so Slave can look at it.</p>}
                  </>
                )}
              </fieldset>

              <fieldset className="grid gap-2" data-testid="cap">
                <legend className="mb-2 text-sm font-medium">How much may it spend?</legend>
                <RadioGroup value={effectiveCap} onValueChange={(value) => setCap(value as CapChoice)} className="grid grid-cols-2 gap-2">
                  {CAP_CHOICES.filter((choice) => lead || choice === 'budget' || choice === 'none').map((choice) => (
                    <Label
                      key={choice}
                      className={cn('flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 font-normal', effectiveCap === choice && 'border-primary bg-accent/50')}
                      data-testid={`cap-${choice}`}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <RadioGroupItem value={choice} />
                        {CAP_WORDS[choice].title}
                      </span>
                      <span className="text-xs text-muted-foreground">{CAP_WORDS[choice].hint}</span>
                    </Label>
                  ))}
                </RadioGroup>
                {(effectiveCap === 'budget' || effectiveCap === 'both') && (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="draft-budget" className="w-24 font-normal">
                      Budget
                    </Label>
                    <span className="text-sm text-muted-foreground">$</span>
                    <Input id="draft-budget" data-testid="draft-budget" type="number" min={1} step="1" className="w-28" value={budget} onChange={(event) => setBudget(event.target.value)} />
                  </div>
                )}
                {(effectiveCap === 'time' || effectiveCap === 'both') && (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="draft-minutes" className="w-24 font-normal">
                      Time limit
                    </Label>
                    <Input id="draft-minutes" data-testid="draft-minutes" type="number" min={10} max={1440} step={1} className="w-28" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
                    <span className="text-sm text-muted-foreground">minutes</span>
                  </div>
                )}
                {effectiveCap === 'none' && (
                  <Label className="items-start font-normal text-warning-foreground">
                    <Checkbox checked={unlimitedOk} onCheckedChange={(value) => setUnlimitedOk(value === true)} data-testid="cap-none-ok" />I understand this project can spend without limit.
                  </Label>
                )}
                {capped === null && effectiveCap !== 'none' && <p className="text-xs text-destructive">A budget is more than $0; a time limit is 10 to 1440 whole minutes.</p>}
                {(effectiveCap === 'budget' || effectiveCap === 'both') && <p className="text-xs text-muted-foreground">A fifth of the budget is kept for checking the work.</p>}
              </fieldset>

              <Label className="font-normal">
                <Switch checked={edited.autoMerge} onCheckedChange={(value) => setEdited({ ...edited, autoMerge: value })} data-testid="draft-auto-merge" />
                Merge automatically when everything is proven
              </Label>

              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
                    <ChevronDownIcon />
                    More options
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 flex flex-col gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="draft-base">Base branch</Label>
                    <Input id="draft-base" className="font-mono text-xs" list="found-branches" value={edited.baseBranch} onChange={(event) => setEdited({ ...edited, baseBranch: event.target.value })} />
                    <datalist id="found-branches">
                      {(chosenPath?.branches ?? []).map((branch) => (
                        <option key={branch} value={branch} />
                      ))}
                    </datalist>
                  </div>
                  <div className="grid gap-2">
                    <span className="text-sm font-medium">The checks that prove the work</span>
                    {edited.repo.mode === 'new' && edited.verifyCommands.length === 0 && (
                      <p className="text-xs text-muted-foreground">Nothing to run yet: a new repository starts with a check of its own that the lead extends.</p>
                    )}
                    {candidates.map((entry) => (
                      <Label key={entry.command} className="font-normal">
                        <Checkbox
                          checked={edited.verifyCommands.some((command) => command.command === entry.command)}
                          onCheckedChange={(value) =>
                            setEdited({
                              ...edited,
                              verifyCommands: value === true ? [...edited.verifyCommands, entry] : edited.verifyCommands.filter((command) => command.command !== entry.command),
                            })
                          }
                        />
                        <span className="font-mono text-xs">{entry.command}</span>
                        <span className="text-xs text-muted-foreground">{VERIFY_SOURCE_LABEL[entry.source]}</span>
                      </Label>
                    ))}
                    <div className="flex gap-2">
                      <Input aria-label="Another check" className="font-mono text-xs" placeholder="npm test" value={addition} onChange={(event) => setAddition(event.target.value)} />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const command = addition.trim()
                          if (command === '') return
                          setEdited({ ...edited, verifyCommands: [...edited.verifyCommands, { command, source: 'operator' }] })
                          setAddition('')
                        }}
                      >
                        <PlusIcon />
                        Add
                      </Button>
                    </div>
                    {needsCheck && <p className="text-xs text-destructive">A folder that already has code needs at least one check.</p>}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="draft-setup">Setup commands (one per line)</Label>
                    <Textarea
                      id="draft-setup"
                      className="font-mono text-xs"
                      rows={2}
                      value={edited.setupCommands.join('\n')}
                      onChange={(event) => setEdited({ ...edited, setupCommands: event.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== '') })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <span className="text-sm font-medium">Runtime</span>
                    <RadioGroup value={edited.provider ?? 'claude_code'} onValueChange={(value) => setEdited({ ...edited, provider: value === 'cursor' ? 'cursor' : 'claude_code' })}>
                      <Label className="font-normal">
                        <RadioGroupItem value="claude_code" />
                        Claude Code
                      </Label>
                      <Label className="font-normal">
                        <RadioGroupItem value="cursor" />
                        Cursor
                      </Label>
                    </RadioGroup>
                    {!lead && <p className="text-xs text-warning-foreground">This project will use the older way of building, and a time limit does not apply to it.</p>}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          )}
          {edited !== null && (
            <CardFooter className="flex flex-col items-stretch gap-3">
              <Button data-testid="start-building" disabled={!ready || starting || view?.status === 'creating'} onClick={() => void start()}>
                {starting || view?.status === 'creating' ? <Loader2Icon className="animate-spin" /> : <RocketIcon />}
                {starting || view?.status === 'creating' ? 'Starting…' : view?.status === 'failed' ? 'Try again' : 'Start building'}
              </Button>
              {!keepTalking && (
                <p className="text-center text-xs text-muted-foreground">
                  Not right?{' '}
                  <Button variant="link" className="h-auto p-0 text-xs" onClick={() => setKeepTalking(true)}>
                    Keep talking
                  </Button>
                </p>
              )}
            </CardFooter>
          )}
        </Card>

        {steps.length > 0 && (
          <Card className="gap-2 py-4" data-testid="intake-steps">
            <CardContent>
              <ol className="flex flex-col gap-1 text-sm">
                {steps.map((entry) => (
                  <li key={`${entry.step}-${entry.at}`} data-step={entry.step} data-status={entry.status} className="flex items-start gap-2">
                    {entry.status === 'failed' ? <XIcon className="mt-0.5 size-4 text-destructive" /> : <CheckIcon className="mt-0.5 size-4 text-success" />}
                    <span>
                      {INTAKE_STEP_LABEL[entry.step as IntakeStep]}
                      {entry.status === 'failed' && entry.detail !== null && <span className="block text-xs text-destructive">{entry.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
              {view?.status === 'failed' && view.workspaceId !== null && (
                <Link href={`/w/${view.workspaceId}`} className="mt-2 inline-block text-sm underline underline-offset-4">
                  Open the project it made
                </Link>
              )}
            </CardContent>
          </Card>
        )}
      </aside>
    </div>
  )
}
