import { countStaleTemplateMappings, mapTemplateCapabilities } from './capabilityMapping.js'
import type { ModelDecider } from './simulation/llm.js'

/**
 * Catalogue capability mapping (2026-09-20), R7: the daemon's slice of the mapping pass -- ONE
 * batch per global pass, stale rows only, so a freshly imported catalogue is mapped at the
 * daemon's own rhythm rather than in one burst, and a taxonomy change re-maps at the same pace.
 * Without a decider it reports and does nothing: a daemon built without one silently leaving
 * every persona unmapped is exactly the failure an operator cannot diagnose from outside
 * (the `tickIntakes` precedent).
 */
export interface TickCapabilityMappingReport {
  readonly skippedNoDecider: boolean
  readonly stale: number
  readonly calls: number
  readonly mapped: number
  readonly failedBatches: number
  readonly costUsd: number
}

export async function tickCapabilityMapping(input: {
  readonly model: string
  readonly modelDecider?: ModelDecider
}): Promise<TickCapabilityMappingReport> {
  if (input.modelDecider === undefined) {
    const { stale } = await countStaleTemplateMappings()
    return { skippedNoDecider: true, stale, calls: 0, mapped: 0, failedBatches: 0, costUsd: 0 }
  }
  const report = await mapTemplateCapabilities({
    decider: input.modelDecider,
    model: input.model,
    only: 'stale',
    dryRun: false,
    maxBatches: 1,
  })
  return {
    skippedNoDecider: false,
    stale: report.stale,
    calls: report.calls,
    mapped: report.mapped,
    failedBatches: report.failedBatches,
    costUsd: report.costUsd,
  }
}
