'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ExternalEventForm } from '@slave-of-ai/simulation'
import { useSimulationStream } from '../../hooks/useSimulationStream'
import { metricValue } from '../../lib/metricValue'
import { formatMinor } from '../../lib/money'
import { sendControl } from '../../lib/postControl'
import type { SimulationSnapshot, JournalRow } from '../../server/simulation'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { SelectField, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { AdoptDrawer } from './AdoptDrawer'
import { AutoRunControls } from './AutoRunControls'
import { CloneDrawer } from './CloneDrawer'
import { JournalTable } from './JournalTable'
import { SimulationStrip } from './SimulationStrip'
import { Button } from '../ui/Button'

type Tab = 'overview' | 'decisions' | 'journal'

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

/** `'open orders'` → `'open-orders'`: a headline or metric label, as a `data-testid` suffix. */
function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** A field's starting text (M31b §5): the field's OWN `default` when its sector states one --
 *  trade's demand form opens on M29/M30's plausible order (qty 10 at 120.00, due in 10 days,
 *  collected in 15), which the first cut of this function flattened to `1` / `0.00` -- and
 *  otherwise a plain, always-parseable value by kind: `1` for a count or a day, `0.00` (major
 *  units) for money, the first option for a select. Switching the event kind resets every field to
 *  this, since the previous kind's fields may not even exist on the new one. */
function defaultInjectFieldValues(form: ExternalEventForm | undefined, injectOptions: SimulationSnapshot['injectOptions']): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of form?.fields ?? []) {
    if (field.kind === 'select') values[field.name] = injectOptions[field.optionsFrom ?? '']?.[0]?.id ?? ''
    else values[field.name] = field.default ?? (field.kind === 'money' ? '0.00' : '1')
  }
  return values
}

/** The simulation run page's body (M29 T10): a persistent strip that says what this is (and is
 *  not), the control surface (step/run-to/pause/resume/halt/inject), the simulated company's
 *  numbers kept apart from the one figure that is real money (spend on the deciding model), and
 *  three tabs — the rolled-up metrics, per-decision detail, and the raw journal. */
export function SimulationClient({ initial }: { readonly initial: SimulationSnapshot }): React.JSX.Element {
  const router = useRouter()
  const { summary, headline, metricLabels, metrics, currency, injectForms, injectOptions, adoptable } = initial
  const [tab, setTab] = useState<Tab>('overview')
  const [runToDay, setRunToDay] = useState(String(summary.horizonDays))
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [injectKind, setInjectKind] = useState(injectForms[0]?.type ?? '')
  const [injectDay, setInjectDay] = useState(String(summary.simTime + 1))
  const [injectFields, setInjectFields] = useState<Record<string, string>>(() => defaultInjectFieldValues(injectForms[0], injectOptions))
  const currentInjectForm = injectForms.find((f) => f.type === injectKind)
  // Switching the event kind resets every field to a fresh default (M31b §5): the previous kind's
  // fields may not even exist on the new one (trade's `qty` vs. software's `engineerId`).
  useEffect(() => { setInjectFields(defaultInjectFieldValues(currentInjectForm, injectOptions)) }, [injectKind]) // eslint-disable-line react-hooks/exhaustive-deps
  // Review round 1, Minor #1: a `select` field with nothing to select from would otherwise post
  // `''` as the field's value with no operator ever having chosen anything -- the submit is
  // blocked instead, and the field says so.
  const hasEmptyInjectSelect = (currentInjectForm?.fields ?? []).some((field) => field.kind === 'select' && (injectOptions[field.optionsFrom ?? ''] ?? []).length === 0)
  const stream = useSimulationStream(summary.id, summary.version, summary.status)
  // Fix wave, Important #1: a status verb (auto-run's error halt, a CLI pause or halt) never
  // bumps `version`, so `version` alone would leave this page stale until reload. (Stopping an
  // auto-run was the third such verb until M32 item 1 gave it a version bump of its own -- it
  // moves neither status nor day, so a bump was the only thing the stream could see it by.)
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
  // The event's own shape is the plugin's `externalEventForms` (M31b §5): each field parses by
  // its own `kind` -- `int` as an integer, `money` from the major-units text the input carries
  // (exactly as the trade unit-price field always converted) into the minor-unit field the event
  // schema wants, `select` as the raw option id -- so the trade fields end up posting exactly the
  // shape M29/M30 always posted, and a new sector's fields need no code here at all.
  const submitInject = (): Promise<void> => {
    const day = Number.parseInt(injectDay, 10)
    const fields: Record<string, unknown> = {}
    for (const field of currentInjectForm?.fields ?? []) {
      const raw = injectFields[field.name] ?? ''
      fields[field.name] = field.kind === 'int' ? Number.parseInt(raw, 10) : field.kind === 'money' ? Math.round(Number.parseFloat(raw) * 100) : raw
    }
    const event = { type: injectKind, ...fields }
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
      // Ruling R10: an unmeasured call is not free to the cap -- `prepareModelDecision` charges it
      // `PER_CALL_CAP_USD` ($1, the ceiling one call is spawned with), so the panel says so rather
      // than leaving an operator to read "$0.0038 of $2.00" and think the run has $1.9962 left.
      // M32 item 4: and it says what KIND of figure that is. $1.00 is the most such a call could
      // have cost, not what it did cost -- nobody knows what it cost -- so the cap arithmetic is
      // an estimate on the safe side, and a panel that stated it as a fact was overstating what
      // this system knows about the operator's own bill.
      const unmeasuredSuffix = usage.unmeasured > 0 ? ` · ${usage.unmeasured} unmeasured (charged as $1.00 each toward the cap, an estimate)` : ''
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
              <Button variant="primary" size="sm" data-testid="sim-step" disabled={pending || !steppable} onClick={() => void call('step', stepBody({ steps: 1 }))}>Step 1 day</Button>
              <TextField inputProps={{ 'aria-label': 'run to day', 'data-testid': 'sim-run-to-day', value: runToDay, inputMode: 'numeric', className: 'w-16', onChange: (event) => setRunToDay(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
              <Button variant="primary" size="sm" data-testid="sim-run-to" disabled={pending || !steppable} onClick={() => void call('step', stepBody({ untilDay: Number.parseInt(runToDay, 10) }))}>Run to day</Button>
            </>
          )}
          {summary.status === 'paused' ? (
            <Button variant="ghost" size="sm" data-testid="sim-resume" disabled={pending} onClick={() => void call('resume')}>Resume</Button>
          ) : (
            <Button variant="ghost" size="sm" data-testid="sim-pause" disabled={pending || !runnable} onClick={() => void call('pause')}>Pause</Button>
          )}
          <DangerConfirm label="Halt" testId="sim-halt" confirmText="halt this simulation: no further step, ever" disabled={pending || summary.status === 'finished' || summary.status === 'halted'} onConfirm={async () => { const error = await sendControl(`${base}/halt`, { method: 'POST', body: { reason: 'operator' } }); if (error === null) router.refresh(); return error }} />
          <Button variant="ghost" size="sm" data-testid="sim-inject-open" disabled={summary.status === 'finished' || summary.status === 'halted'} onClick={() => setInjectOpen((v) => !v)}>Add external event</Button>
          <Button variant="ghost" size="sm" data-testid="sim-clone-open" onClick={() => setCloneOpen(true)}>Clone…</Button>
          {adoptable && <Button variant="ghost" size="sm" data-testid="sim-adopt-open" onClick={() => setAdoptOpen(true)}>Adopt this organisation…</Button>}
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
            <SelectField label="event" selectProps={{ 'data-testid': 'sim-inject-kind', value: injectKind, onChange: (event) => setInjectKind(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}>
              {injectForms.map((form) => <option key={form.type} value={form.type}>{form.label}</option>)}
            </SelectField>
            <TextField label="day" inputProps={{ 'data-testid': 'sim-inject-day', value: injectDay, className: 'w-16', onChange: (event) => setInjectDay(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>} />
            {(currentInjectForm?.fields ?? []).map((field) => {
              const testId = field.testId ?? `sim-inject-${field.name}`
              const value = injectFields[field.name] ?? ''
              const onChange = (v: string): void => setInjectFields({ ...injectFields, [field.name]: v })
              if (field.kind === 'select') {
                const options = injectOptions[field.optionsFrom ?? ''] ?? []
                if (options.length === 0) return <span key={field.name} data-testid={testId} className="text-xs text-tone-blocked">no {field.label} available</span>
                return (
                  <SelectField key={field.name} label={field.label} selectProps={{ 'data-testid': testId, value, onChange: (event) => onChange(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </SelectField>
                )
              }
              // `money` reads and writes major units (the same text field the trade unit-price
              // field always was), converted to the minor-unit event field on submit.
              return (
                <TextField
                  key={field.name}
                  label={field.kind === 'money' ? `${field.label} (${currency})` : field.label}
                  inputProps={{ 'data-testid': testId, value, className: field.kind === 'money' ? 'w-20' : 'w-16', onChange: (event) => onChange(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
                />
              )
            })}
            <Button variant="primary" size="sm" data-testid="sim-inject-submit" disabled={pending || hasEmptyInjectSelect} onClick={() => void submitInject()}>Add</Button>
            <span className="text-xs text-text-3">a clone of this run's scenario will not carry an event added here</span>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel title="Simulated company">
            <div data-testid="sim-company" className="flex flex-col gap-1 text-xs text-text-2">
              {headline.map((item) => {
                const display = item.ofHorizon === true ? `${item.value} / ${summary.horizonDays}` : item.kind === 'money' ? formatMinor(item.value, currency) : String(item.value)
                return (
                  <div key={item.label}>
                    {item.label} <span data-testid={`sim-company-${slugify(item.label)}`} className={item.kind === 'money' ? 'font-mono text-text-1' : undefined}>{display}</span>
                  </div>
                )
              })}
              {headline.some((item) => item.kind === 'money') && <div className="text-text-3">simulated money in {currency}; not real spend</div>}
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
                {Object.entries(metricLabels).map(([key, label]) => {
                  // The plugin's own labels and order drive this panel (M31b §5); trade's runtime
                  // metrics object also carries two fields no label names -- `sources` (per-metric
                  // provenance) and a `<key>Day` companion for a "when" figure like `minCashDay`.
                  // Since M32 item 6 `SimulationMetrics` is `unknown`-valued and says so, so these
                  // reads are ordinary narrowing rather than a defensive cast around a type that
                  // claimed the fields could not be there.
                  //
                  // M32 review: through the SAME `metricValue` the compare page uses, so the two
                  // cannot disagree about what is a number -- a labelled metric that is not one
                  // reads `—` here and `—` there, rather than a confident `0` on one page and a
                  // dash on the other.
                  const value = metricValue(metrics[key])
                  const dayValue = metrics[`${key}Day`]
                  const sources = (metrics['sources'] as Record<string, readonly string[] | undefined> | undefined)?.[key]
                  return (
                    <div key={key} data-testid={`sim-metric-${key}`} className="rounded-card border border-line bg-bg-2 p-2 text-xs">
                      <div className="text-text-3">{label.label}{typeof dayValue === 'number' ? ` (day ${dayValue})` : ''}</div>
                      <div className="font-mono text-sm text-text-1">{value === null ? '—' : label.kind === 'money' ? formatMinor(value, currency) : String(value)}</div>
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
      <CloneDrawer open={cloneOpen} onClose={() => setCloneOpen(false)} sourceId={summary.id} sourceName={summary.name} sourcePolicy={summary.policy} sector={summary.sector} />
      {adoptable && <AdoptDrawer open={adoptOpen} onClose={() => setAdoptOpen(false)} simulationId={summary.id} />}
    </div>
  )
}
