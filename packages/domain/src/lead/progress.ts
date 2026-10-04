import { z } from 'zod'
import { LEAD_TURNS, LEAD_TURN_NOTE_MAX_CHARS, STOP_REASONS, type LeadTurn, type StopReason } from './constants.js'

/**
 * Lead-flow plan A L11: what a lead-flow version carries between turns and proof rounds, stored on
 * `GoalDelivery.leadProgress` and moved only under the delivery's lock.
 */
export interface LeadProgress {
  /** What the lead's next turn is for and what it is told; null when nothing is queued. */
  readonly nextTurn: { readonly kind: LeadTurn; readonly note: string } | null
  /** Why the lead gets no further turn (its budget share or the time is spent); null while it may work. */
  readonly leadEnded: StopReason | null
  /** The requirement keys the next proof round checks; empty is the whole set (spec P5). */
  readonly recheckKeys: readonly string[]
  /** Failures of `runId` awaiting the confirmer (spec P3), and whether that round was full. */
  readonly confirm: { readonly runId: string; readonly keys: readonly string[]; readonly scope: 'full' | 'partial' } | null
  /** The last confirmed failing set, for "two rounds in a row" (spec P7). */
  readonly failing: readonly string[]
  /** Keys the two verifiers disagreed on (spec P3): never reworked, named in the report. */
  readonly disputed: readonly string[]
  /** Keys the latest round could not verify (spec P4): never a stop on their own. */
  readonly unverifiable: readonly string[]
  /** The wrap-up turn was dispatched (spec B4). */
  readonly wrapUpSent: boolean
  /** How often a lead's question was answered "decide yourself" (plan A L10). */
  readonly askReplies: number
  /** How often the base branch was taken in (plan A L15). */
  readonly baseMerges: number
}

export const INITIAL_LEAD_PROGRESS: LeadProgress = {
  nextTurn: null,
  leadEnded: null,
  recheckKeys: [],
  confirm: null,
  failing: [],
  disputed: [],
  unverifiable: [],
  wrapUpSent: false,
  askReplies: 0,
  baseMerges: 0,
}

const keyList = z.array(z.string().min(1).max(20)).max(400)

/** READ-tolerant: every field defaults, so a row written before a field existed still parses. */
export const leadProgressSchema = z.object({
  nextTurn: z.object({ kind: z.enum(LEAD_TURNS), note: z.string().max(LEAD_TURN_NOTE_MAX_CHARS) }).nullable().default(null),
  leadEnded: z.enum(STOP_REASONS).nullable().default(null),
  recheckKeys: keyList.default([]),
  confirm: z.object({ runId: z.string().min(1), keys: keyList, scope: z.enum(['full', 'partial']) }).nullable().default(null),
  failing: keyList.default([]),
  disputed: keyList.default([]),
  unverifiable: keyList.default([]),
  wrapUpSent: z.boolean().default(false),
  askReplies: z.number().int().nonnegative().default(0),
  baseMerges: z.number().int().nonnegative().default(0),
})

/** The stored progress, or the initial one for a null column or a value that does not parse. */
export function readLeadProgress(value: unknown): LeadProgress {
  const parsed = leadProgressSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : INITIAL_LEAD_PROGRESS
}
