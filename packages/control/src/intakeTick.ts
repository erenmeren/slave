import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_PER_CALL_CAP_USD, buildIntakePrompt, parseIntakeAnswer } from '@slave-of-ai/domain'
import { detachedCalls } from './detachedCalls.js'
import { claimIntakes, recordIntakeReply, type ClaimedIntake } from './intake.js'
import { refusalText } from './refusal.js'
import { DEFAULT_MAX_MODEL_CALLS } from './simulation/auto-run.js'
import type { ModelDecider } from './simulation/llm.js'

/**
 * The intake calls this PROCESS has started and not yet recorded, keyed by intake id.
 *
 * The set, the room arithmetic and the drain now come from {@link detachedCalls} (fix round 1,
 * I3): `tickSupervisorChat` needs the identical four things, and the block was copied verbatim
 * into it -- which is how a fix made here silently is not made there. The reasoning for why it is
 * this process's own set, and why two daemons keeping separate ones is not a hole, moved with it.
 *
 * The stored promise NEVER rejects: the whole body of {@link startIntakeCall} is caught.
 */
const calls = detachedCalls()

/** The intakes whose model call this process started and has not recorded. A copy. */
export function inFlightIntakeCalls(): ReadonlySet<string> {
  return calls.inFlight()
}

/** Waits for every detached intake call to finish recording. The daemon awaits this on shutdown:
 *  recording is a database write for a call the account has already been billed for, so
 *  disconnecting Prisma out from under one would lose exactly the row that must not be lost. */
export async function drainIntakeCalls(): Promise<void> {
  await calls.drain()
}

/** What one pass did. `due` counts the conversations waiting for a reply when the pass began --
 *  which is the number an operator needs when `skippedNoDecider` is non-zero. */
export interface TickIntakesReport {
  readonly due: number
  readonly startedModelCalls: number
  readonly skippedNoDecider: number
  readonly skippedInFlight: number
}

/**
 * One claimed conversation's call, started and NOT awaited (M59 R14, the shape M32 item 2 gave the
 * simulations). Everything after the call -- the parse, the record, removing the id from the
 * in-flight set -- happens when the promise settles.
 *
 * Nothing thrown in here escapes: a decider that rejects (the CLI died, the spawn failed) becomes
 * an unusable answer, which is recorded and charged like any other, because the money was spent
 * either way. A conversation is never left in `replying` by a throw -- and if the process dies
 * before this settles, `INTAKE_CLAIM_TTL_MS` is what frees the row.
 */
function startIntakeCall(intake: ClaimedIntake, decider: ModelDecider, model: string): void {
  const settled = (async (): Promise<void> => {
    try {
      const prompt = buildIntakePrompt({
        transcript: intake.transcript,
        facts: intake.facts,
        callsLeft: intake.callsLeft,
      })
      const outcome = await decider({ model, prompt, maxBudgetUsd: INTAKE_PER_CALL_CAP_USD })
      if (outcome.kind !== 'answer') {
        // A failed call and an isolation breach both leave the turn with no answer, but they are
        // NOT the same thing to the person waiting: a failed call never read the message, while a
        // breach came back from a model that did. They take the two outcomes accordingly, which is
        // what decides the sentence the conversation ends up carrying.
        const unreachable = outcome.kind === 'failed'
        const reason = unreachable ? outcome.reason : `isolation breach: ${outcome.tools.join(', ')}`
        // The reason must not simply vanish: this is the sink `IntakeReplyOutcome`'s docstrings
        // promise, the same convention `ask.ts`/`answer.ts` use for a decider's own failure reason.
        // Logged on BOTH paths, including the one that also writes the reason to the transcript --
        // an operator reading a daemon's output should not have to open a drawer to see why a
        // conversation stalled.
        process.stderr.write(`[intake] ${intake.id}: model answer unusable — ${reason}\n`)
        const recorded = await recordIntakeReply(
          intake.id,
          unreachable
            ? { kind: 'unreachable', reason, costUsd: outcome.costUsd }
            : { kind: 'unusable', reason, costUsd: outcome.costUsd },
        )
        if (!recorded.ok) process.stderr.write(`[intake] ${intake.id}: ${refusalText(recorded.error)}\n`)
        return
      }
      const parsed = parseIntakeAnswer(outcome.text, intake.facts)
      const recorded =
        parsed === null
          ? await recordIntakeReply(intake.id, { kind: 'unusable', reason: 'the answer could not be read', costUsd: outcome.costUsd })
          : await recordIntakeReply(intake.id, {
              kind: 'answer',
              answer: parsed.answer,
              downgraded: parsed.downgraded,
              costUsd: outcome.costUsd,
            })
      if (!recorded.ok) process.stderr.write(`[intake] ${intake.id}: ${refusalText(recorded.error)}\n`)
    } catch (error) {
      // `unreachable`, not `unusable`: a throw from the decider (a spawn that never started, a
      // rejected promise) is a call that came back with nothing, so the person is told the model
      // was not reached rather than asked to rewrite a message it never read.
      await recordIntakeReply(intake.id, {
        kind: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
        // A throw before the call returned is a call whose cost nobody measured, and the cap is
        // what an unmeasured call is charged at -- never zero.
        costUsd: null,
      }).catch(() => undefined)
    }
  })()
  calls.start(intake.id, settled)
}

/**
 * One global pass over every conversation waiting for a reply (M59 R14).
 *
 * WITHOUT A DECIDER IT CLAIMS NOTHING. `tickSimulations` reports `skippedNoDecider` and leaves the
 * row alone for the same reason, and here it matters more: a claim taken by a process that cannot
 * answer holds the conversation for `INTAKE_CLAIM_TTL_MS`, and a person watching a drawer would
 * see "Thinking" for five minutes because a daemon was started without a model.
 *
 * `by` is this process's own name (`<pid>@<host>`), written onto the claim so an operator looking
 * at a stuck row can tell which daemon holds it.
 */
export async function tickIntakes(input: {
  readonly now: Date
  readonly by: string
  readonly model: string
  readonly modelDecider?: ModelDecider
  readonly maxConcurrentModelCalls?: number
}): Promise<TickIntakesReport> {
  const due = await prisma.intake.count({ where: { status: 'awaiting_reply' } })
  const decider = input.modelDecider
  if (decider === undefined) return { due, startedModelCalls: 0, skippedNoDecider: due, skippedInFlight: 0 }

  const room = calls.room(input.maxConcurrentModelCalls ?? DEFAULT_MAX_MODEL_CALLS)
  if (room <= 0) return { due, startedModelCalls: 0, skippedNoDecider: 0, skippedInFlight: due }

  const claimed = await claimIntakes({ by: input.by, limit: room, now: input.now })
  let started = 0
  for (const intake of claimed) {
    // A row this process is already carrying: the claim can return one after a TTL reclaim races
    // its own in-flight call, and paying twice for one message is the thing the set exists to stop.
    if (calls.has(intake.id)) continue
    startIntakeCall(intake, decider, input.model)
    started += 1
  }
  return { due, startedModelCalls: started, skippedNoDecider: 0, skippedInFlight: Math.max(0, due - started) }
}
