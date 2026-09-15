'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@slave-of-ai/control'
import type { RosterCompany } from '../../server/org'
import { ModelSelect } from '../ModelSelect'
import { ProviderSelect } from '../ProviderSelect'
import type { TemplateRow } from '../workforce/TemplateForm'
import { FieldLabel, INPUT_SHELL, SelectField, TextField } from '../ui/FormControls'
import { Drawer } from '../ui/Drawer'
import { Button } from '../ui/Button'

/**
 * "New slave" (M58 R24): a slave does not need a project. Persona and name are the form;
 * department and project are optional and empty by default -- with neither, they land in the pool.
 *
 * ONE call: `POST /api/org/slaves`. The route itself sequences create, optional department join
 * and optional seat; a refusal of a later step does not undo the person.
 */
export function NewSlaveDrawer({
  open,
  onClose,
  roster,
  templates,
  teams,
  defaultTeamId,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
  readonly teams: readonly { readonly teamId: string; readonly name: string; readonly workspaceId: string; readonly projectName: string }[]
  readonly defaultTeamId?: string
}): React.JSX.Element | null {
  const router = useRouter()
  const [companyTeamId, setCompanyTeamId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [model, setModel] = useState('')
  const [teamId, setTeamId] = useState(defaultTeamId ?? '')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [landedInPool, setLandedInPool] = useState(false)

  const reset = (): void => {
    setCompanyTeamId('')
    setTemplateId('')
    setName('')
    setProvider('')
    setModel('')
    setTeamId(defaultTeamId ?? '')
    setPending(false)
    setErrorText(null)
    setLandedInPool(false)
  }

  const close = (): void => {
    if (pending) return
    reset()
    onClose()
  }

  if (!open) return null

  const departments = roster.flatMap((company) =>
    company.teams.map((team) => ({
      companyTeamId: team.companyTeamId,
      label: `${team.teamName} (${company.companyName})`,
    })),
  )
  const ready = templateId !== '' || name.trim() !== ''

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch('/api/org/slaves', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(templateId === '' ? {} : { templateId }),
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          ...(provider === '' ? {} : { provider }),
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          ...(companyTeamId === '' ? {} : { companyTeamId }),
          ...(teamId === '' ? {} : { teamId }),
        }),
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setErrorText(
          payload !== null && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'that slave could not be made',
        )
        return
      }
      setLandedInPool(companyTeamId === '' && teamId === '')
      reset()
      router.refresh()
      onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <Drawer open={open} onClose={close} label="New slave" testId="new-slave-drawer" dismissible={!pending}>
      <div className="flex items-center justify-between">
        <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New slave</h2>
        <button type="button" data-testid="new-slave-close" onClick={close} className="text-text-3 hover:text-text-1">
          ✕
        </button>
      </div>
      <p className="text-xs text-text-3">
        a slave does not need a project. Pick a persona, give them a name, and they wait in the pool until somebody seats them.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <SelectField
          label="Persona"
          selectProps={{ 'aria-label': 'persona', 'data-testid': 'new-slave-persona', value: templateId, disabled: pending, onChange: (event) => setTemplateId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">select a persona</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </SelectField>
        <TextField
          label="Name"
          inputProps={{ 'aria-label': 'slave name', 'data-testid': 'new-slave-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
        />
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1">
            <FieldLabel>Provider</FieldLabel>
            <ProviderSelect testId="new-slave-provider" ariaLabel="provider" value={provider} onChange={setProvider} disabled={pending} placeholder="select a provider" className={`w-40 ${INPUT_SHELL}`} />
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Model</FieldLabel>
            <ModelSelect provider={provider} value={model} onChange={setModel} disabled={pending} ariaLabel="model" inputTestId="new-slave-model-input" className="w-52" />
          </label>
        </div>
        <SelectField
          label="Department (optional)"
          selectProps={{ 'aria-label': 'department', 'data-testid': 'new-slave-department', value: companyTeamId, disabled: pending, onChange: (event) => setCompanyTeamId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">no department</option>
          {departments.map((d) => (
            <option key={d.companyTeamId} value={d.companyTeamId}>{d.label}</option>
          ))}
        </SelectField>
        <SelectField
          label="Project (optional)"
          selectProps={{ 'aria-label': 'assign to project', 'data-testid': 'new-slave-project', value: teamId, disabled: pending, onChange: (event) => setTeamId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">no project</option>
          {teams.map((team) => (
            <option key={team.teamId} value={team.teamId}>{`${team.projectName} — ${team.name}`}</option>
          ))}
        </SelectField>
        <p data-testid="new-slave-pool-note" className="text-xs text-text-3">
          {companyTeamId === '' && teamId === ''
            ? 'with no department and no project, this slave lands in the pool'
            : 'they will be put to work as soon as they are made'}
        </p>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" type="submit" data-testid="new-slave-submit" disabled={pending || !ready}>
            {pending ? 'creating…' : landedInPool ? 'created — in the pool' : 'Create slave'}
          </Button>
          {errorText !== null && (
            <span role="alert" data-testid="new-slave-error" className="text-xs text-tone-blocked">
              {errorText}
            </span>
          )}
        </div>
      </form>
    </Drawer>
  )
}
