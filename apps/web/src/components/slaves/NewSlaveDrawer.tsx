'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@slave-of-ai/control'
import type { RosterCompany } from '../../server/org'
import { postControl, sendControl } from '../../lib/postControl'
import { ModelSelect } from '../ModelSelect'
import { ProviderSelect } from '../ProviderSelect'
import type { TemplateRow } from '../TemplateCatalog'
import { FieldLabel, INPUT_SHELL, SelectField, TextField } from '../ui/FormControls'
import { Drawer } from '../ui/Drawer'
import { Button } from '../ui/Button'

const NEW_DEPARTMENT = '__new__'

/**
 * "New slave" (M25 §6): the catalog form -- company, department template, slave template, name,
 * provider+model -- with an optional "assign to project" step. Two existing calls in sequence:
 * `POST /api/org/slaves`, then `POST /api/w/:id/company` when a project was chosen. If the first
 * succeeds and the second is refused, the drawer stays open showing the refusal and says the
 * catalog row exists (nothing is rolled back). `NewProjectDrawer`'s frame, which is `ui/Drawer` now (M44 R3).
 *
 * Fix round 1 (Important findings): `SlavesClient` renders this unconditionally -- `!open`
 * returns `null`, it never unmounts -- so its form state outlives a close/reopen unless reset
 * explicitly. `reset()` clears every field; `close()` wraps it around `onClose` and is the ONLY
 * path the scrim, the ✕ button and Escape use, plus a full success calls it instead of a bare
 * `onClose()`. Once `POST /api/org/slaves` succeeds, `createdSlave` locks the submit button
 * (label "created") so a resubmission after a refused assign step can't re-POST the same
 * `companyTeamId`+`name` into a `duplicate_name` refusal -- the note's "assign from the project
 * card" and closing are the only paths forward, same as the ruling on Finding 1. A "new
 * department…" create is different: `POST /api/org/slaves` refusing it does NOT set
 * `createdSlave` (the slave itself never got made), so a retry may still proceed -- but it must
 * not recreate the department. `POST /api/org/teams` succeeding rewrites `companyTeamId` to the
 * real id and clears `newDepartment`, and the id is appended to `createdDepartments` so the
 * `<select>` has a real option to hold that value (Finding 2); `departmentJustCreatedNote` marks
 * that this submission's refusal followed a department create, so the drawer can say so.
 */
export function NewSlaveDrawer({
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
  const [createdSlave, setCreatedSlave] = useState(false)
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
    setCreatedSlave(false)
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
    if (createdSlave) return
    setPending(true)
    setErrorText(null)
    setCreatedButUnassigned(false)
    setDepartmentJustCreatedNote(false)
    let targetTeam = companyTeamId
    let justCreatedDepartment = false
    if (companyTeamId === NEW_DEPARTMENT) {
      // A raw `fetch` (this step wants the created id back, which `postControl` does not carry) --
      // so a network failure THROWS rather than answering, and an uncaught throw here left
      // `pending` true for good: the drawer could neither close nor retry (M25 final review).
      let created: Response
      try {
        created = await fetch('/api/org/teams', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ companyId, name: newDepartment }),
        })
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error))
        setPending(false)
        return
      }
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
      // The department now exists -- a retry after the slave step below refuses must address
      // it by its real id, not recreate it by resubmitting `__new__` (Finding 2).
      setCompanyTeamId(departmentId)
      setNewDepartment('')
      setCreatedDepartments((prev) => [...prev, { companyId, companyTeamId: departmentId, teamName: newDepartment }])
    }
    const slave = await postControl('/api/org/slaves', {
      companyTeamId: targetTeam,
      templateId,
      name,
      // The pair rule (`pairRefusal`): a provider never travels without a model.
      ...(model !== '' ? { model, ...(provider !== '' ? { provider } : {}) } : {}),
    })
    if (!slave.ok) {
      setErrorText(slave.error)
      setDepartmentJustCreatedNote(justCreatedDepartment)
      setPending(false)
      return
    }
    // The catalog row now exists -- a resubmission from here on must not repeat that POST
    // (Finding 1): only the note's instruction or closing are the paths forward.
    setCreatedSlave(true)
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
    // M44 R3: `ui/Drawer` owns Escape, the scrim, the Tab trap and focus restore. `dismissible`
    // carries the same mid-submit guard `close()` has always had -- the scrim and Escape are both
    // inert while a POST is in flight -- and `close` keeps its own copy, because the ✕ button
    // below routes through it too.
    <Drawer open={open} onClose={close} label="New slave" testId="new-slave-drawer" dismissible={!pending}>
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New slave</h2>
          <button type="button" data-testid="new-slave-close" onClick={close} className="text-text-3 hover:text-text-1">
            ✕
          </button>
        </div>
        <p className="text-xs text-text-3">add a slave to a company's catalog — and, if you pick a project, put it to work there now</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <SelectField
            label="Company"
            selectProps={{ 'aria-label': 'company', 'data-testid': 'new-slave-company', value: companyId, disabled: pending, onChange: (event) => { setCompanyId(event.target.value); setCompanyTeamId('') } } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a company</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </SelectField>
          <SelectField
            label="Department"
            selectProps={{ 'aria-label': 'department template', 'data-testid': 'new-slave-department', value: companyTeamId, disabled: pending || companyId === '', onChange: (event) => setCompanyTeamId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
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
              inputProps={{ 'aria-label': 'new department name', 'data-testid': 'new-slave-department-name', value: newDepartment, disabled: pending, onChange: (event) => setNewDepartment(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
            />
          )}
          <SelectField
            label="Template"
            selectProps={{ 'aria-label': 'slave template', 'data-testid': 'new-slave-template', value: templateId, disabled: pending, onChange: (event) => setTemplateId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a template</option>
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
            label="Assign to project (optional)"
            selectProps={{ 'aria-label': 'assign to project', 'data-testid': 'new-slave-project', value: workspaceId, disabled: pending, onChange: (event) => setWorkspaceId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">catalog only</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </SelectField>
          <div className="flex items-center gap-3">
            <Button variant="primary" size="sm" type="submit" data-testid="new-slave-submit" disabled={pending || !ready || createdSlave}>
              {createdSlave ? 'created' : pending ? 'creating…' : 'Create slave'}
            </Button>
            {errorText !== null && (
              <span role="alert" data-testid="new-slave-error" className="text-xs text-tone-blocked">
                {errorText}
              </span>
            )}
            {departmentJustCreatedNote && (
              <span data-testid="new-slave-note" className="text-xs text-text-3">
                department template created; the slave was refused
              </span>
            )}
          </div>
          {createdButUnassigned && <p className="text-xs text-text-3">catalog slave created; assign from the project card</p>}
        </form>
    </Drawer>
  )
}
