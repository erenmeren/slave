import type { AnalyticsView } from '@slave-of-ai/control'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMinutes, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DayBars, Figure } from './DayBars'
import { periodWord } from './words'

const count = (value: number): string => value.toLocaleString('en-US')

/** A whole split into parts, as one bar with its words under it; a bare track when there is nothing to split. */
function Split({ id, parts, empty }: { readonly id: string; readonly parts: readonly { readonly id: string; readonly word: string; readonly value: number; readonly tone: string }[]; readonly empty: string }): React.JSX.Element {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  return (
    <div data-testid={id} className="flex flex-col gap-2">
      <div aria-hidden className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {parts.map((part) => part.value > 0 && <div key={part.id} className={cn('h-full', part.tone)} style={{ flex: `${String(part.value)} 0 0` }} />)}
      </div>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {parts.map((part) => (
            <li key={part.id} data-testid={`${id}-${part.id}`} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('size-2.5 rounded-[3px]', part.tone)} />
              <span className="font-semibold tabular-nums">{count(part.value)}</span>
              <span className="text-muted-foreground">{part.word}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Work: how much was done for the money -- the steps day by day, the lead's turns, the helper
 * sessions it started, the checks and what they found, and how the builds stand.
 */
export function WorkSection({ view }: { readonly view: AnalyticsView }): React.JSX.Element {
  const work = view.work
  const builds = Object.values(work.builds).reduce((total, value) => total + value, 0)
  return (
    <section aria-labelledby="work-heading" data-testid="analytics-work" className="flex min-w-0 flex-col gap-4">
      <h2 id="work-heading" className="text-lg font-semibold tracking-tight">Work</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure id="steps" label="Steps" value={count(work.steps)} detail="Every command, read and edit anybody made" />
        <Figure id="turns" label="Lead turns" value={count(work.leadTurns)} detail="Times a lead was started or sent back" />
        <Figure id="helper-sessions" label="Helper sessions" value={count(work.helperSessions)} detail="Times a lead handed work to a helper" />
        <Figure id="checks" label="Checks run" value={count(work.checks)} detail="Times a checker tried the running product" />
      </div>

      <Card data-testid="work-by-day" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Steps per day</CardTitle>
          <CardDescription>The lead&apos;s steps, its helpers&apos; and the checkers&apos;, on the day each was made. Days are UTC.</CardDescription>
        </CardHeader>
        <CardContent>
          <DayBars
            id="steps-chart"
            label={`Steps per day ${periodWord(view.days)}`}
            columns={work.byDay.map((day) => ({ day: day.day, total: day.steps, segments: day.steps > 0 ? [{ id: 'steps', value: day.steps, tone: 'bg-info', name: 'Steps' }] : [] }))}
            format={(value) => (Number.isInteger(value) ? count(value) : value.toFixed(1))}
            empty={`Nobody made a step ${periodWord(view.days)}.`}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="work-checks" className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">What the checks found</CardTitle>
            <CardDescription>One verdict per requirement per check: a requirement checked twice counts twice.</CardDescription>
          </CardHeader>
          <CardContent>
            <Split
              id="verdicts"
              empty={work.checks === 0 ? `No check ran ${periodWord(view.days)}. A build is checked once the lead says it is done.` : 'The checks have given no verdict yet.'}
              parts={[
                { id: 'works', word: 'work', value: work.verdicts.works, tone: 'bg-success' },
                { id: 'fails', word: "don't work", value: work.verdicts.fails, tone: 'bg-destructive' },
                { id: 'unverifiable', word: "couldn't be checked", value: work.verdicts.unverifiable, tone: 'bg-warning' },
              ]}
            />
          </CardContent>
        </Card>
        <Card data-testid="work-builds" className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Builds</CardTitle>
            <CardDescription>
              {builds === 0
                ? `No build was worked on ${periodWord(view.days)}.`
                : work.averageDeliveredWorkedMs === null
                  ? `${plural(builds, 'build')} worked on ${periodWord(view.days)}; none delivered yet, so there is no average working time.`
                  : `${plural(builds, 'build')} worked on ${periodWord(view.days)}. A delivered build took ${formatMinutes(work.averageDeliveredWorkedMs)} of working time on average.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Split
              id="build-groups"
              empty="Ask for a build on a project and it is counted here."
              parts={[
                { id: 'delivered', word: 'delivered', value: work.builds.delivered, tone: 'bg-success' },
                { id: 'running', word: 'in progress', value: work.builds.running, tone: 'bg-info' },
                { id: 'waiting', word: 'waiting for you', value: work.builds.waiting, tone: 'bg-warning' },
                { id: 'stopped', word: 'left or replaced', value: work.builds.stopped, tone: 'bg-muted-foreground/50' },
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
