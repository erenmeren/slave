import Link from 'next/link'
import type { AnalyticsView } from '@slave-of-ai/control'
import { LimitBar } from '@/components/app/LimitBar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMinutes, formatUsd, percentOf, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DayBars, Figure, Legend } from './DayBars'
import { gapSentence, moneyColumns, moneyWord, partWord, perStepWord, periodWord, seriesOf } from './words'

const GROUP_TONE: Readonly<Record<AnalyticsView['money']['byBuild'][number]['group'], string>> = {
  delivered: 'bg-success-muted text-success-foreground',
  stopped: 'bg-muted text-muted-foreground',
  waiting: 'bg-warning-muted text-warning-foreground',
  running: 'bg-info-muted text-info-foreground',
}

/**
 * Money: what was spent in the period and on what, day by day, then project by project and build
 * by build. A sum a session's cost is missing from says "at least", and says why.
 */
export function MoneySection({ view }: { readonly view: AnalyticsView }): React.JSX.Element {
  const money = view.money
  const gaps = gapSentence(money)
  const single = view.projectId !== null
  const builds = Object.values(view.work.builds).reduce((total, count) => total + count, 0)
  const series = single ? [] : seriesOf(money.byDay, view.projects)
  const columns = single ? money.byDay.map((day) => ({ day: day.day, total: day.totalUsd, segments: day.totalUsd > 0 ? [{ id: 'spent', value: day.totalUsd, tone: 'bg-info', name: 'Spent' }] : [] })) : moneyColumns(money.byDay, series)
  return (
    <section aria-labelledby="money-heading" data-testid="analytics-money" className="flex min-w-0 flex-col gap-4">
      <h2 id="money-heading" className="text-lg font-semibold tracking-tight">Money</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure id="spent" label="Spent" value={moneyWord(money.totalUsd, money)} detail={gaps === null ? `Every session ${periodWord(view.days)} reported its cost` : 'Some sessions are missing from this sum'} />
        <Figure id="building" label="Building" value={partWord(money.buildingUsd)} detail="The leads' turns, their helpers inside them" tone="bg-info" />
        <Figure id="checking" label="Checking" value={partWord(money.checkingUsd)} detail="The checkers' runs" tone="bg-checking" />
        <Figure id="steering" label="Reading and steering" value={partWord(money.steeringUsd)} detail="Turning requests into requirements, and deciding" tone="bg-warning" />
      </div>
      {gaps !== null && (
        <p data-testid="money-gaps" className="text-sm text-muted-foreground">
          {gaps}
        </p>
      )}

      <Card data-testid="money-by-day" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">Spent per day</CardTitle>
          <CardDescription>A session&apos;s cost lands on the day it ended: the runtime reports it then, helpers included. Days are UTC.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DayBars id="money-chart" label={`Money spent per day ${periodWord(view.days)}`} columns={columns} format={formatUsd} empty={money.liveSessions > 0 ? 'No session has reported a cost yet. The first figure arrives when a turn ends.' : `Nothing was spent ${periodWord(view.days)}.`} />
          <Legend series={series} />
        </CardContent>
      </Card>

      <Card data-testid="money-by-project" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">By project</CardTitle>
          <CardDescription>What each project spent {periodWord(view.days)}. The budget is measured against the newest build, whatever the period.</CardDescription>
        </CardHeader>
        <CardContent>
          {money.byProject.length === 0 ? (
            <p data-testid="money-by-project-empty" className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No projects yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead className="text-right">Builds</TableHead>
                  <TableHead className="text-right">Building</TableHead>
                  <TableHead className="text-right">Checking</TableHead>
                  <TableHead className="text-right">Reading and steering</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="w-[120px]">Used</TableHead>
                  <TableHead className="text-right">Not measured</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {money.byProject.map((row) => {
                  const used = percentOf(row.budgetSpentUsd, row.budgetUsd)
                  return (
                    <TableRow key={row.projectId} data-testid="project-money-row">
                      <TableCell className="max-w-[260px]">
                        <Link href={`/w/${row.projectId}`} className="block truncate font-medium hover:underline" title={row.name}>
                          {row.name}
                        </Link>
                        {(row.archived || row.flow === 'packages') && <span className="text-xs text-muted-foreground">{[row.archived ? 'archived' : null, row.flow === 'packages' ? 'built the older way' : null].filter((word) => word !== null).join(' · ')}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.builds}</TableCell>
                      <TableCell className="text-right tabular-nums">{partWord(row.buildingUsd)}</TableCell>
                      <TableCell className="text-right tabular-nums">{partWord(row.checkingUsd)}</TableCell>
                      <TableCell className="text-right tabular-nums">{partWord(row.steeringUsd)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{moneyWord(row.totalUsd, row)}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', row.budgetUsd === null && 'text-xs text-muted-foreground')}>{row.budgetUsd === null ? 'none set' : formatUsd(row.budgetUsd)}</TableCell>
                      <TableCell>
                        {used === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <LimitBar percent={used} label="Spent of the budget" className="w-14" />
                            <span className="text-xs tabular-nums">{Math.round(used)}%</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {row.unmeasuredSessions === 0 && row.liveSessions === 0 ? '—' : [row.liveSessions > 0 ? `${String(row.liveSessions)} open` : null, row.unmeasuredSessions > 0 ? `${String(row.unmeasuredSessions)} without a cost` : null].filter((word) => word !== null).join(' · ')}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="money-by-build" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">By build</CardTitle>
          <CardDescription>
            {builds === 0 ? `No build was worked on ${periodWord(view.days)}.` : `${plural(builds, 'build')} worked on ${periodWord(view.days)}, newest first, each with its whole figures.`}
            {builds > money.byBuild.length && ` Only the newest ${String(money.byBuild.length)} are listed.`}
          </CardDescription>
        </CardHeader>
        {money.byBuild.length > 0 && (
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Build</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Lead turns</TableHead>
                  <TableHead className="text-right">Helpers called</TableHead>
                  <TableHead className="text-right">Steps</TableHead>
                  <TableHead className="text-right">Worked</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Per step</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {money.byBuild.map((row) => (
                  <TableRow key={`${row.projectId}:${String(row.version)}`} data-testid="build-money-row" data-group={row.group}>
                    <TableCell className="max-w-[280px]">
                      <Link href={`/w/${row.projectId}`} className="block truncate font-medium hover:underline" title={row.projectName}>
                        {row.projectName}
                      </Link>
                      <Link href={`/w/${row.projectId}/goals/${String(row.version)}`} className="text-xs text-muted-foreground hover:underline">
                        Build {row.version} · its report
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge className={GROUP_TONE[row.group]}>{row.state}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.turns}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.helperSessions}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.steps}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMinutes(row.workedMs)}</TableCell>
                    <TableCell className={cn('text-right whitespace-nowrap tabular-nums', row.spentUsd === 0 && 'text-xs text-muted-foreground')}>{moneyWord(row.spentUsd, row)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{perStepWord(row.spentUsd, row.steps, row)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </section>
  )
}
