import { CONDUCT_PER_CALL_CAP_USD } from '../conduct/constants.js'
import { DECISION_SOURCE_LABEL, GOAL_REPORT_STATE_LABEL, HAND_OFF_STATUS_LABEL, acceptedCommitText, handOffNote, noPackagesLabel, reportCaveats, smokeOutcomeLabel, unverifiedRequirementLabel } from './caveats.js'
import { evidenceAnchor, evidenceCut, formatReportUsd, mdFence, mdInline, mdQuote, shortCommit } from './escape.js'
import type { QuestionCloseReason } from '../messaging/close.js'
import { formatWait } from '../supervisor/cards.js'
import type { GoalReport, GoalReportAuthor, GoalReportQuestion } from './types.js'

/** Who wrote a trail entry's quoted `detail` (plan D6), in words. Exported (plan R6: shared from
 *  one place) so the web page's decision-trail panel (a later task) prints the same words rather
 *  than defining its own copy. */
export const GOAL_REPORT_AUTHOR_WORDS: Readonly<Record<GoalReportAuthor, string>> = {
  system: "Slave's record",
  model: "the model's words",
  person: "a person's words",
}

/** Who answered a question (plan D6/spec R10). Exported for the same reason as
 *  {@link GOAL_REPORT_AUTHOR_WORDS}. */
export const GOAL_REPORT_ANSWERED_BY = { person: 'a person', supervisor: 'the Supervisor', slave: 'a slave' } as const

/** Human cards H1: how a question closed, in words (shared with the web page). */
export const GOAL_REPORT_CLOSE_WORDS = {
  answered: 'answered',
  decided: 'decided on a card',
  dismissed: 'closed without an answer',
  timed_out: 'continued without an answer',
  superseded: 'superseded by a new goal version',
} as const satisfies Readonly<Record<QuestionCloseReason, string>>

/** Who closed a question, in words (shared with the web page): the report never names a user id. */
export const GOAL_REPORT_CLOSED_BY = { system: 'Slave', person: 'a person' } as const

/** A closed question's line, after "Closed: " -- a timeout says how long the run waited. Shared
 *  with the web page, so the two say the same. */
export function questionClosedWords(closed: NonNullable<GoalReportQuestion['closed']>): string {
  return closed.reason === 'timed_out' ? `${GOAL_REPORT_CLOSE_WORDS.timed_out} after ${formatWait(closed.waitedMs)}` : GOAL_REPORT_CLOSE_WORDS[closed.reason]
}

/** Human cards H3: the questions a run continued past without an answer, in report order. */
export function continuedWithoutAnswer(report: GoalReport): readonly (GoalReportQuestion & { readonly closed: NonNullable<GoalReportQuestion['closed']> })[] {
  return report.questions.flatMap((q) => (q.closed !== null && q.closed.reason === 'timed_out' ? [{ ...q, closed: q.closed }] : []))
}

/** Where the asking task is read in the app -- its runs and the worker's own report, which names the
 *  assumption a continued run made. Ids are encoded, so the link is a link whatever they hold. The
 *  web page links it; the Markdown export names the task instead. */
export function questionTaskHref(workspaceId: string, taskId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/tasks?task=${encodeURIComponent(taskId)}`
}

/**
 * The goal version's report as Markdown (spec R10, plan D7): deterministic (a pure function of
 * `report`, no clock read, no sorting of its own) and inert (every value another party wrote goes
 * through `mdInline`, `mdFence` or `mdQuote`). Sections, in order: state, what to know, why it
 * stopped, a refused merge, goal, requirements, rounds, smoke checks, shared decisions, hand-offs, evidence, packages, denied
 * tool calls, spend, decision trail, runs that continued without an answer (when any), questions.
 */
export function renderGoalReportMarkdown(report: GoalReport): string {
  const lines: string[] = []
  const d = report.delivery
  lines.push(`# Goal v${String(report.goalVersion)} report: ${mdInline(report.workspaceName)}`, '')
  lines.push(`State: **${GOAL_REPORT_STATE_LABEL[report.state]}**${stateDetail(report)}`, '')
  lines.push(`As of: ${report.asOf === null ? 'no recorded fact yet' : mdInline(report.asOf)}`, '')

  const caveats = reportCaveats(report)
  if (caveats.length > 0) lines.push('## What to know', '', ...caveats.map((line) => `- ${mdInline(line)}`), '')
  if (report.state === 'needs_human' && d?.needsHumanReason != null) lines.push('## Why it stopped', '', ...mdQuote(d.needsHumanReason), '')
  if (d?.mergeError != null) lines.push('## The merge git refused', '', mdFence(d.mergeError), '')

  lines.push('## Goal', '', report.goal === null ? 'No goal text is recorded for this version.' : mdFence(report.goal), '')

  lines.push('## Requirements', '')
  if (report.requirements === null) {
    lines.push('Not extracted yet.', '')
  } else {
    lines.push('| Key | Requirement | Status | Round | Package | Evidence |', '| --- | --- | --- | --- | --- | --- |')
    for (const item of report.requirements) {
      const v = item.verdict
      lines.push(
        `| ${mdInline(item.key)} | ${mdInline(item.text)} | ${v === null ? unverifiedRequirementLabel(report.state) : mdInline(v.status)} | ${v === null ? '—' : String(v.round)} | ` +
          `${item.packageKey === null ? '—' : mdInline(item.packageKey)} | ${v === null ? '—' : `[check and output](#${evidenceAnchor(item.key)})`} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Verification rounds', '')
  if (report.rounds.length === 0) {
    lines.push('No round has run.', '')
  } else {
    lines.push('| Round | Verifier | Commit checked | Pass | Fail | Unverifiable | Finished |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const round of report.rounds) {
      lines.push(
        `| ${String(round.round)} | ${round.verifier === null ? '—' : mdInline(round.verifier)} | ${shortCommit(round.commit)} | ` +
          `${String(round.pass)} | ${String(round.fail)} | ${String(round.unverifiable)} | ${mdInline(round.at)} |`,
      )
    }
    lines.push('')
  }

  // Skeleton spec S7 (plan B D10): every smoke attempt of the version, and each hand-off (D11).
  lines.push('## Smoke checks', '')
  if (report.smoke.length === 0) {
    lines.push('No smoke check has run.', '')
  } else {
    lines.push('| Round | Outcome | Exit | Took | Commit checked | Sent back | Finished |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const s of report.smoke) {
      lines.push(
        `| ${String(s.round)} | ${mdInline(smokeOutcomeLabel(s))} | ${s.exitCode === null ? '—' : String(s.exitCode)} | ` +
          `${s.durationMs === null ? '—' : `${String(Math.round(s.durationMs / 1000))} s`} | ${shortCommit(s.tip)} | ` +
          `${s.reworkedPackage === null ? '—' : mdInline(s.reworkedPackage)} | ${mdInline(s.at)} |`,
      )
    }
    // The change is the worker's raw words: `mdInline` defuses markers, escapes HTML and Markdown
    // punctuation, and folds its lines into one, so no fence, heading or tag can start from it.
    const handed = report.smoke.filter((s) => s.handOff !== null)
    if (handed.length > 0) lines.push('')
    for (const s of handed) {
      const h = s.handOff
      if (h === null) continue
      lines.push(
        `- Round ${String(s.round)}: ${s.reworkedPackage === null ? 'a package' : mdInline(s.reworkedPackage)} handed the fix to ${mdInline(h.toPackage)} (${mdInline(h.path)})` +
          `${h.change === '' ? '' : `: ${mdInline(h.change)}`}`,
      )
    }
    const latest = report.smoke.at(-1)
    if (latest !== undefined && latest.output !== '') lines.push('', `Output of the latest smoke check (round ${String(latest.round)}):`, '', mdFence(latest.output))
    lines.push('')
  }

  // Supervisor-as-conductor spec C3: the version's shared decisions, as every contract listed them.
  lines.push('## Shared decisions', '')
  if (report.decisions.length === 0) lines.push('No shared decision was recorded.', '')
  else {
    for (const d of report.decisions) lines.push(`- ${mdInline(d.title)}: ${mdInline(d.decision)} (${DECISION_SOURCE_LABEL[d.source]})`)
    lines.push('')
  }

  // Spec C2: every hand-off, where it went and what became of it. The change and the note are words
  // a worker or the conductor wrote, so they are escaped; the parentheses around the note are literal.
  lines.push('## Hand-offs', '')
  if (report.handOffs.length === 0) lines.push('No package handed work to another.', '')
  else {
    for (const h of report.handOffs) {
      const what = h.path ?? h.packageKey
      const note = handOffNote(h)
      lines.push(
        `- ${mdInline(h.fromPackage ?? 'the conductor')} → ${mdInline(h.toPackage ?? 'no package')}${what === null ? '' : ` (${mdInline(what)})`}, ` +
          `${mdInline(HAND_OFF_STATUS_LABEL[h.status])}${note === null ? '' : ` (${mdInline(note)})`}: ${mdInline(h.change)}`,
      )
    }
    if (report.handOffsOmitted > 0) lines.push(`- … and ${String(report.handOffsOmitted)} more, not listed.`)
    lines.push('')
  }

  const verified = (report.requirements ?? []).filter((item) => item.verdict !== null)
  if (verified.length > 0) {
    lines.push('## Evidence', '')
    for (const item of verified) {
      const v = item.verdict
      if (v === null) continue
      const earlier = item.history.filter((h) => h.round !== v.round).map((h) => `round ${String(h.round)} ${mdInline(h.status)}`)
      lines.push(`### Evidence for ${mdInline(item.key)}`, '')
      lines.push(`Requirement: ${mdInline(item.text)}`, '')
      lines.push(`Taken from the goal: ${item.source === '' ? '—' : mdInline(item.source)}`, '')
      lines.push(`Verdict: **${mdInline(v.status)}** in round ${String(v.round)} (run ${mdInline(v.runId)})${earlier.length === 0 ? '' : `; earlier: ${earlier.join(', ')}`}.`, '')
      lines.push('Check:', '', v.check === '' ? 'No check was written.' : mdFence(v.check), '')
      lines.push('Output:', '', v.output === '' ? 'No output.' : mdFence(v.output), '')
      if (v.reason !== '') lines.push('Reason:', '', ...mdQuote(v.reason), '')
      const cut = evidenceCut(v.check) + evidenceCut(v.output) + evidenceCut(v.reason)
      if (cut > 0) lines.push(`(Trimmed: ${String(cut)} characters cut from this evidence.)`, '')
    }
  }

  lines.push('## Packages', '')
  if (report.packages.length === 0) lines.push(noPackagesLabel(report.state), '')
  for (const pkg of report.packages) {
    lines.push(`### ${mdInline(pkg.key)}: ${mdInline(pkg.title)}${pkg.isIntegration ? ' (the integration package)' : ''}`, '')
    lines.push(`- Seat: ${pkg.seat === null ? 'none' : mdInline(pkg.seat)}${pkg.persona === null ? '' : ` (persona ${mdInline(pkg.persona)})`}`)
    lines.push(`- Requirements: ${pkg.requirementKeys.length === 0 ? 'none of its own' : pkg.requirementKeys.map(mdInline).join(', ')}`)
    lines.push(`- Owns: ${pkg.ownedPaths.map(mdInline).join(', ')}`)
    if (pkg.dependsOn.length > 0) lines.push(`- Depends on: ${pkg.dependsOn.map(mdInline).join(', ')}`)
    lines.push(
      `- Task: ${pkg.taskStatus === null ? 'none' : mdInline(pkg.taskStatus)}${pkg.integrated ? integratedWhere(report) : ''}; ` +
        `${String(pkg.implementationRuns)} implementation ${pkg.implementationRuns === 1 ? 'run' : 'runs'}`,
    )
    lines.push(`- Files merged (from git): ${pkg.mergedFiles === null ? 'not recorded' : pkg.mergedFiles.length === 0 ? 'none' : pkg.mergedFiles.map(mdInline).join(', ')}${pkg.mergedFilesTruncated ? ' (cut)' : ''}`)
    lines.push(`- Files the worker reported: ${pkg.reportedFiles === null ? 'no report filed' : pkg.reportedFiles.length === 0 ? 'none' : pkg.reportedFiles.map(mdInline).join(', ')}`)
    if (pkg.report !== null) {
      const claims = pkg.report.requirements.map((r) => `${mdInline(r.key)} ${mdInline(r.status.replace('_', ' '))}`).join(', ')
      lines.push(`- The worker's report: ${claims === '' ? 'no requirement' : claims}; workflow ${String(pkg.report.workflowDone)} of ${String(pkg.report.workflowTotal)} steps done`)
    }
    lines.push('')
  }
  lines.push(`Verifier: ${report.verifier === null ? 'none recorded' : mdInline(report.verifier)}`, '')

  // Skeleton spec S9 (plan B D10): the tool calls the version's runs were refused.
  lines.push('## Denied tool calls', '')
  if (report.deniedToolCalls.length === 0) lines.push('No denied tool call is recorded.', '')
  for (const denial of report.deniedToolCalls) {
    lines.push(`- ${mdInline(denial.at)} · ${denial.packageKey === null ? 'the verifier' : mdInline(denial.packageKey)}: ${mdInline(denial.detail)} (run ${mdInline(denial.runId)})`)
  }
  if (report.deniedToolCallsOmitted > 0) lines.push(`- … and ${String(report.deniedToolCallsOmitted)} more, not listed.`)
  if (report.deniedToolCalls.length > 0 || report.deniedToolCallsOmitted > 0) lines.push('')

  const s = report.spend
  lines.push('## Spend', '', '| Part | Amount |', '| --- | --- |')
  // Final wave M5: the same suffixes as the page's runs row, so the two say the same thing.
  lines.push(
    `| Runs of this version | ${formatReportUsd(s.runsMeasuredUsd)}${s.runsUnmeasured === 0 ? '' : ` + ${String(s.runsUnmeasured)} unmeasured (not in the total)`}` +
      `${s.runsLive === 0 ? '' : ` + ${String(s.runsLive)} still running`} |`,
  )
  lines.push(
    `| Conductor calls | ${formatReportUsd(s.conductorMeasuredUsd)}${s.conductorUnmeasuredCalls === 0 ? '' : ` + ${String(s.conductorUnmeasuredCalls)} unmeasured, charged at ${formatReportUsd(CONDUCT_PER_CALL_CAP_USD)} each`} |`,
  )
  lines.push(`| Supervisor decisions | ${formatReportUsd(s.supervisorMeasuredUsd)}${s.supervisorUnmeasuredCalls === 0 ? '' : ` + ${String(s.supervisorUnmeasuredCalls)} unmeasured, charged at the cap`} |`)
  lines.push(`| **This version** | **${formatReportUsd(s.versionUsd)}** |`)
  lines.push(
    `| Project so far | ${formatReportUsd(s.projectSpentUsd)}${s.projectBudgetUsd === null ? ', no budget set' : ` of a ${formatReportUsd(s.projectBudgetUsd)} budget`} |`,
    '',
  )
  lines.push('The conversation with the Supervisor and the intake are counted in the project figure only: they belong to no one version.', '')

  lines.push('## Decision trail', '')
  if (report.trail.length === 0) lines.push('Nothing recorded yet.')
  for (const entry of report.trail) {
    lines.push(`- ${mdInline(entry.at)} · ${mdInline(entry.text)}${entry.detail === null ? '' : ` (${GOAL_REPORT_AUTHOR_WORDS[entry.detailBy ?? 'system']}:)`}`)
    if (entry.detail !== null) lines.push(...mdQuote(entry.detail).map((line) => `  ${line}`))
  }
  lines.push('')

  const continued = continuedWithoutAnswer(report)
  if (continued.length > 0) {
    lines.push('## Runs that continued without an answer', '')
    for (const q of continued) {
      lines.push(`- ${mdInline(q.at)} · ${askerWords(q)} waited ${formatWait(q.closed.waitedMs)}, then continued on its own assumption:`, ...mdQuote(q.question).map((line) => `  ${line}`), '')
      // No link: an exported file has no app to follow one into (fix round 1). The task id names it.
      lines.push(`  The assumption is in the worker's report${q.taskId === null ? '' : ` on task ${mdInline(q.taskId)}`}.`, '')
    }
  }

  lines.push('## Questions', '')
  if (report.questions.length === 0) lines.push('No questions were asked.', '')
  for (const q of report.questions) {
    lines.push(`- ${mdInline(q.at)} · ${askerWords(q)} asked:`, ...mdQuote(q.question).map((line) => `  ${line}`), '')
    // A blank line separates the quoted question from what follows: without it, CommonMark's
    // lazy continuation reads a plain "Answered by …"/"Not answered." line as more text inside
    // the worker's own blockquote (no ">" is required to continue a blockquote's last paragraph,
    // only to interrupt one) -- fix round 1, I1.
    if (q.answer === null) {
      lines.push('  Not answered.', '')
    } else {
      lines.push(`  Answered by ${GOAL_REPORT_ANSWERED_BY[q.answer.by]} at ${mdInline(q.answer.at)}:`, ...mdQuote(q.answer.text).map((line) => `  ${line}`), '')
    }
    if (q.closed !== null && q.closed.reason !== 'answered') {
      lines.push(`  Closed: ${questionClosedWords(q.closed)} (${GOAL_REPORT_CLOSED_BY[q.closed.by]}, ${mdInline(q.closed.at)}).`, '')
    }
  }

  lines.push('---', '', "Built from Slave's records of this goal version. Quoted text is marked with who wrote it.")
  return `${lines.join('\n').trimEnd()}\n`
}

/** Who asked, escaped: the package and the seat's name, or "A worker" when neither is known. */
function askerWords(q: GoalReportQuestion): string {
  const who = [q.packageKey === null ? null : mdInline(q.packageKey), q.askedBy === null ? null : `(${mdInline(q.askedBy)})`].filter((part) => part !== null).join(' ')
  return who === '' ? 'A worker' : who
}

/** Where an integrated package's task landed (final wave I1): the integration branch when the
 *  version has a delivery; the base branch for a version conducted before there was one. Shared
 *  with the web page, so the two say the same. */
export function integratedWhere(report: GoalReport): string {
  return report.delivery === null ? `, merged into ${report.baseBranch}` : ', on the integration branch'
}

/** What follows the state word: who merged and where, what is verified, which round. */
function stateDetail(report: GoalReport): string {
  const d = report.delivery
  if (d === null) return ''
  if (report.state === 'merged' && d.merge !== null) {
    return ` into ${mdInline(d.merge.into)} ${d.merge.by === 'human' ? 'by a person' : 'by Slave'} (commit ${shortCommit(d.merge.commit)})`
  }
  if (report.state === 'accepted') return ` (${acceptedCommitText(report, mdInline(d.integrationBranch))})`
  if (report.state === 'integrating' || report.state === 'verifying' || report.state === 'needs_human') {
    return d.round === 0 ? '' : ` (verification round ${String(d.round)}; at most ${String(d.roundBase + d.roundCap)} before it stops for a person)`
  }
  return ''
}
