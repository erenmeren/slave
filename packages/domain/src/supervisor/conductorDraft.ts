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

/**
 * Plan B D6: what a decision row keeps about a conductor answer, beside the ordinary draft --
 * everything a person approving it needs, and what carrying it out applies (D7).
 */
export interface ConductorDraft {
  readonly basis: ConductorBasis
  /** The basis items that did not check out; empty when the basis verified. */
  readonly unverified: readonly string[]
  readonly changes: ConductorChange
  readonly newDecision: SharedDecision | null
  readonly handOff: HandOffItem | null
}

export const conductorDraftSchema: z.ZodType<ConductorDraft, z.ZodTypeDef, unknown> = z.object({
  basis: conductorBasisSchema,
  unverified: z.array(z.string()),
  changes: z.enum(CONDUCTOR_CHANGES),
  newDecision: sharedDecisionSchema.nullable(),
  handOff: handOffItemSchema.nullable(),
})
