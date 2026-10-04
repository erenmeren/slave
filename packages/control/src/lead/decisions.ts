import { prisma } from '@slave-of-ai/db/client'
import { GoalDecisionRefused, writeGoalDecisionIn } from '../conductorAnswer.js'

/**
 * Lead-flow spec B9 (plan A L18): the lead's decisions as decision records with the source `lead`,
 * through the one writer every shared decision goes through -- sanitised, bounded, a title the
 * version already has left alone (the file is read again after every turn), nothing past the
 * version's cap. Each decision is its own transaction: one that is refused costs the others nothing.
 */
export async function recordLeadDecisions(
  workspaceId: string,
  goalVersion: number,
  decisions: readonly { readonly title: string; readonly decision: string }[],
): Promise<{ readonly written: number; readonly known: number; readonly refused: number }> {
  let written = 0
  let known = 0
  let refused = 0
  for (const [index, one] of decisions.entries()) {
    try {
      await prisma.$transaction((tx) => writeGoalDecisionIn(tx, { workspaceId, goalVersion, title: one.title, decision: one.decision, source: 'lead', questionId: null, decisionId: null }))
      written += 1
    } catch (error) {
      if (!(error instanceof GoalDecisionRefused)) throw error
      if (error.why === 'at_cap') {
        refused = decisions.length - index
        break
      }
      if (error.why === 'title_taken') known += 1
    }
  }
  return { written, known, refused }
}
