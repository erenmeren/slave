import type { Prisma } from '@slave-of-ai/db/client'

/**
 * The goal versions the goal pass still moves on (`apps/orchestrator/src/goal.ts`): integrating,
 * verifying, or accepted and neither merged nor refused by git. Only these route a hand-off --
 * `routeLateAnswers` runs inside that pass -- so a late answer to a package of any other version
 * (merged, abandoned, needs_human) reaches nobody (final wave, finding 6). One definition, so the
 * pass and the card's "goes to the package as a hand-off" cannot disagree. A module of its own:
 * `goalDelivery.ts` imports the Supervisor, which imports `questions.ts`.
 */
export const ROUTED_DELIVERY_WHERE: Prisma.GoalDeliveryWhereInput = {
  OR: [{ status: 'integrating' }, { status: 'verifying' }, { status: 'accepted', mergedAt: null, mergeError: null }],
}
