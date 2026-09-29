import { handMergeInstruction } from '../conduct/goalBranch.js'
import { sanitisePersonText } from '../handoff/contract.js'
import { GOAL_REPORT_SUMMARY_MAX_CHARS } from './constants.js'
import { formatReportUsd, shortCommit } from './escape.js'
import type { GoalReport } from './types.js'

/** What the note says that the report's own rows do not carry. */
export interface GoalReportSummaryOptions {
  /** An accepted version with `autoMerge` on whose newest goal-pass trip is "waits for a clean
   *  checkout" (final wave M8): the note asks for a clean checkout, not a hand merge. */
  readonly waitsForCleanCheckout?: boolean
}

/**
 * The Supervisor chat's note when a goal version comes to rest (spec R10, plan D10): what happened
 * to it, how its requirements stand, who held its packages, what it cost. Then a pointer to the
 * report, where the evidence and the trail are. Plain text, composed from the report's facts:
 * package keys come from the conductor's answer, seats are person names, the stop reason is
 * Slave's own sentence, and all of it is defused (`sanitisePersonText`) because the note sits in
 * the conversation history later chat turns read. Bounded by `GOAL_REPORT_SUMMARY_MAX_CHARS`.
 */
export function goalReportSummary(report: GoalReport, options: GoalReportSummaryOptions = {}): string {
  const lines = [`Goal v${String(report.goalVersion)} report: ${headline(report, options)}`, requirementsLine(report)]
  if (report.packages.length > 0) lines.push(`Packages: ${report.packages.map((pkg) => `${pkg.key} (${pkg.seat ?? 'no seat'})`).join(', ')}.`)
  const s = report.spend
  lines.push(
    `Spend on this version: ${formatReportUsd(s.versionUsd)}` +
      `${s.runsUnmeasured === 0 ? '' : ` (${String(s.runsUnmeasured)} ${s.runsUnmeasured === 1 ? 'run' : 'runs'} did not report a cost)`}` +
      `; project: ${formatReportUsd(s.projectSpentUsd)}${s.projectBudgetUsd === null ? ', no budget set' : ` of a ${formatReportUsd(s.projectBudgetUsd)} budget`}.`,
  )
  lines.push('Open the report for the evidence behind each requirement and the decision trail.')
  return sanitisePersonText(lines.join('\n')).slice(0, GOAL_REPORT_SUMMARY_MAX_CHARS)
}

function headline(report: GoalReport, options: GoalReportSummaryOptions): string {
  const d = report.delivery
  const base = d?.baseBranch ?? report.baseBranch
  switch (report.state) {
    case 'merged': {
      const merge = d?.merge ?? null
      if (merge === null) return `merged into ${base}.`
      // Plan D2: a hand merge whose commit is not the verified one landed a tree nobody verified.
      // With no verified commit on record there is nothing to compare with (final wave T4), so the
      // note says that rather than a verdict either way.
      if (merge.by === 'human' && d?.verifiedCommit == null) {
        return `merged into ${merge.into} by a person (commit ${shortCommit(merge.commit)}); no verified commit is recorded for it.`
      }
      if (merge.by === 'human' && merge.commit !== d?.verifiedCommit) {
        return `merged into ${merge.into} by a person (commit ${shortCommit(merge.commit)}); that tree was not itself verified.`
      }
      // Final wave M1: "the verified commit" only when the records say it is.
      const verified = d?.verifiedCommit != null && merge.commit === d.verifiedCommit ? ', the verified commit' : ''
      return `merged into ${merge.into}${merge.by === 'human' ? ' by a person' : ''} (commit ${shortCommit(merge.commit)}${verified}).`
    }
    case 'conducted_without_delivery':
      return `conducted before Slave built goal versions on an integration branch; its packages merged straight into ${base}.`
    case 'accepted':
      if (d === null) return 'every requirement is verified.'
      // Final wave M8: with autoMerge on, a dirty or switched checkout is all the merge waits for.
      // The person has to act, but by cleaning the checkout, never by merging by hand.
      if (options.waitsForCleanCheckout === true) {
        return (
          `every requirement is verified, and it waits for a clean checkout of ${d.baseBranch}: the project checkout has uncommitted changes ` +
          `or is not on ${d.baseBranch}. Once it is clean and on ${d.baseBranch}, Slave merges it.`
        )
      }
      return `every requirement is verified, and it waits for you: ${handMergeInstruction(d.integrationBranch, d.baseBranch, report.workspaceId, report.goalVersion, d.verifiedCommit)}.`
    case 'needs_human': {
      const reason = d?.needsHumanReason ?? 'the verification loop stopped'
      return `stopped, and needs you: ${reason.length > 700 ? `${reason.slice(0, 700)}…` : reason}`
    }
    case 'abandoned':
      return `abandoned; nothing of it reached ${base}.`
    default:
      return `${report.state.replace('_', ' ')}.`
  }
}

function requirementsLine(report: GoalReport): string {
  if (report.requirements === null) return 'Requirements: not extracted.'
  const all = report.requirements
  const pass = all.filter((item) => item.verdict?.status === 'pass').length
  const failing = all.filter((item) => item.verdict?.status === 'fail').map((item) => item.key)
  const unverifiable = all.filter((item) => item.verdict?.status === 'unverifiable').map((item) => item.key)
  const last = report.rounds.at(-1)
  return (
    `Requirements: ${String(pass)} of ${String(all.length)} pass${last === undefined ? ', none verified yet' : ` (round ${String(last.round)})`}` +
    `${failing.length === 0 ? '' : `; failing: ${failing.join(', ')}`}${unverifiable.length === 0 ? '' : `; could not be checked: ${unverifiable.join(', ')}`}.`
  )
}
