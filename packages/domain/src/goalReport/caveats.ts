import { TERMINAL } from '../task/state.js'
import { GOAL_REPORT_FILES_MAX, GOAL_REPORT_TRAIL_MAX } from './constants.js'
import { evidenceCut, shortCommit } from './escape.js'
import type { GoalReport, GoalReportState } from './types.js'

/** How a person says each state. One wording for the page, the export and the chat note. */
export const GOAL_REPORT_STATE_LABEL: Readonly<Record<GoalReportState, string>> = {
  not_conducted: 'not conducted yet',
  conducted_without_delivery: 'conducted without an integration branch',
  integrating: 'being built',
  verifying: 'being verified',
  accepted: 'verified, waiting to be merged',
  merged: 'merged',
  needs_human: 'needs you',
  abandoned: 'abandoned',
}

const keysOf = (items: readonly { readonly key: string }[]): string => items.map((item) => item.key).join(', ')
const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`

/** A package's task is done moving (plan R6: shares `TERMINAL`, the domain's one terminal-status
 *  set, rather than a second copy of `['done', 'failed', 'cancelled']`). `pkg.taskStatus` is a
 *  plain `string | null` here (the report's own shape, D1), so the check widens `TERMINAL` rather
 *  than narrowing the status to `TaskStatus`. */
const isFinishedTaskStatus = (status: string): boolean => (TERMINAL as readonly string[]).includes(status)

/**
 * What this report cannot vouch for (plan D8), in the order a reader should see it. The page and
 * the export print the same list. Everything here is a fact about the report's own data. Nothing
 * is looked up.
 */
export function reportCaveats(report: GoalReport): readonly string[] {
  const out: string[] = []
  const delivery = report.delivery
  const base = delivery?.baseBranch ?? report.baseBranch
  const requirements = report.requirements ?? []
  if (report.requirements === null) {
    out.push('The requirements of this goal version have not been extracted yet, so nothing can be checked against them.')
  }
  if (report.state === 'not_conducted') out.push('This goal version has not been conducted yet: it has no packages and no verification.')
  if (report.state === 'conducted_without_delivery') {
    out.push(
      `This version was conducted before Slave built goal versions on an integration branch; its packages merged straight into ${base}, ` +
        'and no integration, verification or merge of the version is recorded.',
    )
  }
  if (report.decision?.fallback === true) {
    out.push("The conductor's answers were unusable, so this version was delivered as one package by default.")
  }
  const last = report.rounds.at(-1)
  if (delivery !== null && last === undefined && report.state !== 'abandoned') {
    // Final wave M3: a version already past verification did not "not run yet" -- it was accepted
    // without a round on record (a row accepted before verification existed).
    out.push(
      report.state === 'merged' || report.state === 'accepted'
        ? 'This version was accepted without a recorded verification round: no requirement is verified.'
        : 'No verification round has run yet: no requirement is verified.',
    )
  }
  const moving = report.packages.filter((pkg) => pkg.taskStatus !== null && !isFinishedTaskStatus(pkg.taskStatus))
  if (last !== undefined && (report.state === 'integrating' || report.state === 'verifying') && moving.length > 0) {
    const which = moving.length === 1 ? `package ${keysOf(moving)} is` : `packages ${keysOf(moving)} are`
    out.push(`The verdicts below are from round ${String(last.round)}; ${which} being worked on again since, so they may change.`)
  }
  const unverifiable = requirements.filter((item) => item.verdict?.status === 'unverifiable')
  if (unverifiable.length > 0) {
    out.push(`The verifier could not check ${keysOf(unverifiable)}; the version cannot be accepted until ${unverifiable.length === 1 ? 'it is' : 'they are'}.`)
  }
  const trimmed = requirements.filter(
    (item) => item.verdict !== null && [item.verdict.check, item.verdict.output, item.verdict.reason].some((text) => evidenceCut(text) > 0),
  )
  if (trimmed.length > 0) {
    out.push(`The evidence for ${keysOf(trimmed)} was trimmed to fit; the verifier's full output stays in its run's scratch directory.`)
  }
  const merge = delivery?.merge ?? null
  if (merge !== null && merge.by === 'human' && merge.commit !== delivery?.verifiedCommit) {
    out.push(
      delivery?.verifiedCommit == null
        ? `A person merged this version into ${merge.into} by hand (commit ${shortCommit(merge.commit)}), and no verified commit is recorded for it.`
        : // Final wave M2: the commits differ, and that is all the records say -- not why they differ.
          `A person merged this version into ${merge.into} by hand: commit ${shortCommit(merge.commit)} is not the verified commit ` +
            `${shortCommit(delivery.verifiedCommit)}; the tree that landed was not itself verified.`,
    )
  }
  if (report.state === 'abandoned') out.push(`This goal version was abandoned; nothing of it reached ${base}.`)
  const { runsUnmeasured, runsLive } = report.spend
  if (runsUnmeasured > 0) {
    out.push(`${count(runsUnmeasured, 'run', 'runs')} did not report ${runsUnmeasured === 1 ? 'its' : 'their'} cost; ${runsUnmeasured === 1 ? 'it is' : 'they are'} not in the version's spend.`)
  }
  if (runsLive > 0) {
    out.push(`${count(runsLive, 'run is', 'runs are')} still going; ${runsLive === 1 ? 'its' : 'their'} cost is not known yet.`)
  }
  const unrecorded = report.packages.filter((pkg) => pkg.integrated && pkg.mergedFiles === null)
  if (unrecorded.length > 0) {
    // Final wave I1/M4: a base-branch merge (a version with no delivery) records no list at all;
    // an integration merge records none when it predates Plan 5 or git's listing failed.
    out.push(
      delivery === null
        ? `The files ${keysOf(unrecorded)} merged into ${base} were not recorded (Slave records them only for a merge into an integration branch); the worker's own list is shown.`
        : `The files ${keysOf(unrecorded)} merged were not recorded (merged before Slave recorded them, or git could not list them); the worker's own list is shown.`,
    )
  }
  const cut = report.packages.filter((pkg) => pkg.mergedFilesTruncated)
  if (cut.length > 0) out.push(`The file lists of ${keysOf(cut)} are cut at ${String(GOAL_REPORT_FILES_MAX)} files per merge.`)
  if (report.trailOmitted > 0) {
    out.push(`The decision trail shows the newest ${String(GOAL_REPORT_TRAIL_MAX)} entries; ${count(report.trailOmitted, 'older entry is', 'older entries are')} left out.`)
  }
  return out
}
