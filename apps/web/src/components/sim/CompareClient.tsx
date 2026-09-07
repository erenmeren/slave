import type { SimulationComparison } from '@slave-of-ai/control'
import { formatMinor } from '../../lib/money'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'

const METRIC_LABELS = {
  deliveredQty: 'delivered', onTimeQty: 'on time', lateDays: 'late days', purchaseCostMinor: 'purchase cost', closingInventory: 'closing stock',
  closingCashMinor: 'closing cash', minCashMinor: 'minimum cash', collectedMinor: 'collected', unpaidCommitmentsMinor: 'unpaid commitments',
} as const
const MONEY: ReadonlySet<string> = new Set(['purchaseCostMinor', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor'])
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
        <span className="text-text-3">— synthetic data, no verdict</span>
      </div>

      {!clean && (
        <div data-testid="sim-compare-warning" className="flex flex-col gap-1 rounded-card border border-line bg-bg-2 p-3 text-xs text-tone-blocked">
          {!definitionsMatch && <div>the runs did not share the same world — {differences.join(', ')} differ</div>}
          {a.injected > 0 && <div>a has {a.injected} injected event{a.injected === 1 ? '' : 's'}</div>}
          {b.injected > 0 && <div>b has {b.injected} injected event{b.injected === 1 ? '' : 's'}</div>}
        </div>
      )}

      <DataTable columns={COLUMNS} header={['metric', 'A', 'B', 'Δ']}>
        {(Object.keys(METRIC_LABELS) as (keyof typeof METRIC_LABELS)[]).map((key) => {
          const isMoney = MONEY.has(key)
          const av = a.metrics[key]
          const bv = b.metrics[key]
          const dv = deltas[key]
          return (
            <div key={key} data-testid={`sim-compare-row-${key}`}>
              <Row columns={COLUMNS}>
                <span className="text-text-3">{METRIC_LABELS[key]}</span>
                <span className="font-mono text-text-1">{isMoney ? formatMinor(av, currency) : String(av)}</span>
                <span className="font-mono text-text-1">{isMoney ? formatMinor(bv, currency) : String(bv)}</span>
                <span data-testid={`sim-compare-delta-${key}`} className="font-mono text-text-1">{isMoney ? deltaMoney(dv, currency) : deltaCount(dv)}</span>
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
