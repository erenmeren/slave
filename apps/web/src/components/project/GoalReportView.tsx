import Link from 'next/link'
import {
  CONDUCT_PER_CALL_CAP_USD,
  GOAL_REPORT_ANSWERED_BY,
  GOAL_REPORT_AUTHOR_WORDS,
  GOAL_REPORT_STATE_LABEL,
  acceptedCommitText,
  evidenceAnchor,
  evidenceCut,
  formatReportUsd,
  integratedWhere,
  noPackagesLabel,
  reportCaveats,
  shortCommit,
  unverifiedRequirementLabel,
  type GoalReport,
  type GoalReportState,
  type GoalReportVerdictStatus,
} from '@slave-of-ai/domain'
import { Alert } from '../ui/Alert'
import { Panel } from '../ui/Panel'
import { ScrollArea } from '../ui/ScrollArea'
import { SectionLabel } from '../ui/SectionLabel'
import { StatusPill, type StatusTone } from '../ui/StatusPill'

/** Which handoff tone each report state reads in. The WORD comes from the shared
 *  `GOAL_REPORT_STATE_LABEL` (plan R6), so the page, the export and the chat note say the same. */
const STATE_TONE: Readonly<Record<GoalReportState, StatusTone>> = {
  not_conducted: 'planning',
  conducted_without_delivery: 'idle',
  integrating: 'working',
  verifying: 'review',
  accepted: 'waiting',
  merged: 'done',
  needs_human: 'blocked',
  abandoned: 'idle',
}

const VERDICT_TONE: Readonly<Record<GoalReportVerdictStatus, StatusTone>> = { pass: 'done', fail: 'blocked', unverifiable: 'waiting' }

const PRE = 'mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-chip border border-line bg-bg-1 p-2 font-mono text-[11.5px] text-t1'
const CELL = 'border-b border-line px-2 py-[6px] align-top text-left'

/**
 * One goal version's report (Conductor Plan 5, spec R10, plan D9): the same facts and the same
 * caveats as the Markdown export (`reportCaveats` and the label tables are shared from
 * `@slave-of-ai/domain`), laid out for reading. A pure render of plain data, so no `'use client'`:
 * the server page renders it. Every string another party wrote -- a requirement, a check, an
 * output, a reason, a package title, a question -- is a JSX child, so it is characters on the
 * page, never elements (spec §1: another party's text is data). There is no
 * raw-HTML prop anywhere here.
 */
export function GoalReportView({ report }: { readonly report: GoalReport }): React.JSX.Element {
  const d = report.delivery
  const caveats = reportCaveats(report)
  const base = `/w/${report.workspaceId}`
  const verified = (report.requirements ?? []).filter((item) => item.verdict !== null)
  return (
    <ScrollArea testId="goal-report" className="flex flex-col gap-[var(--gap-2)] p-[var(--gap-3)]">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="type-title text-[18px] font-semibold text-t1">Goal v{report.goalVersion} report</h1>
        {/* `StatusPill`'s own testid is fixed (`status-pill`), so the named wrapper carries the raw
          * state on `title` for a person to hover and a test to read (M44 R5). */}
        <span data-testid="goal-report-state" title={report.state}>
          <StatusPill tone={STATE_TONE[report.state]} label={GOAL_REPORT_STATE_LABEL[report.state]} title={report.state} />
        </span>
        <nav aria-label="Goal versions" className="flex flex-wrap gap-2 text-[12.5px]">
          {report.versions.map((version) => (
            <Link
              key={version}
              data-testid="goal-report-version-link"
              href={`${base}/goals/${String(version)}`}
              {...(version === report.goalVersion ? { 'aria-current': 'page' as const } : {})}
              className={version === report.goalVersion ? 'font-semibold text-t1' : 'text-accent'}
            >
              v{version}
            </Link>
          ))}
        </nav>
        <a
          data-testid="goal-report-download"
          href={`/api${base}/goals/${String(report.goalVersion)}/report?format=markdown`}
          className="ml-auto text-[12.5px] text-accent"
        >
          Download as Markdown
        </a>
      </header>
      <p data-testid="goal-report-facts" className="text-[12.5px] text-t3">
        {report.workspaceName} · as of {report.asOf ?? 'no recorded fact yet'}
        {/* Final wave M6: only a merged version says who merged it -- the Markdown's own rule. */}
        {report.state === 'merged' && d?.merge != null && ` · merged into ${d.merge.into} ${d.merge.by === 'human' ? 'by a person' : 'by Slave'} (commit ${shortCommit(d.merge.commit)})`}
        {report.state === 'accepted' && d !== null && ` · ${acceptedCommitText(report, d.integrationBranch)}`}
        {(report.state === 'integrating' || report.state === 'verifying' || report.state === 'needs_human') &&
          d !== null &&
          d.round > 0 &&
          ` · verification round ${String(d.round)}; at most ${String(d.roundBase + d.roundCap)} before it stops for a person`}
      </p>

      {report.state === 'needs_human' && d?.needsHumanReason != null && (
        <Alert variant="error" testId="goal-report-stopped">
          Why it stopped: {d.needsHumanReason}
        </Alert>
      )}
      {d?.mergeError != null && (
        <Alert variant="notice" testId="goal-report-merge-error">
          The merge git refused: {d.mergeError}
        </Alert>
      )}
      {/* What the report cannot vouch for (plan D8), first after the state: a reader sees the
        * limits before the facts they qualify. */}
      {caveats.length > 0 && (
        <Panel title="What to know">
          <ul data-testid="goal-report-caveats" className="list-disc pl-5 text-[13px] text-tone-waiting">
            {caveats.map((line) => (
              <li key={line} data-testid="goal-report-caveat">
                {line}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Goal">
        <pre className={PRE}>{report.goal ?? 'No goal text is recorded for this version.'}</pre>
      </Panel>

      <Panel title="Requirements">
        {report.requirements === null ? (
          <p className="text-[13px] text-t2">Not extracted yet.</p>
        ) : report.requirements.length === 0 ? (
          <p className="text-[13px] text-t2">No requirements.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-t3">
                  {['Key', 'Requirement', 'Status', 'Round', 'Package', 'Evidence'].map((heading) => (
                    <th key={heading} className={CELL}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.requirements.map((item) => (
                  <tr key={item.key} data-testid="goal-report-requirement" data-key={item.key}>
                    <td className={`${CELL} font-mono`}>{item.key}</td>
                    <td className={CELL}>{item.text}</td>
                    <td className={CELL}>
                      {item.verdict === null ? (
                        <span className="text-t3">{unverifiedRequirementLabel(report.state)}</span>
                      ) : (
                        <StatusPill tone={VERDICT_TONE[item.verdict.status]} label={item.verdict.status} title={item.verdict.status} />
                      )}
                    </td>
                    <td className={CELL}>{item.verdict?.round ?? '—'}</td>
                    <td className={CELL}>{item.packageKey ?? '—'}</td>
                    <td className={CELL}>
                      {item.verdict === null ? (
                        '—'
                      ) : (
                        <a href={`#${evidenceAnchor(item.key)}`} className="text-accent">
                          check and output
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Verification rounds">
        {report.rounds.length === 0 ? (
          <p className="text-[13px] text-t2">No round has run.</p>
        ) : (
          <ul className="text-[13px] text-t2">
            {report.rounds.map((round) => (
              <li key={round.round} data-testid="goal-report-round">
                Round {round.round}: {round.pass} pass, {round.fail} fail, {round.unverifiable} unverifiable. Verified by{' '}
                {round.verifier ?? 'a seat that is gone'} on commit <span className="font-mono">{shortCommit(round.commit)}</span>, finished{' '}
                {round.at}.
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {verified.length > 0 && (
        <Panel title="Evidence">
          {verified.map((item) => {
            const v = item.verdict
            if (v === null) return null
            const earlier = item.history.filter((h) => h.round !== v.round).map((h) => `round ${String(h.round)} ${h.status}`)
            const cut = evidenceCut(v.check) + evidenceCut(v.output) + evidenceCut(v.reason)
            return (
              <section
                key={item.key}
                id={evidenceAnchor(item.key)}
                data-testid="goal-report-evidence"
                className="border-t border-line pt-3 first:border-t-0 first:pt-0"
              >
                <SectionLabel>{`Evidence for ${item.key}`}</SectionLabel>
                <p className="mt-1 text-[13px] text-t1">{item.text}</p>
                <p className="text-[12px] text-t3">Taken from the goal: {item.source === '' ? '—' : item.source}</p>
                <p className="mt-1 text-[12.5px] text-t2">
                  <StatusPill tone={VERDICT_TONE[v.status]} label={v.status} title={v.status} /> in round {v.round} (run{' '}
                  <span className="font-mono">{v.runId}</span>){earlier.length > 0 && `; earlier: ${earlier.join(', ')}`}
                </p>
                <p className="mt-2 text-[12px] text-t3">Check</p>
                <pre className={PRE}>{v.check === '' ? 'No check was written.' : v.check}</pre>
                <p className="mt-2 text-[12px] text-t3">Output</p>
                <pre className={PRE}>{v.output === '' ? 'No output.' : v.output}</pre>
                {v.reason !== '' && (
                  <>
                    <p className="mt-2 text-[12px] text-t3">Reason</p>
                    <pre className={PRE}>{v.reason}</pre>
                  </>
                )}
                {cut > 0 && <p className="mt-1 text-[12px] text-tone-waiting">Trimmed: {cut} characters cut from this evidence.</p>}
              </section>
            )
          })}
        </Panel>
      )}

      <Panel title="Packages">
        {report.packages.length === 0 && <p className="text-[13px] text-t2">{noPackagesLabel(report.state)}</p>}
        {report.packages.map((pkg) => (
          <section
            key={pkg.key}
            data-testid="goal-report-package"
            data-key={pkg.key}
            className="border-t border-line pt-3 text-[13px] text-t2 first:border-t-0 first:pt-0"
          >
            <p className="font-medium text-t1">
              {pkg.key}: {pkg.title}
              {pkg.isIntegration && ' (the integration package)'}
            </p>
            <p>
              Seat: {pkg.seat ?? 'none'}
              {pkg.persona !== null && ` (persona ${pkg.persona})`} · requirements:{' '}
              {pkg.requirementKeys.length === 0 ? 'none of its own' : pkg.requirementKeys.join(', ')}
            </p>
            <p>
              Owns: <span className="font-mono text-[12px]">{pkg.ownedPaths.join(', ')}</span>
            </p>
            {pkg.dependsOn.length > 0 && <p>Depends on: {pkg.dependsOn.join(', ')}</p>}
            <p>
              Task: {pkg.taskStatus ?? 'none'}
              {pkg.integrated && integratedWhere(report)} · {pkg.implementationRuns} implementation{' '}
              {pkg.implementationRuns === 1 ? 'run' : 'runs'}
            </p>
            <p>
              Files merged (from git):{' '}
              <span className="font-mono text-[12px]">
                {pkg.mergedFiles === null ? 'not recorded' : pkg.mergedFiles.length === 0 ? 'none' : pkg.mergedFiles.join(', ')}
              </span>
              {pkg.mergedFilesTruncated && ' (cut)'}
            </p>
            <p>
              Files the worker reported:{' '}
              <span className="font-mono text-[12px]">
                {pkg.reportedFiles === null ? 'no report filed' : pkg.reportedFiles.length === 0 ? 'none' : pkg.reportedFiles.join(', ')}
              </span>
            </p>
            {pkg.report !== null && (
              <p>
                The worker&apos;s report:{' '}
                {pkg.report.requirements.length === 0
                  ? 'no requirement'
                  : pkg.report.requirements.map((r) => `${r.key} ${r.status.replace('_', ' ')}`).join(', ')}
                ; workflow {pkg.report.workflowDone} of {pkg.report.workflowTotal} steps done
              </p>
            )}
          </section>
        ))}
        <p className="text-[13px] text-t2">Verifier: {report.verifier ?? 'none recorded'}</p>
      </Panel>

      <Panel title="Spend">
        <dl data-testid="goal-report-spend" className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px] text-t2">
          <dt>Runs of this version</dt>
          <dd>
            {formatReportUsd(report.spend.runsMeasuredUsd)}
            {report.spend.runsUnmeasured > 0 && ` + ${String(report.spend.runsUnmeasured)} unmeasured (not in the total)`}
            {report.spend.runsLive > 0 && ` + ${String(report.spend.runsLive)} still running`}
          </dd>
          <dt>Conductor calls</dt>
          <dd>
            {formatReportUsd(report.spend.conductorMeasuredUsd)}
            {report.spend.conductorUnmeasuredCalls > 0 &&
              ` + ${String(report.spend.conductorUnmeasuredCalls)} unmeasured, charged at ${formatReportUsd(CONDUCT_PER_CALL_CAP_USD)} each`}
          </dd>
          <dt>Supervisor decisions</dt>
          <dd>
            {formatReportUsd(report.spend.supervisorMeasuredUsd)}
            {report.spend.supervisorUnmeasuredCalls > 0 && ` + ${String(report.spend.supervisorUnmeasuredCalls)} unmeasured, charged at the cap`}
          </dd>
          <dt className="font-medium text-t1">This version</dt>
          <dd className="font-medium text-t1">{formatReportUsd(report.spend.versionUsd)}</dd>
          <dt>Project so far</dt>
          <dd>
            {formatReportUsd(report.spend.projectSpentUsd)}
            {report.spend.projectBudgetUsd === null ? ', no budget set' : ` of a ${formatReportUsd(report.spend.projectBudgetUsd)} budget`}
          </dd>
        </dl>
        <p className="text-[12px] text-t3">
          The conversation with the Supervisor and the intake are counted in the project figure only: they belong to no one version.
        </p>
      </Panel>

      <Panel title="Decision trail">
        {report.trail.length === 0 && <p className="text-[13px] text-t2">Nothing recorded yet.</p>}
        <ol className="flex flex-col gap-2 text-[13px] text-t2">
          {report.trail.map((entry, index) => (
            <li key={`${entry.at}-${String(index)}`} data-testid="goal-report-trail-entry">
              <span className="font-mono text-[11.5px] text-t3">{entry.at}</span> {entry.text}
              {entry.detail !== null && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[12px] text-t3">{GOAL_REPORT_AUTHOR_WORDS[entry.detailBy ?? 'system']}</summary>
                  <pre className={PRE}>{entry.detail}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Questions">
        {report.questions.length === 0 && <p className="text-[13px] text-t2">No questions were asked.</p>}
        {report.questions.map((q) => (
          <div key={q.id} data-testid="goal-report-question" className="text-[13px] text-t2">
            <p>
              <span className="font-mono text-[11.5px] text-t3">{q.at}</span> {q.packageKey ?? 'A worker'}
              {q.askedBy !== null && ` (${q.askedBy})`} asked:
            </p>
            <pre className={PRE}>{q.question}</pre>
            {q.answer === null ? (
              <p className="text-tone-waiting">Not answered.</p>
            ) : (
              <>
                <p>
                  Answered by {GOAL_REPORT_ANSWERED_BY[q.answer.by]} at {q.answer.at}:
                </p>
                <pre className={PRE}>{q.answer.text}</pre>
              </>
            )}
          </div>
        ))}
      </Panel>

      <p className="text-[12px] text-t3">Built from Slave&apos;s records of this goal version. Quoted text is marked with who wrote it.</p>
    </ScrollArea>
  )
}
