import type { LeadNoteKind, LeadState, StopReason, WorkspaceFlow } from './constants.js'
import type { UserTaskState } from '../status/user.js'

/**
 * Lead UX design (2026-10-05) section 5: the state of a whole project in one word, as every screen
 * shows it. Derived from the project's own row and its newest build, never stored: the lead flow's
 * state word (`GoalDelivery.leadState`) is what it reads, and a person's stop or a halt is laid
 * over it because nothing runs while either holds.
 */
export const PROJECT_PHASES = [
  'empty',
  'starting',
  'building',
  'checking',
  'needs_decision',
  'ready_to_merge',
  'delivered',
  'closed',
  'paused',
  'failed',
  'older',
] as const
export type ProjectPhase = (typeof PROJECT_PHASES)[number]

/** What {@link projectPhaseOf} reads. */
export interface ProjectPhaseFacts {
  readonly flow: WorkspaceFlow
  /** `Workspace.haltedReason`. */
  readonly haltedReason: string | null
  /** `Workspace.goalVersion`: 0 is "nothing was ever asked for". */
  readonly goalVersion: number
  /** The newest build that has a delivery row, or null. */
  readonly delivery: {
    readonly goalVersion: number
    readonly leadState: LeadState | null
    readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  } | null
}

/**
 * `emergencyStop` writes `emergency stop by <who>`: a person's own stop reads Paused, and any other
 * halt (a gate failure, the breaker, a missing verify command) is Slave stopping the project.
 */
export function isPersonStop(haltedReason: string): boolean {
  return haltedReason.startsWith('emergency stop')
}

/** Section 5 of the design, as a function. */
export function projectPhaseOf(facts: ProjectPhaseFacts): ProjectPhase {
  if (facts.flow === 'packages') return 'older'
  if (facts.haltedReason !== null) return isPersonStop(facts.haltedReason) ? 'paused' : 'failed'
  if (facts.goalVersion === 0) return 'empty'
  const delivery = facts.delivery
  // A build asked for whose delivery is not written yet: its requirements are being read.
  if (delivery === null || delivery.goalVersion < facts.goalVersion || delivery.leadState === null) return 'starting'
  switch (delivery.leadState) {
    case 'building':
      return 'building'
    case 'proving':
      return 'checking'
    case 'delivered':
      return 'delivered'
    case 'stopped':
      return 'closed'
    case 'awaiting_decision':
      // An accepted build waits only for a merge: a person's hand, or automatic merge turned on.
      return delivery.status === 'accepted' ? 'ready_to_merge' : 'needs_decision'
  }
}

/** The phases a person must act on: the sidebar's amber marker, Home's "Waiting for you". */
export function phaseNeedsPerson(phase: ProjectPhase): boolean {
  return phase === 'needs_decision' || phase === 'ready_to_merge'
}

/** The phases in which something runs: the Project screen re-reads every 3 seconds, Stop is offered. */
export function phaseIsActive(phase: ProjectPhase): boolean {
  return phase === 'starting' || phase === 'building' || phase === 'checking'
}

/** The badge of each phase (design section 5). A total `Record`: a twelfth phase fails the build. */
export const PROJECT_PHASE_LABEL: Readonly<Record<ProjectPhase, string>> = {
  empty: 'Not started',
  starting: 'Getting ready',
  building: 'Building',
  checking: 'Checking',
  needs_decision: 'Needs your decision',
  ready_to_merge: 'Ready to merge',
  delivered: 'Delivered',
  closed: 'Left unmerged',
  paused: 'Paused',
  failed: 'Stopped by a problem',
  older: 'Older project',
}

/** The sentence under a project's name (design section 5). */
export function projectPhaseSentence(phase: ProjectPhase, context: { readonly baseBranch: string; readonly haltedReason: string | null }): string {
  switch (phase) {
    case 'empty':
      return 'Nothing has been asked for yet. Describe what you want built below.'
    case 'starting':
      return 'Slave is reading your request and setting up a branch. This takes a minute.'
    case 'building':
      return "The lead is building what you asked for. You don't need to do anything."
    case 'checking':
      return 'An independent checker is starting the product and trying every requirement.'
    case 'needs_decision':
      return 'The build stopped before everything was proven. Choose what happens next.'
    case 'ready_to_merge':
      return 'Everything that could be checked was checked. Merge it yourself, or let Slave merge it.'
    case 'delivered':
      return `Merged into ${context.baseBranch}. The proof is below.`
    case 'closed':
      return 'You left this build. Its branch is kept; nothing was merged.'
    case 'paused':
      return 'You stopped this project. Nothing runs until you press Continue.'
    case 'failed':
      return `Slave stopped this project: ${context.haltedReason ?? 'no reason was recorded'}. Fix it, then press Continue.`
    case 'older':
      return 'This project uses the older way of building. You can read it here; it cannot be driven from this screen.'
  }
}

/** Why a build stopped, in a person's words (design section 5). */
export const STOP_REASON_WORDS: Readonly<Record<StopReason, string>> = {
  proven: 'Everything was checked on the running product and works.',
  not_all_proven: 'Some requirements could not be confirmed.',
  no_progress: 'The same problems came back two checks in a row.',
  budget_spent: 'The budget ran out.',
  time_spent: 'The time limit ran out.',
  nothing_built: 'The lead finished without building anything.',
  lead_failed: 'The lead kept failing and was stopped.',
  proof_unusable: 'The checks themselves kept failing, so nothing could be proven.',
  accepted_as_is: 'You accepted it as it was.',
  left: 'You left it unmerged.',
}

/** One requirement's result, as the Proof table shows it. `disputed` and `unchecked` are not verdicts
 *  a checker writes: the first is the two checkers disagreeing, the second is no check yet. */
export const REQUIREMENT_RESULTS = ['pass', 'fail', 'unverifiable', 'disputed', 'unchecked'] as const
export type RequirementResult = (typeof REQUIREMENT_RESULTS)[number]

export const REQUIREMENT_RESULT_LABEL: Readonly<Record<RequirementResult, string>> = {
  pass: 'Works',
  fail: "Doesn't work",
  unverifiable: "Couldn't check",
  disputed: 'Checkers disagree',
  unchecked: 'Not checked yet',
}

/**
 * The Proof table's word for one requirement: a key the two checkers disagreed on reads
 * `disputed` whatever the newest verdict says, because that disagreement is what the lead flow
 * acted on (spec P3); otherwise the newest verdict, or `unchecked`.
 */
export function requirementResultOf(key: string, verdict: 'pass' | 'fail' | 'unverifiable' | null, disputed: readonly string[]): RequirementResult {
  if (disputed.includes(key)) return 'disputed'
  return verdict ?? 'unchecked'
}

/** What a `workspace.lead_noted` line says, in a person's words, for the Notes list. */
export const LEAD_NOTE_WORDS: Readonly<Record<LeadNoteKind, string>> = {
  turn: 'The lead started a new turn',
  decisions_read: "The lead's decisions were recorded",
  decisions_missing: 'The lead left no record of its decisions',
  report_missing: 'The lead left no closing report',
  ask_refused: 'The lead asked a question and was told to decide itself',
  denied: 'Some of the lead\'s actions were refused, and it was told to work another way',
  disputed: 'The two checkers disagreed',
  unverifiable: 'Some requirements could not be checked',
  limit_wait: "Waited for the provider's usage limit to reset",
  wrap_up: 'Told the lead to wrap up',
  lead_ended: 'The lead was stopped',
  base_taken: 'The latest base branch was merged into the work',
  roster_dropped: 'Some helpers did not fit and were left out',
  branch_rewritten: 'The lead rewrote its branch',
}

/**
 * Lead UX design section 8: a task of an older (packages-flow) project, in a person's words. The
 * domain's `USER_TASK_LABEL` is the old board's upper-case chip; this is the sentence-case word the
 * read-only task list shows.
 */
export const OLDER_TASK_WORDS: Readonly<Record<UserTaskState, string>> = {
  queued: 'Waiting to start',
  working: 'Being worked on',
  verifying: 'Being checked',
  review: 'Being reviewed',
  merging: 'Being merged',
  waiting: 'Waiting for an answer',
  blocked: 'Blocked',
  done: 'Done',
  integrated: 'Done and merged',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
