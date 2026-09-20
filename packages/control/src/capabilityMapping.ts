import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_MAP_BATCH_SIZE,
  CAPABILITY_MAP_PER_CALL_CAP_USD,
  buildCapabilityMappingPrompt,
  capabilityMappingHash,
  mappableSentences,
  parseCapabilityMappingAnswer,
  profileSpecSchema,
  type CapabilityMappingPersona,
  type CapabilityRecord,
} from '@slave-of-ai/domain'
import { effectiveCapabilityKeys, listCapabilities } from './capability.js'
import { syncPersonPool, type PersonPoolSyncReport } from './personPool.js'
import type { ModelDecider } from './simulation/llm.js'

/**
 * Catalogue capability mapping (2026-09-20), R6: the ONE verb that asks a model which taxonomy
 * keys a persona provides, in batches, and writes the answer beside the exact matcher's keys.
 *
 * Money discipline, in order: the hash (R4) decides whether a call is owed at all; the batch
 * bounds the prompt; the per-call cap bounds the call; one transaction per batch bounds what a
 * bad answer can touch. A batch that fails -- no JSON, an isolation breach, a spawn failure --
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

/** R4: every structured template with at least one mappable sentence, with today's hash beside
 *  the stored one. Read once per pass, id ascending, so a batch boundary is deterministic. */
async function loadCandidates(taxonomy: readonly CapabilityRecord[]): Promise<readonly Candidate[]> {
  const rows = await prisma.slaveTemplate.findMany({
    where: { profileSpec: { not: Prisma.DbNull } },
    select: {
      id: true,
      name: true,
      role: true,
      profileSpec: true,
      capabilityKeys: true,
      mappedCapabilityKeys: true,
      capabilityMappingHash: true,
      unresolvedCapabilities: true,
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
    // The EXACT half is what the row's current effective set holds minus the mapped half -- the
    // matcher's own output is not stored on its own, and re-running it here would couple this
    // pass to `normaliseCapabilities`. Subtracting is exact because both halves are sets.
    const exactKeys = row.capabilityKeys.filter((key) => !row.mappedCapabilityKeys.includes(key))
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

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].toSorted().every((v, i) => v === [...b].toSorted()[i])
}

export async function mapTemplateCapabilities(input: MapTemplateCapabilitiesInput): Promise<CapabilityMappingReport> {
  const taxonomy = await listCapabilities()
  const candidates = await loadCandidates(taxonomy)
  const due = input.only === 'all' ? candidates : candidates.filter((c) => c.hash !== c.storedHash)
  const batchSize = Math.max(1, input.batchSize ?? CAPABILITY_MAP_BATCH_SIZE)
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
    if (input.maxBatches !== undefined && calls >= input.maxBatches) break
    const batch = due.slice(start, start + batchSize)
    const prompt = buildCapabilityMappingPrompt(batch.map((c) => c.persona), taxonomy)
    calls += 1
    let outcome
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
    const writes: { candidate: Candidate; keys: readonly string[]; dropped: readonly string[] }[] = []
    for (const candidate of batch) {
      const result = byId.get(candidate.persona.id)
      if (result === undefined) {
        absent += 1
        continue
      }
      droppedKeys += result.dropped.length
      writes.push({ candidate, keys: result.keys, dropped: result.dropped })
    }
    for (const write of writes) {
      rows.push({ templateId: write.candidate.persona.id, name: write.candidate.persona.name, keys: write.keys, dropped: write.dropped })
    }
    if (input.dryRun) {
      mapped += writes.length
      continue
    }
    await prisma.$transaction(async (tx) => {
      for (const { candidate, keys } of writes) {
        const same = sameSet(candidate.storedMapped, keys) && candidate.storedHash === candidate.hash
        if (same) {
          unchanged += 1
          continue
        }
        await tx.slaveTemplate.update({
          where: { id: candidate.persona.id },
          data: {
            mappedCapabilityKeys: [...keys],
            capabilityMappingHash: candidate.hash,
            capabilityMappedAt: now,
            capabilityKeys: effectiveCapabilityKeys(candidate.exactKeys, keys),
          },
        })
        mapped += 1
        wrote = true
      }
    })
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
