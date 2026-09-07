import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import { refusalText } from '../refusal.js'
import { clearAutoRun, json, locked } from './shared.js'
import { haltUnparsed, stepLocked } from './write.js'
import { PER_CALL_CAP_USD, applyModelDecision, prepareModelDecision, type ModelDecider } from './llm.js'

/** Re-exported from `write.js`, where it lives so that `llm.ts` (which halts through it too) can
 *  reach it without an import cycle back through this module (fix round 1, ruling R6). It was
 *  first written here and is still this file's own halt path, so the name stays on this module's
 *  surface as well. */
export { haltUnparsed }

export const AUTO_RUN_MIN_MS = 250
export const AUTO_RUN_MAX_MS = 3_600_000
/** One daemon pass steps at most this many runs; the rest wait for the next tick. */
export const TICK_SIMULATIONS_CAP = 50

export async function startAutoRun(simulationId: string, input: { readonly everyMs: number; readonly untilDay: number }, _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  if (!Number.isInteger(input.everyMs) || input.everyMs < AUTO_RUN_MIN_MS || input.everyMs > AUTO_RUN_MAX_MS) return err({ kind: 'invalid_simulation_input', detail: `everyMs must be an integer between ${AUTO_RUN_MIN_MS} and ${AUTO_RUN_MAX_MS}` })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.status !== 'ready' && row.status !== 'running') return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    if (!Number.isInteger(input.untilDay) || input.untilDay <= row.simTime || input.untilDay > loaded.definition.horizonDays) return err({ kind: 'invalid_simulation_input', detail: `untilDay must be an integer greater than the current day (${row.simTime}) and at most the horizon (${loaded.definition.horizonDays})` })
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'auto_run_started', everyMs: input.everyMs, untilDay: input.untilDay } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { status: 'running', autoRunEveryMs: input.everyMs, autoRunUntilDay: input.untilDay, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq, status: 'running' }) } })
    return ok(undefined)
  })
}

export async function stopAutoRun(simulationId: string, reason: 'operator' = 'operator', _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.autoRunEveryMs === null) return ok(undefined)
    const seq = await clearAutoRun(tx, row, loaded, reason, loaded.state.journalSeq + 1)
    // M32 item 1: `version` moves with the clear, exactly as ruling R11 made it move for the
    // `until_day` clear. The operator's stop touches neither `status` (a stopped run stays
    // `running`; it simply stops advancing) nor `simTime`, so `version` is the only field the run
    // page's SSE stream -- keyed on the `version|status|simTime` composite -- can see this by.
    // Without the bump the page went on offering "Stop auto-run" for an intent that no longer
    // existed until somebody reloaded by hand. The early return above keeps a second stop free:
    // with no intent to clear, nothing is written and the version does not move.
    await tx.simulationRun.update({ where: { id: simulationId }, data: { version: row.version + 1, autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
    return ok(undefined)
  })
}

export type AutoStepOutcome = { readonly stepped: true; readonly day: number } | { readonly stepped: false; readonly reason: 'no_intent' | 'not_running' | 'not_due' | 'until_day' }

/** The daemon's verb (spec §2.2): "due" is decided under the row lock from the row's own
 *  watermark, so a second daemon or a click racing this pass finds either the new watermark or
 *  the lock — never a second step for the same tick. */
export async function autoStepDue(simulationId: string, now: Date): Promise<Result<AutoStepOutcome, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.autoRunEveryMs === null || row.autoRunUntilDay === null) return ok({ stepped: false, reason: 'no_intent' } as const)
    if (row.status !== 'running') return ok({ stepped: false, reason: 'not_running' } as const)
    if (row.lastAutoStepAt !== null && row.lastAutoStepAt.getTime() + row.autoRunEveryMs > now.getTime()) return ok({ stepped: false, reason: 'not_due' } as const)
    if (row.simTime >= row.autoRunUntilDay) {
      const seq = await clearAutoRun(tx, row, loaded, 'until_day', loaded.state.journalSeq + 1)
      // M31a ruling R11: `version` moves with the clear. Neither `status` nor `simTime` changes
      // here, so `version` is the only field the run page's SSE stream can see this by -- without
      // the bump the page kept offering "Stop auto-run" for an intent that no longer existed.
      await tx.simulationRun.update({ where: { id: simulationId }, data: { version: row.version + 1, autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
      return ok({ stepped: false, reason: 'until_day' } as const)
    }
    const outcome = await stepLocked(tx, row, loaded, { untilDay: row.simTime + 1, lastAutoStepAt: now })
    return ok({ stepped: true, day: outcome.day } as const)
  }, { timeout: 60_000, maxWait: 10_000 })
}

/** How many model calls this process keeps in flight at once when the caller names no cap. The
 *  daemon reads `SLAVEOFAI_MAX_MODEL_CALLS` and passes it in; anything that forgets to gets this. */
export const DEFAULT_MAX_MODEL_CALLS = 3

/**
 * The model calls this PROCESS has started and not yet applied, keyed by run id (M32 item 2).
 *
 * Module-level, and deliberately so: it is the daemon process's own set, it must survive from one
 * `tickSimulations` pass to the next (that is the whole point -- a pass that started a call is not
 * the pass that finishes it), and there is exactly one daemon loop per process. Two daemons on the
 * same database each keep their own set and cannot see each other's; that is not a hole, because
 * `applyModelDecision` re-checks `version` under the row lock and discards a decision the world has
 * moved past -- the set saves money, the lock keeps correctness.
 *
 * The stored promise NEVER rejects: `startModelCall` catches everything inside it, so nothing here
 * can become an unhandled rejection, and `drainModelCalls` can await the values safely.
 */
const inFlight = new Map<string, Promise<void>>()

/** The run ids whose model call this process started and has not yet applied. A copy: callers
 *  (tests, and anything that reports) must not be able to edit the set the pass decides from. */
export function inFlightModelCalls(): ReadonlySet<string> {
  return new Set(inFlight.keys())
}

/** Waits for every detached model call to finish applying. The daemon awaits this on shutdown --
 *  an apply is a database write, and disconnecting Prisma out from under one would lose the usage
 *  row for a call the account has already been billed for (spec §2.6). Tests await it to observe
 *  what a call did. Loops rather than awaiting one snapshot: an apply can, in principle, be slower
 *  than the pass that started another. */
export async function drainModelCalls(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight.values()])
}

/** What one pass did.
 *
 *  `stepped` and `halted` count only what the pass itself finished: the rules runs it stepped, and
 *  the halts it decided synchronously (a corrupt state, a refusal, an exhausted budget). An llm
 *  run's own step is NOT here -- the pass does not wait for it (see {@link tickSimulations}); what
 *  the pass did for one is `startedModelCalls`, and the outcome lands in the run's journal.
 *
 *  `skippedNoDecider` counts the `llm` runs this pass left untouched because no model decider was
 *  injected -- the one-shot CLI `tick` is exactly that caller, and an operator who armed an llm
 *  auto-run and then ran `tick` needs to be told why nothing happened rather than left to conclude
 *  the run is stuck.
 *
 *  `skippedInFlight` counts the `llm` runs this pass left for a later one because a model call was
 *  already out: the run was in flight, or the cap was full when the run was reached, DUE OR NOT.
 *  Not-due-or-not is genuinely unknown here -- the check happens before `prepareModelDecision`, so
 *  the pass never reads the run at all -- and that is the honest reading of the number: "left
 *  alone because this process is already carrying calls", not "would have stepped but could not".
 *  It is therefore non-zero on every pass for the whole life of a call, which is why the daemon
 *  does not log on it alone. */
export interface TickSimulationsReport {
  readonly candidates: number
  readonly stepped: number
  readonly halted: number
  readonly skippedNoDecider: number
  readonly skippedInFlight: number
  readonly startedModelCalls: number
}

/** What `prepareModelDecision` handed back for a run that has a day to decide. */
type PreparedDecision = { readonly version: number; readonly role: string; readonly prompt: string; readonly promptHash: string; readonly model: string; readonly remainingUsd: number }

/**
 * Starts one model call and returns IMMEDIATELY (M32 item 2). Everything after the call -- the
 * apply, a halt for a refusal or a throw, and removing the run from the in-flight set -- happens
 * when the promise settles, on nobody's stack.
 *
 * Nothing thrown in here escapes: the whole body is caught, the halt path is caught again (a halt
 * that itself fails must not become an unhandled rejection), and the promise stored in `inFlight`
 * is therefore always a resolving one. That is what lets `tickSimulations` fire and forget without
 * ever leaving a rejected promise behind.
 */
function startModelCall(simulationId: string, decider: ModelDecider, prepared: PreparedDecision, now: Date): void {
  const { version, role, prompt, promptHash, model, remainingUsd } = prepared
  const settled = (async (): Promise<void> => {
    try {
      // The model call itself: no lock held, no transaction open, capped at the smaller of what
      // the run has left and the per-call ceiling.
      const outcome = await decider({ model, prompt, maxBudgetUsd: Math.min(remainingUsd, PER_CALL_CAP_USD) })
      const applied = await applyModelDecision(simulationId, { expectedVersion: version, role, outcome, promptHash, now })
      // `simulation_not_found` is a run deleted while its call was out: there is nothing left to
      // halt, and halting it would only fail again.
      if (!applied.ok && applied.error.kind !== 'simulation_not_found') {
        await haltUnparsed(simulationId, `auto-run step failed: ${refusalText(applied.error)}`)
      }
    } catch (error) {
      // A decider that rejects (the CLI died, the spawn failed) or an apply that throws: the run
      // halts with the message, exactly as a thrown rules step does. An auto-run never retries
      // forever.
      await haltUnparsed(simulationId, `auto-run step failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined)
    }
  })()
  inFlight.set(simulationId, settled.finally((): void => { inFlight.delete(simulationId) }))
}

/** One global pass (spec §5): every running run with an intent, in creation order, capped. A
 *  step that throws or refuses (anything but not-found) halts that run with the message and the
 *  pass moves on — an auto-run never retries forever.
 *
 *  M31a §4: an `llm` run does not go through `autoStepDue`, because its step needs a model call
 *  that takes seconds to minutes and must not happen with a transaction open. It goes through the
 *  two-phase path instead -- `prepareModelDecision` (unlocked) → `modelDecider` (NO transaction) →
 *  `applyModelDecision` (locked). With no decider injected, an llm run is skipped and counted; the
 *  rules runs in the same pass are unaffected either way.
 *
 *  M32 item 2 -- the model step is OFF this loop. The pass prepares each due llm run, STARTS its
 *  `modelDecider(...)` without awaiting it, records the run id in {@link inFlightModelCalls} and
 *  moves on; the apply happens when that promise settles ({@link startModelCall}). So:
 *
 *  - every due llm run starts in the same pass, up to `maxConcurrentModelCalls`. M31a's ruling R7
 *    allowed exactly one call per pass because the pass AWAITED it, and the daemon awaits the
 *    pass: fifty due runs meant fifty timeouts end to end, and one slow run blocked every fast one.
 *    Nothing is awaited now, so the rule that existed to bound the loop is not needed and R7 is
 *    superseded.
 *  - a run whose call is still out is skipped by later passes (`skippedInFlight`), which is what
 *    keeps this from paying twice for the same day: nothing about the ROW says a decision is in
 *    flight, so the set is the only record of it.
 *  - the cap bounds concurrent SPEND and concurrent child processes, not the loop. Filling it is
 *    also a skip: those runs wait exactly like a run that is not due yet.
 *  - `stepped`/`halted` count only what this pass finished itself (see {@link
 *    TickSimulationsReport}); an llm run's own outcome lands in its journal, not in this report.
 *
 *  Everything the pass still awaits is short and database-only: `autoStepDue` for a rules run and
 *  `prepareModelDecision` for an llm one. */
export async function tickSimulations(input: { readonly now: Date; readonly modelDecider?: ModelDecider; readonly maxConcurrentModelCalls?: number }): Promise<TickSimulationsReport> {
  const rows = await prisma.simulationRun.findMany({ where: { autoRunEveryMs: { not: null }, status: 'running' }, select: { id: true, decisionProvider: true }, orderBy: { createdAt: 'asc' }, take: TICK_SIMULATIONS_CAP })
  const maxConcurrent = input.maxConcurrentModelCalls ?? DEFAULT_MAX_MODEL_CALLS
  let stepped = 0
  let halted = 0
  let skippedNoDecider = 0
  let skippedInFlight = 0
  let startedModelCalls = 0
  for (const { id, decisionProvider } of rows) {
    try {
      if (decisionProvider === 'llm') {
        const decider = input.modelDecider
        if (decider === undefined) {
          skippedNoDecider += 1
          continue
        }
        // This run is already mid-decision, or the process is already carrying as many calls as it
        // is allowed to. Either way the run waits, untouched and unbilled -- and it is checked
        // BEFORE `prepareModelDecision`, so a pass that cannot act on a run does not even read it.
        if (inFlight.has(id) || inFlight.size >= maxConcurrent) {
          skippedInFlight += 1
          continue
        }
        const prepared = await prepareModelDecision(id, input.now)
        if (!prepared.ok) {
          if (prepared.error.kind === 'simulation_not_found') continue
          await haltUnparsed(id, `auto-run step failed: ${refusalText(prepared.error)}`)
          halted += 1
          continue
        }
        // An exhausted budget has already halted the run inside `prepareModelDecision`; a skip is
        // simply a run with nothing due. Neither spends anything.
        if (prepared.value.kind === 'budget') {
          halted += 1
          continue
        }
        if (prepared.value.kind === 'skip') continue
        // Started, not awaited: this returns as soon as the child is on its way.
        startModelCall(id, decider, prepared.value, input.now)
        startedModelCalls += 1
        continue
      }
      const result = await autoStepDue(id, input.now)
      if (result.ok) {
        if (result.value.stepped) stepped += 1
        continue
      }
      if (result.error.kind === 'simulation_not_found') continue
      await haltUnparsed(id, `auto-run step failed: ${refusalText(result.error)}`)
      halted += 1
    } catch (error) {
      await haltUnparsed(id, `auto-run step failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined)
      halted += 1
    }
  }
  return { candidates: rows.length, stepped, halted, skippedNoDecider, skippedInFlight, startedModelCalls }
}
