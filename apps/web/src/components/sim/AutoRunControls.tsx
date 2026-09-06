import { useState } from 'react'
import type { SimulationSummary } from '@slave-of-ai/control'
import { GhostButton, PrimaryButton, SelectField, TextField } from '../ui/FormControls'

/** The auto-run control (M30 §6): hands the run to the orchestrator's daemon rather than the
 *  page's own click-to-step. It does not step anything itself -- it only sets the row's
 *  `autoRunEveryMs`/`autoRunUntilDay`, and a running `npm run orchestrator -- daemon` is what
 *  actually steps one day every `everyMs` at its own pace. */
export function AutoRunControls({
  summary,
  onStart,
  onStop,
  pending,
}: {
  readonly summary: SimulationSummary
  readonly onStart: (everyMs: number, untilDay: number) => void
  readonly onStop: () => void
  readonly pending: boolean
}): React.JSX.Element | null {
  const [everyMs, setEveryMs] = useState('1000')
  const [untilDay, setUntilDay] = useState(String(summary.horizonDays))
  const runnable = summary.status === 'ready' || summary.status === 'running'
  if (summary.autoRun !== null) {
    return (
      <GhostButton data-testid="sim-auto-run-stop" disabled={pending} onClick={onStop}>Stop auto-run</GhostButton>
    )
  }
  if (!runnable) return null
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField label="every" selectProps={{ 'data-testid': 'sim-auto-run-every', value: everyMs, onChange: (event) => setEveryMs(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}>
        <option value="250">250 ms</option>
        <option value="1000">1 s</option>
        <option value="5000">5 s</option>
      </SelectField>
      <TextField label="until day" inputProps={{ 'data-testid': 'sim-auto-run-until', value: untilDay, inputMode: 'numeric', className: 'w-16', onChange: (event) => setUntilDay(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
      <PrimaryButton data-testid="sim-auto-run-start" disabled={pending} onClick={() => onStart(Number.parseInt(everyMs, 10), Number.parseInt(untilDay, 10))}>Auto-run</PrimaryButton>
      <span className="text-xs text-text-3">steps one day every {everyMs} ms at the daemon&rsquo;s pace; needs <code>npm run orchestrator -- daemon</code> running</span>
    </div>
  )
}
