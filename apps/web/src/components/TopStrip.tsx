import type { OverviewSnapshot } from '../server/overview'

const AGENT_BUCKETS = [
  { key: 'working', statuses: ['working', 'starting', 'resuming'] },
  { key: 'paused', statuses: ['paused', 'pausing', 'stopping'] },
  { key: 'idle', statuses: ['idle'] },
] as const

export function TopStrip({ snapshot }: { readonly snapshot: OverviewSnapshot }): React.JSX.Element {
  return (
    <section className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-5">
      {AGENT_BUCKETS.map((bucket) => (
        <div key={bucket.key} data-testid={`count-${bucket.key}`} className="bg-bg-1 px-4 py-3">
          <div className="font-mono text-xl">{snapshot.agents.filter((a) => (bucket.statuses as readonly string[]).includes(a.status)).length}</div>
          <div className="text-xs text-text-2">agents {bucket.key}</div>
        </div>
      ))}
      <div data-testid="count-tasks-active" className="bg-bg-1 px-4 py-3">
        <div className="font-mono text-xl">{snapshot.tasks.active}</div>
        <div className="text-xs text-text-2">tasks active</div>
      </div>
      <div data-testid="count-tasks-blocked" className="bg-bg-1 px-4 py-3">
        <div className="font-mono text-xl">{snapshot.tasks.blocked}</div>
        <div className="text-xs text-text-2">tasks blocked</div>
      </div>
    </section>
  )
}
