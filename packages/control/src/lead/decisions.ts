import { prisma } from '@slave-of-ai/db/client'
import { decisionTitleKey } from '@slave-of-ai/domain'
import { GoalDecisionRefused, storedDecisionTitle, writeGoalDecisionIn } from '../conductorAnswer.js'

/**
 * Lead-flow spec B9 (plan A L18): the lead's decisions as decision records with the source `lead`,
 * through the one writer every shared decision goes through -- sanitised, bounded, a title the
 * version already has left alone (the file is read again after every turn), nothing past the
 * version's cap. Each decision is its own transaction: one that is refused costs the others nothing.
 *
 * Task 7 review: the writer checks the cap before the title, so a title the version already has is
 * told apart here first, by the writer's own key ({@link storedDecisionTitle}): it is `known` and
 * the writer is not called. `refused` counts only NEW titles (each once) that the cap kept out --
 * a file re-read at the cap whose every title is recorded refuses nothing.
 */
export async function recordLeadDecisions(
  workspaceId: string,
  goalVersion: number,
  decisions: readonly { readonly title: string; readonly decision: string }[],
): Promise<{ readonly written: number; readonly known: number; readonly refused: number }> {
  const recorded = new Set((await prisma.goalDecision.findMany({ where: { workspaceId, goalVersion }, select: { titleKey: true } })).map((row) => row.titleKey))
  const refusedKeys = new Set<string>()
  let written = 0
  let known = 0
  let atCap = false
  for (const one of decisions) {
    const key = decisionTitleKey(storedDecisionTitle(one.title))
    if (recorded.has(key)) {
      known += 1
      continue
    }
    if (atCap) {
      // An empty title is refused for being empty, not by the cap.
      if (key !== '') refusedKeys.add(key)
      continue
    }
    try {
      await prisma.$transaction((tx) => writeGoalDecisionIn(tx, { workspaceId, goalVersion, title: one.title, decision: one.decision, source: 'lead', questionId: null, decisionId: null }))
      written += 1
      recorded.add(key)
    } catch (error) {
      if (!(error instanceof GoalDecisionRefused)) throw error
      if (error.why === 'at_cap') {
        atCap = true
        refusedKeys.add(key)
      } else if (error.why === 'title_taken') {
        // Written by another writer since the titles were read.
        known += 1
        recorded.add(key)
      }
    }
  }
  return { written, known, refused: refusedKeys.size }
}
