import { err, ok, type Result } from '@slave-of-ai/domain'
import { confirmGoalMerge, retryGoal } from '../goalDelivery.js'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import { resolveSettledDecisions } from '../supervisor.js'
import { acceptLeadGoalAsIs, leaveLeadGoal } from './card.js'

/** Lead UX design section 7: the four answers the Project screen's decision card offers. */
export const BUILD_DECISIONS = ['accept', 'leave', 'retry', 'merged'] as const
export type BuildDecision = (typeof BUILD_DECISIONS)[number]

/**
 * Lead UX design section 7: a person answers a build from the Project screen's decision card.
 *
 * - `accept` -- Accept as it is: {@link acceptLeadGoalAsIs}, then the build's open
 *   `goal_needs_human` card is closed, as an approval on that card would have closed it. The goal
 *   pass merges it, or waits for the hand merge.
 * - `leave` -- Leave it unmerged: {@link leaveLeadGoal} (its `abandonGoal` closes the card).
 * - `retry` -- Check again: `retryGoal`, the CLI's `retry-goal` (it closes the card).
 * - `merged` -- I merged it: `confirmGoalMerge`, checked against git (it closes the card).
 *
 * The two lead verbs answer `none` for a build that is not a stopped lead build; that is refused
 * here as `build_not_waiting`, so a button pressed on a stale screen says the build moved on
 * instead of claiming it did something.
 */
export async function decideBuild(
  workspaceId: string,
  goalVersion: number,
  decision: BuildDecision,
  principal?: Principal,
): Promise<Result<{ readonly decision: BuildDecision }, ControlRefusal>> {
  switch (decision) {
    case 'accept': {
      const accepted = await acceptLeadGoalAsIs(workspaceId, goalVersion, principal)
      if (!accepted.ok) return accepted
      if (accepted.value === 'none') return err({ kind: 'build_not_waiting', goalVersion })
      await resolveSettledDecisions({
        workspaceId,
        situationKind: 'goal_needs_human',
        subjectIdPrefix: `${workspaceId}:v${String(goalVersion)}:`,
        reason: `goal v${String(goalVersion)} was accepted as it is`,
        ...(principal === undefined ? {} : { principal }),
      })
      return ok({ decision })
    }
    case 'leave': {
      const left = await leaveLeadGoal(workspaceId, goalVersion, principal)
      if (!left.ok) return left
      return left.value === 'none' ? err({ kind: 'build_not_waiting', goalVersion }) : ok({ decision })
    }
    case 'retry': {
      const retried = await retryGoal(workspaceId, goalVersion, principal)
      return retried.ok ? ok({ decision }) : retried
    }
    case 'merged': {
      const merged = await confirmGoalMerge(workspaceId, goalVersion, principal)
      return merged.ok ? ok({ decision }) : merged
    }
  }
}
