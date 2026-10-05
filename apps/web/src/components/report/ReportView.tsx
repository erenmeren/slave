import Link from 'next/link'
import { ArrowLeftIcon, DownloadIcon } from 'lucide-react'
import type { GoalReport, GoalReportSharedDecision, GoalReportSmoke, GoalReportState } from '@slave-of-ai/domain'
import { ResultBadge } from '@/components/project/ProofSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMinutes, formatUsd, plural } from '@/lib/format'

/** A build's state as the report's header says it (lead UX design section 6.4). */
export const REPORT_STATE_WORDS: Readonly<Record<GoalReportState, string>> = {
  not_conducted: 'Not started',
  conducted_without_delivery: 'Built the older way',
  integrating: 'Building',
  verifying: 'Checking',
  accepted: 'Accepted, waiting to be merged',
  merged: 'Merged',
  needs_human: 'Waiting for your decision',
  abandoned: 'Left unmerged',
}

/** Who a recorded decision came from, in a person's words. */
export const DECISION_SOURCE_WORDS: Readonly<Record<GoalReportSharedDecision['source'], string>> = {
  person: 'You',
  lead: 'The lead',
  conductor_plan: 'Slave',
  conductor_answer: 'Slave',
}

/** One smoke attempt's outcome in words. */
export const SMOKE_WORDS: Readonly<Record<GoalReportSmoke['outcome'], string>> = {
  running: 'Running',
  passed: 'Passed',
  missing: 'No smoke script',
  stub: 'The smoke script does nothing yet',
  failed: 'Failed',
  timed_out: 'Took too long and was stopped',
  error: 'Could not be run',
}

const when = (iso: string): string => new Date(iso).toLocaleString()

/**
 * Lead UX design section 6.4: what exactly was asked, checked, decided and spent for one build,
 * outcome first, one printable column. Sections with nothing in them are left out. The step-by-step
 * trail and the caveats are written in Slave's own vocabulary, so they stay in the Markdown
 * download, which is the full record.
 */
export function ReportView({ report }: { readonly report: GoalReport }): React.JSX.Element {
  const delivery = report.delivery
  const requirements = report.requirements
  const merge = delivery?.merge ?? null
  return (
    <article className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-4 py-6 md:px-8 print:max-w-none" data-testid="report" data-state={report.state}>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/w/${report.workspaceId}`}>
            <ArrowLeftIcon />
            {report.workspaceName}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/w/${report.workspaceId}/goals/${String(report.goalVersion)}/report?format=markdown`} data-testid="report-download">
            <DownloadIcon />
            Download as Markdown
          </a>
        </Button>
      </div>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Build {report.goalVersion} of {report.workspaceName}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary" data-testid="report-state">
            {REPORT_STATE_WORDS[report.state]}
          </Badge>
          {merge !== null && (
            <span className="text-muted-foreground">
              Merged into {merge.into} at <code className="font-mono">{merge.commit.slice(0, 7)}</code> {merge.by === 'human' ? 'by hand' : 'by Slave'}
            </span>
          )}
          {delivery?.mergeError != null && <span className="text-destructive">The merge failed: {delivery.mergeError}</span>}
        </div>
        {report.versions.length > 1 && (
          <nav aria-label="Other builds" className="flex flex-wrap gap-1 text-sm print:hidden">
            {report.versions.map((version) => (
              <Button key={version} asChild size="sm" variant={version === report.goalVersion ? 'secondary' : 'ghost'} className="h-7">
                <Link href={`/w/${report.workspaceId}/goals/${String(version)}`}>Build {version}</Link>
              </Button>
            ))}
          </nav>
        )}
      </header>

      {report.goal !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What you asked for</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{report.goal}</p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="report-requirements">
        <CardHeader>
          <CardTitle className="text-base">Requirements</CardTitle>
          {report.rounds.length > 0 && <CardDescription>Checked {plural(report.rounds.length, 'time')} on the running product.</CardDescription>}
        </CardHeader>
        <CardContent>
          {requirements === null ? (
            <p className="text-sm text-muted-foreground">This build has no report yet: its requirements have not been read.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Requirement and how it was checked</TableHead>
                  <TableHead className="w-36">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requirements.map((item) => (
                  <TableRow key={item.key} data-testid="report-requirement">
                    <TableCell className="align-top font-mono text-xs text-muted-foreground">{item.key}</TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <p>{item.text}</p>
                      {item.verdict !== null && (
                        <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                          <p>{item.verdict.reason}</p>
                          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap">{item.verdict.check}</pre>
                          {item.verdict.output !== '' && <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap">{item.verdict.output}</pre>}
                        </div>
                      )}
                      {item.history.length > 1 && (
                        <p className="mt-1 text-xs text-muted-foreground">Every check: {item.history.map((entry) => entry.status === 'pass' ? 'works' : entry.status === 'fail' ? "doesn't work" : "couldn't check").join(' → ')}</p>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <ResultBadge result={item.verdict?.status ?? 'unchecked'} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {report.smoke.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Smoke check</CardTitle>
            <CardDescription>The product&apos;s own script that starts it and tries it, run before every check.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {report.smoke.map((attempt) => (
              <div key={attempt.attemptId} className="text-sm">
                <p>
                  <span className="font-medium">{SMOKE_WORDS[attempt.outcome]}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {when(attempt.at)}
                    {attempt.exitCode !== null && ` · exit code ${String(attempt.exitCode)}`}
                    {attempt.durationMs !== null && ` · ${formatMinutes(attempt.durationMs)}`}
                  </span>
                </p>
                {attempt.output !== '' && attempt.outcome !== 'passed' && <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{attempt.output}</pre>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {report.decisions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Decisions</CardTitle>
            <CardDescription>What was decided along the way, and by whom.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3 text-sm">
              {report.decisions.map((decision) => (
                <li key={`${decision.at}-${decision.title}`}>
                  <p className="font-medium">
                    {decision.title} <span className="font-normal text-muted-foreground">· {DECISION_SOURCE_WORDS[decision.source]}</span>
                  </p>
                  <p className="text-muted-foreground whitespace-pre-wrap">{decision.decision}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Spend</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          <p>
            This build: {report.spend.runsUnmeasured > 0 ? 'at least ' : ''}
            {formatUsd(report.spend.versionUsd)}
            {report.spend.runsLive > 0 && <span className="text-muted-foreground"> (still running)</span>}
          </p>
          <p className="text-muted-foreground">
            The whole project: {formatUsd(report.spend.projectSpentUsd)}
            {report.spend.projectBudgetUsd !== null && ` of ${formatUsd(report.spend.projectBudgetUsd)}`}
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground print:hidden">The full record (every step, every check, and what it cannot vouch for) is in the Markdown download.</p>
    </article>
  )
}
