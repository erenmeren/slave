import { z } from 'zod'
import { handOffItemSchema, type HandOffItem } from '../conduct/handOff.js'
import { sharedDecisionSchema, type SharedDecision } from '../conduct/packages.js'

/** Supervisor-as-conductor spec C4: what following an answer would change. Anything but `none` is a person's (D5). */
export const CONDUCTOR_CHANGES = ['none', 'requirement', 'ownership', 'budget'] as const
export type ConductorChange = (typeof CONDUCTOR_CHANGES)[number]

/** Spec C4: the plan items an answer rests on -- requirement keys, package keys, decision titles. */
export interface ConductorBasis {
  readonly requirements: readonly string[]
  readonly packages: readonly string[]
  readonly decisions: readonly string[]
}

export const conductorBasisSchema = z.object({
  requirements: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  packages: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  decisions: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
})

/** Fix round 1: the bounds of {@link ConductorDraft.unverified} -- a basis has at most 60 items, so its failures fit. */
export const CONDUCTOR_UNVERIFIED_MAX = 60
export const CONDUCTOR_UNVERIFIED_ITEM_MAX_CHARS = 300

/**
 * Plan B D6: what a decision row keeps about a conductor answer, beside the ordinary draft --
 * everything a person approving it needs, and what carrying it out applies (D7).
 */
export interface ConductorDraft {
  readonly basis: ConductorBasis
  /**
   * Why the answer was not checked out: the reply's own notes first (F16, a `newDecision` or
   * `handOff` that did not read, or a question answered more than once), then the basis items that
   * do not exist in the version. Empty when everything verified. At most
   * {@link CONDUCTOR_UNVERIFIED_MAX} items of {@link CONDUCTOR_UNVERIFIED_ITEM_MAX_CHARS} each.
   */
  readonly unverified: readonly string[]
  readonly changes: ConductorChange
  readonly newDecision: SharedDecision | null
  readonly handOff: HandOffItem | null
}

export const conductorDraftSchema: z.ZodType<ConductorDraft, z.ZodTypeDef, unknown> = z.object({
  basis: conductorBasisSchema,
  unverified: z.array(z.string().max(CONDUCTOR_UNVERIFIED_ITEM_MAX_CHARS)).max(CONDUCTOR_UNVERIFIED_MAX),
  changes: z.enum(CONDUCTOR_CHANGES),
  newDecision: sharedDecisionSchema.nullable(),
  handOff: handOffItemSchema.nullable(),
})
