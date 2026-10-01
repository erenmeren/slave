import { prisma } from '@slave-of-ai/db/client'
import { GOAL_DECISIONS_MAX, decisionTitleKey, sanitisePersonText, storableText, type ConductorDraft } from '@slave-of-ai/domain'
import { routeAnswerHandOff } from './handOffs.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'

/** What became of a conductor answer's new decision, for the log and the tests. */
export type ConductorDecisionOutcome = 'none' | 'recorded' | 'title_taken' | 'at_cap' | 'no_version'

/** What became of a conductor answer's hand-off. */
export type ConductorHandOffOutcome = 'none' | 'routed' | 'no_asker' | 'no_version'

export interface ConductorOutcome {
  readonly decision: ConductorDecisionOutcome
  readonly handOff: ConductorHandOffOutcome
}

/** Refused inside the decision's transaction (constraint: a refusal there must throw to roll back). */
class DecisionsAtCap extends Error {}

/**
 * Supervisor-as-conductor plan B D7: what a conductor answer does beyond its text, once the answer
 * was sent. Its `newDecision` joins the version's shared decisions (a title the version already has
 * is left alone: an answer extends the decisions, never rewrites one). Its `handOff` is routed by
 * Plan A's rule, from the asking run ({@link routeAnswerHandOff}). Called with no lock held --
 * `routeHandOffs` takes the delivery lock, which is not re-entrant.
 *
 * The two halves are independent: a decision that could not be written does not keep the hand-off
 * from being routed, and either failure is thrown after both were tried. A hand-off whose routing
 * threw is routed again by the goal pass (`routeStoredHandOffs`, F4).
 */
export async function applyConductorOutcome(input: {
  readonly workspaceId: string
  readonly decisionId: string
  readonly messageId: string
  readonly conductor: ConductorDraft
}): Promise<ConductorOutcome> {
  const question = await prisma.slaveMessage.findUnique({
    where: { id: input.messageId },
    select: { id: true, senderRunId: true, task: { select: { goalVersion: true, workPackage: { select: { key: true, goalVersion: true } } } } },
  })
  const goalVersion = question?.task?.workPackage?.goalVersion ?? question?.task?.goalVersion ?? null
  const { newDecision, handOff } = input.conductor
  if (question === null || goalVersion === null) {
    if (newDecision !== null || handOff !== null) {
      console.warn(`[conductor-answer] decision ${input.decisionId}: the question belongs to no goal version; its decision and hand-off were not recorded`)
    }
    return { decision: newDecision === null ? 'none' : 'no_version', handOff: handOff === null ? 'none' : 'no_version' }
  }

  const failures: unknown[] = []
  let decision: ConductorDecisionOutcome = 'none'
  if (newDecision !== null) {
    try {
      decision = await recordAnswerDecision({ workspaceId: input.workspaceId, goalVersion, questionId: question.id, decisionId: input.decisionId, ...newDecision })
    } catch (error) {
      failures.push(error)
    }
  }

  let routed: ConductorHandOffOutcome = 'none'
  if (handOff !== null) {
    if (question.senderRunId === null) {
      // A question no run asked has no asker to route from (and no worker who could have asked it).
      console.warn(`[conductor-answer] decision ${input.decisionId}: the question has no asking run; its hand-off was not routed`)
      routed = 'no_asker'
    } else {
      try {
        await routeAnswerHandOff({
          workspaceId: input.workspaceId,
          goalVersion,
          decisionId: input.decisionId,
          fromRunId: question.senderRunId,
          askerPackageKey: question.task?.workPackage?.key ?? null,
          handOff,
        })
        routed = 'routed'
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length > 0) throw failures[0]
  return { decision, handOff: routed }
}

/**
 * Spec C3: a conductor answer's new shared decision, written once. The text is the model's, made
 * storable and defused (F8: it reaches every package's prompt), and the key is read from the cleaned
 * title. Controller ruling F13: the version's cap is re-counted under a per-version advisory lock in
 * the same transaction as the insert -- the judging counted it too, but two answers of one batch can
 * both pass that count. A title the version already has (the unique key) is left alone and said: the
 * answer is out, and an answer never rewrites a decision.
 */
async function recordAnswerDecision(input: {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly questionId: string
  readonly decisionId: string
  readonly title: string
  readonly decision: string
}): Promise<ConductorDecisionOutcome> {
  const { workspaceId, goalVersion } = input
  const title = sanitisePersonText(storableText(input.title)).trim()
  const text = sanitisePersonText(storableText(input.decision)).trim()
  if (title === '' || text === '') return 'none'
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`slaveofai:goal-decisions:${workspaceId}:v${String(goalVersion)}`}))`
      if ((await tx.goalDecision.count({ where: { workspaceId, goalVersion } })) >= GOAL_DECISIONS_MAX) throw new DecisionsAtCap()
      await tx.goalDecision.create({
        data: {
          workspaceId,
          goalVersion,
          title,
          titleKey: decisionTitleKey(title),
          decision: text,
          source: 'conductor_answer',
          questionId: input.questionId,
          decisionId: input.decisionId,
        },
      })
    })
    return 'recorded'
  } catch (error) {
    if (error instanceof DecisionsAtCap) {
      console.warn(`[conductor-answer] decision ${input.decisionId}: goal v${String(goalVersion)} already has ${String(GOAL_DECISIONS_MAX)} shared decisions; "${title}" was not added`)
      return 'at_cap'
    }
    if (isUniqueConstraintViolation(error)) {
      console.warn(`[conductor-answer] decision ${input.decisionId}: goal v${String(goalVersion)} already has a shared decision titled "${title}"; it was left as it is`)
      return 'title_taken'
    }
    throw error
  }
}
