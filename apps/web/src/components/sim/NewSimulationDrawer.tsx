'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sectors, type SectorName } from '@slave-of-ai/simulation'
import { errorMessage } from '../../lib/postControl'
import { ModelSelect } from '../ModelSelect'
import { Drawer } from '../ui/Drawer'
import { SelectField, TextField } from '../ui/FormControls'
import { Button } from '../ui/Button'

export interface SimulationCompanyOption { readonly id: string; readonly name: string; readonly slaves: number }

const SECTOR_NAMES = Object.keys(sectors) as SectorName[]
const DEFAULT_CAP = '2.00'

/** Create a simulation from a catalog company (M29 §7; sector picker M31b §5). No source checkout,
 *  no branch, no verify command: a simulation runs on synthetic resources, and this form says so.
 *  The company list is per sector, filtered server-side to the companies whose frozen roster the
 *  chosen sector can actually staff (`companiesForSector`) -- so nothing offered here can be
 *  refused by `createSimulation` for a short roster; when a sector has no fitting company yet, the
 *  sector's own `rosterRequirement` explains why. `decisionProvider llm` (M31a §5) is a paid,
 *  capped run -- the model field, the cap and an explicit consent checkbox appear only then, and
 *  the submit stays disabled until the checkbox is checked. */
export function NewSimulationDrawer({
  open,
  onClose,
  companiesBySector,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly companiesBySector: Readonly<Record<SectorName, readonly SimulationCompanyOption[]>>
}): React.JSX.Element | null {
  const router = useRouter()
  // The default is the registry's own first entry, never a sector literal (review round 1,
  // Important #1) -- `SECTOR_NAMES` comes from `Object.keys(sectors)` above, which the registry
  // guarantees is non-empty, so the assertion is safe.
  const [sector, setSector] = useState<SectorName>(SECTOR_NAMES[0]!)
  const [companyId, setCompanyId] = useState('')
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState<'A' | 'B'>('A')
  const [seed, setSeed] = useState('1')
  const [decisionProvider, setDecisionProvider] = useState<'rules' | 'llm'>('rules')
  const [model, setModel] = useState('')
  const [cap, setCap] = useState(DEFAULT_CAP)
  const [consent, setConsent] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  if (!open) return null
  const isLlm = decisionProvider === 'llm'
  const companies = companiesBySector[sector] ?? []
  const submit = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const body: Record<string, unknown> = { companyId, name, policy, sector }
    const seedNumber = Number.parseInt(seed, 10)
    if (Number.isInteger(seedNumber)) body['seed'] = seedNumber
    if (isLlm) {
      body['decisionProvider'] = 'llm'
      body['modelProvider'] = 'claude_code'
      body['model'] = model
      body['maxModelCostUsd'] = Number.parseFloat(cap)
    }
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
    // M44 R3: `ui/Drawer`, with the same `!pending` guard the scrim and the Escape handler carried.
    <Drawer open={open} onClose={onClose} label="New simulation" testId="new-simulation-drawer" dismissible={!pending}>
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New simulation</h2>
          <button type="button" data-testid="new-simulation-close" onClick={() => { if (!pending) onClose() }} className="text-text-3 hover:text-text-1">✕</button>
        </div>
        <p className="text-xs text-text-3">
          {isLlm
            ? `a ${sector} company on synthetic data, decided by a model — no source checkout; the roster is frozen at creation`
            : `a ${sector} company on synthetic data, decided by the rules provider — no source checkout, no model call; the roster is frozen at creation`}
        </p>
        <SelectField
          label="sector"
          selectProps={{
            'aria-label': 'sector', 'data-testid': 'new-simulation-sector', value: sector, disabled: pending,
            onChange: (event) => { setSector(event.target.value as SectorName); setCompanyId('') },
          } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          {SECTOR_NAMES.map((s) => <option key={s} value={s}>{s}</option>)}
        </SelectField>
        <SelectField label="company" selectProps={{ 'aria-label': 'company', 'data-testid': 'new-simulation-company', value: companyId, disabled: pending, onChange: (event) => setCompanyId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          <option value="">select a company</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.slaves} {c.slaves === 1 ? 'slave' : 'slaves'}</option>)}
        </SelectField>
        {companies.length === 0 && <p data-testid="new-simulation-roster-hint" className="text-xs text-text-3">no catalog company fits yet — {sectors[sector].rosterRequirement}</p>}
        <TextField label="name" inputProps={{ 'aria-label': 'simulation name', 'data-testid': 'new-simulation-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
        <SelectField label="policy" selectProps={{ 'aria-label': 'policy', 'data-testid': 'new-simulation-policy', value: policy, disabled: pending, onChange: (event) => setPolicy(event.target.value as 'A' | 'B') } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          {/* The chosen sector's own prose (final fix wave): trade's two suppliers are not
              software's two review policies, and a hard-coded pair here printed trade's over both. */}
          <option value="A">{sectors[sector].policyLabels.A}</option>
          <option value="B">{sectors[sector].policyLabels.B}</option>
        </SelectField>
        <TextField label="seed" inputProps={{ 'aria-label': 'seed', 'data-testid': 'new-simulation-seed', value: seed, disabled: pending, inputMode: 'numeric', onChange: (event) => setSeed(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
        <SelectField label="decision provider" selectProps={{ 'aria-label': 'decision provider', 'data-testid': 'new-simulation-provider', value: decisionProvider, disabled: pending, onChange: (event) => setDecisionProvider(event.target.value as 'rules' | 'llm') } as React.SelectHTMLAttributes<HTMLSelectElement>}>
          <option value="rules">rules — no model call</option>
          <option value="llm">llm — a model decides, capped</option>
        </SelectField>
        {isLlm && (
          <>
            <span className="flex flex-col gap-1">
              <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">model</span>
              <ModelSelect provider="claude_code" value={model} onChange={setModel} disabled={pending} ariaLabel="model" inputTestId="new-simulation-model" />
            </span>
            <TextField label="cost cap (USD)" inputProps={{ 'aria-label': 'cost cap', 'data-testid': 'new-simulation-cap', value: cap, disabled: pending, inputMode: 'decimal', onChange: (event) => setCap(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
            <label className="flex items-center gap-2 text-xs text-text-2">
              <input type="checkbox" data-testid="new-simulation-consent" checked={consent} disabled={pending} onChange={(event) => setConsent(event.target.checked)} />
              I understand this run makes paid model calls up to the cap
            </label>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" data-testid="new-simulation-submit" disabled={pending || companyId === '' || name.trim() === '' || (isLlm && !consent)} onClick={() => void submit()}>{pending ? 'creating…' : 'Create simulation'}</Button>
          {errorText !== null && <span role="alert" data-testid="new-simulation-error" className="text-xs text-tone-blocked">{errorText}</span>}
        </div>
    </Drawer>
  )
}
