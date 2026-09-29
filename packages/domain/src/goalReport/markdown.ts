import { CONDUCT_PER_CALL_CAP_USD } from '../conduct/constants.js'
import { GOAL_REPORT_STATE_LABEL, reportCaveats } from './caveats.js'
import { evidenceAnchor, evidenceCut, formatReportUsd, mdFence, mdInline, mdQuote, shortCommit } from './escape.js'
import type { GoalReport, GoalReportAuthor } from './types.js'

/** Who wrote a trail entry's quoted `detail` (plan D6), in words. Exported (plan R6: shared from
 *  one place) so the web page's decision-trail panel (a later task) prints the same words rather
 *  than defining its own copy. */
export const WORDS_OF: Readonly<Record<GoalReportAuthor, string>> = {
  system: "Slave's record",
  model: "the model's words",
  person: "a person's words",
}

/** Who answered a question (plan D6/spec R10). Exported for the same reason as {@link WORDS_OF}. */
export const ANSWERED_BY = { person: 'a person', supervisor: 'the Supervisor', slave: 'a slave' } as const

/**
 * The goal version's report as Markdown (spec R10, plan D7): deterministic (a pure function of
 * `report`, no clock read, no sorting of its own) and inert (every value another party wrote goes
 * through `mdInline`, `mdFence` or `mdQuote`). Sections, in order: state, what to know, why it
 * stopped, a refused merge, goal, requirements, rounds, evidence, packages, spend, decision trail,
 * questions.
 */
export function renderGoalReportMarkdown(report: GoalReport): string {
  const lines: string[] = []
  const d = report.delivery
  lines.push(`# Goal v${String(report.goalVersion)} report: ${mdInline(report.workspaceName)}`, '')
  lines.push(`State: **${GOAL_REPORT_STATE_LABEL[report.state]}**${stateDetail(report)}`, '')
  lines.push(`As of: ${report.asOf ?? 'no recorded fact yet'}`, '')

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
        `| ${mdInline(item.key)} | ${mdInline(item.text)} | ${v === null ? 'not verified yet' : v.status} | ${v === null ? '—' : String(v.round)} | ` +
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
          `${String(round.pass)} | ${String(round.fail)} | ${String(round.unverifiable)} | ${round.at} |`,
      )
    }
    lines.push('')
  }

  const verified = (report.requirements ?? []).filter((item) => item.verdict !== null)
  if (verified.length > 0) {
    lines.push('## Evidence', '')
    for (const item of verified) {
      const v = item.verdict
      if (v === null) continue
      const earlier = item.history.filter((h) => h.round !== v.round).map((h) => `round ${String(h.round)} ${h.status}`)
      lines.push(`### Evidence for ${mdInline(item.key)}`, '')
      lines.push(`Requirement: ${mdInline(item.text)}`, '')
      lines.push(`Taken from the goal: ${item.source === '' ? '—' : mdInline(item.source)}`, '')
      lines.push(`Verdict: **${v.status}** in round ${String(v.round)} (run ${mdInline(v.runId)})${earlier.length === 0 ? '' : `; earlier: ${earlier.join(', ')}`}.`, '')
      lines.push('Check:', '', v.check === '' ? 'No check was written.' : mdFence(v.check), '')
      lines.push('Output:', '', v.output === '' ? 'No output.' : mdFence(v.output), '')
      if (v.reason !== '') lines.push('Reason:', '', ...mdQuote(v.reason), '')
      const cut = evidenceCut(v.check) + evidenceCut(v.output) + evidenceCut(v.reason)
      if (cut > 0) lines.push(`(Trimmed: ${String(cut)} characters cut from this evidence.)`, '')
    }
  }

  lines.push('## Packages', '')
  if (report.packages.length === 0) lines.push('No packages yet.', '')
  for (const pkg of report.packages) {
    lines.push(`### ${mdInline(pkg.key)}: ${mdInline(pkg.title)}${pkg.isIntegration ? ' (the integration package)' : ''}`, '')
    lines.push(`- Seat: ${pkg.seat === null ? 'none' : mdInline(pkg.seat)}${pkg.persona === null ? '' : ` (persona ${mdInline(pkg.persona)})`}`)
    lines.push(`- Requirements: ${pkg.requirementKeys.length === 0 ? 'none of its own' : pkg.requirementKeys.map(mdInline).join(', ')}`)
    lines.push(`- Owns: ${pkg.ownedPaths.map(mdInline).join(', ')}`)
    if (pkg.dependsOn.length > 0) lines.push(`- Depends on: ${pkg.dependsOn.map(mdInline).join(', ')}`)
    lines.push(
      `- Task: ${pkg.taskStatus === null ? 'none' : mdInline(pkg.taskStatus)}${pkg.integrated ? ', on the integration branch' : ''}; ` +
        `${String(pkg.implementationRuns)} implementation ${pkg.implementationRuns === 1 ? 'run' : 'runs'}`,
    )
    lines.push(`- Files merged (from git): ${pkg.mergedFiles === null ? 'not recorded' : pkg.mergedFiles.length === 0 ? 'none' : pkg.mergedFiles.map(mdInline).join(', ')}${pkg.mergedFilesTruncated ? ' (cut)' : ''}`)
    lines.push(`- Files the worker reported: ${pkg.reportedFiles === null ? 'no report filed' : pkg.reportedFiles.length === 0 ? 'none' : pkg.reportedFiles.map(mdInline).join(', ')}`)
    if (pkg.report !== null) {
      const claims = pkg.report.requirements.map((r) => `${mdInline(r.key)} ${r.status.replace('_', ' ')}`).join(', ')
      lines.push(`- The worker's report: ${claims === '' ? 'no requirement' : claims}; workflow ${String(pkg.report.workflowDone)} of ${String(pkg.report.workflowTotal)} steps done`)
    }
    lines.push('')
  }
  lines.push(`Verifier: ${report.verifier === null ? 'none recorded' : mdInline(report.verifier)}`, '')

  const s = report.spend
  lines.push('## Spend', '', '| Part | Amount |', '| --- | --- |')
  lines.push(`| Runs of this version | ${formatReportUsd(s.runsMeasuredUsd)} |`)
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
    lines.push(`- ${entry.at} · ${mdInline(entry.text)}${entry.detail === null ? '' : ` (${WORDS_OF[entry.detailBy ?? 'system']}:)`}`)
    if (entry.detail !== null) lines.push(...mdQuote(entry.detail).map((line) => `  ${line}`))
  }
  lines.push('')

  lines.push('## Questions', '')
  if (report.questions.length === 0) lines.push('No questions were asked.')
  for (const q of report.questions) {
    const who = [q.packageKey === null ? null : mdInline(q.packageKey), q.askedBy === null ? null : `(${mdInline(q.askedBy)})`].filter((part) => part !== null).join(' ')
    lines.push(`- ${q.at} · ${who === '' ? 'A worker' : who} asked:`, ...mdQuote(q.question).map((line) => `  ${line}`))
    if (q.answer === null) lines.push('  Not answered.')
    else lines.push(`  Answered by ${ANSWERED_BY[q.answer.by]} at ${q.answer.at}:`, ...mdQuote(q.answer.text).map((line) => `  ${line}`))
  }
  lines.push('')

  lines.push('---', '', "Built from Slave's records of this goal version. Quoted text is marked with who wrote it.")
  return `${lines.join('\n').trimEnd()}\n`
}

/** What follows the state word: who merged and where, what is verified, which round. */
function stateDetail(report: GoalReport): string {
  const d = report.delivery
  if (d === null) return ''
  if (report.state === 'merged' && d.merge !== null) {
    return ` into ${mdInline(d.merge.into)} ${d.merge.by === 'human' ? 'by a person' : 'by Slave'} (commit ${shortCommit(d.merge.commit)})`
  }
  if (report.state === 'accepted') return ` (verified commit ${shortCommit(d.verifiedCommit)} on ${mdInline(d.integrationBranch)})`
  if (report.state === 'integrating' || report.state === 'verifying' || report.state === 'needs_human') {
    return d.round === 0 ? '' : ` (verification round ${String(d.round)}; at most ${String(d.roundBase + d.roundCap)} before it stops for a person)`
  }
  return ''
}
