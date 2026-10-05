import type { LeadState } from './constants.js'

/** What {@link leadStateOf} reads off a goal delivery and its workspace. */
export interface LeadStateFacts {
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  readonly merged: boolean
  /** The lead's task is `done` and on the work branch. */
  readonly integrated: boolean
  readonly autoMerge: boolean
  readonly mergeFailed: boolean
}

/**
 * Lead-flow spec section 3 (plan A L14): a version's state in one word. An accepted version that
 * will be merged on the next pass still reads `proving`; one a person must merge by hand reads
 * `awaiting_decision`, as does every stop.
 */
export function leadStateOf(facts: LeadStateFacts): LeadState {
  if (facts.status === 'abandoned') return 'stopped'
  if (facts.merged) return 'delivered'
  if (facts.status === 'needs_human') return 'awaiting_decision'
  if (facts.status === 'accepted') return facts.autoMerge && !facts.mergeFailed ? 'proving' : 'awaiting_decision'
  if (facts.status === 'verifying') return 'proving'
  return facts.integrated ? 'proving' : 'building'
}
