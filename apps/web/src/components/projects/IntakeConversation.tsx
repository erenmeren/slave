'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react'
import { useRouter } from 'next/navigation'
import {
  INTAKE_BOOTSTRAP_VERIFY_COMMAND,
  INTAKE_MAX_SEATS_PER_TEMPLATE,
  INTAKE_STATUS_LABEL,
  INTAKE_STEP_LABEL,
  INTAKE_STEP_STATUS_LABEL,
  intakeRepositoryPath,
  intakeRepositorySlug,
  PROVIDER_LABEL,
  SUPERVISOR_DEFAULT_PROVIDER,
  VERIFY_SOURCE_LABEL,
  type IntakeDraft,
  type IntakeFacts,
  type IntakeStatus,
  type IntakeStep,
  type IntakeStepEntry,
  type VerifySource,
} from '@slave-of-ai/domain'
import type { ProviderKind } from '@slave-of-ai/control'
import { errorMessage } from '../../lib/postControl'
import { onUnauthorized } from '../../lib/onUnauthorized'
import { ProjectsPanel } from '../ProjectsPanel'
import { ProviderSelect } from '../ProviderSelect'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL, TextField } from '../ui/FormControls'

const POLL_MS = 1_500

interface IntakeMessageView {
  readonly seq: number
  readonly role: 'human' | 'assistant' | 'fact'
  readonly text: string
  readonly facts: IntakeFacts | null
  readonly createdAt: string
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

type RepoChoice = 'existing' | 'new-root' | 'new-path'

const WAITING: readonly IntakeStatus[] = ['awaiting_reply', 'replying', 'creating']

type InstallationRootState =
  | { readonly status: 'idle'; readonly root: null }
  | { readonly status: 'loading'; readonly root: null }
  | { readonly status: 'loaded'; readonly root: string }
  | { readonly status: 'failed'; readonly root: null }

function FactCard({ facts }: { readonly facts: IntakeFacts }): React.JSX.Element {
  return (
    <div data-testid="intake-fact-card" className="flex flex-wrap gap-1 rounded-tile border border-line bg-card px-2 py-1.5">
      {facts.paths.map((path) => (
        <span key={path.path} className="flex flex-wrap items-center gap-1">
          <span data-testid="intake-fact-chip" title={path.path} className="rounded-chip bg-hover px-1.5 py-0.5 font-mono text-[11px] text-text-2">
            {path.isRepository ? `repository · ${path.branches.join(', ')}` : path.isEmptyDir ? 'empty folder' : 'folder'}
          </span>
          {path.verify.map((finding) => (
            <span
              key={`${path.path}:${finding.command}`}
              data-testid="intake-fact-chip"
              title={finding.source}
              className="rounded-chip bg-hover px-1.5 py-0.5 font-mono text-[11px] text-text-2"
            >
              {finding.command}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}

export function IntakeConversation({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const router = useRouter()
  const [intakeId, setIntakeId] = useState<string | null>(null)
  const [view, setView] = useState<IntakeView | null>(null)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [opening, setOpening] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [byHand, setByHand] = useState(false)
  const [edited, setEdited] = useState<IntakeDraft | null>(null)
  const [choice, setChoice] = useState<RepoChoice>('existing')
  const [addition, setAddition] = useState('')
  const [installationRoot, setInstallationRoot] = useState<InstallationRootState>({ status: 'idle', root: null })
  const takenFrom = useRef<string | null>(null)
  const installationRequested = useRef(false)

  const refresh = useCallback(async (id: string): Promise<void> => {
    const response = await fetch(`/api/intakes/${id}`)
    if (response.status === 401) onUnauthorized()
    if (!response.ok) return
    const body = (await response.json()) as { intake: IntakeView }
    setView(body.intake)
  }, [])

  const open = useCallback(async (): Promise<void> => {
    setOpening(true)
    setErrorText(null)
    try {
      const response = await fetch('/api/intakes', { method: 'POST' })
      if (response.status === 401) onUnauthorized()
      if (!response.ok) {
        setErrorText(errorMessage(await response.json().catch(() => null), response.status))
        return
      }
      const body = (await response.json()) as { id: string }
      setIntakeId(body.id)
      await refresh(body.id)
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpening(false)
    }
  }, [refresh])

  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    void open()
  }, [open])

  const waiting = view !== null && WAITING.includes(view.status)
  useEffect(() => {
    if (intakeId === null || !waiting) return
    const timer = setInterval((): void => void refresh(intakeId), POLL_MS)
    return (): void => clearInterval(timer)
  }, [intakeId, waiting, refresh])

  useEffect(() => {
    const draft = view?.draft ?? null
    if (draft === null) return
    const stamp = JSON.stringify(draft)
    if (takenFrom.current === stamp) return
    takenFrom.current = stamp
    setEdited(draft)
    setChoice(draft.repo.mode === 'existing' ? 'existing' : draft.repo.path === null ? 'new-root' : 'new-path')
  }, [view?.draft])

  const needsInstallationRoot = view !== null && view.facts === null && edited?.repo.mode === 'new' && edited.repo.path === null
  // The load is kept, not cancelled, when the choice moves off the new-root one: the GET is
  // idempotent and the latch is per mount, so discarding an answer in flight would leave a
  // choice that comes back with no root and no way to ask for one again.
  useEffect(() => {
    if (!needsInstallationRoot || installationRequested.current) return
    installationRequested.current = true
    setInstallationRoot({ status: 'loading', root: null })
    void (async (): Promise<void> => {
      try {
        const response = await fetch('/api/installation')
        if (response.status === 401) onUnauthorized()
        if (!response.ok) {
          setErrorText(errorMessage(await response.json().catch(() => null), response.status))
          setInstallationRoot({ status: 'failed', root: null })
          return
        }
        const body = (await response.json()) as { resolved: string }
        setInstallationRoot({ status: 'loaded', root: body.resolved })
      } catch (cause) {
        setErrorText(cause instanceof Error ? cause.message : String(cause))
        setInstallationRoot({ status: 'failed', root: null })
      }
    })()
  }, [needsInstallationRoot])

  const selectedPathFact = useMemo(
    () =>
      edited?.repo.mode === 'existing'
        ? view?.facts?.paths.find((path) => path.path === edited.repo.path)
        : undefined,
    [edited?.repo, view?.facts],
  )
  const detected = useMemo(
    () => selectedPathFact?.verify.map((finding) => finding.command) ?? [],
    [selectedPathFact],
  )
  const candidates = useMemo(() => {
    const own = edited?.verifyCommands ?? []
    const extra = detected.filter((command) => !own.some((entry) => entry.command === command))
    return [...own, ...extra.map((command) => ({ command, source: 'detected' as VerifySource }))]
  }, [edited?.verifyCommands, detected])
  const newRootPath = useMemo(() => {
    const root = view?.facts?.reposRoot ?? (installationRoot.status === 'loaded' ? installationRoot.root : null)
    return root === null || root === undefined ? null : intakeRepositoryPath(root, intakeRepositorySlug(edited?.name ?? ''))
  }, [edited?.name, installationRoot, view?.facts])
  const newRootLabel = newRootPath ?? (installationRoot.status === 'failed' ? 'Repositories folder unavailable' : 'Loading repositories folder')

  const send = async (): Promise<void> => {
    if (intakeId === null || text.trim() === '') return
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/intakes/${intakeId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (response.status === 401) onUnauthorized()
      if (!response.ok) {
        setErrorText(errorMessage(await response.json().catch(() => null), response.status))
        return
      }
      setText('')
      await refresh(intakeId)
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const create = async (): Promise<void> => {
    if (intakeId === null || edited === null) return
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/intakes/${intakeId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: edited }),
      })
      if (response.status === 401) onUnauthorized()
      if (response.ok) {
        const body = (await response.json()) as { workspaceId: string }
        router.push(`/w/${body.workspaceId}`)
        return
      }
      setErrorText(errorMessage(await response.json().catch(() => null), response.status))
      await refresh(intakeId)
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  if (byHand) {
    return (
      <ProjectsPanel
        initial={{
          ...(edited === null ? {} : { name: edited.name, baseBranch: edited.baseBranch }),
          repoPath: edited?.repo.path ?? (edited?.repo.mode === 'new' ? newRootPath : view?.facts?.paths.find((path) => path.isRepository)?.path) ?? '',
          verifyText: (edited?.verifyCommands ?? candidates).map((entry) => entry.command).join('\n'),
          ...(edited?.setupCommands === undefined ? {} : { setupText: edited.setupCommands.join('\n') }),
          ...(edited?.budgetUsd === undefined || edited.budgetUsd === null ? {} : { budgetText: String(edited.budgetUsd) }),
          ...(edited?.provider === undefined || edited.provider === null ? {} : { provider: edited.provider }),
        }}
      />
    )
  }

  // M60 §7b: a repository that does not exist yet has no code, so no command could prove anything
  // about it and an empty list is the truthful answer -- `intakeDraftSchema` permits it for exactly
  // that case, and `acceptIntake` plants the bootstrap gate over it. Demanding one here made that
  // relaxation unreachable and pushed the person into typing a command instead, which reads as a
  // gate they chose: nothing is planted, nothing is asked to write it, and the project is gated on
  // a file that never arrives. An EXISTING repository is still held to it.
  const gateOptional = edited?.repo.mode === 'new'
  // Final review, Important 8: a persona has three people, so a fourth seat from one names somebody
  // who is not there. `intakeDraftSchema` refuses it and `acceptIntake` re-parses, so pressing the
  // button on such a draft is a round trip whose only outcome is a refusal; the card says which
  // persona instead, and the button stays off until the draft is one that can actually be staffed.
  const overStaffed =
    edited === null
      ? []
      : [
          ...new Set(
            edited.team
              .filter(
                (seat) =>
                  edited.team.filter((other) => other.templateId === seat.templateId).length >
                  INTAKE_MAX_SEATS_PER_TEMPLATE,
              )
              .map((seat) => seat.templateId),
          ),
        ]
  const draftReady =
    edited !== null &&
    (gateOptional || edited.verifyCommands.length > 0) &&
    edited.name.trim() !== '' &&
    overStaffed.length === 0
  const newRootReady = choice !== 'new-root' || newRootPath !== null

  return (
    <div data-testid="intake-conversation" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {(view?.messages ?? []).map((message) =>
          message.role === 'fact' && message.facts !== null ? (
            <FactCard key={message.seq} facts={message.facts} />
          ) : (
            <p
              key={message.seq}
              data-testid="intake-message"
              data-role={message.role}
              data-seq={message.seq}
              className={
                message.role === 'human'
                  ? 'self-end rounded-bubble bg-accent px-3 py-2 text-[13px] text-accent-ink'
                  : 'self-start rounded-bubble bg-card px-3 py-2 text-[13px] text-text-1'
              }
            >
              {message.text}
            </p>
          ),
        )}
        {waiting && (
          <span data-testid="intake-thinking" data-status={view?.status} title={view?.status} className="self-start text-[12.5px] text-text-3">
            {view === null ? '' : INTAKE_STATUS_LABEL[view.status]}…
          </span>
        )}
      </div>

      {view?.status === 'drafted' && edited !== null && (
        <div data-testid="intake-draft" className="flex flex-col gap-2 rounded-page-card border border-line bg-card p-3">
          <TextField
            label="name"
            inputProps={
              {
                'data-testid': 'intake-draft-name',
                'aria-label': 'project name',
                value: edited.name,
                onChange: (event) => setEdited({ ...edited, name: event.target.value }),
              } as InputHTMLAttributes<HTMLInputElement>
            }
          />

          <div data-testid="intake-repo-mode" data-choice={choice} className="flex flex-wrap gap-1">
            {(['existing', 'new-root', 'new-path'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`intake-repo-${option}`}
                aria-pressed={choice === option}
                onClick={() => {
                  setChoice(option)
                  setEdited({
                    ...edited,
                    repo:
                      option === 'existing'
                        ? { mode: 'existing', path: edited.repo.path ?? '' }
                        : { mode: 'new', path: option === 'new-root' ? null : (edited.repo.path ?? '') },
                  })
                }}
                className={`rounded-chip px-2 py-0.5 text-[12px] ${choice === option ? 'bg-hover text-text-1' : 'text-text-3'}`}
              >
                {{ existing: 'a repository I have', 'new-root': `a new one under ${newRootLabel}`, 'new-path': 'a new one at' }[option]}
              </button>
            ))}
          </div>
          {choice !== 'new-root' && (
            <TextField
              label="repository path"
              inputProps={
                {
                  'data-testid': 'intake-repo-path',
                  'aria-label': 'repository path',
                  value: edited.repo.path ?? '',
                  onChange: (event) =>
                    setEdited({ ...edited, repo: { mode: choice === 'existing' ? 'existing' : 'new', path: event.target.value } }),
                  className: 'w-full font-mono',
                } as InputHTMLAttributes<HTMLInputElement>
              }
            />
          )}

          <label className="flex flex-col gap-1">
            <FieldLabel>base branch</FieldLabel>
            <select
              data-testid="intake-base-branch"
              aria-label="base branch"
              value={edited.baseBranch}
              onChange={(event) => setEdited({ ...edited, baseBranch: event.target.value })}
              className={INPUT_SHELL}
            >
              {[...new Set([edited.baseBranch, ...(selectedPathFact?.branches ?? [])])].map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1">
            <FieldLabel>a task is done when these pass</FieldLabel>
            {gateOptional && edited.verifyCommands.length === 0 ? (
              <p data-testid="intake-verify-bootstrap" className="text-[12.5px] text-text-3">
                Nothing to run yet. This project starts with{' '}
                <span className="font-mono text-text-1">{INTAKE_BOOTSTRAP_VERIFY_COMMAND}</span>, planted with the
                repository; every task extends it with the checks for its own work. Leave this empty unless you
                already know a command that would pass.
              </p>
            ) : null}
            {candidates.map((entry) => (
              <label key={entry.command} className="flex items-center gap-1.5 text-[12.5px]">
                <input
                  type="checkbox"
                  data-testid="intake-verify"
                  data-command={entry.command}
                  data-source={entry.source}
                  title={entry.source}
                  aria-label={entry.command}
                  checked={edited.verifyCommands.some((command) => command.command === entry.command)}
                  onChange={(event) =>
                    setEdited({
                      ...edited,
                      verifyCommands: event.target.checked
                        ? [...edited.verifyCommands, entry]
                        : edited.verifyCommands.filter((command) => command.command !== entry.command),
                    })
                  }
                />
                <span className="font-mono text-text-1">{entry.command}</span>
                <span className="text-text-3">{VERIFY_SOURCE_LABEL[entry.source]}</span>
              </label>
            ))}
            <div className="flex gap-1">
              <input
                data-testid="intake-verify-add-input"
                aria-label="another verify command"
                value={addition}
                onChange={(event) => setAddition(event.target.value)}
                className={`${INPUT_SHELL} flex-1 font-mono`}
              />
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="intake-verify-add"
                onClick={() => {
                  const command = addition.trim()
                  if (command === '') return
                  setEdited({ ...edited, verifyCommands: [...edited.verifyCommands, { command, source: 'operator' }] })
                  setAddition('')
                }}
              >
                add
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label="budget (usd)"
              inputProps={
                {
                  type: 'number',
                  step: '0.01',
                  'data-testid': 'intake-draft-budget',
                  'aria-label': 'project budget',
                  value: edited.budgetUsd === null ? '' : String(edited.budgetUsd),
                  onChange: (event) =>
                    setEdited({ ...edited, budgetUsd: event.target.value === '' ? null : Number(event.target.value) }),
                  className: 'w-28',
                } as InputHTMLAttributes<HTMLInputElement>
              }
            />
            <label className="flex flex-col gap-1">
              <FieldLabel>provider</FieldLabel>
              {/* H3: a project born from a conversation is born with a runtime -- so a draft the
                * model left at `null` is shown PRESELECTED on the installation default, not on an
                * empty "none", and `acceptIntake` (`draft.provider ?? SUPERVISOR_DEFAULT_PROVIDER`)
                * is what actually resolves it. The state stays `null` until the person explicitly
                * picks something: submitting an untouched card still posts `provider: null`, the
                * same body the route schema already accepted, and control applies the default --
                * the "null means the installation default" idiom this codebase already uses for
                * the Supervisor's own runtime pair (`workspace-settings-routes`, `supervisorChat`). */}
              <ProviderSelect
                ariaLabel="project provider"
                testId="intake-draft-provider"
                value={edited.provider ?? SUPERVISOR_DEFAULT_PROVIDER}
                onChange={(value: ProviderKind | '') => setEdited({ ...edited, provider: value === '' ? null : value })}
                disabled={pending}
                placeholder="installation default"
                className={INPUT_SHELL}
              />
              {edited.provider === null && (
                <span data-testid="intake-draft-provider-default" className="text-[11.5px] text-text-3">
                  {PROVIDER_LABEL[SUPERVISOR_DEFAULT_PROVIDER]} is the installation default.
                </span>
              )}
            </label>
          </div>

          {/* E R7/R1 §4: the two switches a project is born with, both on -- `intakeDraftSchema`
            * defaults them, so an untouched card creates a project that merges its own approved
            * work and lets its Supervisor carry out what it decides. Unticking either is the
            * person saying otherwise, and what the boxes read is what `acceptIntake` writes. */}
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1.5 text-[12.5px]">
              <input
                type="checkbox"
                data-testid="intake-auto-merge"
                aria-label="merge approved work automatically"
                checked={edited.autoMerge}
                onChange={(event) => setEdited({ ...edited, autoMerge: event.target.checked })}
              />
              <span className="text-text-1">merge approved work automatically</span>
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px]">
              <input
                type="checkbox"
                data-testid="intake-autonomy"
                aria-label="act on its own"
                checked={edited.autonomy === 'act'}
                onChange={(event) => setEdited({ ...edited, autonomy: event.target.checked ? 'act' : 'propose' })}
              />
              <span className="text-text-1">act on its own</span>
            </label>
          </div>

          {edited.team.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {edited.team.map((seat, index) => (
                <span
                  // The INDEX, not the template (final review, Important 8): three seats from one
                  // persona is a legal team, and three chips keyed by one `templateId` are three
                  // duplicate keys -- which React reconciles as one element and warns about.
                  key={`${seat.templateId}-${String(index)}`}
                  data-testid="intake-team-chip"
                  data-template-id={seat.templateId}
                  data-roles={seat.runtimeRoles.join(',')}
                  title={seat.runtimeRoles.join(', ')}
                  className="rounded-chip bg-hover px-1.5 py-0.5 text-[11.5px] text-text-2"
                >
                  {view.facts?.catalogue.find((entry) => entry.templateId === seat.templateId)?.name ?? seat.templateId}
                  {' · '}
                  {seat.runtimeRoles.join(', ')}
                </span>
              ))}
            </div>
          )}

          {overStaffed.length > 0 && (
            <p data-testid="intake-team-over-limit" className="text-[12px] text-danger">
              {overStaffed
                .map((templateId) => view.facts?.catalogue.find((entry) => entry.templateId === templateId)?.name ?? templateId)
                .join(', ')}
              {overStaffed.length === 1 ? ' is asked for' : ' are asked for'} more than three times. Only three people
              exist for any one persona -- ask for at most three seats from it.
            </p>
          )}

          <Button variant="primary" size="sm" type="button" data-testid="intake-create" disabled={pending || !draftReady || !newRootReady} onClick={() => void create()}>
            Create project
          </Button>
        </div>
      )}

      {view !== null && view.stepLog.length > 0 && (
        <ol data-testid="intake-step-log" className="flex flex-col gap-0.5 rounded-tile border border-line bg-card px-2 py-1.5 text-[12px]">
          {view.stepLog.map((entry) => (
            <li
              key={`${entry.step}-${entry.at}`}
              data-testid="intake-step"
              data-step={entry.step}
              data-status={entry.status}
              data-detail={entry.detail ?? undefined}
              title={entry.status}
            >
              {INTAKE_STEP_LABEL[entry.step as IntakeStep]} - {INTAKE_STEP_STATUS_LABEL[entry.status]}
            </li>
          ))}
        </ol>
      )}

      {view?.status === 'failed' && (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" type="button" data-testid="intake-retry" disabled={pending} onClick={() => void create()}>
            Retry
          </Button>
          {view.workspaceId !== null && (
            <a data-testid="intake-created-link" className="text-[12.5px] underline" href={`/w/${view.workspaceId}`}>
              the project it did create
            </a>
          )}
        </div>
      )}

      {intakeId === null && errorText !== null && (
        <Button variant="primary" size="sm" type="button" data-testid="intake-open-retry" disabled={opening} onClick={() => void open()}>
          Retry opening conversation
        </Button>
      )}

      {view?.status !== 'drafted' && (
        <form
          data-testid="intake-composer"
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!pending && !waiting) void send()
          }}
        >
          <input
            aria-label="what do you want to build"
            placeholder="what do you want to build?"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={intakeId === null || pending || waiting}
            className={`${INPUT_SHELL} flex-1`}
          />
          <Button
            variant="primary"
            size="sm"
            type="submit"
            data-testid="intake-send"
            disabled={intakeId === null || pending || waiting || text.trim() === ''}
          >
            send
          </Button>
        </form>
      )}

      <div className="flex items-center justify-between text-[12px] text-text-3">
        <button type="button" data-testid="intake-by-hand" className="underline" disabled={!newRootReady} onClick={() => setByHand(true)}>
          fill in by hand
        </button>
        <button type="button" className="underline" onClick={onClose}>
          close
        </button>
      </div>

      {(errorText !== null || view?.failureReason != null) && (
        <span role="alert" data-testid="intake-error" className="text-xs text-tone-blocked">
          {errorText ?? view?.failureReason}
        </span>
      )}
    </div>
  )
}
