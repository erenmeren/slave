import { VERIFICATION_REASON_MAX_CHARS } from '../conduct/constants.js'
import { trimEvidence, trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import type { StopReason } from './constants.js'

const WHY: Readonly<Record<StopReason, string>> = {
  proven: 'everything is proven',
  not_all_proven: 'nothing is left to send back to the lead, and not every requirement is proven',
  no_progress: 'two rounds in a row failed the same items',
  budget_spent: 'the budget is spent',
  time_spent: 'the time limit is reached',
  nothing_built: 'nothing was built: the lead committed nothing',
  lead_failed: 'the lead could not finish a turn',
  proof_unusable: 'the verification could not be run',
  accepted_as_is: 'a person accepted it as it is',
  left: 'a person left it',
}

/**
 * Lead-flow spec D2 in its smallest form (plan A L13): the text of the one card -- why the loop
 * stopped, what is unproven, and what Approve and Reject do. It is stored on
 * `GoalDelivery.needsHumanReason` and written into `workspace.goal_needs_human`, so it fits their
 * bound; the closing sentence is kept whatever is cut. `detail` is run output or a failure reason:
 * another party's text.
 */
export function renderLeadStop(input: {
  readonly version: number
  readonly reason: StopReason
  readonly failing: readonly string[]
  readonly disputed: readonly string[]
  readonly unverifiable: readonly string[]
  readonly detail: string | null
}): string {
  const list = (label: string, keys: readonly string[]): readonly string[] => (keys.length === 0 ? [] : [`${label}: ${keys.join(', ')}`])
  const unproven = [...list('failing', input.failing), ...list('disputed (the two verifiers disagreed)', input.disputed), ...list('could not be verified', input.unverifiable)]
  const detail = input.detail === null || input.detail.trim() === '' ? '' : ` (${trimEvidence(sanitisePersonText(input.detail.trim()), 600)})`
  return trimToFit(
    [
      `it stopped because ${WHY[input.reason]}${detail}.`,
      unproven.length === 0 ? 'No verification verdict stands for this version, so nothing is proven.' : `What is unproven -- ${unproven.join('; ')}.`,
      'Approve accepts the version as it is and merges it. Reject leaves it: the work branch stays and the next goal version may start.',
    ].join(' '),
    VERIFICATION_REASON_MAX_CHARS,
  )
}
