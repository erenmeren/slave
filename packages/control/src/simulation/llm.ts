import { createHash } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import {
  CompositeDecisionProvider, LlmDecisionProvider, buildDecisionPrompt, parseEnvelopes,
  type ActionEnvelope,
} from '@slave-of-ai/simulation'
import type { ControlRefusal } from '../refusal.js'
import { readSimulation } from './read.js'
import { clearAutoRun, json, locked } from './shared.js'
import { haltUnparsed, stepLocked } from './write.js'

/** The ceiling on ONE model call, whatever budget the run still has (M31a §4). A run's own cap is
 *  cumulative and can be large; this bounds the blast radius of a single decision -- a prompt that
 *  somehow provokes a very long, very expensive answer costs at most this much before the CLI's own
 *  `--max-budget-usd` stops it. The call is capped at `Math.min(remainingUsd, PER_CALL_CAP_USD)`,
 *  so a nearly-exhausted run asks for less than this, never more. */
export const PER_CALL_CAP_USD = 1

/**
 * The provider's `ModelDecisionOutcome`, re-declared here structurally.
 *
 * `packages/control/src/simulation/*` must not import the providers package -- a boundary test
 * (`packages/control/test/simulation-boundary.test.ts`) enforces it, because the simulation's
 * control layer spawns nothing, reads no environment and must stay a pure database verb. The
 * daemon owns the seam: it holds the real `decideWithModel` and passes a plain function in. So the
 * union is copied rather than imported; structural typing makes the daemon's real outcome assign
 * to this one with no cast anywhere.
 */
export type ModelOutcome =
  | {
      readonly kind: 'answer'
      readonly text: string
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
      readonly numTurns: number
    }
  | {
      readonly kind: 'isolation_breach'
      readonly tools: readonly string[]
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
    }
  | {
      readonly kind: 'failed'
      readonly reason: string
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
    }

/** What the daemon injects into `tickSimulations`: the model call itself, as a function. Nothing
 *  in the control layer knows how it is made -- a CLI, a fixture, or a test's `async () => …`. */
export type ModelDecider = (input: { readonly model: string; readonly prompt: string; readonly maxBudgetUsd: number }) => Promise<ModelOutcome>

export type PrepareOutcome =
  /** Nothing to decide: the same three watermark checks `autoStepDue` makes under its lock, plus
   *  `until_day` -- the intent's own end, which clears the intent so the run stops SPENDING and
   *  not merely stops advancing (an llm run that ignored `untilDay` would keep paying for days to
   *  the horizon). */
  | { readonly kind: 'skip'; readonly reason: 'no_intent' | 'not_running' | 'not_due' | 'until_day' }
  /** The cap is reached: the run is already halted by the time this returns. */
  | { readonly kind: 'budget' }
  | {
      readonly kind: 'decide'
      readonly version: number
      readonly day: number
      readonly role: string
      readonly prompt: string
      readonly promptHash: string
      readonly model: string
      readonly remainingUsd: number
    }

/** Writes one journal row at `max(seq) + 1` under the row lock. Used by the one path that journals
 *  outside `stepLocked` and does NOT move `state.journalSeq` (the exhausted budget): the seq is
 *  read fresh from the journal itself because `state.journalSeq` can lag the journal's real
 *  maximum after a `haltUnparsed` (which never rewrites `state`) -- the same reasoning
 *  `injectExternalEvent` documents.
 *
 *  Not moving the watermark is safe HERE and nowhere else (final review, Critical #1): the only
 *  caller halts the run through `haltUnparsed` on the very next line, and `halted` is terminal for
 *  every journal writer in this package -- `stepSimulation`, `startAutoRun` and `setStatus` all
 *  refuse a halted row, and `haltUnparsed` itself reads `max(seq)` fresh. A caller that journals
 *  through this and leaves the run RUNNING would strand `state.journalSeq` behind the journal and
 *  the next `state.journalSeq + 1` writer would collide on `(simulationId, seq)`. */
async function journalControl(simulationId: string, simTime: number, payload: Record<string, unknown>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SimulationRun" WHERE id = ${simulationId} FOR UPDATE`
    const last = await tx.simulationJournalEntry.findFirst({ where: { simulationId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    await tx.simulationJournalEntry.create({ data: { simulationId, seq: (last?.seq ?? -1) + 1, simTime, kind: 'control', actorRole: null, payload: json(payload) } })
  })
}

/**
 * Phase one of a model step (M31a §4): everything that can be decided and built WITHOUT holding a
 * row lock, because the model call that follows takes seconds to minutes and must never happen
 * inside a transaction.
 *
 * Reads the run unlocked, answers the three watermark questions `autoStepDue` answers (plus the
 * intent's own `untilDay`), checks the cumulative spend against the cap, and -- if there is a day
 * to decide -- builds the prompt from the role's OWN observation (the RUN's own sector model's
 * `observe`, which filters by `role.observes`) and the actions that role is allowed to propose --
 * both read off the plugin its `sector` resolves to. Nothing here is
 * written except the halt an exhausted budget causes: preparing a decision is otherwise a pure
 * read, and the `version` it returns is what `applyModelDecision` re-checks under the lock.
 *
 * The unlocked read is safe precisely because nothing is decided by it: a concurrent step that
 * lands between this read and the apply moves the row's `version`, and the apply refuses as stale.
 */
export async function prepareModelDecision(simulationId: string, now: Date): Promise<Result<PrepareOutcome, ControlRefusal>> {
  const read = await readSimulation(prisma, simulationId)
  if (!read.ok) return read
  const { summary, definition, state, plugin } = read.value
  const intent = summary.autoRun
  if (intent === null) return ok({ kind: 'skip', reason: 'no_intent' } as const)
  if (summary.status !== 'running') return ok({ kind: 'skip', reason: 'not_running' } as const)
  const lastStepAt = intent.lastStepAt === null ? null : new Date(intent.lastStepAt).getTime()
  if (lastStepAt !== null && lastStepAt + intent.everyMs > now.getTime()) return ok({ kind: 'skip', reason: 'not_due' } as const)
  if (summary.simTime >= intent.untilDay) {
    // The same ending `autoStepDue` gives a rules run, taken under the row lock so a racing pass
    // finds either the cleared intent or the lock. Stopping stops spending: an llm run that ran
    // past its `untilDay` would go on paying for a model call every period.
    await prisma.$transaction(async (tx) => {
      const got = await locked(tx, simulationId)
      if (!got.ok) return
      const { row, loaded } = got.value
      if (row.autoRunEveryMs === null || row.autoRunUntilDay === null || row.simTime < row.autoRunUntilDay) return
      const seq = await clearAutoRun(tx, row, loaded, 'until_day', loaded.state.journalSeq + 1)
      // Ruling R11: `version` moves too. The clear touches neither `status` nor `simTime`, so
      // `version` is the ONLY field the run page's SSE stream can notice it by -- without the bump
      // the page went on offering "Stop auto-run" for an intent that was already gone, until
      // somebody reloaded by hand.
      await tx.simulationRun.update({ where: { id: simulationId }, data: { version: row.version + 1, autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
    })
    return ok({ kind: 'skip', reason: 'until_day' } as const)
  }

  // Cost honesty (M31a §4, ruling R10): an unmeasured call is stored as a NULL cost -- the ledger
  // never invents a figure for it -- but the CAP is not the ledger. A call that reported nothing
  // still happened and still cost something, and counting it as $0 would let a provider that
  // reports no cost spend to the horizon under any cap at all. So the cap is enforced on
  // `chargedUsd`: the measured spend plus PER_CALL_CAP_USD for every unmeasured call, which is the
  // most a single call could have cost (`decideWithModel` is spawned with `--max-budget-usd` at
  // most that). The run page says so in as many words, so the charge is never a silent one.
  // `>=`, not `>`: reaching the cap ends the run.
  const capUsd = summary.maxModelCostUsd
  const aggregate = await prisma.simulationModelUsage.aggregate({ where: { simulationId }, _sum: { costUsd: true }, _count: { _all: true, costUsd: true } })
  const spentUsd = aggregate._sum.costUsd ?? 0
  const unmeasured = aggregate._count._all - aggregate._count.costUsd
  const chargedUsd = spentUsd + unmeasured * PER_CALL_CAP_USD
  if (capUsd !== null && chargedUsd >= capUsd) {
    await journalControl(simulationId, summary.simTime, { op: 'model_budget_exhausted', spentUsd, unmeasured, chargedUsd, capUsd })
    await haltUnparsed(simulationId, 'model budget exhausted')
    return ok({ kind: 'budget' } as const)
  }

  const roleName = definition.llmRoles[0]
  const role = roleName === undefined ? undefined : definition.roles.find((r) => r.name === roleName)
  // An `llm` run is created with the plugin's own `llmRoleCandidates` (trade `purchasing`, software
  // `lead`) and a non-empty `model`, so neither of these can be missing on a row this function is
  // reached for. A row that somehow has neither is not steppable at all, and saying so as a refusal
  // halts it (through `tickSimulations`'s own halt path) rather than silently skipping it forever.
  if (roleName === undefined || role === undefined) return err({ kind: 'simulation_corrupt', simulationId, reason: 'an llm run has no llm role to decide for' })
  if (summary.model === null) return err({ kind: 'simulation_corrupt', simulationId, reason: 'an llm run has no model' })

  const observation = plugin.model.observe(state.sector, role)
  const prompt = buildDecisionPrompt({
    role,
    observation,
    actionDocs: plugin.actionDocs.filter((doc) => role.allowedActions.includes(doc.type)),
    day: state.day,
    currency: definition.currency,
    maxActions: definition.limits.maxDecisionsPerStep,
  })
  return ok({
    kind: 'decide',
    version: summary.version,
    day: state.day,
    role: roleName,
    prompt,
    // Recorded so a decision row can be tied back to the exact text the model was shown without
    // storing the prompt itself on every step.
    promptHash: createHash('sha256').update(prompt).digest('hex'),
    model: summary.model,
    // What is left is measured against the same `chargedUsd` the cap is: an unmeasured call has
    // already taken its per-call ceiling out of the budget, so the next call asks for less.
    remainingUsd: capUsd === null ? PER_CALL_CAP_USD : capUsd - chargedUsd,
  } as const)
}

export interface ApplyModelDecisionInput {
  readonly expectedVersion: number
  readonly role: string
  readonly outcome: ModelOutcome
  readonly promptHash: string
  readonly now: Date
}

/**
 * Phase three (M31a §4): the model has answered, and this is the only phase that writes.
 *
 * The usage row goes in FIRST, before any check that can end this transaction early -- the call
 * was made and paid for whatever the row's state turned out to be, so a stale decision or a breach
 * must still be accounted. Then, in order: the stale check (the row moved under us), the isolation
 * breach (the model reached for a tool through a deny-all hook -- halt, do not step), and finally
 * the step itself, with the model's envelopes routed to its own role and the rules answering every
 * other role.
 *
 * A `failed` call and an unparseable answer are NOT errors here: the day still advances with that
 * role proposing nothing, and the decision row carries the reason. A model that cannot answer costs
 * the simulation one day's actions, which is exactly what a role choosing to act on nothing costs.
 */
export async function applyModelDecision(
  simulationId: string,
  input: ApplyModelDecisionInput,
): Promise<Result<{ readonly applied: boolean; readonly reason?: 'stale' | 'breach' | 'failed' }, ControlRefusal>> {
  const { expectedVersion, role, outcome, promptHash, now } = input
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value

    // 1. The usage row, first and unconditionally. `costUsd`/`tokens` stay null when the provider
    //    reported none -- an unmeasured call is never written as a free one.
    const lastUsage = await tx.simulationModelUsage.findFirst({ where: { simulationId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const usageSeq = (lastUsage?.seq ?? -1) + 1
    await tx.simulationModelUsage.create({
      data: {
        simulationId, seq: usageSeq, provider: 'claude_code', costUsd: outcome.costUsd, tokensIn: outcome.tokens?.input ?? null, tokensOut: outcome.tokens?.output ?? null,
        simTime: row.simTime, role,
      },
    })
    const nextSeq = async (): Promise<number> => {
      const last = await tx.simulationJournalEntry.findFirst({ where: { simulationId }, orderBy: { seq: 'desc' }, select: { seq: true } })
      return (last?.seq ?? -1) + 1
    }

    // 2. Stale: the world moved while the model was thinking, so the answer was decided against a
    //    world that no longer exists and is recorded and dropped.
    //
    //    THREE questions, not two (fix round 1, Critical #1). `stopAutoRun` clears the intent
    //    columns and touches neither `version` nor `status`, so a check that read only those two
    //    was blind to it: a person who stopped the run mid-call would watch it step once more
    //    anyway, which spec §2.6 forbids. The cleared intent is the third question, and the
    //    journal names which one answered.
    const staleReason = row.version !== expectedVersion ? 'version' : row.status !== 'running' ? 'status' : row.autoRunEveryMs === null ? 'intent_cleared' : null
    if (staleReason !== null) {
      const seq = await nextSeq()
      await tx.simulationJournalEntry.create({
        data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'stale_decision', role, reason: staleReason, expectedVersion, actual: row.version, promptHash, usageSeq } },
      })
      // The watermark moves with the row (final review, Critical #1). A stale decision is NOT a
      // terminal state -- the run is still running, still (possibly) armed, still haltable -- and
      // every other writer computes its own seq as `state.journalSeq + 1` (`stepLocked`,
      // `setStatus`, `startAutoRun`). Leaving `journalSeq` behind the row just written meant the
      // next write of any kind collided on the journal's `(simulationId, seq)` unique and threw:
      // one stale decision and Halt stopped working. Only `journalSeq` changes; `version` must not
      // (nothing about the world moved) and neither may `status`.
      await tx.simulationRun.update({ where: { id: simulationId }, data: { state: json({ ...loaded.state, journalSeq: seq }) } })
      return ok({ applied: false, reason: 'stale' } as const)
    }

    // 3. The breach. The deny-all hook is meant to make a tool call impossible; a tool call that
    //    happened anyway means the isolation this whole design rests on did not hold, so the run
    //    halts rather than absorbing one more day of it.
    if (outcome.kind === 'isolation_breach') {
      const reason = `isolation breach: ${outcome.tools.join(', ')}`
      const seq = await nextSeq()
      await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'isolation_breach', role, tools: [...outcome.tools], usageSeq } } })
      // Ruling R12: then the halt itself, exactly as every other halt path writes it (`setStatus`
      // for the operator's verb, `haltUnparsed` for the daemon's error path). The breach row names
      // WHAT was found; a reader scanning the journal for "when did this run stop, and why" must
      // find the same `control { op: 'halted', reason }` row here as anywhere else -- an automatic
      // halt that only journalled its cause was invisible to that reading.
      await tx.simulationJournalEntry.create({ data: { simulationId, seq: seq + 1, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'halted', reason } } })
      const seqAfter = await clearAutoRun(tx, row, { ...loaded, state: { ...loaded.state, journalSeq: seq + 1 } }, 'halted', seq + 2)
      await tx.simulationRun.update({
        where: { id: simulationId },
        data: { status: 'halted', haltedReason: reason, autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seqAfter, status: 'halted', haltedReason: reason }) },
      })
      return ok({ applied: false, reason: 'breach' } as const)
    }

    // 4. The answer, parsed outside the engine (`parseEnvelopes` is pure and validates every
    //    element as an `ActionEnvelope`). A failed call is the same shape with nothing to parse.
    let envelopes: readonly ActionEnvelope[] = []
    let parseError: string | null = null
    if (outcome.kind === 'failed') {
      parseError = outcome.reason
    } else {
      const parsed = parseEnvelopes(outcome.text, loaded.definition.limits.maxDecisionsPerStep)
      if ('parseError' in parsed) parseError = parsed.parseError
      else envelopes = parsed.envelopes
    }

    await stepLocked(tx, row, loaded, {
      untilDay: row.simTime + 1,
      lastAutoStepAt: now,
      provider: new CompositeDecisionProvider({
        llmRoles: loaded.definition.llmRoles,
        llm: new LlmDecisionProvider(new Map([[role, envelopes]])),
        rules: loaded.plugin.rulesProvider(loaded.definition),
      }),
      // What the engine cannot know about its own decision point: which model answered, which
      // usage row paid for it, and whether that answer parsed. `parseError: null` is written
      // explicitly so every model-decided row carries the same shape.
      decisionExtras: { [role]: { model: row.model, usageSeq, promptHash, parseError } },
    })
    return ok(outcome.kind === 'failed' ? ({ applied: true, reason: 'failed' } as const) : ({ applied: true } as const))
  }, { timeout: 60_000, maxWait: 10_000 })
}
