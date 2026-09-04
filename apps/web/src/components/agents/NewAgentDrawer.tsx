'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import type { RosterCompany } from '../../server/org'
import { postControl, sendControl } from '../../lib/postControl'
import { ModelSelect } from '../ModelSelect'
import { ProviderSelect } from '../ProviderSelect'
import type { TemplateRow } from '../TemplateCatalog'
import { FieldLabel, INPUT_SHELL, PrimaryButton, SelectField, TextField } from '../ui/FormControls'

const NEW_DEPARTMENT = '__new__'

/**
 * "New agent" (M25 §6): the catalog form -- company, department template, agent template, name,
 * provider+model -- with an optional "assign to project" step. Two existing calls in sequence:
 * `POST /api/org/agents`, then `POST /api/w/:id/company` when a project was chosen. If the first
 * succeeds and the second is refused, the drawer stays open showing the refusal and says the
 * catalog row exists (nothing is rolled back). `NewProjectDrawer`'s frame: scrim, dialog, Escape.
 */
export function NewAgentDrawer({
  open,
  onClose,
  companies,
  roster,
  templates,
  workspaces,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}): React.JSX.Element | null {
  const router = useRouter()
  const [companyId, setCompanyId] = useState('')
  const [companyTeamId, setCompanyTeamId] = useState('')
  const [newDepartment, setNewDepartment] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [model, setModel] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [createdButUnassigned, setCreatedButUnassigned] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const departments = roster.find((c) => c.companyId === companyId)?.teams ?? []
  const ready =
    companyId !== '' &&
    templateId !== '' &&
    name.trim() !== '' &&
    (companyTeamId === NEW_DEPARTMENT ? newDepartment.trim() !== '' : companyTeamId !== '')

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    setCreatedButUnassigned(false)
    let targetTeam = companyTeamId
    if (companyTeamId === NEW_DEPARTMENT) {
      const created = await fetch('/api/org/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, name: newDepartment }),
      })
      const data = (await created.json().catch(() => null)) as { id?: string; error?: string } | null
      if (!created.ok || data?.id === undefined) {
        setErrorText(data?.error ?? `request failed (${created.status})`)
        setPending(false)
        return
      }
      targetTeam = data.id
    }
    const agent = await postControl('/api/org/agents', {
      companyTeamId: targetTeam,
      templateId,
      name,
      // The pair rule (`pairRefusal`): a provider never travels without a model.
      ...(model !== '' ? { model, ...(provider !== '' ? { provider } : {}) } : {}),
    })
    if (!agent.ok) {
      setErrorText(agent.error)
      setPending(false)
      return
    }
    if (workspaceId !== '') {
      const error = await sendControl(`/api/w/${workspaceId}/company`, { method: 'POST', body: { companyId } })
      if (error !== null) {
        setErrorText(error)
        setCreatedButUnassigned(true)
        setPending(false)
        router.refresh()
        return
      }
    }
    setPending(false)
    router.refresh()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-agent-scrim" onClick={onClose} className="flex-1 bg-black/50" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="New agent"
        data-testid="new-agent-drawer"
        className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New agent</h2>
          <button type="button" data-testid="new-agent-close" onClick={onClose} className="text-text-3 hover:text-text-1">
            ✕
          </button>
        </div>
        <p className="text-xs text-text-3">add an agent to a company's catalog — and, if you pick a project, put it to work there now</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <SelectField
            label="Company"
            selectProps={{ 'aria-label': 'company', 'data-testid': 'new-agent-company', value: companyId, disabled: pending, onChange: (event) => { setCompanyId(event.target.value); setCompanyTeamId('') } } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a company</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </SelectField>
          <SelectField
            label="Department"
            selectProps={{ 'aria-label': 'department template', 'data-testid': 'new-agent-department', value: companyTeamId, disabled: pending || companyId === '', onChange: (event) => setCompanyTeamId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a department</option>
            {departments.map((d) => (
              <option key={d.companyTeamId} value={d.companyTeamId}>{d.teamName}</option>
            ))}
            <option value={NEW_DEPARTMENT}>new department…</option>
          </SelectField>
          {companyTeamId === NEW_DEPARTMENT && (
            <TextField
              label="New department name"
              inputProps={{ 'aria-label': 'new department name', 'data-testid': 'new-agent-department-name', value: newDepartment, disabled: pending, onChange: (event) => setNewDepartment(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
            />
          )}
          <SelectField
            label="Template"
            selectProps={{ 'aria-label': 'agent template', 'data-testid': 'new-agent-template', value: templateId, disabled: pending, onChange: (event) => setTemplateId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </SelectField>
          <TextField
            label="Name"
            inputProps={{ 'aria-label': 'agent name', 'data-testid': 'new-agent-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
          />
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <FieldLabel>Provider</FieldLabel>
              <ProviderSelect testId="new-agent-provider" ariaLabel="provider" value={provider} onChange={setProvider} disabled={pending} placeholder="select a provider" className={`w-40 ${INPUT_SHELL}`} />
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>Model</FieldLabel>
              <ModelSelect provider={provider} value={model} onChange={setModel} disabled={pending} ariaLabel="model" inputTestId="new-agent-model-input" className="w-52" />
            </label>
          </div>
          <SelectField
            label="Assign to project (optional)"
            selectProps={{ 'aria-label': 'assign to project', 'data-testid': 'new-agent-project', value: workspaceId, disabled: pending, onChange: (event) => setWorkspaceId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">catalog only</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </SelectField>
          <div className="flex items-center gap-3">
            <PrimaryButton type="submit" data-testid="new-agent-submit" disabled={pending || !ready}>
              {pending ? 'creating…' : 'Create agent'}
            </PrimaryButton>
            {errorText !== null && (
              <span role="alert" data-testid="new-agent-error" className="text-xs text-tone-blocked">
                {errorText}
              </span>
            )}
          </div>
          {createdButUnassigned && <p className="text-xs text-text-3">catalog agent created; assign from the project card</p>}
        </form>
      </aside>
    </div>
  )
}
