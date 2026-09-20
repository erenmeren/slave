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
 *
 * WHAT A PASS COSTS (final review, I2). Two things keep a once-a-second question cheap. First,
 * `countStaleTemplateMappings()` has its own lean read: the persona, the hash, and none of the
 * per-row `normaliseCapabilities` work a real pass needs. Second, the QUIET WINDOW below: a
 * catalogue that is fully mapped answers "nothing stale" forever, and asking the database again
 * every second for {@link CAPABILITY_MAP_QUIET_MS} tells nobody anything new.
 */

/**
 * How long a pass that found NOTHING stale may skip counting again.
 *
 * A time window rather than a memo of what changed, because `SlaveTemplate` carries no `updatedAt`
 * column to compare against: there is nothing cheap to ask that would say "something moved". The
 * whole cost of being wrong is latency -- an import or an activation that lands one second into
 * the window waits out the rest of it before its first batch is mapped -- and a minute is far
 * below the time a fresh catalogue takes to map anyway (one batch per pass).
 */
export const CAPABILITY_MAP_QUIET_MS = 60_000

/** When this process may next count. Zero means "on the next pass". Module-level for `inFlight`'s
 *  own reason: the pass that learns there is nothing to do is not the pass that acts on it. */
let quietUntil = 0

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

/** Forgets the quiet window and waits for any call still out, so one test's "nothing is stale"
 *  cannot silence the next test's stale row for a minute. Module state is process-wide and every
 *  test in a file shares it; this is the `beforeEach` hook that makes each one start from the same
 *  place. */
export async function resetCapabilityMappingTickForTests(): Promise<void> {
  quietUntil = 0
  await drainCapabilityMappingCalls()
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
      // THE ONE PLACE this package writes to a stream, and the reason is the detachment. The rule
      // (`./catalog.ts`, `onProgress`) is that control decides and writes while the caller prints,
      // and every other pass obeys it by RETURNING its numbers -- the daemon prints the
      // `{ capabilityMapping }` line off what `tickCapabilityMapping` returned. This call settles
      // long after that pass returned, so there is no caller left to hand the numbers to: the line
      // is written here or it is written nowhere. `process.stdout.write` and not `console.log`
      // (final review, M1) so the stream is named rather than inherited, one line, one newline.
      process.stdout.write(
        `${JSON.stringify({
          capabilityMappingPass: {
            calls: report.calls,
            mapped: report.mapped,
            failedBatches: report.failedBatches,
            absent: report.absent,
            droppedKeys: report.droppedKeys,
            costUsd: report.costUsd,
            unmeasuredCalls: report.unmeasuredCalls,
          },
        })}\n`,
      )
    } catch (error) {
      process.stderr.write(`[capabilityMapping] ${error instanceof Error ? error.message : String(error)}\n`)
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
  // The quiet window, before anything is read (final review, I2): the last count found nothing
  // stale and less than {@link CAPABILITY_MAP_QUIET_MS} has passed, so this pass asks the database
  // nothing at all. `stale: 0` is what the count it is standing in for said; a row imported or
  // activated inside the window is mapped when the window closes, not sooner.
  if (Date.now() < quietUntil) {
    return { skippedNoDecider: input.modelDecider === undefined, skippedInFlight: false, started: false, stale: 0 }
  }
  if (input.modelDecider === undefined) {
    const { stale } = await countStaleTemplateMappings()
    if (stale === 0) quietUntil = Date.now() + CAPABILITY_MAP_QUIET_MS
    return { skippedNoDecider: true, skippedInFlight: false, started: false, stale }
  }
  if (inFlight !== null) {
    // No window is opened here however this count comes out: a call is out, and the pass that
    // sees it settle must count for real -- that is the pass which learns whether the batch it
    // just paid for left anything behind.
    const { stale } = await countStaleTemplateMappings()
    return { skippedNoDecider: false, skippedInFlight: true, started: false, stale }
  }
  const { stale } = await countStaleTemplateMappings()
  if (stale === 0) {
    quietUntil = Date.now() + CAPABILITY_MAP_QUIET_MS
    return { skippedNoDecider: false, skippedInFlight: false, started: false, stale: 0 }
  }
  startCapabilityMappingCall(input.modelDecider, input.model)
  return { skippedNoDecider: false, skippedInFlight: false, started: true, stale }
}
