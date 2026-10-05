import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  GOAL_DECISIONS_MAX,
  SHARED_DECISION_TEXT_MAX_CHARS,
  SHARED_DECISION_TITLE_MAX_CHARS,
  decisionTitleKey,
  sanitisePersonText,
  storableText,
  trimToFit,
  type ConductorDraft,
} from '@slave-of-ai/domain'
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

/** Human cards plan B D6: why a shared decision was not written. Thrown, so a caller's transaction
 *  rolls back (constraint: a refusal inside a transaction must throw). */
export class GoalDecisionRefused extends Error {
  constructor(
    readonly why: 'empty' | 'at_cap' | 'title_taken',
    message: string,
  ) {
    super(message)
    this.name = 'GoalDecisionRefused'
  }
}

/** The advisory lock a version's shared decisions are written under. Lock order for a person's card
 *  (plan B D6): this lock, then the Workspace row, then the question row -- the conductor's writer
 *  takes this lock and then, through the insert's foreign key, a share lock on the Workspace row, so
 *  taking it after the Workspace row would deadlock against it. */
export async function lockGoalDecisions(tx: Prisma.TransactionClient, workspaceId: string, goalVersion: number): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`slaveofai:goal-decisions:${workspaceId}:v${String(goalVersion)}`}))`
}

/**
 * A shared decision's title as {@link writeGoalDecisionIn} stores it -- storable, defused, bounded.
 * Its `decisionTitleKey` is the key a version's titles are unique by; exported so a caller that
 * must tell a known title from a new one before writing (`recordLeadDecisions`) computes the same key.
 */
export function storedDecisionTitle(title: string): string {
  return trimToFit(sanitisePersonText(storableText(title)).trim(), SHARED_DECISION_TITLE_MAX_CHARS)
}

/**
 * Spec C3, human cards H2.5 (plan B D6): one shared decision, written inside `tx` under the version's
 * advisory lock ({@link lockGoalDecisions}; re-taken as a no-op by a caller that holds it) -- the cap
 * re-counted, the title's key looked up (not caught as a unique violation, which would poison `tx`).
 * Text made storable and defused: it reaches every package's prompt; bounded again AFTER that
 * (ruling F63: defusing can lengthen it). THROWS {@link GoalDecisionRefused}.
 */
export async function writeGoalDecisionIn(
  tx: Prisma.TransactionClient,
  input: {
    readonly workspaceId: string
    readonly goalVersion: number
    readonly title: string
    readonly decision: string
    readonly source: 'conductor_answer' | 'person' | 'lead'
    readonly questionId: string | null
    readonly decisionId: string | null
  },
): Promise<void> {
  const { workspaceId, goalVersion } = input
  const title = storedDecisionTitle(input.title)
  const text = trimToFit(sanitisePersonText(storableText(input.decision)).trim(), SHARED_DECISION_TEXT_MAX_CHARS)
  if (title === '' || text === '') throw new GoalDecisionRefused('empty', 'a shared decision needs a title and a decision')
  await lockGoalDecisions(tx, workspaceId, goalVersion)
  if ((await tx.goalDecision.count({ where: { workspaceId, goalVersion } })) >= GOAL_DECISIONS_MAX) {
    throw new GoalDecisionRefused('at_cap', `goal v${String(goalVersion)} already has ${String(GOAL_DECISIONS_MAX)} shared decisions`)
  }
  const titleKey = decisionTitleKey(title)
  if ((await tx.goalDecision.findUnique({ where: { workspaceId_goalVersion_titleKey: { workspaceId, goalVersion, titleKey } }, select: { id: true } })) !== null) {
    throw new GoalDecisionRefused('title_taken', `goal v${String(goalVersion)} already has a shared decision titled "${title}"`)
  }
  await tx.goalDecision.create({
    data: { workspaceId, goalVersion, title, titleKey, decision: text, source: input.source, questionId: input.questionId, decisionId: input.decisionId },
  })
}

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
 * Spec C3: a conductor answer's new shared decision, written once ({@link writeGoalDecisionIn}).
 * Controller ruling F13: the version's cap is re-counted under a per-version advisory lock in the
 * same transaction as the insert -- the judging counted it too, but two answers of one batch can both
 * pass that count. A title the version already has is left alone and said: the answer is out, and an
 * answer never rewrites a decision.
 */
async function recordAnswerDecision(input: {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly questionId: string
  readonly decisionId: string
  readonly title: string
  readonly decision: string
}): Promise<ConductorDecisionOutcome> {
  try {
    await prisma.$transaction((tx) => writeGoalDecisionIn(tx, { ...input, source: 'conductor_answer' }))
    return 'recorded'
  } catch (error) {
    if (error instanceof GoalDecisionRefused) {
      if (error.why !== 'empty') console.warn(`[conductor-answer] decision ${input.decisionId}: ${error.message}; "${input.title}" was not added`)
      return error.why === 'empty' ? 'none' : error.why
    }
    // A writer that does not take the advisory lock (the plan's own decisions) can still meet the unique key.
    if (isUniqueConstraintViolation(error)) return 'title_taken'
    throw error
  }
}
