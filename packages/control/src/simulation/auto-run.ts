import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import { refusalText } from '../refusal.js'
import { clearAutoRun, json, locked } from './shared.js'
import { stepLocked } from './write.js'

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

export async function stopAutoRun(simulationId: string, reason: 'operator' | 'until_day' = 'operator', _principal?: Principal): Promise<Result<void, ControlRefusal>> {
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
 *  reads the whole story: the intent was cleared, then the run was halted. */
async function haltUnparsed(simulationId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
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

/** One global pass (spec §5): every running run with an intent, in creation order, capped. A
 *  step that throws or refuses (anything but not-found) halts that run with the message and the
 *  pass moves on — an auto-run never retries forever. */
export async function tickSimulations(input: { readonly now: Date }): Promise<{ readonly candidates: number; readonly stepped: number; readonly halted: number }> {
  const rows = await prisma.simulationRun.findMany({ where: { autoRunEveryMs: { not: null }, status: 'running' }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: TICK_SIMULATIONS_CAP })
  let stepped = 0
  let halted = 0
  for (const { id } of rows) {
    try {
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
  return { candidates: rows.length, stepped, halted }
}
