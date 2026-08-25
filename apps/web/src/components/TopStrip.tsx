import { TONE_TEXT, type StatusTone } from './ui/StatusPill'
import type { OverviewSnapshot } from '../server/overview'

const AGENT_BUCKETS: ReadonlyArray<{ readonly key: string; readonly statuses: readonly string[]; readonly tone?: StatusTone }> = [
  { key: 'working', statuses: ['working', 'starting', 'resuming'], tone: 'working' },
  { key: 'paused', statuses: ['paused', 'pausing', 'stopping'], tone: 'paused' },
  { key: 'idle', statuses: ['idle'] },
]

/**
 * 1a's 6-up summary strip (design handoff §1a / spec §3): same 1px-gutter grid the strip always
 * had (`gap-px` over `bg-line`, tiles punched through it), restyled onto the `ui/` StatStrip's
 * type scale and tone vocabulary (`StatusPill`'s `TONE_TEXT`) rather than the container itself —
 * `StatStrip` renders its own fixed `data-testid`s per item (`stat-strip-item`), which would
 * collide with this strip's per-bucket test-ids (`count-working` etc.) that `overview-components.
 * test.tsx` asserts on unmodified. A non-zero count for a bucket that has a tone reads in that
 * tone; zero (or idle, which carries none) stays neutral — the same "tone only when it says
 * something" rule `ProjectsClient.tsx`'s stat strip items already follow.
 */
export function TopStrip({ snapshot }: { readonly snapshot: OverviewSnapshot }): React.JSX.Element {
  const tasksActive = snapshot.tasks.active
  const tasksBlocked = snapshot.tasks.blocked

  return (
    <section className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-5">
      {AGENT_BUCKETS.map((bucket) => {
        const count = snapshot.agents.filter((a) => (bucket.statuses as readonly string[]).includes(a.status)).length
        const tone = bucket.tone !== undefined && count > 0 ? bucket.tone : undefined
        return (
          <div key={bucket.key} data-testid={`count-${bucket.key}`} className="flex flex-col gap-1 bg-bg-1 p-[10px]">
            <span className={`font-mono text-lg font-semibold ${tone !== undefined ? TONE_TEXT[tone] : 'text-text-1'}`}>{count}</span>
            <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">agents {bucket.key}</span>
          </div>
        )
      })}
      <div data-testid="count-tasks-active" className="flex flex-col gap-1 bg-bg-1 p-[10px]">
        <span className={`font-mono text-lg font-semibold ${tasksActive > 0 ? TONE_TEXT.working : 'text-text-1'}`}>{tasksActive}</span>
        <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">tasks active</span>
      </div>
      <div data-testid="count-tasks-blocked" className="flex flex-col gap-1 bg-bg-1 p-[10px]">
        <span className={`font-mono text-lg font-semibold ${tasksBlocked > 0 ? TONE_TEXT.blocked : 'text-text-1'}`}>{tasksBlocked}</span>
        <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">tasks blocked</span>
      </div>
    </section>
  )
}
