import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_MAP_BATCH_SIZE,
  CAPABILITY_MAP_PER_CALL_CAP_USD,
  buildCapabilityMappingPrompt,
  capabilityMappingHash,
  mappableSentences,
  normaliseCapabilities,
  parseCapabilityMappingAnswer,
  profileSpecSchema,
  type CapabilityMappingPersona,
  type CapabilityRecord,
} from '@slave-of-ai/domain'
import { effectiveCapabilityKeys, listCapabilities, sameStringSet } from './capability.js'
import { syncPersonPool, type PersonPoolSyncReport } from './personPool.js'
import type { ModelDecider, ModelOutcome } from './simulation/llm.js'

/**
 * Catalogue capability mapping (2026-09-20), R6: the ONE verb that asks a model which taxonomy
 * keys a persona provides, in batches, and writes the answer beside the exact matcher's keys.
 *
 * Money discipline, in order: the hash (R4) decides whether a call is owed at all; ACTIVE
 * templates only (fix round 1) -- an inactive template can never be proposed by
 * `hire_from_catalog`, so paying to map it is waste; the batch bounds the prompt; the per-call cap
 * bounds the call; one transaction per batch bounds what a bad answer can touch. When a template
 * is later activated its hash is still whatever it was (possibly null), so it is simply stale (or
 * new) the next time this pass runs -- no separate "activated" bookkeeping is needed. A batch that
 * fails -- no JSON, an isolation breach, a spawn failure, a write that throws mid-transaction --
 * leaves its rows exactly as they were, so the next pass retries them, and never stops the
 * batches after it.
 */

export interface MapTemplateCapabilitiesInput {
  readonly decider: ModelDecider
  readonly model: string
  /** `stale` maps only rows whose hash disagrees with today's; `all` re-asks for every mappable row. */
  readonly only: 'stale' | 'all'
  /** Build, call, parse -- write nothing; `rows` says what would have been written. */
  readonly dryRun: boolean
  readonly batchSize?: number
  readonly maxBatches?: number
  readonly maxBudgetUsdPerCall?: number
}

export interface CapabilityMappingRow {
  readonly templateId: string
  readonly name: string
  readonly keys: readonly string[]
  readonly dropped: readonly string[]
}

export interface CapabilityMappingReport {
  readonly considered: number
  readonly stale: number
  readonly calls: number
  readonly mapped: number
  readonly unchanged: number
  readonly absent: number
  readonly failedBatches: number
  readonly droppedKeys: number
  readonly costUsd: number
  readonly unmeasuredCalls: number
  readonly rows: readonly CapabilityMappingRow[]
  readonly pool: PersonPoolSyncReport | null
}

interface Candidate {
  readonly persona: CapabilityMappingPersona
  readonly hash: string
  readonly storedHash: string | null
  readonly storedMapped: readonly string[]
  readonly exactKeys: readonly string[]
}

/** R4: every ACTIVE, structured template with at least one mappable sentence, with today's hash
 *  beside the stored one. Read once per pass, id ascending, so a batch boundary is deterministic. */
async function loadCandidates(taxonomy: readonly CapabilityRecord[]): Promise<readonly Candidate[]> {
  const rows = await prisma.slaveTemplate.findMany({
    where: { active: true, profileSpec: { not: Prisma.DbNull } },
    select: {
      id: true,
      name: true,
      role: true,
      profileSpec: true,
      capabilityKeys: true,
      mappedCapabilityKeys: true,
      capabilityMappingHash: true,
    },
    orderBy: { id: 'asc' },
  })
  const candidates: Candidate[] = []
  for (const row of rows) {
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    if (!spec.success) continue
    if (mappableSentences(spec.data.capabilities).length === 0) continue
    const persona: CapabilityMappingPersona = {
      id: row.id,
      name: row.name,
      runtimeRole: spec.data.runtimeRole || row.role,
      summary: spec.data.summary,
      identity: spec.data.identity,
      capabilities: spec.data.capabilities,
    }
    // The EXACT half is recomputed fresh against the LIVE taxonomy (`reconcileTemplateCapabilities`
    // does the same, in this package) rather than subtracted from the stored columns -- a key the
    // exact matcher finds AND the model also chose lives in BOTH `capabilityKeys` and
    // `mappedCapabilityKeys`; subtracting would zero it out the moment a later re-map dropped it
    // from the model's own answer, losing a key the persona still states by word (fix round 1,
    // Important 1).
    const exactKeys = normaliseCapabilities(spec.data.capabilities, taxonomy).keys
    candidates.push({
      persona,
      hash: capabilityMappingHash(persona, taxonomy),
      storedHash: row.capabilityMappingHash,
      storedMapped: row.mappedCapabilityKeys,
      exactKeys,
    })
  }
  return candidates
}

export async function countStaleTemplateMappings(): Promise<{ readonly considered: number; readonly stale: number }> {
  const taxonomy = await listCapabilities()
  const candidates = await loadCandidates(taxonomy)
  return { considered: candidates.length, stale: candidates.filter((c) => c.hash !== c.storedHash).length }
}

/** A finite positive integer, or the fallback -- guards `batchSize`/`maxBatches` against a caller
 *  passing `NaN`, `0`, a negative number or a fraction (fix round 1, minors). */
function positiveIntOr<T>(value: number | undefined, fallback: T): number | T {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
}

export async function mapTemplateCapabilities(input: MapTemplateCapabilitiesInput): Promise<CapabilityMappingReport> {
  const taxonomy = await listCapabilities()
  const candidates = await loadCandidates(taxonomy)
  const due = input.only === 'all' ? candidates : candidates.filter((c) => c.hash !== c.storedHash)
  const batchSize = positiveIntOr(input.batchSize, CAPABILITY_MAP_BATCH_SIZE)
  const maxBatches = positiveIntOr(input.maxBatches, undefined)
  const cap = input.maxBudgetUsdPerCall ?? CAPABILITY_MAP_PER_CALL_CAP_USD

  let calls = 0
  let mapped = 0
  let unchanged = 0
  let absent = 0
  let failedBatches = 0
  let droppedKeys = 0
  let costUsd = 0
  let unmeasuredCalls = 0
  const rows: CapabilityMappingRow[] = []
  let wrote = false

  for (let start = 0; start < due.length; start += batchSize) {
    if (maxBatches !== undefined && calls >= maxBatches) break
    const batch = due.slice(start, start + batchSize)
    const prompt = buildCapabilityMappingPrompt(batch.map((c) => c.persona), taxonomy)
    calls += 1
    let outcome: ModelOutcome
    try {
      outcome = await input.decider({ model: input.model, prompt, maxBudgetUsd: cap })
    } catch {
      failedBatches += 1
      continue
    }
    if (outcome.costUsd === null) unmeasuredCalls += 1
    else costUsd += outcome.costUsd
    if (outcome.kind !== 'answer') {
      failedBatches += 1
      continue
    }
    const parsed = parseCapabilityMappingAnswer(outcome.text, batch.map((c) => c.persona), taxonomy)
    if (parsed === null) {
      failedBatches += 1
      continue
    }
    const byId = new Map(parsed.map((r) => [r.id, r] as const))
    const now = new Date()
    // Classified BEFORE the dryRun branch (fix round 1, minors) so `mapped`/`unchanged`/`rows`
    // mean the same thing whether or not this call actually writes: `rows` holds only the
    // personas that would be (or were) written, never one already exactly what is stored.
    const writes: { candidate: Candidate; keys: readonly string[]; dropped: readonly string[] }[] = []
    let batchUnchanged = 0
    for (const candidate of batch) {
      const result = byId.get(candidate.persona.id)
      if (result === undefined) {
        absent += 1
        continue
      }
      droppedKeys += result.dropped.length
      const same = sameStringSet(candidate.storedMapped, result.keys) && candidate.storedHash === candidate.hash
      if (same) {
        batchUnchanged += 1
        continue
      }
      writes.push({ candidate, keys: result.keys, dropped: result.dropped })
    }
    for (const write of writes) {
      rows.push({ templateId: write.candidate.persona.id, name: write.candidate.persona.name, keys: write.keys, dropped: write.dropped })
    }
    if (input.dryRun) {
      mapped += writes.length
      unchanged += batchUnchanged
      continue
    }
    // The counters below are LOCAL to this batch and folded into the running totals only once the
    // transaction resolves (fix round 1, Important 2): a thrown `tx.slaveTemplate.update` -- a
    // concurrent delete of a template mid-batch, say -- rolls the whole batch back, and the
    // rejection must not leave the closure's increments behind, must not stop the batches after
    // it, and must not stop `syncPersonPool()` from running off whatever earlier batches DID
    // commit.
    let batchMapped = 0
    let batchWrote = false
    try {
      await prisma.$transaction(async (tx) => {
        for (const { candidate, keys } of writes) {
          await tx.slaveTemplate.update({
            where: { id: candidate.persona.id },
            data: {
              mappedCapabilityKeys: [...keys],
              capabilityMappingHash: candidate.hash,
              capabilityMappedAt: now,
              capabilityKeys: effectiveCapabilityKeys(candidate.exactKeys, keys),
            },
          })
          batchMapped += 1
          batchWrote = true
        }
      })
    } catch {
      failedBatches += 1
      continue
    }
    mapped += batchMapped
    unchanged += batchUnchanged
    if (batchWrote) wrote = true
  }

  const pool = wrote ? await syncPersonPool() : null
  return {
    considered: candidates.length,
    stale: due.length,
    calls,
    mapped,
    unchanged,
    absent,
    failedBatches,
    droppedKeys,
    costUsd,
    unmeasuredCalls,
    rows,
    pool,
  }
}
