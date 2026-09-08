'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { errorMessage } from '../../lib/postControl'
import { PrimaryButton, SelectField, TextField } from '../ui/FormControls'

/** Fix round 1, Minor #4: a blank field or one that is not a whole number must not silently fall
 *  back to a default the person never chose -- it blocks the submit and says so. */
function isWholeNumber(text: string): boolean {
  return /^-?\d+$/.test(text.trim())
}

/** The GET `/api/sim/[id]/adoption` shape (control's `AdoptionPreview`, M33 §3). Mirrored here
 *  rather than imported from `@slave-of-ai/control`: `apps/web` reads it off the wire, the same way
 *  every other snapshot this app renders crosses the client/server boundary as plain JSON. */
export interface AdoptionPreview {
  readonly simulationId: string
  readonly companyId: string
  readonly companyName: string
  /** `runtimeRole` is what adoption actually WRITES to `Slave.role` (T1-E5 / ruling R2, control's
   *  `roleOverridesOf`) -- read off the preview rather than re-derived here (fix round 1, ruling
   *  R3): the run's `lead` becomes the runtime's `manager`, its `reviewer` stays `reviewer`, and
   *  every other member -- `product`, every engineer -- keeps the CATALOG role the planner already
   *  staffs by. */
  readonly roles: readonly { readonly slaveName: string; readonly catalogRole: string; readonly role: string; readonly runtimeRole: string }[]
  readonly settings: { readonly maxConcurrentRuns: number; readonly maxAttempts: number; readonly autoMerge: false }
  readonly model: { readonly provider: 'claude_code' | 'cursor'; readonly model: string } | null
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}

/**
 * Puts an organisation tried in a simulation onto a real, company-less project (M33 §4). Unlike
 * `CloneDrawer`, which works entirely off props the run page already has, this drawer fetches its
 * OWN preview on open: the roster it shows is the CURRENT one (§3's `adoptionPreview` reads the
 * roster fresh, not the frozen definition), and the eligible workspace list can only be known at
 * the moment the drawer opens.
 */
export function AdoptDrawer({
  open,
  onClose,
  simulationId,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly simulationId: string
}): React.JSX.Element | null {
  const router = useRouter()
  const [preview, setPreview] = useState<AdoptionPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState('')
  const [maxAttempts, setMaxAttempts] = useState('')
  const [applyModel, setApplyModel] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPreview(null)
    setPreviewError(null)
    setErrorText(null)
    setApplyModel(false)
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/api/sim/${simulationId}/adoption`)
        const data: unknown = await response.json().catch(() => null)
        if (cancelled) return
        if (!response.ok) {
          setPreviewError(errorMessage(data, response.status))
          return
        }
        const value = data as AdoptionPreview
        setPreview(value)
        setWorkspaceId(value.workspaces[0]?.id ?? '')
        setMaxConcurrentRuns(String(value.settings.maxConcurrentRuns))
        setMaxAttempts(String(value.settings.maxAttempts))
      } catch (error) {
        if (!cancelled) setPreviewError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, simulationId])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, pending])

  if (!open) return null

  const leadName = preview?.roles.find((row) => row.role === 'lead')?.slaveName ?? null
  const maxConcurrentValid = isWholeNumber(maxConcurrentRuns)
  const maxAttemptsValid = isWholeNumber(maxAttempts)

  const submit = async (): Promise<void> => {
    if (pending || preview === null || workspaceId === '' || !maxConcurrentValid || !maxAttemptsValid) return
    setPending(true)
    setErrorText(null)
    const body: Record<string, unknown> = {
      workspaceId,
      maxConcurrentRuns: Number.parseInt(maxConcurrentRuns, 10),
      maxAttempts: Number.parseInt(maxAttempts, 10),
    }
    if (applyModel) body['applyModel'] = true
    try {
      const response = await fetch(`/api/sim/${simulationId}/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setErrorText(errorMessage(data, response.status))
        setPending(false)
        return
      }
      const target =
        typeof data === 'object' && data !== null && 'workspaceId' in data
          ? String((data as { workspaceId: unknown }).workspaceId)
          : workspaceId
      setPending(false)
      onClose()
      router.push(`/w/${target}`)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="sim-adopt-scrim" onClick={() => { if (!pending) onClose() }} className="flex-1 bg-black/50" />
      <aside role="dialog" aria-modal="true" aria-label="Adopt this organisation" data-testid="sim-adopt-drawer" className="flex w-[560px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">Adopt this organisation</h2>
          <button type="button" data-testid="sim-adopt-close" onClick={() => { if (!pending) onClose() }} className="text-text-3 hover:text-text-1">✕</button>
        </div>
        <p className="text-xs text-text-3">the current roster, materialised with the run's roles; nothing runs and autoMerge stays off</p>
        {previewError !== null && <span role="alert" data-testid="sim-adopt-preview-error" className="text-xs text-tone-blocked">{previewError}</span>}
        {preview !== null && (
          <>
            <table data-testid="sim-adopt-roles" className="w-full text-left text-xs text-text-2">
              <thead>
                <tr className="text-text-3">
                  <th className="font-normal">slave</th>
                  <th className="font-normal">run role</th>
                  <th className="font-normal">becomes</th>
                </tr>
              </thead>
              <tbody>
                {preview.roles.map((row) => (
                  <tr key={row.slaveName} data-testid="sim-adopt-role-row">
                    <td>{row.slaveName}</td>
                    <td>{row.role}</td>
                    <td>{row.runtimeRole}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.workspaces.length === 0 ? (
              <p data-testid="sim-adopt-no-workspace" className="text-xs text-tone-blocked">no workspace without a company; create one from Projects first</p>
            ) : (
              <SelectField
                label="workspace"
                selectProps={{
                  'aria-label': 'adopt workspace',
                  'data-testid': 'sim-adopt-workspace',
                  value: workspaceId,
                  disabled: pending,
                  onChange: (event) => setWorkspaceId(event.target.value),
                } as React.SelectHTMLAttributes<HTMLSelectElement>}
              >
                {preview.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </SelectField>
            )}
            <TextField
              label="max concurrent runs"
              inputProps={{ 'aria-label': 'max concurrent runs', 'data-testid': 'sim-adopt-max-concurrent', value: maxConcurrentRuns, disabled: pending, inputMode: 'numeric', onChange: (event) => setMaxConcurrentRuns(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
            />
            {!maxConcurrentValid && <span role="alert" data-testid="sim-adopt-max-concurrent-error" className="text-xs text-tone-blocked">enter a whole number</span>}
            <TextField
              label="max attempts"
              inputProps={{ 'aria-label': 'max attempts', 'data-testid': 'sim-adopt-max-attempts', value: maxAttempts, disabled: pending, inputMode: 'numeric', onChange: (event) => setMaxAttempts(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
            />
            {!maxAttemptsValid && <span role="alert" data-testid="sim-adopt-max-attempts-error" className="text-xs text-tone-blocked">enter a whole number</span>}
            <div className="text-xs text-text-3">autoMerge <span data-testid="sim-adopt-automerge" className="text-text-2">off (locked)</span></div>
            {preview.model !== null && leadName !== null && (
              <label className="flex items-center gap-2 text-xs text-text-2">
                <input type="checkbox" data-testid="sim-adopt-apply-model" checked={applyModel} disabled={pending} onChange={(event) => setApplyModel(event.target.checked)} />
                also set {preview.model.model} on {leadName}&apos;s roster row — real, paid use
              </label>
            )}
            <div className="flex items-center gap-3">
              <PrimaryButton data-testid="sim-adopt-submit" disabled={pending || preview.workspaces.length === 0 || workspaceId === '' || !maxConcurrentValid || !maxAttemptsValid} onClick={() => void submit()}>
                {pending ? 'adopting…' : 'Adopt this organisation'}
              </PrimaryButton>
              {errorText !== null && <span role="alert" data-testid="sim-adopt-error" className="text-xs text-tone-blocked">{errorText}</span>}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
