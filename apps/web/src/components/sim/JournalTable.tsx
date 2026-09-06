import { DataTable, Row } from '../ui/DataTable'
import type { JournalRow } from '../../server/simulation'

const COLUMNS = '60px 60px 140px 120px 1fr'

/** The summary column's rules (M29 T10 brief): each journal `kind` reads differently because
 *  each one records a different fact — a decision's actions, an outcome, an external nudge, or
 *  a control op — and squashing them into one shape would hide which is which. */
function summaryFor(row: JournalRow): string {
  const payload = row.payload
  switch (row.kind) {
    case 'decision': {
      const actions = (payload['actions'] as readonly { type: string; rationale: string }[] | undefined) ?? []
      return actions.length === 0 ? 'no action' : actions.map((a) => `${a.type} (${a.rationale})`).join('; ')
    }
    case 'action_applied': {
      const action = payload['action'] as { type: string; params: Record<string, unknown> } | undefined
      return `applied ${action?.type ?? ''} ${JSON.stringify(action?.params ?? {})}`
    }
    case 'action_rejected': {
      const action = payload['action'] as { type: string } | undefined
      const reason = payload['reason'] as { kind: string } | undefined
      return `rejected ${action?.type ?? ''}: ${reason?.kind ?? ''} ${JSON.stringify(reason ?? {})}`
    }
    case 'event':
    case 'external_event': {
      const event = payload['event'] as { type?: string } | undefined
      const { event: _event, ...record } = payload
      return `${event?.type ?? String(payload['kind'] ?? '')} ${JSON.stringify(record)}`
    }
    case 'control':
      return String(payload['op'] ?? '')
    default:
      return JSON.stringify(payload)
  }
}

/** The full, un-summarised journal (M29 spec §7): every seq, in order, so a reader can trace
 *  exactly what the simulation recorded rather than trusting the Decisions tab's rollup. */
export function JournalTable({ rows }: { readonly rows: readonly JournalRow[] }): React.JSX.Element {
  return (
    <DataTable columns={COLUMNS} header={['seq', 'day', 'kind', 'role', 'summary']}>
      {rows.map((row) => (
        <div key={row.seq} data-testid="sim-journal-row">
          <Row columns={COLUMNS}>
            <span className="font-mono text-text-3">{row.seq}</span>
            <span>{row.simTime}</span>
            <span className="text-text-2">{row.kind}</span>
            <span className="text-text-2">{row.actorRole ?? '—'}</span>
            <span className="truncate text-text-2" title={summaryFor(row)}>{summaryFor(row)}</span>
          </Row>
        </div>
      ))}
    </DataTable>
  )
}
