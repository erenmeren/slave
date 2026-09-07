import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import { refusalText } from '../refusal.js'
import { clearAutoRun, json, locked } from './shared.js'
import { stepLocked } from './write.js'
// `llm.ts` imports `haltUnparsed` back out of this module: the cycle is function-level only (both
// sides call, neither reads the other at module-evaluation time), which ESM and every bundler this
// repo uses resolve through hoisted function declarations.
import { PER_CALL_CAP_USD, applyModelDecision, prepareModelDecision, type ModelDecider } from './llm.js'

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
    await tx.simulationRun.update({ where: { id: simulationId }, data: { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
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
      await tx.simulationRun.update({ where: { id: simulationId }, data: { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null, state: json({ ...loaded.state, journalSeq: seq }) } })
      return ok({ stepped: false, reason: 'until_day' } as const)
    }
    const outcome = await stepLocked(tx, row, loaded, { untilDay: row.simTime + 1, lastAutoStepAt: now })
    return ok({ stepped: true, day: outcome.day } as const)
  }, { timeout: 60_000, maxWait: 10_000 })
}

/** Halts a run whose state cannot be parsed (spec M30 §5): `haltSimulation` goes through
 *  `locked()` → `parseRow`, which would refuse `simulation_corrupt` again on a corrupt state, so
 *  `tickSimulations`'s halt path writes the row and its journal directly instead of replaying the
 *  normal `setStatus` path. The stored `state` JSON is left untouched -- it is the evidence of
 *  what went wrong, not something this can safely rewrite without parsing it. Journals an
 *  `auto_run_stopped { reason: 'error' }` row first when the run held an intent, so the journal
 *  reads the whole story: the intent was cleared, then the run was halted. Takes the row lock
 *  first (fix wave, Minor #2): every other journal writer in this file goes through `locked()`,
 *  which does the same `FOR UPDATE` before its own read -- this was the one writer that read the
 *  row unlocked, open to a concurrent writer's read-modify-write racing in between.
 *
 *  Exported since M31a Task 4: the model path halts through this same writer too -- an exhausted
 *  budget, a refusal from `prepareModelDecision`, a throw around the model call. */
export async function haltUnparsed(simulationId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SimulationRun" WHERE id = ${simulationId} FOR UPDATE`
    const row = await tx.simulationRun.findUnique({ where: { id: simulationId }, select: { simTime: true, autoRunEveryMs: true } })
    if (row === null) return
    const last = await tx.simulationJournalEntry.findFirst({ where: { simulationId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    let seq = (last?.seq ?? -1) + 1
    if (row.autoRunEveryMs !== null) {
      await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'auto_run_stopped', reason: 'error' } } })
      seq += 1
    }
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op: 'halted', reason } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { status: 'halted', haltedReason: reason, autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null } })
  })
}

/** What one pass did. `skippedNoDecider` counts the `llm` runs this pass left untouched because
 *  no model decider was injected -- the one-shot CLI `tick` is exactly that caller, and an
 *  operator who armed an llm auto-run and then ran `tick` needs to be told why nothing happened
 *  rather than left to conclude the run is stuck. */
export interface TickSimulationsReport {
  readonly candidates: number
  readonly stepped: number
  readonly halted: number
  readonly skippedNoDecider: number
}

/** One global pass (spec §5): every running run with an intent, in creation order, capped. A
 *  step that throws or refuses (anything but not-found) halts that run with the message and the
 *  pass moves on — an auto-run never retries forever.
 *
 *  M31a §4: an `llm` run does not go through `autoStepDue`, because its step needs a model call
 *  that takes seconds to minutes and must not happen with a transaction open. It goes through the
 *  two-phase path instead -- `prepareModelDecision` (unlocked) → `modelDecider` (NO transaction) →
 *  `applyModelDecision` (locked). With no decider injected, an llm run is skipped and counted; the
 *  rules runs in the same pass are unaffected either way. */
export async function tickSimulations(input: { readonly now: Date; readonly modelDecider?: ModelDecider }): Promise<TickSimulationsReport> {
  const rows = await prisma.simulationRun.findMany({ where: { autoRunEveryMs: { not: null }, status: 'running' }, select: { id: true, decisionProvider: true }, orderBy: { createdAt: 'asc' }, take: TICK_SIMULATIONS_CAP })
  let stepped = 0
  let halted = 0
  let skippedNoDecider = 0
  for (const { id, decisionProvider } of rows) {
    try {
      if (decisionProvider === 'llm') {
        const decider = input.modelDecider
        if (decider === undefined) {
          skippedNoDecider += 1
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
        const { model, prompt, remainingUsd, version, role, promptHash } = prepared.value
        // The model call itself: no lock held, no transaction open, capped at the smaller of what
        // the run has left and the per-call ceiling.
        const outcome = await decider({ model, prompt, maxBudgetUsd: Math.min(remainingUsd, PER_CALL_CAP_USD) })
        const applied = await applyModelDecision(id, { expectedVersion: version, role, outcome, promptHash, now: input.now })
        if (!applied.ok) {
          if (applied.error.kind === 'simulation_not_found') continue
          await haltUnparsed(id, `auto-run step failed: ${refusalText(applied.error)}`)
          halted += 1
          continue
        }
        if (applied.value.applied) stepped += 1
        else if (applied.value.reason === 'breach') halted += 1
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
  return { candidates: rows.length, stepped, halted, skippedNoDecider }
}
