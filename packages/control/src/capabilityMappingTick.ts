import { countStaleTemplateMappings, mapTemplateCapabilities } from './capabilityMapping.js'
import type { ModelDecider } from './simulation/llm.js'

/**
 * Catalogue capability mapping (2026-09-20), R7: the daemon's slice of the mapping pass -- ONE
 * batch per global pass, stale rows only, so a freshly imported catalogue is mapped at the
 * daemon's own rhythm rather than in one burst, and a taxonomy change re-maps at the same pace.
 *
 * DETACHED (fix round 1), following the intake precedent exactly (M59 R14, `./intakeTick.ts`):
 * one batch is one model round-trip plus a transaction, and awaiting it inline in the daemon's
 * global pass would delay `tickSimulations` and `tickIntakes` behind somebody else's mapping call
 * on every pass that has a batch to map -- roughly 56 passes after a fresh import at the default
 * batch size. `started`/`skippedInFlight` are this tick's own shape of what `tickIntakes` reports
 * as `startedModelCalls`/`skippedInFlight`: this process tracks at most ONE mapping call at a time
 * (`maxBatches: 1` means there is only ever one batch to ask about, unlike the intake's
 * per-conversation map), so a single `inFlight` slot -- not a map -- suffices.
 *
 * Without a decider it reports and starts nothing: a daemon built without one silently leaving
 * every persona unmapped is exactly the failure an operator cannot diagnose from outside (the
 * `tickIntakes` precedent).
 */

/**
 * The one mapping call this process has started and not yet finished, or null when none is out.
 *
 * Module-level for `tickIntakes`' own reason (`./intakeTick.ts`): the pass that starts the call is
 * not the pass that finishes it, and this process's daemon must be able to find it again next tick
 * to avoid starting a second one while the first is still out.
 *
 * The stored promise NEVER rejects: the whole body of the detached call is caught.
 */
let inFlight: Promise<void> | null = null

/** Whether this process currently has a mapping call out. For tests. */
export function inFlightCapabilityMapping(): boolean {
  return inFlight !== null
}

/** Waits for the in-flight mapping call, if any, to finish recording (the `drainIntakeCalls`
 *  shape). The daemon awaits this on shutdown: the write is for a call the account has already
 *  been billed for, so disconnecting Prisma out from under it would lose exactly the record that
 *  must not be lost. */
export async function drainCapabilityMappingCalls(): Promise<void> {
  while (inFlight !== null) await inFlight
}

export interface TickCapabilityMappingReport {
  readonly skippedNoDecider: boolean
  readonly skippedInFlight: boolean
  readonly started: boolean
  readonly stale: number
}

/**
 * One batch's call, started and NOT awaited (the `startIntakeCall` shape, `./intakeTick.ts`).
 * Everything after the call -- the write, the pool sync it triggers -- happens when the promise
 * settles, long after this tick has returned.
 *
 * Nothing thrown in here escapes: a decider that rejects, a transaction that throws, is logged and
 * the batch is left exactly as `mapTemplateCapabilities` left it (its own `failedBatches`
 * accounting), so the next pass retries whatever this one could not finish.
 */
function startCapabilityMappingCall(decider: ModelDecider, model: string): void {
  const settled = (async (): Promise<void> => {
    try {
      const report = await mapTemplateCapabilities({ decider, model, only: 'stale', dryRun: false, maxBatches: 1 })
      // Mirrors how the intake records its call (`./intakeTick.ts`): the pass that started this
      // call returned long before it settled, so this is the only place its numbers still reach an
      // operator.
      console.log(
        JSON.stringify({
          capabilityMappingPass: {
            calls: report.calls,
            mapped: report.mapped,
            failedBatches: report.failedBatches,
            absent: report.absent,
            droppedKeys: report.droppedKeys,
            costUsd: report.costUsd,
            unmeasuredCalls: report.unmeasuredCalls,
          },
        }),
      )
    } catch (error) {
      console.warn(`[capabilityMapping] ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  inFlight = settled.finally((): void => {
    inFlight = null
  })
}

export async function tickCapabilityMapping(input: {
  readonly model: string
  readonly modelDecider?: ModelDecider
}): Promise<TickCapabilityMappingReport> {
  if (input.modelDecider === undefined) {
    const { stale } = await countStaleTemplateMappings()
    return { skippedNoDecider: true, skippedInFlight: false, started: false, stale }
  }
  if (inFlight !== null) {
    const { stale } = await countStaleTemplateMappings()
    return { skippedNoDecider: false, skippedInFlight: true, started: false, stale }
  }
  const { stale } = await countStaleTemplateMappings()
  if (stale === 0) {
    return { skippedNoDecider: false, skippedInFlight: false, started: false, stale: 0 }
  }
  startCapabilityMappingCall(input.modelDecider, input.model)
  return { skippedNoDecider: false, skippedInFlight: false, started: true, stale }
}
