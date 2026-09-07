'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSimulationStream } from '../../hooks/useSimulationStream'
import { formatMinor } from '../../lib/money'
import { sendControl } from '../../lib/postControl'
import type { SimulationSnapshot, JournalRow } from '../../server/simulation'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { PrimaryButton, GhostButton, SelectField, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { AutoRunControls } from './AutoRunControls'
import { CloneDrawer } from './CloneDrawer'
import { JournalTable } from './JournalTable'
import { SimulationStrip } from './SimulationStrip'

type Tab = 'overview' | 'decisions' | 'journal'
const METRIC_LABELS = { deliveredQty: 'delivered', onTimeQty: 'on time', lateDays: 'late days', purchaseCostMinor: 'purchase cost', closingInventory: 'closing stock', closingCashMinor: 'closing cash', minCashMinor: 'minimum cash', collectedMinor: 'collected', unpaidCommitmentsMinor: 'unpaid commitments' } as const
const MONEY = new Set(['purchaseCostMinor', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor'])

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

/** The simulation run page's body (M29 T10): a persistent strip that says what this is (and is
 *  not), the control surface (step/run-to/pause/resume/halt/inject), the simulated company's
 *  numbers kept apart from the one figure that is real money (spend on the deciding model), and
 *  three tabs — the rolled-up metrics, per-decision detail, and the raw journal. */
export function SimulationClient({ initial }: { readonly initial: SimulationSnapshot }): React.JSX.Element {
  const router = useRouter()
  const { summary, company, metrics, currency } = initial
  const [tab, setTab] = useState<Tab>('overview')
  const [runToDay, setRunToDay] = useState(String(summary.horizonDays))
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [inject, setInject] = useState({ kind: 'demand', day: String(company.day + 1), qty: '10', unitPrice: '120.00', dueInDays: '10', collectInDays: '15', supplierId: 'normal', extraDays: '3' })
  const stream = useSimulationStream(summary.id, summary.version, summary.status)
  // Fix wave, Important #1: a status verb (auto-run's error halt, a CLI pause/halt/stop-auto-run)
  // never bumps `version`, so `version` alone would leave this page stale until reload.
  useEffect(() => { if (stream.version !== summary.version || stream.status !== summary.status) router.refresh() }, [stream.version, stream.status, summary.version, summary.status, router])
  const runnable = summary.status === 'ready' || summary.status === 'running'
  // Step / Run-to-day are refused while an auto-run owns this run (a manual step during auto-run
  // is a UI refusal, not the control verb's) -- but Pause and Halt must stay live regardless
  // (spec §4: pause clears the intent, which is exactly what should stop an auto-run in flight).
  const steppable = runnable && summary.autoRun === null
  const base = `/api/sim/${summary.id}`

  const call = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`${base}/${path}`, body === undefined ? { method: 'POST' } : { method: 'POST', body })
    setPending(false)
    if (error !== null) setErrorText(error)
    else router.refresh()
  }
  const stepBody = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...extra, expectedVersion: summary.version, idempotencyKey: newKey() })
  const submitInject = (): Promise<void> => {
    const day = Number.parseInt(inject.day, 10)
    const event = inject.kind === 'demand'
      ? { type: 'demand', qty: Number.parseInt(inject.qty, 10), unitPriceMinor: Math.round(Number.parseFloat(inject.unitPrice) * 100), dueInDays: Number.parseInt(inject.dueInDays, 10), collectInDays: Number.parseInt(inject.collectInDays, 10) }
      : { type: 'supplier_delay', supplierId: inject.supplierId, extraDays: Number.parseInt(inject.extraDays, 10) }
    return call('inject', { day, event, idempotencyKey: newKey() })
  }
  // The panel's text (M31a §5): an `llm` run with a cap reads `$<spent> of $<cap>` -- `spent` at
  // four decimals so a real but tiny call never rounds to the misleading `$0.00`, `cap` at two
  // since it is the operator's own round figure -- plus an `unmeasured` count when > 0. A `rules`
  // run (or an `llm` run whose cap is somehow absent) keeps the M31 count-and-total reading.
  const modelUsageText = ((): string => {
    const usage = initial.modelUsage
    if (summary.decisionProvider === 'llm' && usage.capUsd !== null) {
      // Fix round 1, Minor #1: `spentUsd === null` means every call so far is unmeasured -- there
      // is no real figure to print, so the word replaces it rather than a `spentUsd ?? 0` that
      // would read as an accurate $0.00 and hide the very calls the `unmeasured` count names.
      const spentText = usage.spentUsd === null ? 'unmeasured' : `$${usage.spentUsd.toFixed(4)}`
      const unmeasuredSuffix = usage.unmeasured > 0 ? ` · ${usage.unmeasured} unmeasured` : ''
      return `${spentText} of $${usage.capUsd.toFixed(2)}${unmeasuredSuffix}`
    }
    if (usage.rows.length === 0) return `${summary.decisionProvider} provider — no model calls; cost: no record`
    return `${usage.rows.length} calls · ${usage.spentUsd === null ? 'cost unmeasured' : `$${usage.spentUsd.toFixed(2)}`}${usage.unmeasured > 0 ? ` · ${usage.unmeasured} unmeasured` : ''}`
  })()
  // A decision's own cost (M31a §5): matched by the usage row whose `seq` equals the decision
  // payload's `usageSeq`, never by array position -- `unmeasured` when that row's cost is still
  // null, and the same text when no row is found at all (the usage insert has not committed yet).
  const costForDecision = (d: JournalRow): string => {
    const usageSeq = d.payload['usageSeq']
    const row = initial.modelUsage.rows.find((r) => r.seq === usageSeq)
    return row === undefined || row.costUsd === null ? 'unmeasured' : `$${row.costUsd.toFixed(4)}`
  }
  const decisions = initial.journal.filter((row) => row.kind === 'decision')
  // Matched by the journal's own `actionIndex`, not by array position — the outcome rows for a
  // decision's several actions can land out of order (a later action's rejection can be journalled
  // before an earlier action's own applied row), so zipping by index `i` would mislabel them.
  const outcomeFor = (decision: JournalRow, actionIndex: number): JournalRow | undefined =>
    initial.journal.find((row) => (row.kind === 'action_applied' || row.kind === 'action_rejected') && row.simTime === decision.simTime && row.actorRole === decision.actorRole && row.payload['index'] === decision.payload['index'] && row.payload['actionIndex'] === actionIndex)

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <SimulationStrip summary={summary} connection={stream.connection} />
      <div className="flex flex-col gap-4 p-6">
        <div data-testid="sim-controls" className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-[14.5px] font-semibold text-text-1">{summary.name}</h1>
          {summary.decisionProvider === 'llm' ? (
            <span className="text-xs text-text-3">an llm run steps only through auto-run (the daemon makes the model calls); a call already in flight finishes and is billed</span>
          ) : (
            <>
              <PrimaryButton data-testid="sim-step" disabled={pending || !steppable} onClick={() => void call('step', stepBody({ steps: 1 }))}>Step 1 day</PrimaryButton>
              <TextField inputProps={{ 'aria-label': 'run to day', 'data-testid': 'sim-run-to-day', value: runToDay, inputMode: 'numeric', className: 'w-16', onChange: (event) => setRunToDay(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
              <PrimaryButton data-testid="sim-run-to" disabled={pending || !steppable} onClick={() => void call('step', stepBody({ untilDay: Number.parseInt(runToDay, 10) }))}>Run to day</PrimaryButton>
            </>
          )}
          {summary.status === 'paused' ? (
            <GhostButton data-testid="sim-resume" disabled={pending} onClick={() => void call('resume')}>Resume</GhostButton>
          ) : (
            <GhostButton data-testid="sim-pause" disabled={pending || !runnable} onClick={() => void call('pause')}>Pause</GhostButton>
          )}
          <DangerConfirm label="Halt" testId="sim-halt" confirmText="halt this simulation: no further step, ever" disabled={pending || summary.status === 'finished' || summary.status === 'halted'} onConfirm={async () => { const error = await sendControl(`${base}/halt`, { method: 'POST', body: { reason: 'operator' } }); if (error === null) router.refresh(); return error }} />
          <GhostButton data-testid="sim-inject-open" disabled={summary.status === 'finished' || summary.status === 'halted'} onClick={() => setInjectOpen((v) => !v)}>Add external event</GhostButton>
          <GhostButton data-testid="sim-clone-open" onClick={() => setCloneOpen(true)}>Clone…</GhostButton>
          <AutoRunControls summary={summary} pending={pending} onStart={(everyMs, untilDay) => void call('auto-run', { everyMs, untilDay })} onStop={() => void call('auto-run/stop')} />
          {initial.compareCandidates.length > 0 && (
            <SelectField
              label="compare with"
              selectProps={{
                'data-testid': 'sim-compare-with',
                defaultValue: '',
                onChange: (event) => { if (event.target.value !== '') router.push(`/sim/compare?a=${summary.id}&b=${event.target.value}`) },
              } as React.SelectHTMLAttributes<HTMLSelectElement>}
            >
              <option value="">compare with…</option>
              {initial.compareCandidates.map((c) => <option key={c.id} value={c.id}>{c.name} (policy {c.policy})</option>)}
            </SelectField>
          )}
          {errorText !== null && <span role="alert" data-testid="sim-error" className="text-xs text-tone-blocked">{errorText}</span>}
          {summary.status === 'halted' && (
            <span data-testid="sim-halted-note" className="text-xs text-text-3">
              halted{summary.haltedReason !== null ? ` (${summary.haltedReason})` : ''}
              {summary.decisionProvider === 'llm' ? '' : ' — stepping is in-request, so nothing was in flight to stop'}
            </span>
          )}
        </div>
        {injectOpen && (
          <div className="flex flex-wrap items-end gap-2 rounded-card border border-line bg-bg-2 p-3">
            <SelectField label="event" selectProps={{ 'data-testid': 'sim-inject-kind', value: inject.kind, onChange: (event) => setInject({ ...inject, kind: event.target.value }) } as React.SelectHTMLAttributes<HTMLSelectElement>}><option value="demand">customer demand</option><option value="supplier_delay">supplier delay</option></SelectField>
            <TextField label="day" inputProps={{ 'data-testid': 'sim-inject-day', value: inject.day, className: 'w-16', onChange: (event) => setInject({ ...inject, day: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
            {inject.kind === 'demand' ? (
              <>
                <TextField label="qty" inputProps={{ 'data-testid': 'sim-inject-qty', value: inject.qty, className: 'w-16', onChange: (event) => setInject({ ...inject, qty: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
                <TextField label={`unit price (${currency})`} inputProps={{ 'data-testid': 'sim-inject-price', value: inject.unitPrice, className: 'w-20', onChange: (event) => setInject({ ...inject, unitPrice: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
                <TextField label="due in days" inputProps={{ 'data-testid': 'sim-inject-due', value: inject.dueInDays, className: 'w-16', onChange: (event) => setInject({ ...inject, dueInDays: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
                <TextField label="collect in days" inputProps={{ 'data-testid': 'sim-inject-collect', value: inject.collectInDays, className: 'w-16', onChange: (event) => setInject({ ...inject, collectInDays: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
              </>
            ) : (
              <>
                <SelectField label="supplier" selectProps={{ 'data-testid': 'sim-inject-supplier', value: inject.supplierId, onChange: (event) => setInject({ ...inject, supplierId: event.target.value }) } as React.SelectHTMLAttributes<HTMLSelectElement>}><option value="normal">normal</option><option value="fast">fast</option></SelectField>
                <TextField label="extra days" inputProps={{ 'data-testid': 'sim-inject-extra-days', value: inject.extraDays, className: 'w-16', onChange: (event) => setInject({ ...inject, extraDays: event.target.value }) } as React.InputHTMLAttributes<HTMLInputElement>} />
              </>
            )}
            <PrimaryButton data-testid="sim-inject-submit" disabled={pending} onClick={() => void submitInject()}>Add</PrimaryButton>
            <span className="text-xs text-text-3">a clone of this run's scenario will not carry an event added here</span>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel title="Simulated company">
            <div data-testid="sim-company" className="flex flex-col gap-1 text-xs text-text-2">
              <div>day <span data-testid="sim-company-day">{company.day} / {summary.horizonDays}</span></div>
              <div>cash <span data-testid="sim-company-cash" className="font-mono text-text-1">{formatMinor(company.cashMinor, currency)}</span></div>
              <div>stock <span data-testid="sim-company-inventory">{company.inventory}</span> · capacity {company.dailyShipCapacity}/day</div>
              <div>open orders {company.openOrders} · pending demand {company.pendingDemand} · inbound purchases {company.inboundPurchases}</div>
              <div className="text-text-3">simulated money in {currency}; not real spend</div>
            </div>
          </Panel>
          <Panel title="Model usage (real)">
            <div data-testid="sim-model-usage" className="text-xs text-text-2">{modelUsageText}</div>
          </Panel>
        </div>
        <div role="tablist" aria-label="simulation sections" className="flex gap-2 text-xs">
          {(['overview', 'decisions', 'journal'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} data-testid={`sim-tab-${t}`} onClick={() => setTab(t)} className={`rounded px-2 py-1 ${tab === t ? 'bg-bg-2 text-text-1' : 'text-text-3'}`}>{t}</button>
          ))}
        </div>
        {tab === 'overview' && (
          <div role="tabpanel" aria-label="overview">
            <Panel title="Metrics (from the journal)">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {(Object.keys(METRIC_LABELS) as (keyof typeof METRIC_LABELS)[]).map((key) => {
                  const value = metrics[key]
                  const sources = (metrics.sources as Record<string, readonly string[] | undefined>)[key]
                  return (
                    <div key={key} data-testid={`sim-metric-${key}`} className="rounded-card border border-line bg-bg-2 p-2 text-xs">
                      <div className="text-text-3">{METRIC_LABELS[key]}{key === 'minCashMinor' ? ` (day ${metrics.minCashDay})` : ''}</div>
                      <div className="font-mono text-sm text-text-1">{MONEY.has(key) ? formatMinor(value, currency) : String(value)}</div>
                      {sources !== undefined && <div className="text-[10px] text-text-3">from {sources.join(', ')}</div>}
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 text-xs text-text-3">roles: {initial.roles.map((r) => `${r.name} — ${r.slaveName}`).join(' · ')}</div>
            </Panel>
          </div>
        )}
        {tab === 'decisions' && (
          <div role="tabpanel" aria-label="decisions">
            <Panel title="Decisions">
              <div className="flex flex-col gap-2">
                {decisions.map((d) => {
                  const isLlm = d.payload['provider'] === 'llm'
                  const parseError = d.payload['parseError']
                  return (
                    <div key={d.seq} data-testid="sim-decision-row" className="rounded-card border border-line bg-bg-2 p-2 text-xs text-text-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <span>day {d.simTime} · <span className="text-text-1">{d.actorRole}</span> · {String(d.payload['provider'])} provider</span>
                        {isLlm && (
                          <>
                            <Chip tone="working">llm</Chip>
                            <span className="font-mono">{String(d.payload['model'])}</span>
                            <span>{costForDecision(d)}</span>
                          </>
                        )}
                      </div>
                      {((d.payload['actions'] as { type: string; params: Record<string, unknown>; rationale: string }[] | undefined) ?? []).map((a, i) => {
                        const outcome = outcomeFor(d, i)
                        return <div key={i} className="ml-2">{a.type} {JSON.stringify(a.params)} — &ldquo;{a.rationale}&rdquo; → {outcome === undefined ? 'no outcome' : outcome.kind === 'action_applied' ? 'applied' : `rejected: ${JSON.stringify(outcome.payload['reason'])}`}</div>
                      })}
                      {((d.payload['actions'] as unknown[] | undefined) ?? []).length === 0 && <div className="ml-2 text-text-3">no action</div>}
                      {parseError !== undefined && <div className="ml-2 text-tone-blocked">parse error: {String(parseError)}</div>}
                    </div>
                  )
                })}
              </div>
            </Panel>
          </div>
        )}
        {tab === 'journal' && (
          <div role="tabpanel" aria-label="journal">
            <Panel title={`Journal (last ${initial.journal.length})`}><JournalTable rows={initial.journal} /></Panel>
          </div>
        )}
      </div>
      <CloneDrawer open={cloneOpen} onClose={() => setCloneOpen(false)} sourceId={summary.id} sourceName={summary.name} sourcePolicy={summary.policy} />
    </div>
  )
}
