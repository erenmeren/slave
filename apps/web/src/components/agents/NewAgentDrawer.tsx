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
 *
 * Fix round 1 (Important findings): `AgentsClient` renders this unconditionally -- `!open`
 * returns `null`, it never unmounts -- so its form state outlives a close/reopen unless reset
 * explicitly. `reset()` clears every field; `close()` wraps it around `onClose` and is the ONLY
 * path the scrim, the ✕ button and Escape use, plus a full success calls it instead of a bare
 * `onClose()`. Once `POST /api/org/agents` succeeds, `createdAgent` locks the submit button
 * (label "created") so a resubmission after a refused assign step can't re-POST the same
 * `companyTeamId`+`name` into a `duplicate_name` refusal -- the note's "assign from the project
 * card" and closing are the only paths forward, same as the ruling on Finding 1. A "new
 * department…" create is different: `POST /api/org/agents` refusing it does NOT set
 * `createdAgent` (the agent itself never got made), so a retry may still proceed -- but it must
 * not recreate the department. `POST /api/org/teams` succeeding rewrites `companyTeamId` to the
 * real id and clears `newDepartment`, and the id is appended to `createdDepartments` so the
 * `<select>` has a real option to hold that value (Finding 2); `departmentJustCreatedNote` marks
 * that this submission's refusal followed a department create, so the drawer can say so.
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
  const [createdAgent, setCreatedAgent] = useState(false)
  const [createdDepartments, setCreatedDepartments] = useState<
    readonly { readonly companyId: string; readonly companyTeamId: string; readonly teamName: string }[]
  >([])
  const [departmentJustCreatedNote, setDepartmentJustCreatedNote] = useState(false)

  const reset = (): void => {
    setCompanyId('')
    setCompanyTeamId('')
    setNewDepartment('')
    setTemplateId('')
    setName('')
    setProvider('')
    setModel('')
    setWorkspaceId('')
    setPending(false)
    setErrorText(null)
    setCreatedButUnassigned(false)
    setCreatedAgent(false)
    setCreatedDepartments([])
    setDepartmentJustCreatedNote(false)
  }

  const close = (): void => {
    // Folded minor (M25 final review): while a submit is in flight, the scrim, the ✕ button and
    // Escape all route here -- closing mid-request would tear down state a pending `fetch` still
    // writes into (`setPending`, `setErrorText`, ...) after the drawer looks closed, and would let
    // an operator navigate away from a request whose result they can no longer see. This guard
    // never blocks `submit()`'s OWN final `close()` call on success: that call runs inside the
    // same closure `submit` captured when it started (the render where the button was clicked,
    // `pending` still false there), so it reads that render's `pending`, not the live state --
    // only the scrim/✕/Escape handlers, rebound fresh on the re-render that flips `pending` true,
    // see the current value.
    if (pending) return
    reset()
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` is recreated every render
    // (it closes over `reset()`, `onClose` and now `pending`), but listing `close` itself here
    // would resubscribe on every render (it has no stable identity); `pending` is listed instead
    // of it. That is no longer optional the way it was before `close` gained its `pending` guard
    // (M25 final review, folded minor): this effect otherwise keeps the `close` closure from
    // whenever it last ran -- typically mount, `pending` false then -- forever, so Escape would
    // never see a submit's `pending` become true and the guard could never fire. `reset()` and
    // `onClose` still need no entry of their own, the same reasoning as before: `reset()` only
    // calls this component's own state setters and `onClose` is a prop that does no more than
    // that either, so a stale closure over either one re-arms the exact same listener a fresh one
    // would.
  }, [open, pending])

  if (!open) return null

  const departments = [
    ...(roster.find((c) => c.companyId === companyId)?.teams ?? []),
    ...createdDepartments.filter((d) => d.companyId === companyId),
  ]
  const ready =
    companyId !== '' &&
    templateId !== '' &&
    name.trim() !== '' &&
    (companyTeamId === NEW_DEPARTMENT ? newDepartment.trim() !== '' : companyTeamId !== '')

  const submit = async (): Promise<void> => {
    if (createdAgent) return
    setPending(true)
    setErrorText(null)
    setCreatedButUnassigned(false)
    setDepartmentJustCreatedNote(false)
    let targetTeam = companyTeamId
    let justCreatedDepartment = false
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
      // A local `const` so the narrowing above (`data.id` is no longer `undefined`) survives
      // into the `setCreatedDepartments` updater closure below -- TS does not carry a property
      // access's narrowing into a nested function, only a plain variable's.
      const departmentId = data.id
      targetTeam = departmentId
      justCreatedDepartment = true
      // The department now exists -- a retry after the agent step below refuses must address
      // it by its real id, not recreate it by resubmitting `__new__` (Finding 2).
      setCompanyTeamId(departmentId)
      setNewDepartment('')
      setCreatedDepartments((prev) => [...prev, { companyId, companyTeamId: departmentId, teamName: newDepartment }])
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
      setDepartmentJustCreatedNote(justCreatedDepartment)
      setPending(false)
      return
    }
    // The catalog row now exists -- a resubmission from here on must not repeat that POST
    // (Finding 1): only the note's instruction or closing are the paths forward.
    setCreatedAgent(true)
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
    router.refresh()
    close()
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-agent-scrim" onClick={close} className="flex-1 bg-black/50" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="New agent"
        data-testid="new-agent-drawer"
        className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New agent</h2>
          <button type="button" data-testid="new-agent-close" onClick={close} className="text-text-3 hover:text-text-1">
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
            <PrimaryButton type="submit" data-testid="new-agent-submit" disabled={pending || !ready || createdAgent}>
              {createdAgent ? 'created' : pending ? 'creating…' : 'Create agent'}
            </PrimaryButton>
            {errorText !== null && (
              <span role="alert" data-testid="new-agent-error" className="text-xs text-tone-blocked">
                {errorText}
              </span>
            )}
            {departmentJustCreatedNote && (
              <span data-testid="new-agent-note" className="text-xs text-text-3">
                department template created; the agent was refused
              </span>
            )}
          </div>
          {createdButUnassigned && <p className="text-xs text-text-3">catalog agent created; assign from the project card</p>}
        </form>
      </aside>
    </div>
  )
}
