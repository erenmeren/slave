import type { ProjectView } from '@slave-of-ai/control'
import { LimitBar } from '@/components/app/LimitBar'
import { formatMinutes, formatUsd, percentOf, plural } from '@/lib/format'

function Stat({ id, label, value, detail, children }: { readonly id: string; readonly label: string; readonly value: string; readonly detail: string | null; readonly children?: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid={`stat-${id}`} className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="truncate text-xl font-semibold tabular-nums">{value}</span>
      {children}
      {detail !== null && <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span>}
    </div>
  )
}

/**
 * The figures of a build, always in sight at the top of the Project screen: what was spent against
 * the budget, the working time against its limit, how many are working right now and who, and how
 * much work was done.
 */
export function BuildStats({ project }: { readonly project: ProjectView }): React.JSX.Element | null {
  const build = project.build
  if (build === null) return null
  const working = build.people.filter((person) => person.state === 'working')
  const helpers = build.people.filter((person) => person.kind === 'helper')
  const spent = `${build.spendUnmeasured ? 'at least ' : ''}${formatUsd(build.spentUsd)}`
  const liveTurn = build.turns.some((turn) => turn.endedAt === null)
  return (
    <section data-testid="build-stats" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        id="spent"
        label="Spent"
        value={project.budgetUsd === null ? spent : `${spent} of ${formatUsd(project.budgetUsd)}`}
        detail={liveTurn ? 'The running turn is added when it ends' : project.budgetUsd === null ? 'No budget set' : null}
      >
        <LimitBar percent={percentOf(build.spentUsd, project.budgetUsd)} label="Spent of the budget" />
      </Stat>
      <Stat
        id="time"
        label="Working time"
        value={project.timeLimitMs === null ? formatMinutes(build.workedMs) : `${formatMinutes(build.workedMs)} of ${formatMinutes(project.timeLimitMs)}`}
        detail={project.timeLimitMs === null ? 'No time limit set' : null}
      >
        <LimitBar percent={percentOf(build.workedMs, project.timeLimitMs)} label="Working time of the limit" />
      </Stat>
      <Stat
        id="working"
        label="Working now"
        value={plural(working.length, 'person', 'people')}
        detail={working.length === 0 ? (build.people.length === 0 ? 'Nobody has started yet' : `${plural(build.people.length, 'person', 'people')} worked on this build`) : working.map((person) => person.name).join(', ')}
      />
      <Stat
        id="work"
        label="Work done"
        value={plural(build.toolCalls, 'step')}
        detail={`${plural(build.turns.length, 'lead turn')} · ${plural(helpers.length, 'helper')} · checked ${plural(build.rounds, 'time')}`}
      />
    </section>
  )
}
