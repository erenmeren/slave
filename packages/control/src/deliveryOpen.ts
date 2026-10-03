import type { Prisma } from '@slave-of-ai/db/client'

/**
 * The goal versions the goal pass still moves on (`apps/orchestrator/src/goal.ts`): integrating,
 * verifying, or accepted and neither merged nor refused by git. Not the rule for whether a hand-off
 * reaches a run -- an accepted version expires every item routed into it, and only an integrating
 * one delivers: that is `handOffRoute` (domain), which a late answer's card reads its fate from
 * (final wave round 2). A module of its own: `goalDelivery.ts` imports the Supervisor, which
 * imports `questions.ts`.
 */
export const ROUTED_DELIVERY_WHERE: Prisma.GoalDeliveryWhereInput = {
  OR: [{ status: 'integrating' }, { status: 'verifying' }, { status: 'accepted', mergedAt: null, mergeError: null }],
}
