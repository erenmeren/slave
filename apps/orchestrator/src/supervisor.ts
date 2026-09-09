import {
  applyDecision,
  expirePendingDecisions,
  loadSupervisorWorld,
  recordDecision,
  refusalText,
  supervisorSettings,
  type LoadedSupervisorWorld,
  type ModelDecider,
} from '@slave-of-ai/control'
import {
  SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK,
  SUPERVISOR_PER_CALL_CAP_USD,
  buildDecisionPrompt,
  candidates,
  chooseByRules,
  filterFresh,
  observe,
  parseDecisionAnswer,
  type Candidate,
  type Decider,
  type Situation,
  type SupervisorWorld,
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
  readonly loadWorld?: (workspaceId: string, now: Date) => Promise<LoadedSupervisorWorld>
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

  // The switch next, in one indexed read, and before anything expensive (fix round 1, Important 1).
  // Report only (spec §1) means exactly that: no world, no decisions, no events, no model calls.
  // `recordDecision` would refuse each situation anyway, but a daemon ticking once a second against
  // a switched-off project would still be paying for a full world load every second to learn
  // nothing. A missing project stops here too -- there is nothing to supervise and no reason to let
  // the loader throw about it.
  const enabled = await supervisorSettings(deps.workspaceId)
  if (enabled === null || !enabled.enabled) return NO_SUPERVISION

  // From here on the SNAPSHOT's settings are the ones that count (fix round 2, spec §5). The read
  // above decided only whether to load a world at all; the profile that goes into a prompt has to
  // be the one that was true inside the world the decision is made on, not one read a few
  // milliseconds earlier on a different connection.
  const { world, settings } = await (deps.loadWorld ?? loadSupervisorWorld)(deps.workspaceId, now)

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
    const decision = choice ?? { ...byTheRules(catalogue), modelCostUsd: null, modelCalled: false }

    const recorded = await recordDecision({
      workspaceId: deps.workspaceId,
      situation,
      candidates: catalogue,
      chosenIndex: decision.chosenIndex,
      rationale: decision.rationale,
      decidedBy: decision.decidedBy,
      modelCostUsd: decision.modelCostUsd,
      modelCalled: decision.modelCalled,
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
    if (recorded.value.status === 'pending') proposed += 1

    if (recorded.value.tier !== 'applied') continue
    applied += 1
    const carried = await applyDecision(recorded.value.id, 'system')
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
