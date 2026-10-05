import type { BuildView, TurnRow } from '@slave-of-ai/control'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ESTIMATE_TITLE, aboutUsd, runningEstimateLine, unpricedWord } from '@/lib/estimate'
import { formatMinutes, formatUsd, plural } from '@/lib/format'

/** The lead's turns in a person's words; the diagram's side panel and timeline say them the same way. */
export const TURN_WORD: Readonly<Record<string, string>> = {
  build: 'Building',
  rework: 'Fixing what failed',
  wrap_up: 'Wrapping up',
  continue: 'Continuing',
  answer: 'Reading your answer',
  base: 'Taking in the base branch',
}

const STATUS_WORD: Readonly<Record<string, string>> = {
  starting: 'Starting',
  working: 'Working',
  pause_requested: 'Pausing',
  paused: 'Paused',
  resuming: 'Resuming',
  stopping: 'Stopping',
  stopped: 'Stopped',
  succeeded: 'Finished',
  failed: 'Failed',
}

const words = (table: Readonly<Record<string, string>>, key: string): string => table[key] ?? key.replaceAll('_', ' ')

/**
 * A turn's cost, or why there is none yet. The reported figure when there is one; while the turn
 * runs, about what it has used so far; for a turn that ended without reporting, that, and the
 * estimate beside it when there is one.
 */
export function turnCostWord(turn: TurnRow): string {
  if (turn.costUsd !== null) return formatUsd(turn.costUsd)
  if (turn.endedAt !== null) return turn.estimatedUsd === null ? 'not reported' : `not reported · ${aboutUsd(turn.estimatedUsd)} (estimate)`
  if (turn.estimatedUsd !== null) return `${aboutUsd(turn.estimatedUsd)} so far`
  return turn.unpricedModels.length > 0 ? unpricedWord(turn.unpricedModels) : 'when it ends'
}

function Part({ id, label, usd, note, running = null }: { readonly id: string; readonly label: string; readonly usd: number; readonly note: string; readonly running?: string | null }): React.JSX.Element {
  return (
    <div data-testid={`cost-${id}`} className="flex min-w-0 flex-col rounded-lg border p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{formatUsd(usd)}</span>
      {running !== null && <span data-testid={`cost-${id}-running`} className="truncate text-xs text-info-foreground tabular-nums" title={ESTIMATE_TITLE}>{running}</span>}
      <span className="truncate text-xs text-muted-foreground" title={note}>{note}</span>
    </div>
  )
}

/**
 * Where the build's money went: the lead (its helpers' cost is inside it), the checks, and
 * reading the request into requirements -- then each turn of the lead with its steps, its working
 * time and its cost. A turn's cost is reported when the turn ends; until then the turn says about
 * what it has used so far, as an estimate that is in none of the sums.
 */
export function CostSection({ build }: { readonly build: BuildView }): React.JSX.Element | null {
  if (build.turns.length === 0 && build.spend.totalUsd === 0) return null
  const helpers = build.people.filter((person) => person.kind === 'helper').length
  const running = runningEstimateLine(build.spend.estimatedRunningUsd, build.spend.unpricedModels)
  return (
    <Card data-testid="cost">
      <CardHeader>
        <CardTitle className="text-base">Cost</CardTitle>
        <CardDescription>
          {build.spendUnmeasured ? 'At least ' : ''}
          {formatUsd(build.spend.totalUsd)} so far
          {build.spend.unmeasuredRuns > 0 && ` · ${plural(build.spend.unmeasuredRuns, 'session')} ended without reporting a cost`}
          {running !== null && <span data-testid="cost-running" title={ESTIMATE_TITLE}> · {running}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Part id="lead" label="Lead and helpers" usd={build.spend.leadUsd} note={`${plural(build.turns.length, 'turn')} · ${plural(helpers, 'helper')}`} running={runningEstimateLine(build.spend.estimatedRunningLeadUsd, build.spend.unpricedModels)} />
          <Part id="proof" label="Checking" usd={build.spend.proofUsd} note={`checked ${plural(build.rounds, 'time')}`} running={build.spend.estimatedRunningProofUsd > 0 ? runningEstimateLine(build.spend.estimatedRunningProofUsd, []) : null} />
          <Part id="reading" label="Reading the request" usd={build.spend.conductorUsd} note="turning it into requirements" />
        </div>
        {build.turns.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead turn</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Steps</TableHead>
                <TableHead className="text-right">Worked</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {build.turns.map((turn, index) => (
                <TableRow key={turn.runId} data-testid="turn-row">
                  <TableCell>
                    <span className="text-muted-foreground tabular-nums">{index + 1}.</span> {words(TURN_WORD, turn.turn)}
                    {turn.resumed && <span className="text-xs text-muted-foreground"> · same session</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{words(STATUS_WORD, turn.status)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{turn.toolCalls}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinutes(turn.workedMs)}</TableCell>
                  <TableCell data-testid="turn-cost" className={turn.costUsd === null ? 'text-right text-xs text-muted-foreground tabular-nums' : 'text-right tabular-nums'} title={turn.costUsd === null && turn.estimatedUsd !== null ? ESTIMATE_TITLE : undefined}>{turnCostWord(turn)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
