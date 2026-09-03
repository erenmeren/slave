'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import { errorMessage } from '../lib/postControl'
import { ProviderSelect } from './ProviderSelect'
import { FieldLabel, INPUT_SHELL, PrimaryButton, TextField } from './ui/FormControls'

/** One command per line, trimmed, blanks dropped -- the shape both `verifyCommands` and
 *  `setupCommands` want, and the shape the CLI's own repeatable `--verify`/`--setup` flags land in
 *  after `createWorkspace`'s `cleanCommands` (`packages/control/src/workspace.ts`). */
function splitCommands(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Settings' "attach a repository" form (M23 spec §2 A3): the `CompanyManager` idiom (local state,
 * `pending`, `errorText`, `role="alert"` error span) with `RuntimeCard`'s "not budgeted" checkbox
 * pattern for the budget field.
 *
 * Not `sendControl`: `POST /api/org/workspaces` is the one org route whose success body carries an
 * `id` (spec §2 A3) rather than the bare `{ ok: true }` every other org route returns, so this form
 * dials `fetch` directly and reads the refusal text with the same `errorMessage` helper
 * `sendControl` uses internally.
 */
export function ProjectsPanel(): React.JSX.Element {
  const router = useRouter()
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const [verifyText, setVerifyText] = useState('')
  const [setupText, setSetupText] = useState('')
  const [budgetText, setBudgetText] = useState('20')
  const [unbudgeted, setUnbudgeted] = useState(false)
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const verifyCommands = splitCommands(verifyText)
  const canSubmit = name.trim() !== '' && repoPath.trim() !== '' && verifyCommands.length > 0

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const response = await fetch('/api/org/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        repoPath,
        baseBranch,
        verifyCommands,
        setupCommands: splitCommands(setupText),
        budgetUsd: unbudgeted ? null : Number(budgetText),
        provider: provider === '' ? null : provider,
      }),
    })
    setPending(false)
    if (response.ok) {
      const data = (await response.json()) as { id: string }
      router.push(`/w/${data.id}`)
      return
    }
    const data: unknown = await response.json().catch(() => null)
    setErrorText(errorMessage(data, response.status))
  }

  return (
    <form
      data-testid="create-workspace-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="name"
          inputProps={
            {
              'data-testid': 'create-workspace-name',
              'aria-label': 'workspace name',
              value: name,
              onChange: (event) => setName(event.target.value),
              disabled: pending,
              className: 'w-48',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <TextField
          label="repository path"
          inputProps={
            {
              'data-testid': 'create-workspace-repo',
              'aria-label': 'workspace repository path',
              placeholder: '/absolute/path/to/clone',
              value: repoPath,
              onChange: (event) => setRepoPath(event.target.value),
              disabled: pending,
              className: 'w-64 font-mono',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <TextField
          label="base branch"
          inputProps={
            {
              'data-testid': 'create-workspace-base',
              'aria-label': 'workspace base branch',
              value: baseBranch,
              onChange: (event) => setBaseBranch(event.target.value),
              disabled: pending,
              className: 'w-32',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1">
          <FieldLabel>verify commands (one per line)</FieldLabel>
          <textarea
            data-testid="create-workspace-verify"
            aria-label="workspace verify commands"
            rows={3}
            value={verifyText}
            onChange={(event) => setVerifyText(event.target.value)}
            disabled={pending}
            className={`${INPUT_SHELL} w-64 font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <FieldLabel>setup commands (one per line)</FieldLabel>
          <textarea
            data-testid="create-workspace-setup"
            aria-label="workspace setup commands"
            rows={3}
            value={setupText}
            onChange={(event) => setSetupText(event.target.value)}
            disabled={pending}
            className={`${INPUT_SHELL} w-64 font-mono`}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="budget (usd)"
          inputProps={
            {
              type: 'number',
              step: '0.01',
              'data-testid': 'create-workspace-budget',
              'aria-label': 'workspace budget',
              value: budgetText,
              onChange: (event) => setBudgetText(event.target.value),
              disabled: pending || unbudgeted,
              className: 'w-32',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="create-workspace-no-budget"
            aria-label="workspace not budgeted"
            checked={unbudgeted}
            onChange={(event) => setUnbudgeted(event.target.checked)}
            disabled={pending}
          />
          <FieldLabel>not budgeted</FieldLabel>
        </label>
        <label className="flex flex-col gap-1">
          <FieldLabel>provider</FieldLabel>
          <ProviderSelect
            ariaLabel="workspace provider"
            testId="create-workspace-provider"
            value={provider}
            onChange={setProvider}
            disabled={pending}
            placeholder="none"
            className={INPUT_SHELL}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <PrimaryButton type="submit" data-testid="create-workspace-submit" disabled={pending || !canSubmit}>
          attach repository
        </PrimaryButton>
        {errorText !== null && (
          <span role="alert" data-testid="create-workspace-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>
    </form>
  )
}
