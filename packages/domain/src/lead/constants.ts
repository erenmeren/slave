/**
 * Lead-flow spec (2026-10-04), plan A: the closed lists and bounds of the lead flow. A leaf module
 * (no imports): the event schema reads the lists and must not import anything that imports it.
 */

/** Plan A L1: how a project builds a goal version. */
export const WORKSPACE_FLOWS = ['packages', 'lead'] as const
export type WorkspaceFlow = (typeof WORKSPACE_FLOWS)[number]

/** Spec section 3: the state of a lead-flow goal version (`spec` and `hunting` arrive with plan B). */
export const LEAD_STATES = ['building', 'proving', 'delivered', 'awaiting_decision', 'stopped'] as const
export type LeadState = (typeof LEAD_STATES)[number]

/** Plan A L4: what one turn of the lead's session is for. */
export const LEAD_TURNS = ['build', 'rework', 'wrap_up', 'continue', 'answer', 'base'] as const
export type LeadTurn = (typeof LEAD_TURNS)[number]

/** Spec P7 (plan A L12/L13): why a lead-flow version's loop ended. */
export const STOP_REASONS = [
  'proven',
  'not_all_proven',
  'no_progress',
  'budget_spent',
  'time_spent',
  'nothing_built',
  'lead_failed',
  'proof_unusable',
  'accepted_as_is',
  'left',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

/** What a `workspace.lead_noted` line is about. */
export const LEAD_NOTE_KINDS = [
  'turn',
  'decisions_read',
  'decisions_missing',
  'report_missing',
  'ask_refused',
  'disputed',
  'unverifiable',
  'limit_wait',
  'wrap_up',
  'lead_ended',
  'base_taken',
  'roster_dropped',
  'branch_rewritten',
] as const
export type LeadNoteKind = (typeof LEAD_NOTE_KINDS)[number]

/** Bounds `workspace.lead_noted.detail`. */
export const LEAD_NOTE_DETAIL_MAX_CHARS = 500
/** Bounds `LeadProgress.nextTurn.note`: what a queued turn is told (a verifier's evidence, a reason). */
export const LEAD_TURN_NOTE_MAX_CHARS = 20_000

/** Plan A L2: `WorkPackage.templateId` of a lead's package -- no catalogue persona stands behind it. */
export const LEAD_TEMPLATE_ID = 'lead'
/** Plan A L2: the team the three system seats sit in, and the seats' `Slave.role` titles. */
export const LEAD_TEAM_NAME = 'Lead flow'
export const LEAD_SEAT_ROLES = { lead: 'Lead', verifier: 'Verifier', confirmer: 'Confirmer' } as const
/** Spec B4: one fifth of the goal's budget is kept for proof. */
export const PROOF_RESERVE_RATIO = 0.2
/** Spec B4: at this part of its share the lead is told to wrap up. */
export const LEAD_WRAP_UP_RATIO = 0.8
/** A leg smaller than this is not worth a spawn: the share counts as spent. */
export const LEAD_MIN_LEG_USD = 0.05

/** Spec B5 (plan A L8): a lead turn whose stream said nothing for this long is restarted. */
export const LEAD_STALL_MS = 30 * 60_000
/** Plan A L10: how often a lead's question is answered "decide yourself" per goal version. */
export const LEAD_ASK_REPLIES_MAX = 2
/** Plan A L15: how often the base branch is taken into a version before a person merges by hand. */
export const LEAD_BASE_MERGES_MAX = 3

/** Spec S3 / plan A L16: the roster's size and the bounds of its session definitions. */
export const LEAD_ROSTER_MAX = 15
export const LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS = 6000
export const LEAD_ROSTER_JSON_MAX_BYTES = 100_000

/** Spec B9 (plan A L18): where the lead records its decisions, and how much of it is read. */
export const LEAD_DECISIONS_FILE = 'docs/DECISIONS.md'
export const LEAD_DECISIONS_FILE_MAX_BYTES = 200_000

/** Plan A L7: the goal's time limit, in milliseconds: ten minutes to a day, whole minutes. */
export const LEAD_TIME_LIMIT_BOUNDS_MS = { min: 10 * 60_000, max: 24 * 60 * 60_000 } as const

/** Plan A L12: the smoke check's place in a failing set -- it is not a requirement key. */
export const SMOKE_FAILING_KEY = 'SMOKE'

/** Plan A L13: the only situations the Supervisor raises in a lead-flow workspace. Spelled as
 *  strings so this module stays a leaf; `SITUATION_KINDS` holds both. */
export const LEAD_SITUATION_KINDS: readonly string[] = ['goal_needs_human', 'workspace_halted']

/** Plan A L16: the tool names that start a subordinate session -- the current one and the older. */
export const SUBORDINATE_TOOLS: readonly string[] = ['Agent', 'Task']
