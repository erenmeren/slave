import { applyDecision, recordDecision, refusalText, retireQuestionCards } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  CONDUCT_PER_CALL_CAP_USD,
  CONDUCTOR_ANSWER_BATCH_MAX,
  CONDUCTOR_ANSWER_RETRY_CAP,
  CONDUCTOR_ANSWER_VERSIONS_PER_TICK,
  buildConductorAnswerPrompt,
  candidates,
  criticalMatches,
  err,
  judgeConductorAnswer,
  parseConductorAnswers,
  storableText,
  type Candidate,
  type ConductorAnswer,
  type Decider,
  type Draft,
  type Result,
  type Situation,
  type SupervisorConductorPlan,
  type SupervisorQuestion,
  type SupervisorWorld,
  type Tier,
} from '@slave-of-ai/domain'
import type { ModelSeam } from './supervisor.js'

/** Preflight F9: a failed batch's reason is the model's or the parser's words, stored on the ledger
 *  row and shown in a person's card -- storable and bounded, like every other model text we keep. */
const BATCH_FAILURE_REASON_MAX_CHARS = 500

export interface ConductorPassInput {
  readonly workspaceId: string
  readonly world: SupervisorWorld
  /** The fresh `conductor_question` situations of this pass (`filterFresh` already ran). */
  readonly situations: readonly Situation[]
  readonly seam: ModelSeam | null
  readonly profile: string | null
  readonly now: Date
}

export interface ConductorPass {
  readonly decided: number
  readonly applied: number
  readonly proposed: number
  readonly skippedCooldown: number
  readonly answered: number
  readonly drafted: number
  /** Batched answer calls made, whatever came back -- one ledger row each. */
  readonly calls: number
  /** The questions this pass answered (applied and carried out): the loop must not raise a fresh
   *  `waiting_stale` card about a wait this pass just ended (review M4). */
  readonly answeredIds: ReadonlySet<string>
}

type Tally = { -readonly [K in keyof Omit<ConductorPass, 'answeredIds'>]: ConductorPass[K] } & { readonly answeredIds: Set<string> }

interface Choice {
  readonly chosenIndex: number
  readonly rationale: string
  readonly decidedBy: Decider
  readonly draft?: Draft
  readonly tier?: Tier
}

/** Paused askers first (a run is waiting), then oldest, then by id -- one order for every tick. */
const pausedFirst = (a: SupervisorQuestion, b: SupervisorQuestion): number =>
  Number(b.askerWaiting) - Number(a.askerWaiting) || a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId)

/**
 * Supervisor-as-conductor spec C4: every fresh conductor question, in ONE call per goal version and
 * tick, outside the general per-tick cap (plan B D3). Records one decision per question through
 * `recordDecision` and carries out the applied ones through `applyDecision` -- like `supervise()`,
 * this file records and applies and never calls a verb itself.
 *
 * Before any call, the rules hand a question to a person when the critical lexicon matches it
 * (M39 E2: the domain's judge sees an empty lexicon, so this is where it is checked), when its
 * version has no plan loaded (no packages: nothing to answer FROM, and a silent skip would leave
 * the asker waiting forever), when no model is wired, and when it has already been in
 * `CONDUCTOR_ANSWER_RETRY_CAP` calls since it was last decided -- failed batches and replies that
 * left it out alike (plan B D4).
 */
export async function answerConductorQuestions(input: ConductorPassInput): Promise<ConductorPass> {
  const tally: Tally = { decided: 0, applied: 0, proposed: 0, skippedCooldown: 0, answered: 0, drafted: 0, calls: 0, answeredIds: new Set() }
  const batches = new Map<number, { readonly plan: SupervisorConductorPlan; readonly questions: SupervisorQuestion[] }>()
  for (const situation of input.situations) {
    const question = input.world.questions.find((q) => q.messageId === situation.subjectId)
    if (question === undefined) {
      // Defensive: `observe` builds the situation from this same world. Never skipped silently.
      await escalate(input, tally, situation, 'the question was not in the world this pass read')
      continue
    }
    // M39 E2, unchanged (spec ruling 2): the lexicon stops the call; a person types the answer.
    const lexicon = criticalMatches(question.body)
    if (lexicon.length > 0) {
      const catalogue = candidates(situation, input.world)
      const index = catalogue.findIndex((c) => c.action.kind === 'answer_question')
      await record(input, tally, situation, catalogue, {
        chosenIndex: index === -1 ? catalogue.length - 1 : index,
        rationale: `Escalated without asking a model: the question mentions ${lexicon.join(', ')}, which only a person may answer.`,
        decidedBy: 'rules',
        ...(index === -1
          ? {}
          : {
              tier: 'escalated' as const,
              draft: { body: null, sources: [], rejectedSources: [], critical: { lexicon, model: false }, confidence: 'interpretation' as const },
            }),
      })
      continue
    }
    const plan = question.goalVersion === null ? undefined : input.world.conductorPlans.find((p) => p.goalVersion === question.goalVersion)
    if (plan === undefined) {
      await escalate(input, tally, situation, 'the question belongs to no conducted goal version with a plan')
      continue
    }
    if (input.seam === null) {
      // Final wave M2: the real reason in the card (spec C4) -- `supervise` withholds the seam on a
      // halt or a spent budget, which a person must read as such, not as a missing model.
      const why =
        input.world.halted !== null
          ? `the workspace is halted (${input.world.halted.reason}), so no model was asked`
          : input.world.budgetExhausted
            ? 'the budget is spent, so no model was asked'
            : 'there was no model call to answer it with'
      await escalate(input, tally, situation, why)
      continue
    }
    const attempts = await answerAttempts(input.workspaceId, question.messageId)
    if (attempts.count >= CONDUCTOR_ANSWER_RETRY_CAP) {
      await escalate(input, tally, situation, attemptsText(attempts))
      continue
    }
    const batch = batches.get(plan.goalVersion) ?? { plan, questions: [] }
    batch.questions.push(question)
    batches.set(plan.goalVersion, batch)
  }

  // Review M3: the oldest versions first, at most CONDUCTOR_ANSWER_VERSIONS_PER_TICK calls a pass;
  // the others are neither asked nor counted as attempts, and wait for the next tick.
  const due = [...batches.values()].toSorted((a, b) => a.plan.goalVersion - b.plan.goalVersion).slice(0, CONDUCTOR_ANSWER_VERSIONS_PER_TICK)
  for (const { plan, questions } of due) {
    if (input.seam === null) break
    const batch = questions.toSorted(pausedFirst).slice(0, CONDUCTOR_ANSWER_BATCH_MAX)
    tally.calls += 1
    const answers = await callForAnswers(input, input.seam, plan, batch)
    if (!answers.ok) continue
    for (const answer of answers.value) {
      const situation = input.situations.find((s) => s.subjectId === answer.messageId)
      if (situation === undefined) continue
      const catalogue = candidates(situation, input.world)
      const index = catalogue.findIndex((c) => c.action.kind === 'answer_question')
      if (index === -1) continue
      const asked = batch.find((q) => q.messageId === answer.messageId)
      const judged = judgeConductorAnswer(answer, plan, { halted: input.world.halted !== null, fromHandOffRouting: asked?.fromHandOffRouting ?? true })
      await record(input, tally, situation, catalogue, { chosenIndex: index, rationale: judged.rationale, decidedBy: 'model', draft: judged.draft, tier: judged.tier })
    }
  }
  return tally
}

/**
 * Plan B D4: the batch's one model call and its one ledger row, whatever happened. A decider that
 * throws is a call made whose cost never came back -- a failed, unmeasured row, as `callConductor` rules.
 *
 * No `timeoutMs` (controller ruling F1): the call takes the Supervisor's default, not the conductor's
 * six minutes, so one slow batch cannot hold the tick. A timeout comes back `failed` -- a failed
 * batch, retried next tick and counted toward the question's attempts.
 */
async function callForAnswers(
  input: ConductorPassInput,
  seam: ModelSeam,
  plan: SupervisorConductorPlan,
  batch: readonly SupervisorQuestion[],
): Promise<Result<readonly ConductorAnswer[], string>> {
  const asked = batch.map((q) => q.messageId)
  const prompt = buildConductorAnswerPrompt({ goal: input.world.goal, plan, questions: batch, profile: input.profile })
  let costUsd: number | null = null
  let result: Result<readonly ConductorAnswer[], string>
  try {
    const outcome = await seam.decider({ model: seam.model, prompt, maxBudgetUsd: CONDUCT_PER_CALL_CAP_USD })
    costUsd = outcome.costUsd
    result =
      outcome.kind === 'answer'
        ? parseConductorAnswers(outcome.text, asked)
        : err(outcome.kind === 'failed' ? outcome.reason : `the model tried to use tools (${outcome.tools.join(', ')})`)
  } catch (error) {
    result = err(`the model call threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  const reason = result.ok ? null : storableText(result.error).trim().slice(0, BATCH_FAILURE_REASON_MAX_CHARS) || 'no reason given'
  await prisma.conductorCall.create({
    data: {
      workspaceId: input.workspaceId,
      goalVersion: plan.goalVersion,
      stage: 'answer',
      outcome: result.ok ? 'ok' : 'failed',
      reason,
      modelCostUsd: costUsd,
      unmeasured: costUsd === null,
      questionIds: asked,
    },
  })
  if (reason !== null) console.warn(`[conductor-answer] goal v${String(plan.goalVersion)}: the batch of ${String(asked.length)} was unusable: ${reason}`)
  return result
}

interface Attempts {
  readonly count: number
  readonly failed: number
  /** The newest failed call's stored reason, or null when every call came back usable. */
  readonly lastFailure: string | null
}

/**
 * Plan B D4: the answer calls this question was ever in, failed batches and usable replies that left
 * it out alike. The WHOLE history (review I1, controller ruling): a window opened at the latest
 * decision would include the cap's own escalation, so every person resolving that card would buy the
 * question three more paid batches. Past the cap it is re-escalated by the rules each cooldown, free.
 */
async function answerAttempts(workspaceId: string, messageId: string): Promise<Attempts> {
  const calls = await prisma.conductorCall.findMany({
    where: { workspaceId, stage: 'answer', questionIds: { has: messageId } },
    orderBy: { createdAt: 'asc' },
    select: { outcome: true, reason: true },
  })
  const failures = calls.filter((call) => call.outcome === 'failed')
  return { count: calls.length, failed: failures.length, lastFailure: failures.at(-1)?.reason ?? null }
}

/** Review M6: the card says what happened -- failed calls, replies that left it out, or both. */
function attemptsText(attempts: Attempts): string {
  const n = String(attempts.count)
  if (attempts.failed === attempts.count) return `the conductor's answer call failed ${n} times; the last: ${attempts.lastFailure ?? 'no reason recorded'}`
  if (attempts.failed === 0) return `it was in ${n} answer calls without an answer; each reply left it out`
  return `it was in ${n} answer calls without an answer (${String(attempts.failed)} failed; the last: ${attempts.lastFailure ?? 'no reason recorded'})`
}

/** The rules' escalation, with the reason in the summary a person's card shows (spec C4: "the real reason in the card"). */
async function escalate(input: ConductorPassInput, tally: Tally, situation: Situation, why: string): Promise<void> {
  const told: Situation = { ...situation, summary: `${situation.summary} Not answered by the conductor: ${why}.` }
  const catalogue = candidates(told, input.world)
  const index = catalogue.findIndex((c) => c.action.kind === 'escalate_to_human')
  await record(input, tally, told, catalogue, {
    chosenIndex: index === -1 ? catalogue.length - 1 : index,
    rationale: `The conductor could not answer this (${why}); a person decides.`,
    decidedBy: 'rules',
  })
}

/** One decision row, and its apply when it was applied -- `supervise()`'s own accounting. */
async function record(input: ConductorPassInput, tally: Tally, situation: Situation, catalogue: readonly Candidate[], choice: Choice): Promise<void> {
  const recorded = await recordDecision({
    workspaceId: input.workspaceId,
    situation,
    candidates: catalogue,
    chosenIndex: choice.chosenIndex,
    rationale: choice.rationale,
    decidedBy: choice.decidedBy,
    // Plan B D4: the call is charged on its `ConductorCall` row; a cost here would count it twice.
    modelCostUsd: null,
    modelCalled: false,
    ...(choice.draft === undefined ? {} : { draft: choice.draft }),
    ...(choice.tier === undefined ? {} : { tier: choice.tier }),
    now: input.now,
  })
  if (!recorded.ok) {
    if (recorded.error.kind === 'supervisor_cooldown') tally.skippedCooldown += 1
    else console.warn(`[conductor-answer] ${situation.subjectId} was not recorded: ${refusalText(recorded.error)}`)
    return
  }
  tally.decided += 1
  if (recorded.value.status === 'pending') {
    tally.proposed += 1
    if (choice.draft !== undefined) tally.drafted += 1
  }
  if (recorded.value.tier !== 'applied') return
  tally.applied += 1
  const carried = await applyDecision(recorded.value.id, 'system')
  if (!carried.ok) {
    console.warn(`[conductor-answer] decision ${recorded.value.id} could not be applied: ${refusalText(carried.error)}`)
    return
  }
  if (choice.draft === undefined) return
  tally.answered += 1
  tally.answeredIds.add(situation.subjectId)
  // Human cards H1: the answer closed the question, so no other card about it stays open.
  await retireQuestionCards(input.workspaceId, situation.subjectId, 'The question was answered.', input.now, recorded.value.id)
}
