import type { SimulationComparison } from '@slave-of-ai/control'
import { metricValue } from '../../lib/metricValue'
import { formatMinor } from '../../lib/money'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'

const COLUMNS = '1.4fr 1fr 1fr 1fr'

/** `formatMinor` already carries an ASCII `-` for a negative amount; a non-negative one gets an
 *  explicit `+` so the sign is never ambiguous (`+$4,250.00`, `-$4,250.00`). */
function deltaMoney(minor: number, currency: string): string {
  return minor < 0 ? formatMinor(minor, currency) : `+${formatMinor(minor, currency)}`
}
/** A plain count delta: `+50`, the typographic minus `−4`, or `0` — never a bare positive
 *  integer, which would read as an absolute value rather than a change. */
function deltaCount(value: number): string {
  if (value > 0) return `+${value}`
  if (value < 0) return `−${Math.abs(value)}`
  return '0'
}

/** Two runs, side by side (M30 §4, Task 5): both metric sets, the b − a delta with an explicit
 *  sign, and — only when it matters — a warning that the worlds differed or that one run carries
 *  an injected event the other does not. This page never computes or shows a verdict; the delta
 *  is arithmetic, nothing more. */
export function CompareClient({ comparison }: { readonly comparison: SimulationComparison }): React.JSX.Element {
  const { a, b, deltas, definitionsMatch, differences, currency } = comparison
  const clean = definitionsMatch && a.injected === 0 && b.injected === 0

  return (
    <div className="flex min-h-screen flex-1 flex-col gap-4 p-6">
      <div data-testid="sim-compare-strip" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-6 py-2 text-xs text-text-2">
        <Chip tone="waiting">SIMULATION</Chip>
        <span className="text-text-1">{a.summary.name}</span>
        <span>vs</span>
        <span className="text-text-1">{b.summary.name}</span>
        <span>·</span>
        <span>{a.summary.sector}</span>
        <span>·</span>
        <span className="text-text-3">synthetic data — not a real company; no verdict</span>
      </div>

      {!clean && (
        <div data-testid="sim-compare-warning" className="flex flex-col gap-1 rounded-card border border-line bg-bg-2 p-3 text-xs text-tone-blocked">
          {!definitionsMatch && <div>the runs did not share the same world — {differences.join(', ')} differ</div>}
          {a.injected > 0 && <div>a has {a.injected} injected event{a.injected === 1 ? '' : 's'}</div>}
          {b.injected > 0 && <div>b has {b.injected} injected event{b.injected === 1 ? '' : 's'}</div>}
        </div>
      )}

      <DataTable columns={COLUMNS} header={['metric', 'A', 'B', 'Δ']}>
        {Object.entries(comparison.metricLabels).map(([key, label], index, entries) => {
          const isMoney = label.kind === 'money'
          // M32 item 6: a sector's metrics are `unknown`-valued (trade's carry `sources`, an
          // object), so both figures are narrowed here rather than trusted -- by the same rule
          // `metricDeltas` uses, so a row's A, B and Δ can never disagree about what is a number.
          // Missing reads 0, as it always did; present-but-not-a-finite-number has no figure to
          // show and no delta either -- `—`, never a confident 0.
          const av = metricValue(a.metrics[key])
          const bv = metricValue(b.metrics[key])
          const dv = deltas[key] ?? null
          return (
            <div key={key} data-testid={`sim-compare-row-${key}`}>
              {/* `last` -- the wrapper above makes every `Row` a `:last-child`, so `Row`'s own
                * selector drew no separator anywhere (M46 t4 fix round 1). */}
              <Row columns={COLUMNS} last={index === entries.length - 1}>
                <span className="text-text-3">{label.label}</span>
                <span className="font-mono text-text-1">{av === null ? '—' : isMoney ? formatMinor(av, currency) : String(av)}</span>
                <span className="font-mono text-text-1">{bv === null ? '—' : isMoney ? formatMinor(bv, currency) : String(bv)}</span>
                <span data-testid={`sim-compare-delta-${key}`} className="font-mono text-text-1">{dv === null ? '—' : isMoney ? deltaMoney(dv, currency) : deltaCount(dv)}</span>
              </Row>
            </div>
          )
        })}
      </DataTable>

      <div className="flex flex-col gap-1 text-xs text-text-2">
        <div>a: {a.summary.name} — policy {a.summary.policy} — day {a.summary.simTime} / {a.summary.horizonDays}</div>
        <div>b: {b.summary.name} — policy {b.summary.policy} — day {b.summary.simTime} / {b.summary.horizonDays}</div>
      </div>

      <div data-testid="sim-compare-footer" className="text-xs text-text-3">no verdict is computed; the delta is arithmetic</div>
    </div>
  )
}
