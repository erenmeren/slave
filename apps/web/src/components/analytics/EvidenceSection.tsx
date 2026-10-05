import type { AnalyticsView, EvidenceLine } from '@slave-of-ai/control'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMinutes, formatUsd, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { rateWord } from './words'

/** Where the records came from, said plainly: a lead-built project writes few of them, and judges fewer. */
export function evidenceOrigin(evidence: AnalyticsView['evidence']): string {
  if (evidence.records === 0) return 'No session has ended with a record yet.'
  const lead = "On a project a lead builds, only the lead's turns and the checks are recorded, under their own seats: a helper works inside the lead's session and gets no record, and only \"reached the base branch\" is ever judged there."
  if (evidence.leadFlowRecords === 0) return `All ${plural(evidence.records, 'record')} come from projects built the older way. ${lead}`
  return `${String(evidence.leadFlowRecords)} of ${plural(evidence.records, 'record')} come from projects a lead builds; the rest, and every first-pass and review figure, come from projects built the older way. ${lead}`
}

function Money({ line }: { readonly line: EvidenceLine }): React.JSX.Element {
  if (line.reportedUsd === null && line.estimatedUsd === null && line.unmeasuredRuns === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex flex-col items-end text-xs">
      {line.reportedUsd !== null && <span className="text-sm tabular-nums">{formatUsd(line.reportedUsd)} reported</span>}
      {line.estimatedUsd !== null && <span className="text-muted-foreground tabular-nums">{formatUsd(line.estimatedUsd)} estimated</span>}
      {line.unmeasuredRuns > 0 && <span className="text-muted-foreground">{plural(line.unmeasuredRuns, 'session')} not measured</span>}
    </div>
  )
}

function Lines({ id, first, lines }: { readonly id: string; readonly first: string; readonly lines: readonly EvidenceLine[] }): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{first}</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead>Verified first pass</TableHead>
          <TableHead>Review rejected</TableHead>
          <TableHead>Reached the base branch</TableHead>
          <TableHead className="text-right">Median time</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => (
          <TableRow key={line.key} data-testid={`${id}-row`} data-thin={line.thin}>
            <TableCell className="max-w-[280px]">
              <span className="block truncate font-medium" title={line.name}>{line.name}</span>
              {line.repository !== null && <span className="block truncate text-xs text-muted-foreground" title={line.repository}>{line.repository}</span>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{line.attempted}</TableCell>
            {line.thin ? (
              <TableCell colSpan={3} className="text-xs text-muted-foreground">
                Not enough evidence yet
              </TableCell>
            ) : (
              [line.firstPass, line.reviewRejected, line.integrated].map((rate, index) => (
                <TableCell key={index} className={cn('whitespace-nowrap tabular-nums', rate.pct === null && 'text-xs text-muted-foreground')}>
                  {rateWord(rate)}
                </TableCell>
              ))
            )}
            <TableCell className="text-right whitespace-nowrap tabular-nums">{line.medianDurationMs === null ? '—' : formatMinutes(line.medianDurationMs)}</TableCell>
            <TableCell className="text-right">
              <Money line={line} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * Evidence: the running tally of how each kind of specialist, and each model, has done -- counts
 * always, a rate only where enough sessions were judged, and the money in three figures that are
 * never added up: reported by the runtime, estimated from tokens, and not measured at all.
 */
export function EvidenceSection({ view }: { readonly view: AnalyticsView }): React.JSX.Element {
  const evidence = view.evidence
  return (
    <section aria-labelledby="evidence-heading" data-testid="analytics-evidence" className="flex min-w-0 flex-col gap-4">
      <h2 id="evidence-heading" className="text-lg font-semibold tracking-tight">Evidence</h2>
      <p data-testid="evidence-origin" className="max-w-3xl text-sm text-muted-foreground">
        A record is written when a session of a seat ends. It is a running tally, so the period above does not cut it. {evidenceOrigin(evidence)}
      </p>
      {evidence.records === 0 ? (
        <p data-testid="evidence-empty" className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Not enough evidence yet. The first rows appear when a lead&apos;s turn or a check ends.
        </p>
      ) : (
        <>
          <Card data-testid="evidence-profiles" className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">By kind of specialist</CardTitle>
              <CardDescription>One row per kind of specialist and repository, the most sessions first.</CardDescription>
            </CardHeader>
            <CardContent>
              <Lines id="evidence-profile" first="Specialist" lines={evidence.profiles} />
            </CardContent>
          </Card>
          <Card data-testid="evidence-models" className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">By model</CardTitle>
              <CardDescription>The same sessions, by the model that ran them.</CardDescription>
            </CardHeader>
            <CardContent>
              <Lines id="evidence-model" first="Model" lines={evidence.models} />
            </CardContent>
          </Card>
        </>
      )}
    </section>
  )
}
