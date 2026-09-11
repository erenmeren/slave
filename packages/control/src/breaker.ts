import { prisma } from '@slave-of-ai/db/client'
import { CONSTRAIN_GRACE_CALLS, type Result, err, ok } from '@slave-of-ai/domain'
import { requestPause } from './pause.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'
import { requestResume } from './resume.js'

/**
 * The CONTROL half of the behavioural circuit breaker (M51 R3).
 *
 * Three actors, three packages, and this file is one of them: the Supervisor decides to STEER (a
 * `steer_run` decision, carried out through {@link steerRun}), the system CONSTRAINS
 * ({@link constrainRun}, called by the sweep), and the orchestrator STOPS (the sweep's own
 * claim/cancel shape). Nothing here decides anything -- `detectBehaviour` did that, purely, in
 * `packages/domain`.
 *
 * ## Why a steer is TWO phases (plan erratum E8)
 *
 * `requestPause` claims `pause_requested`, not `paused`: the pause is a cross-process SIGNAL, and
 * the run only reaches `paused` when the gate denies its next tool call and the PUMP observes that
 * deny (`./pause.ts`'s own docstring). `requestResume` refuses anything but `paused`. So a steer
 * cannot be one call:
 *
 *   - {@link steerRun} claims the pause AND queues the sentence, in one conditioned statement.
 *   - {@link deliverBreakerSteer} asks for the resume, on whichever later tick finds the run
 *     actually parked. `apps/orchestrator/src/sweep.ts` calls it once per tick over the runs that
 *     qualify; the tick's existing resume-intent pass then claims `paused -> resuming` and hands
 *     the message to the child, exactly as it does for an operator's own resume.
 *
 * The queued message is the marker, and no column was added for it (D14): a run at a breaker level
 * above `none`, `paused`, with `pauseReason: 'guardrail'` and a `queuedMessage` still sitting on it,
 * is a steer waiting to be delivered and can be nothing else. Nothing else in this tree pauses with
 * a message queued -- `apps/orchestrator/src/tick.ts`'s budget fan-out is the only other
 * `'guardrail'` pause and it queues nothing -- and `claimResume` clears the column, so the marker
 * clears itself.
 *
 * ## Refusals, and where they sit relative to the writes
 *
 * Every refusal in this file is returned BEFORE anything is written, so none of them has to throw
 * (the M50 rule: a refusal after a write inside a transaction COMMITS it). A lost claim -- the run
 * moved under the verb between the read and the write -- is a refusal too, never an exception:
 * both callers are inside a tick, and a race this pass loses is an ordinary outcome.
 */

/** The `requestedBy` every breaker-driven pause and resume is recorded under. One string, in one
 *  place: the pause event and the resume event are two halves of one round trip, and a reader
 *  months later matches them by this name. */
const BREAKER_ACTOR = 'circuit breaker'

/**
 * Phase A of a steer: claim the pause and queue the sentence (M51 R3).
 *
 * Called by `carryOut`'s `steer_run` arm, which runs inside a TICK -- which is why a run that moved
 * under this verb comes back as a refusal a person can read on the decision row rather than as a
 * crashed pass.
 *
 * `text` is passed in verbatim and never re-derived: `candidates.ts` built it from
 * `steerTextFor(trip)` and stored it on the decision, so a reader months later can see what was
 * actually said. Re-deriving it here would mean a row could claim one sentence and the worker
 * receive another.
 *
 * **`breakerSteers` is incremented HERE, at the claim, not at the delivery.** Task 2's hand-off
 * asked for the delivery instead, so that a pause which never reached `paused` would not count as
 * a sentence sent. It cannot: `observe`'s own predicate requires `status === 'working'`, so a run
 * wedged in `pause_requested` is already unreachable by a second steer, and counting at the claim
 * is what makes `STEERS_PER_RUN_MAX` a bound on what this run has been TOLD -- one increment per
 * sentence committed to it, whether or not the child lived long enough to read it. The counter is
 * also what closes `observe`'s `breakerSteers < breakerTrips` clause: without an increment here, a
 * steered run that resumes to `working` would be raised again on the same rung.
 */
export async function steerRun(
  runId: string,
  text: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: { id: true, status: true } })
  if (run === null) return err({ kind: 'run_not_found', runId })
  if (run.status !== 'working') return err({ kind: 'run_not_steerable', runId, status: run.status })

  // `'system'` as the pause's actor, for `deliverAnswers`' own reason: nobody pressed anything.
  const paused = await requestPause(run.id, BREAKER_ACTOR, 'guardrail', principal, 'system')
  if (!paused.ok) return paused

  // One conditioned statement, on the status the claim above just wrote: between `requestPause`
  // returning and this line the run can be stopped or concluded by another process, and queuing a
  // sentence onto a run that is over would leave a message nobody consumes and a steer the ladder
  // believes it sent.
  const queued = await prisma.slaveRun.updateMany({
    where: { id: run.id, status: 'pause_requested', endedAt: null },
    data: { queuedMessage: text, breakerSteers: { increment: 1 } },
  })
  if (queued.count === 0) return err({ kind: 'run_not_steerable', runId, status: run.status })
  return ok(undefined)
}

/**
 * Phase B of a steer: ask for the resume, once the pump has actually parked the run (E8).
 *
 * Called speculatively, once per tick, over every run of the workspace -- so `breaker_not_armed` is
 * an ORDINARY answer here and not a fault. The five clauses below are the whole marker (D14):
 * a level above `none` (the breaker touched this run), `paused` (the pump got there), a `guardrail`
 * pause reason (not a person's), a `queuedMessage` still sitting on it (nothing has consumed the
 * sentence yet) and no resume already asked for (idempotence).
 */
export async function deliverBreakerSteer(runId: string): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, pauseReason: true, queuedMessage: true, resumeRequestedAt: true, breakerLevel: true },
  })
  if (run === null) return err({ kind: 'run_not_found', runId })
  if (
    run.breakerLevel === 'none' ||
    run.status !== 'paused' ||
    run.pauseReason !== 'guardrail' ||
    run.queuedMessage === null ||
    run.resumeRequestedAt !== null
  ) {
    return err({ kind: 'breaker_not_armed', runId })
  }

  // `null` as the message, deliberately: `requestResume` documents that a resume asked for with no
  // message must not erase what is already queued (`./resume.ts`), and phase A queued exactly the
  // sentence that must be delivered. `'system'` as the actor, for `deliverAnswers`' own reason --
  // recording this as a human intervention would put it in the web's "interventions" filter under
  // a person who was never there.
  return requestResume(run.id, null, BREAKER_ACTOR, undefined, 'system')
}

/**
 * The CONSTRAIN rung: leave the run `grace` more tool calls than it has made, and nothing else
 * (M51 R3).
 *
 * ## One statement, and why it is raw
 *
 * The cap is RELATIVE, so reading `toolCalls` in one query and writing `toolCalls + 30` in another
 * would refund whatever the run spent in between -- and the run being constrained is, by
 * definition, the one making calls fastest. The `FOR UPDATE` subselect reads the count under the
 * row's own lock and Postgres computes the sum, so a call that lands mid-verb is not refunded.
 *
 * `AND r."toolCallCap" IS NULL` is the no-second-refund clause (D16): a run already constrained
 * keeps the cap it was given, so a de-escalation followed by a re-escalation cannot hand a wedged
 * run thirty more calls every minute.
 *
 * ## The cap STANDS when the level steps back down
 *
 * Nothing here or anywhere else clears `toolCallCap`. A constrained run that has one healthy beat
 * returns to `steered` and then `none` while the ceiling it was given remains -- deliberately: the
 * word describes what the run is doing NOW, and the cap is a budget already spent down. Clearing it
 * on the way down would make D16's clause unreachable and turn the grace into a refill; the run
 * would be handed thirty more calls for every minute it could fake one healthy beat in.
 *
 * ## `text`, and why it is the caller's
 *
 * Spec R3: a constrained worker that was never told why would simply hit the ceiling in silence. So
 * the caller may pass the sentence, and the steer round trip runs FIRST -- the cap is written
 * whether or not it succeeds, because a run that cannot be steered (it concluded, a person paused
 * it) must still not be handed an unbounded budget. It is a parameter rather than derived here for
 * {@link steerRun}'s reason: the words belong to whoever counted the trip.
 */
export async function constrainRun(
  runId: string,
  grace = CONSTRAIN_GRACE_CALLS,
  text: string | null = null,
): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: { id: true, status: true } })
  if (run === null) return err({ kind: 'run_not_found', runId })
  if (run.status !== 'working') return err({ kind: 'run_not_steerable', runId, status: run.status })

  // The sentence first, its refusal swallowed: `steerRun` refuses a run that moved under it, and
  // this rung's job -- taking the budget away -- must happen either way.
  if (text !== null) await steerRun(run.id, text)

  await prisma.$executeRaw`
    UPDATE "SlaveRun" AS r
    SET "toolCallCap" = prev."toolCalls" + ${grace}, "breakerLevel" = 'constrained'::"BreakerLevel"
    FROM (SELECT id, "toolCalls" FROM "SlaveRun" WHERE id = ${run.id} FOR UPDATE) AS prev
    WHERE r.id = prev.id AND r."endedAt" IS NULL AND r."toolCallCap" IS NULL`
  return ok(undefined)
}
