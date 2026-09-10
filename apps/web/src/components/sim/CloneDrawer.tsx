'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { sectors, type SectorName } from '@slave-of-ai/simulation'
import { errorMessage } from '../../lib/postControl'
import { Drawer } from '../ui/Drawer'
import { SelectField, TextField } from '../ui/FormControls'
import { Button } from '../ui/Button'

const OTHER: Record<'A' | 'B', 'A' | 'B'> = { A: 'B', B: 'A' }

/** Clones a run from its frozen definition (M30 §2.3): same scenario, same roster, same start —
 *  only a different policy or seed. No source checkout, no branch, no journal from the source. */
export function CloneDrawer({
  open, onClose, sourceId, sourceName, sourcePolicy, sector,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly sourceId: string
  readonly sourceName: string
  readonly sourcePolicy: 'A' | 'B'
  /** The source run's sector, off its own summary: a clone never changes sector, so the policy
   *  select here reads that sector's own prose rather than trade's (final fix wave). */
  readonly sector: SectorName
}): React.JSX.Element | null {
  const router = useRouter()
  const otherPolicy = OTHER[sourcePolicy]
  const [name, setName] = useState(`${sourceName} (${otherPolicy})`)
  const [policy, setPolicy] = useState<'A' | 'B'>(otherPolicy)
  const [seed, setSeed] = useState('1')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(`${sourceName} (${otherPolicy})`)
    setPolicy(otherPolicy)
    setSeed('1')
    setErrorText(null)
  }, [open, sourceName, otherPolicy])

  if (!open) return null
  const submit = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const body: Record<string, unknown> = { name, policy }
    const seedNumber = Number.parseInt(seed, 10)
    if (Number.isInteger(seedNumber)) body['seed'] = seedNumber
    try {
      const response = await fetch(`/api/sim/${sourceId}/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
    <Drawer open={open} onClose={onClose} label="Clone simulation" testId="sim-clone-drawer" dismissible={!pending}>
      <div className="flex items-center justify-between">
        <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">Clone simulation</h2>
        <button type="button" data-testid="sim-clone-close" onClick={() => { if (!pending) onClose() }} className="text-text-3 hover:text-text-1">✕</button>
      </div>
      <p className="text-xs text-text-3">same scenario, same roster, same start — a different policy or seed; nothing that happened in the source is carried over</p>
      <TextField label="name" inputProps={{ 'aria-label': 'clone name', 'data-testid': 'sim-clone-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
      <SelectField label="policy" selectProps={{ 'aria-label': 'clone policy', 'data-testid': 'sim-clone-policy', value: policy, disabled: pending, onChange: (event) => setPolicy(event.target.value as 'A' | 'B') } as React.SelectHTMLAttributes<HTMLSelectElement>}>
        <option value="A">{sectors[sector].policyLabels.A}</option>
        <option value="B">{sectors[sector].policyLabels.B}</option>
      </SelectField>
      <TextField label="seed" inputProps={{ 'aria-label': 'clone seed', 'data-testid': 'sim-clone-seed', value: seed, disabled: pending, inputMode: 'numeric', onChange: (event) => setSeed(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" data-testid="sim-clone-submit" disabled={pending || name.trim() === ''} onClick={() => void submit()}>{pending ? 'cloning…' : 'Clone simulation'}</Button>
        {errorText !== null && <span role="alert" data-testid="sim-clone-error" className="text-xs text-tone-blocked">{errorText}</span>}
      </div>
    </Drawer>
  )
}
