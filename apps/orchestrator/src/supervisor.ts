import {
  applyDecision,
  expirePendingDecisions,
  loadSupervisorWorld,
  pruneDecisions,
  recordDecision,
  refusalText,
  supervisorSettings,
  type LoadedSupervisorWorld,
  type ModelDecider,
  type WorkspaceStatsSnapshot,
} from '@slave-of-ai/control'
import {
  SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK,
  SUPERVISOR_PER_CALL_CAP_USD,
  answerTier,
  buildAnswerPrompt,
  buildDecisionPrompt,
  candidates,
  chooseByRules,
  criticalMatches,
  filterFresh,
  isSourced,
  neutraliseMarkers,
  observe,
  parseAnswer,
  parseDecisionAnswer,
  verifySources,
  type Action,
  type Candidate,
  type Decider,
  type Draft,
  type Situation,
  type SupervisorWorld,
  type Tier,
} from '@slave-of-ai/domain'

export interface SuperviseDeps {
  readonly workspaceId: string
  /**
   * The M31a model seam (`packages/control/src/simulation/llm.ts`), injected by the daemon
   * (`cli.ts`'s `buildModelDecider`) and faked in tests. Absent is an ordinary state, not an
   * error: a one-shot `orchestrator tick` and every test that only exercises the loop pass none,
   * and the Supervisor then decides by the rules and spends nothing.
   */
  readonly decider?: ModelDecider
  /** The model name a call is made with. Without it there is no call -- a decider with no model to
   *  aim at is not a usable seam, and guessing a default HERE would put a model name in the
   *  orchestrator's loop rather than in `cli.ts`, where the environment is read. */
  readonly model?: string
  /** The tick's clock. One instant for the whole pass: the world is observed at it, the cooldown
   *  is measured from it and every row this pass writes is stamped with it. */
  readonly now?: () => Date
  /**
   * How the world is read. Defaults to control's `loadSupervisorWorld`; production never passes
   * anything else. It is a seam because "a switched-off Supervisor never loads a world" is a
   * property about a call that DOES NOT HAPPEN, and the only honest way to assert that is to hand
   * the loop a loader it can watch (fix round 1, Important 1).
   */
  readonly loadWorld?: (
    workspaceId: string,
    now: Date,
    opts?: { readonly stats?: WorkspaceStatsSnapshot },
  ) => Promise<LoadedSupervisorWorld>
  /**
   * The reading of the workspace's limits, run counts and halt the TICK already made (M39 §4),
   * passed straight through to the loader so `workspaceStats` runs once per tick instead of twice.
   *
   * Absent is an ordinary state: a one-shot `orchestrator tick` and every test that calls this
   * loop directly pass none, and the loader reads its own inside its own snapshot.
   */
  readonly stats?: WorkspaceStatsSnapshot
}

export interface SuperviseReport {
  /** Situations this pass was FREE to decide -- `observe` filtered by `filterFresh`, not the raw
   *  count of what is stuck (an operator reads that off `summarise`'s `stuck`). */
  readonly situations: number
  /** Decision rows written. */
  readonly decided: number
  /**
   * Decisions this pass CARRIED OUT -- attempted through `applyDecision`. A verb that refuses
   * leaves the row `failed` with the refusal text and a `supervisor.failed` event, and still
   * counts here: the attempt is what the tick did, and the refusal is in the log rather than
   * silently absent from both.
   */
  readonly applied: number
  /** Decisions now waiting on a human (`status: pending`) -- risky proposals and escalations
   *  alike, which is the set the web panel's approve/reject list holds. */
  readonly proposed: number
  /** Situations `recordDecision` refused because their key was already open or still cooling. A
   *  skip, never a failure: `filterFresh` is a cheap first pass over a world already in memory and
   *  the verb holds the real gate, so the two disagreeing is the ordinary case, not a bug. */
  readonly skippedCooldown: number
  /** Model calls made, whatever came back. Never more than
   *  `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK`. */
  readonly modelCalls: number
  /** True when this pass could not have called a model at all -- no decider or no model wired, the
   *  budget exhausted, the workspace halted, or the Supervisor switched off. It is NOT
   *  `modelCalls === 0`: a pass with a model available and nothing stuck also makes no calls, and
   *  those two are different facts about the daemon's wiring. */
  readonly rulesOnly: boolean
  /**
   * Questions this pass ANSWERED itself (M39 §5): `answer_question` decisions whose final tier was
   * `applied` AND whose `answerQuestion` actually went through, so a waiting worker will be resumed
   * by the next tick's `deliverAnswers`.
   *
   * A strict subset of {@link SuperviseReport.applied}, and strict in both directions is the point
   * (fix round 1, Minor 2): `applied` counts the attempt, this counts the outcome. A decision whose
   * verb refused -- the question was answered by somebody else while the pass was drafting -- is an
   * `applied` attempt and a `failed` row, and nobody was answered.
   */
  readonly answered: number
  /** Questions this pass DRAFTED an answer to and left for a human -- an interpretation
   *  (`proposed`) or a critical question (`escalated`). A subset of
   *  {@link SuperviseReport.proposed}, and the number an operator reads as "there is mail". */
  readonly drafted: number
  /** Decision rows deleted as history past `DECISION_RETENTION_MS` (M39 §2). Counted on every pass,
   *  including one a switched-off Supervisor makes: retention is a promise about the TABLE, not
   *  about deciding, and rows written while it was on must still age out after it is off. */
  readonly pruned: number
}

/** What a pass that decided nothing reports -- and what `tick()` returns for the one path that
 *  never reaches the Supervisor at all: an archived project, whose world is never loaded. */
export const NO_SUPERVISION: SuperviseReport = {
  situations: 0,
  decided: 0,
  applied: 0,
  proposed: 0,
  skippedCooldown: 0,
  modelCalls: 0,
  rulesOnly: true,
  answered: 0,
  drafted: 0,
  pruned: 0,
}

/** What one situation was decided by, before it becomes a row. */
interface Choice {
  readonly chosenIndex: number
  readonly rationale: string
  readonly decidedBy: Decider
  /** The cost of the call that was made, `null` when none was or when the provider reported none.
   *  Recorded even when the answer was unusable and the RULES chose -- the money was spent either
   *  way. */
  readonly modelCostUsd: number | null
  /** Whether a call was made at all (spec erratum E6). The pair (`decidedBy: 'rules'`,
   *  `modelCalled: true`) is the fallback case, and it is what `workspaceSpend` charges at the cap
   *  when the cost came back null. */
  readonly modelCalled: boolean
}

/**
 * One Supervisor pass over one workspace (M38 §5), run at the end of every tick.
 *
 * The whole loop, and nothing else: the world comes from `packages/control/src/supervisorWorld.ts`,
 * every judgement is a pure domain function, and every effect goes through `recordDecision` and
 * `applyDecision`. This file NEVER calls a control verb directly -- not `unblockTask`, not
 * `setRuntimeRoles`. That is what keeps "a decision is not work" (spec §1) true of the code and
 * not merely of the prose: an action the Supervisor takes is always a row somebody can read, with
 * the situation it was taken on and the catalogue it was chosen from stored beside it.
 *
 * The model is asked for an INDEX into a rule-built catalogue and can never widen it. It is not
 * asked at all when the budget is exhausted or the workspace is halted -- the two states in which
 * spending money to think about a stopped workspace is exactly the wrong move -- nor when the
 * daemon wired no decider, nor after `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK` calls this pass.
 * Whatever the reason, `chooseByRules` answers instead; the catalogue always contains an
 * escalation, so there is always an answer.
 */
export async function supervise(deps: SuperviseDeps): Promise<SuperviseReport> {
  const now = deps.now?.() ?? new Date()

  // The expiry sweep runs FIRST and runs ALWAYS -- before the switch, before the world (fix round 2,
  // spec §5). Two reasons, and the second is the one that made this a regression when it briefly
  // sat behind the enabled check: a proposal past its TTL must not still be blocking its situation
  // key when `filterFresh` looks at the decisions this instant, and a proposal in a SWITCHED-OFF
  // workspace must not stay `pending` -- and approvable -- forever. Switching the Supervisor off
  // stops it deciding; it does not freeze the questions it already asked. One indexed `findMany`
  // and, almost always, nothing to do.
  await expirePendingDecisions(deps.workspaceId, now)

  // And the retention sweep right behind it (M39 §2), for the same reason it runs before the
  // switch: `SupervisorDecision` grows by one row per stuck situation per cooldown, forever, and a
  // project whose Supervisor was switched off last month must still stop holding the rows it wrote
  // the month before. Bounded to `PRUNE_BATCH` rows and it never touches a `pending` one -- the
  // sweep above is what retires those.
  const pruned = await pruneDecisions(deps.workspaceId, now)

  // The switch next, in one indexed read, and before anything expensive (fix round 1, Important 1).
  // Report only (spec §1) means exactly that: no world, no decisions, no events, no model calls.
  // `recordDecision` would refuse each situation anyway, but a daemon ticking once a second against
  // a switched-off project would still be paying for a full world load every second to learn
  // nothing. A missing project stops here too -- there is nothing to supervise and no reason to let
  // the loader throw about it.
  const enabled = await supervisorSettings(deps.workspaceId)
  if (enabled === null || !enabled.enabled) return { ...NO_SUPERVISION, pruned }

  // From here on the SNAPSHOT's settings are the ones that count (fix round 2, spec §5). The read
  // above decided only whether to load a world at all; the profile that goes into a prompt has to
  // be the one that was true inside the world the decision is made on, not one read a few
  // milliseconds earlier on a different connection.
  const { world, settings } = await (deps.loadWorld ?? loadSupervisorWorld)(deps.workspaceId, now, {
    ...(deps.stats === undefined ? {} : { stats: deps.stats }),
  })

  const situations = filterFresh(observe(world), world)
  // The seam, resolved once for the pass: a decider AND a model to aim it at, a budget that is not
  // gone, and a workspace that is still running. Held as a pair rather than re-tested per
  // situation so the two halves cannot be checked in one place and read in another.
  const seam =
    deps.decider !== undefined && deps.model !== undefined && !world.budgetExhausted && world.halted === null
      ? { decider: deps.decider, model: deps.model }
      : null

  let decided = 0
  let applied = 0
  let proposed = 0
  let skippedCooldown = 0
  let modelCalls = 0
  let answered = 0
  let drafted = 0

  for (const situation of situations) {
    const catalogue = candidates(situation, world)
    let choice: Choice | null = null

    if (seam !== null && modelCalls < SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK) {
      modelCalls += 1
      choice = await askTheModel({
        decider: seam.decider,
        model: seam.model,
        situation,
        catalogue,
        world,
        profile: settings.profile,
      })
    }

    // Every road that is not a usable model answer ends here: no decider, no model, budget gone,
    // halted, over the per-tick cap, a call that failed or breached, an answer that would not
    // parse or pointed outside the catalogue. The cost of a call that DID happen still rides along.
    let decision = choice ?? { ...byTheRules(catalogue), modelCostUsd: null, modelCalled: false }

    // The SECOND call (M39 §5). An `answer_question` offer is not a decision yet -- it is a
    // promise to go and find the answer -- so before the row is written the pass drafts one,
    // checks its citations in code and computes the tier that draft actually earns. Everything
    // that comes back from here is still only ARGUMENTS to `recordDecision`: this file records and
    // applies, it never calls a verb (spec §1).
    const action = catalogue[decision.chosenIndex]?.action
    let draft: Draft | undefined
    let tier: Tier | undefined
    if (action !== undefined && action.kind === 'answer_question') {
      const outcome = await decideQuestion({
        action,
        catalogue,
        choice: decision,
        world,
        profile: settings.profile,
        // The answer call counts against the SAME per-tick cap the choice call does (spec §1,
        // "two model calls per question at most, both counted"): the seam is withheld once the cap
        // is spent, and what comes back says how many calls were made -- including one that THREW,
        // which is money spent whatever it produced.
        seam: seam !== null && modelCalls < SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK ? seam : null,
      })
      modelCalls += outcome.calls
      decision = outcome.choice
      draft = outcome.draft
      tier = outcome.tier
    }

    const recorded = await recordDecision({
      workspaceId: deps.workspaceId,
      situation,
      candidates: catalogue,
      chosenIndex: decision.chosenIndex,
      rationale: decision.rationale,
      decidedBy: decision.decidedBy,
      modelCostUsd: decision.modelCostUsd,
      modelCalled: decision.modelCalled,
      ...(draft === undefined ? {} : { draft }),
      ...(tier === undefined ? {} : { tier }),
      now,
    })
    if (!recorded.ok) {
      if (recorded.error.kind === 'supervisor_cooldown') {
        skippedCooldown += 1
        continue
      }
      // Anything else is the workspace changing under the pass (switched off, or deleted between
      // the load and the write). Logged and skipped: the next tick reloads the world and will see
      // whatever it has become.
      console.warn(
        `[supervise] ${situation.kind} for ${situation.subjectId} was not recorded: ${refusalText(recorded.error)}`,
      )
      continue
    }
    decided += 1
    if (recorded.value.status === 'pending') {
      proposed += 1
      // A drafted answer waiting on a human -- an interpretation at `proposed`, or a critical
      // question at `escalated`. Both put a text in front of a person; the pair is exactly what
      // `summarise`'s `draftsAwaiting` counts off the stored rows.
      if (draft !== undefined) drafted += 1
    }

    if (recorded.value.tier !== 'applied') continue
    applied += 1
    const carried = await applyDecision(recorded.value.id, 'system')
    // Counted AFTER the verb, and only when it agreed (fix round 1, Minor 2). `applied` is what
    // this pass ATTEMPTED -- a refusal is still something the tick did -- but `answered` is a claim
    // about the world: that a worker now has an answer it did not have before. `answerQuestion` can
    // refuse (the question was answered while the pass was drafting), and a report saying it
    // answered a question it did not would be exactly the kind of lie the decision row exists to
    // prevent.
    if (carried.ok && draft !== undefined) answered += 1
    if (!carried.ok) {
      // `applyDecision` has already flipped the row to `failed` and appended `supervisor.failed`.
      // Not retried in this pass: the world that refused it is the world this pass observed, and
      // the cooldown will hold the key until the next one can look again.
      console.warn(
        `[supervise] decision ${recorded.value.id} (${situation.kind}) could not be applied: ${refusalText(carried.error)}`,
      )
    }
  }

  return {
    situations: situations.length,
    decided,
    applied,
    proposed,
    skippedCooldown,
    modelCalls,
    rulesOnly: seam === null,
    answered,
    drafted,
    pruned,
  }
}

/** What the question path hands back to the loop: the choice as it now stands (possibly replaced
 *  by a rules escalation), the draft to store beside it, the FINAL tier `answerTier` computed, and
 *  how many model calls it made -- so the pass's own per-tick counter stays the one authority on
 *  how many calls this workspace has paid for. */
interface QuestionOutcome {
  readonly choice: Choice
  readonly draft?: Draft
  readonly tier?: Tier
  readonly calls: number
}

/**
 * The whole of an `answer_question` decision, from the offer to the draft (M39 §5).
 *
 * Five roads out, in this order, and the order is the point:
 *
 * 1. **The question is gone.** Nothing to answer, nothing to draft: the rules escalate. Defensive
 *    -- `candidates` builds the offer from this same world -- but a fabricated draft about a
 *    question nobody holds would be far worse than a wasted escalation.
 * 2. **The lexicon fired** (erratum E2). NO answer call is made at all: a question about a
 *    credential or a spend must not be answerable even by a model that was about to be careful
 *    about it. The row is `escalated` with a bodiless draft naming the keys that matched, which is
 *    the thing a human then types their own answer into (Task 2 fix round 1).
 * 3. **No model to ask, or the per-tick cap is spent.** The Supervisor never writes an answer
 *    without a model (spec §5), so the situation is escalated BY THE RULES -- deliberately not
 *    `chooseByRules`, which would fall through to a routine re-address the model never chose.
 * 4. **The call came back unusable** -- failed, an isolation breach, a reply that will not parse.
 *    The rules escalate and the cost of the call rides along, exactly as {@link askTheModel} does
 *    for the choice call.
 * 5. **A drafted answer.** Its citations are checked in code ({@link verifySources}), the tier is
 *    {@link answerTier}'s and nobody else's, and the model's `critical` flag is recorded beside the
 *    lexicon's (empty here -- road 2 is the only way a lexicon hit reaches a row).
 *
 * The cost on the row is the SUM of both calls: the workspace paid for the choice and the answer,
 * and a reader looking at what this decision cost must see both. `null + a number` is that number
 * (one call reported a cost and the other did not); two nulls stay null, which is what
 * `workspaceSpend` charges at the per-call cap.
 */
async function decideQuestion(input: {
  readonly action: Extract<Action, { kind: 'answer_question' }>
  readonly catalogue: readonly Candidate[]
  readonly choice: Choice
  readonly world: SupervisorWorld
  readonly profile: string | null
  readonly seam: { readonly decider: ModelDecider; readonly model: string } | null
}): Promise<QuestionOutcome> {
  const { action, catalogue, choice, world, seam } = input
  const question = world.questions.find((pending) => pending.messageId === action.messageId)
  if (question === undefined) {
    return { choice: escalateByRules(catalogue, choice, 'the question is no longer pending'), calls: 0 }
  }

  const lexicon = criticalMatches(question.body)
  if (lexicon.length > 0) {
    return {
      // The RATIONALE is replaced, not just the tier (fix round 1, Minor 6). The model's own
      // sentence was written about the action it chose -- "the task text says which port" -- and
      // leaving it on an escalated, body-null row tells a human the opposite of what happened: that
      // an answer was drafted and is waiting for approval. What actually happened is that a
      // deterministic list of words stopped the call, and the row now says so, naming the words.
      // The model's sentence is not kept: it describes a draft that does not exist, and the draft
      // beside it already carries the only fact worth keeping -- `critical.lexicon`.
      choice: { ...choice, rationale: escalatedByLexicon(lexicon) },
      tier: 'escalated',
      draft: {
        body: null,
        sources: [],
        rejectedSources: [],
        critical: { lexicon, model: false },
        confidence: 'interpretation',
      },
      calls: 0,
    }
  }

  if (seam === null) {
    return {
      choice: escalateByRules(catalogue, choice, 'there was no model call left to draft an answer with'),
      calls: 0,
    }
  }

  const prompt = buildAnswerPrompt({ question, world, profile: input.profile })
  let outcome
  try {
    outcome = await seam.decider({ model: seam.model, prompt, maxBudgetUsd: SUPERVISOR_PER_CALL_CAP_USD })
  } catch (error) {
    console.warn(
      `[supervise] the answer call for question ${action.messageId} threw: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { choice: escalateByRules(catalogue, { ...choice, modelCalled: true }, 'the answer call threw'), calls: 1 }
  }

  const spent = { ...choice, modelCostUsd: addCosts(choice.modelCostUsd, outcome.costUsd), modelCalled: true }

  if (outcome.kind !== 'answer') {
    const why = outcome.kind === 'failed' ? outcome.reason : `isolation breach (${outcome.tools.join(', ')})`
    return { choice: escalateByRules(catalogue, spent, `the answer call was unusable (${why})`), calls: 1 }
  }

  const model = parseAnswer(outcome.text)
  if (model === null) {
    return { choice: escalateByRules(catalogue, spent, 'the drafted answer would not parse'), calls: 1 }
  }

  const check = verifySources(model.sources, question, world)
  const sourced = isSourced(check)
  return {
    choice: spent,
    tier: answerTier({ sourced, critical: model.critical, halted: world.halted !== null }),
    draft: {
      // Neutralised HERE as well as in `sendDraftedAnswer`, because this text is stored and shown
      // to a human long before (or instead of) being sent: a draft in the panel must not be able
      // to carry a run-context marker either.
      body: neutraliseMarkers(model.answer),
      sources: check.verified,
      rejectedSources: check.rejected,
      // The lexicon is empty by construction on this road -- a hit would have short-circuited
      // above -- and it is written out rather than omitted so every stored draft has one shape.
      critical: { lexicon: [], model: model.critical },
      confidence: sourced ? 'sourced' : 'interpretation',
    },
    calls: 1,
  }
}

/** Why an E2 row is an escalation, in the row's own words: the lexicon keys that fired, in the
 *  catalogue's order. `and` rather than a bare list because this is the sentence a human reads in
 *  the panel beside a draft with no body in it. */
function escalatedByLexicon(lexicon: readonly string[]): string {
  const keys =
    lexicon.length === 1 ? lexicon[0] : `${lexicon.slice(0, -1).join(', ')} and ${lexicon[lexicon.length - 1] ?? ''}`
  return `Escalated without asking a model: the question mentions ${String(keys)}, which only a human may answer.`
}

/**
 * Two costs added as MONEY rather than as numbers: a null is "nothing was reported", not zero, so
 * one reported cost beside one unreported is that cost, and two unreported stay unreported --
 * which is the state `workspaceSpend` charges at `SUPERVISOR_PER_CALL_CAP_USD` per call.
 */
function addCosts(first: number | null, second: number | null): number | null {
  if (first === null) return second
  if (second === null) return first
  return first + second
}

/**
 * The one road out of a question the Supervisor could not answer: `escalate_to_human`, decided by
 * the rules, with whatever the model calls have already cost still on it.
 *
 * Deliberately NOT {@link byTheRules}: `chooseByRules` prefers a single routine candidate, so on a
 * stale question with an idle holder it would quietly turn "answer this" into "re-address it to
 * Robin" -- an action nobody chose, taken because the answer call could not be made. Spec §5 says
 * the fallback is the escalation, and `candidates` guarantees there is always one.
 */
function escalateByRules(catalogue: readonly Candidate[], spent: Choice, why: string): Choice {
  const index = catalogue.findIndex((candidate) => candidate.action.kind === 'escalate_to_human')
  return {
    chosenIndex: index === -1 ? catalogue.length - 1 : index,
    rationale: `The Supervisor could not draft an answer (${why}); a human decides what happens next.`,
    decidedBy: 'rules',
    modelCostUsd: spent.modelCostUsd,
    modelCalled: spent.modelCalled,
  }
}

/**
 * One model call, and the answer only if it is usable.
 *
 * Every unusable outcome falls back to the rules and still carries the cost AND `modelCalled: true`
 * (erratum E6): a timeout that burned real tokens is spend whether or not its answer was worth
 * anything, and a null cost on such a call is charged at the per-call cap rather than lost. A decider
 * that THROWS is treated as a failed call rather than allowed out of the tick -- `decideWithModel`
 * spawns a child process, and a spawn that explodes must cost the workspace a rules decision, not
 * its whole scheduling pass.
 */
async function askTheModel(input: {
  readonly decider: ModelDecider
  readonly model: string
  readonly situation: Situation
  readonly catalogue: readonly Candidate[]
  readonly world: SupervisorWorld
  readonly profile: string | null
}): Promise<Choice> {
  const prompt = buildDecisionPrompt({
    situation: input.situation,
    candidates: input.catalogue,
    profile: input.profile,
    world: input.world,
  })

  let outcome
  try {
    outcome = await input.decider({ model: input.model, prompt, maxBudgetUsd: SUPERVISOR_PER_CALL_CAP_USD })
  } catch (error) {
    console.warn(
      `[supervise] the model call for ${input.situation.kind} threw: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { ...byTheRules(input.catalogue), modelCostUsd: null, modelCalled: true }
  }

  if (outcome.kind !== 'answer') {
    const why = outcome.kind === 'failed' ? outcome.reason : `isolation breach (${outcome.tools.join(', ')})`
    return { ...byTheRules(input.catalogue, why), modelCostUsd: outcome.costUsd, modelCalled: true }
  }

  const answer = parseDecisionAnswer(outcome.text, input.catalogue.length)
  if (answer === null) {
    return {
      ...byTheRules(input.catalogue, 'the answer was not a usable candidate index'),
      modelCostUsd: outcome.costUsd,
      modelCalled: true,
    }
  }

  return {
    chosenIndex: answer.candidateIndex,
    rationale: answer.rationale,
    decidedBy: 'model',
    modelCostUsd: outcome.costUsd,
    modelCalled: true,
  }
}

/**
 * The rules' own choice, with the chosen candidate's `why` as the rationale -- so a row decided by
 * the rules reads like one decided by a model, and the panel needs no second rendering for it.
 * `fallbackFrom` names the model failure when there was one, so the rationale says out loud that
 * a model WAS asked -- the row's own `modelCalled` (erratum E6) is what the accounting reads.
 */
function byTheRules(
  catalogue: readonly Candidate[],
  fallbackFrom?: string,
): Omit<Choice, 'modelCostUsd' | 'modelCalled'> {
  const chosenIndex = chooseByRules(catalogue)
  const why = catalogue[chosenIndex]?.why ?? 'the rules chose this action.'
  return {
    chosenIndex,
    rationale: fallbackFrom === undefined ? why : `The model's answer could not be used (${fallbackFrom}); by the rules: ${why}`,
    decidedBy: 'rules',
  }
}
