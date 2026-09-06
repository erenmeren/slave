'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { errorMessage } from '../../lib/postControl'
import { PrimaryButton, SelectField, TextField } from '../ui/FormControls'

export interface SimulationCompanyOption { readonly id: string; readonly name: string; readonly slaves: number }

/** Create a simulation from a catalog company (M29 §7). No source checkout, no branch, no verify
 *  command: the trade sector runs on simulated resources, and this form says so. */
export function NewSimulationDrawer({ open, onClose, companies }: { readonly open: boolean; readonly onClose: () => void; readonly companies: readonly SimulationCompanyOption[] }): React.JSX.Element | null {
  const router = useRouter()
  const [companyId, setCompanyId] = useState('')
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState<'A' | 'B'>('A')
  const [seed, setSeed] = useState('1')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !pending) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, pending])

  if (!open) return null
  const submit = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const body: Record<string, unknown> = { companyId, name, policy }
    const seedNumber = Number.parseInt(seed, 10)
    if (Number.isInteger(seedNumber)) body['seed'] = seedNumber
    try {
      const response = await fetch('/api/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) { setErrorText(errorMessage(data, response.status)); setPending(false); return }
      const id = typeof data === 'object' && data !== null && 'id' in data ? String((data as { id: unknown }).id) : ''
      setPending(false)
      onClose()
      router.push(`/sim/${id}`)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
      setPending(false)
    }
  }
  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-simulation-scrim" onClick={() => { if (!pending) onClose() }} className="flex-1 bg-black/50" />
      <aside role="dialog" aria-modal="true" aria-label="New simulation" data-testid="new-simulation-drawer" className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New simulation</h2>
          <button type="button" data-testid="new-simulation-close" onClick={() => { if (!pending) onClose() }} className="text-text-3 hover:text-text-1">✕</button>
        </div>
        <p className="text-xs text-text-3">a trade company on synthetic data, decided by the rules provider — no source checkout, no model call; the roster is frozen at creation</p>
        <SelectField label="company" selectProps={{ 'aria-label': 'company', 'data-testid': 'new-simulation-company', value: companyId, disabled: pending, onChange: (event) => setCompanyId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          <option value="">select a company</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.slaves} {c.slaves === 1 ? 'slave' : 'slaves'}{c.slaves < 4 ? ' (needs 4)' : ''}</option>)}
        </SelectField>
        <TextField label="name" inputProps={{ 'aria-label': 'simulation name', 'data-testid': 'new-simulation-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
        <SelectField label="policy" selectProps={{ 'aria-label': 'policy', 'data-testid': 'new-simulation-policy', value: policy, disabled: pending, onChange: (event) => setPolicy(event.target.value as 'A' | 'B') } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          <option value="A">A — wait for the normal supplier</option>
          <option value="B">B — hedge with the fast supplier when a delivery is at risk</option>
        </SelectField>
        <TextField label="seed" inputProps={{ 'aria-label': 'seed', 'data-testid': 'new-simulation-seed', value: seed, disabled: pending, inputMode: 'numeric', onChange: (event) => setSeed(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
        <div className="flex items-center gap-3">
          <PrimaryButton data-testid="new-simulation-submit" disabled={pending || companyId === '' || name.trim() === ''} onClick={() => void submit()}>{pending ? 'creating…' : 'Create simulation'}</PrimaryButton>
          {errorText !== null && <span role="alert" data-testid="new-simulation-error" className="text-xs text-tone-blocked">{errorText}</span>}
        </div>
      </aside>
    </div>
  )
}
