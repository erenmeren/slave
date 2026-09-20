import { prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_MAP_ANSWER_MARKER,
  CAPABILITY_MAP_PER_CALL_CAP_USD,
  emptyProfileSpec,
  type ProfileSpec,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { reconcileTemplateCapabilities, syncCapabilityTaxonomy, addCapability } from '../../src/capability.js'
import { countStaleTemplateMappings, mapTemplateCapabilities } from '../../src/capabilityMapping.js'
import { syncPersonPool } from '../../src/personPool.js'
import type { ModelDecider, ModelOutcome } from '../../src/simulation/llm.js'

const TRUNCATE = 'TRUNCATE TABLE "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await prisma.capability.deleteMany({ where: { createdBy: { not: 'seed' } } })
  await syncCapabilityTaxonomy()
})

const specWith = (capabilities: readonly string[], summary = 'A specialist.'): ProfileSpec => ({
  ...emptyProfileSpec(),
  summary,
  identity: 'Someone who does one thing well.',
  capabilities,
})

const structured = async (name: string, capabilities: readonly string[], active = true): Promise<string> =>
  (
    await prisma.slaveTemplate.create({
      data: { name, role: 'engineering', description: `${name}.`, active, profileSpec: specWith(capabilities) as unknown as object },
    })
  ).id

/** A decider that answers from a map of persona NAME -> keys, and records every call. */
function scripted(byName: Record<string, readonly string[]>, outcome?: ModelOutcome): ModelDecider & { calls: string[] } {
  const calls: string[] = []
  const decider: ModelDecider = async (input) => {
    calls.push(input.prompt)
    if (outcome !== undefined) return outcome
    // The prompt carries `persona id: <id>` and `name: <name>` lines in order; answer for each.
    const ids = [...input.prompt.matchAll(/^persona id: (.+)$/gmu)].map((m) => m[1] as string)
    const names = [...input.prompt.matchAll(/^name: (.+)$/gmu)].map((m) => m[1] as string)
    const personas = ids.flatMap((id, i) => {
      const keys = byName[names[i] as string]
      return keys === undefined ? [] : [{ id, keys }]
    })
    return { kind: 'answer', text: `sure\n${JSON.stringify({ personas })}`, costUsd: 0.05, tokens: null, numTurns: 1 }
  }
  return Object.assign(decider, { calls })
}

describe('mapTemplateCapabilities', () => {
  it('maps a stale template, writes the union, stamps the hash, and syncs the pool', async (): Promise<void> => {
    const id = await structured('DevOps Automator', ['CI/CD Excellence', 'Observability Expertise'])
    const decider = scripted({ 'DevOps Automator': ['operations.ci-cd', 'operations.observability', 'made.up'] })

    const report = await mapTemplateCapabilities({ decider, model: 'claude-sonnet-5', only: 'stale', dryRun: false })

    expect(report).toMatchObject({ considered: 1, stale: 1, calls: 1, mapped: 1, absent: 0, failedBatches: 0, droppedKeys: 1 })
    expect(report.costUsd).toBeCloseTo(0.05)
    expect(report.pool).not.toBeNull()
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.mappedCapabilityKeys).toEqual(['operations.ci-cd', 'operations.observability'])
    expect(row.capabilityKeys).toEqual(['operations.ci-cd', 'operations.observability'])
    expect(row.capabilityMappingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.capabilityMappedAt).not.toBeNull()
    expect(decider.calls[0]).toContain(CAPABILITY_MAP_ANSWER_MARKER)
  })

  it('asks with the per-call cap and the model it was given, and honours a maxBudgetUsdPerCall override', async (): Promise<void> => {
    await structured('One', ['a thing'])
    let seen: { maxBudgetUsd: number; model: string } | null = null
    const decider: ModelDecider = async (input) => {
      seen = { maxBudgetUsd: input.maxBudgetUsd, model: input.model }
      return { kind: 'answer', text: '{"personas":[]}', costUsd: 0.01, tokens: null, numTurns: 1 }
    }
    await mapTemplateCapabilities({ decider, model: 'claude-sonnet-5', only: 'stale', dryRun: false })
    expect(seen).toEqual({ maxBudgetUsd: CAPABILITY_MAP_PER_CALL_CAP_USD, model: 'claude-sonnet-5' })

    // 'One' stayed absent from the answer above (empty `personas`), so it is still stale and the
    // only due candidate: a second call with an override reaches the decider with THAT number.
    await mapTemplateCapabilities({ decider, model: 'claude-sonnet-5', only: 'stale', dryRun: false, maxBudgetUsdPerCall: 0.25 })
    expect(seen).toEqual({ maxBudgetUsd: 0.25, model: 'claude-sonnet-5' })
  })

  it('skips a fresh template and makes no call; only: all re-calls it', async (): Promise<void> => {
    await structured('Fresh', ['x'])
    const first = scripted({ Fresh: ['qa.test-automation'] })
    await mapTemplateCapabilities({ decider: first, model: 'm', only: 'stale', dryRun: false })
    expect(first.calls).toHaveLength(1)

    const second = scripted({ Fresh: ['qa.test-automation'] })
    const report = await mapTemplateCapabilities({ decider: second, model: 'm', only: 'stale', dryRun: false })
    expect(second.calls).toHaveLength(0)
    expect(report).toMatchObject({ considered: 1, stale: 0, calls: 0 })

    const third = scripted({ Fresh: ['qa.test-automation'] })
    const again = await mapTemplateCapabilities({ decider: third, model: 'm', only: 'all', dryRun: false })
    expect(third.calls).toHaveLength(1)
    expect(again).toMatchObject({ calls: 1, mapped: 0, unchanged: 1 })
  })

  it('becomes stale again when a taxonomy key is added (R4)', async (): Promise<void> => {
    await structured('Later', ['x'])
    await mapTemplateCapabilities({ decider: scripted({ Later: [] }), model: 'm', only: 'stale', dryRun: false })
    expect((await countStaleTemplateMappings()).stale).toBe(0)
    const added = await addCapability({ key: 'custom.thing', label: 'A thing', role: 'backend' })
    expect(added.ok).toBe(true)
    expect((await countStaleTemplateMappings()).stale).toBe(1)
  })

  it('leaves rows untouched on a null answer, an isolation breach or a failure, and counts the batch', async (): Promise<void> => {
    const id = await structured('Untouched', ['x'])
    for (const outcome of [
      { kind: 'answer', text: 'no json', costUsd: 0.01, tokens: null, numTurns: 1 },
      { kind: 'isolation_breach', tools: ['Bash'], costUsd: 0.01, tokens: null },
    ] as const) {
      const report = await mapTemplateCapabilities({ decider: scripted({}, outcome as ModelOutcome), model: 'm', only: 'stale', dryRun: false })
      expect(report).toMatchObject({ calls: 1, mapped: 0, failedBatches: 1 })
      const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
      expect(row.capabilityMappingHash).toBeNull()
      expect(row.mappedCapabilityKeys).toEqual([])
    }
  })

  it('counts a thrown decider as a failed batch and leaves rows untouched', async (): Promise<void> => {
    const id = await structured('Throws', ['x'])
    const decider: ModelDecider = async () => {
      throw new Error('boom')
    }
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'stale', dryRun: false })
    expect(report).toMatchObject({ calls: 1, failedBatches: 1, mapped: 0 })
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.capabilityMappingHash).toBeNull()
    expect(row.mappedCapabilityKeys).toEqual([])
  })

  it('leaves a persona the answer does not mention untouched and counts it absent', async (): Promise<void> => {
    await structured('Named', ['x'])
    const id = await structured('Forgotten', ['y'])
    const report = await mapTemplateCapabilities({ decider: scripted({ Named: ['qa.exploratory'] }), model: 'm', only: 'stale', dryRun: false })
    expect(report).toMatchObject({ calls: 1, mapped: 1, absent: 1 })
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).capabilityMappingHash).toBeNull()
  })

  it('writes nothing under dryRun and returns what it would have written', async (): Promise<void> => {
    const id = await structured('Preview', ['x'])
    const report = await mapTemplateCapabilities({ decider: scripted({ Preview: ['qa.exploratory'] }), model: 'm', only: 'stale', dryRun: true })
    expect(report.rows).toEqual([{ templateId: id, name: 'Preview', keys: ['qa.exploratory'], dropped: [] }])
    expect(report.pool).toBeNull()
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.mappedCapabilityKeys).toEqual([])
    expect(row.capabilityMappingHash).toBeNull()
  })

  it('never selects a hand-made template or one with no capability sentence', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', description: 'x', active: true } })
    await structured('Blank Sentences', ['  ', ''])
    const decider = scripted({})
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'all', dryRun: false })
    expect(report).toMatchObject({ considered: 0, stale: 0, calls: 0 })
    expect(decider.calls).toHaveLength(0)
  })

  it('never selects an inactive structured template: an inactive persona can never be staffed', async (): Promise<void> => {
    await structured('Inactive', ['x'], false)
    const decider = scripted({})
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'all', dryRun: false })
    expect(report).toMatchObject({ considered: 0, stale: 0, calls: 0 })
    expect(decider.calls).toHaveLength(0)
  })

  it('batches by batchSize, stops at maxBatches, and survives a failed batch in the middle', async (): Promise<void> => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await structured(name, [name.toLowerCase()])
    // Batches are cut in id order, and ids are uuids -- which two personas land in the failed
    // batch is not knowable, so the scripted answer covers everyone and the assertions count.
    let n = 0
    const inner = scripted({ A: ['qa.exploratory'], B: ['qa.exploratory'], C: ['qa.exploratory'], D: ['qa.exploratory'], E: ['qa.exploratory'] })
    const decider: ModelDecider = async (input) => {
      n += 1
      if (n === 2) return { kind: 'answer', text: 'garbage', costUsd: 0.01, tokens: null, numTurns: 1 }
      return inner(input)
    }
    // maxBatches: 3 would never actually bind here -- ceil(5 / 2) is 3 batches total, so it lets
    // every batch run. maxBatches: 2 is the real test of the early stop: the third batch (one
    // persona) is never even attempted.
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'stale', dryRun: false, batchSize: 2, maxBatches: 2 })
    expect(report).toMatchObject({ calls: 2, failedBatches: 1, mapped: 2 })
    expect((await countStaleTemplateMappings()).stale).toBe(3) // the failed batch's two, plus the one maxBatches never reached
  })

  it('reconcile after a mapping keeps the mapped keys, and the pool carries the union', async (): Promise<void> => {
    const id = await structured('Pooled', ['CI/CD Excellence'])
    await mapTemplateCapabilities({ decider: scripted({ Pooled: ['operations.ci-cd'] }), model: 'm', only: 'stale', dryRun: false })
    await reconcileTemplateCapabilities()
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).capabilityKeys).toEqual(['operations.ci-cd'])
    await syncPersonPool()
    const person = await prisma.person.findFirst({ where: { templateId: id } })
    expect(person?.capabilities).toEqual(['operations.ci-cd'])
  })

  it('recomputes the exact half fresh, so a word-matched key survives when the model later drops it (Important 1)', async (): Promise<void> => {
    const id = await structured('Dual Match', ['monitoring', 'CI/CD Excellence'])
    await mapTemplateCapabilities({
      decider: scripted({ 'Dual Match': ['operations.observability', 'operations.ci-cd'] }),
      model: 'm',
      only: 'stale',
      dryRun: false,
    })
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).capabilityKeys).toEqual([
      'operations.ci-cd',
      'operations.observability',
    ])

    // Make it stale again (R4), then re-map with the model answering only the OTHER key -- if the
    // exact half were subtracted from stale, stored columns instead of recomputed fresh, it would
    // read as empty here (both keys sat in `mappedCapabilityKeys` after the first pass) and
    // `operations.observability` -- which the persona still states by the word "monitoring" --
    // would disappear.
    const added = await addCapability({ key: 'custom.dual-match-filler', label: 'Dual Match Filler', role: 'backend' })
    expect(added.ok).toBe(true)
    await mapTemplateCapabilities({
      decider: scripted({ 'Dual Match': ['operations.ci-cd'] }),
      model: 'm',
      only: 'stale',
      dryRun: false,
    })
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.capabilityKeys).toContain('operations.observability')
    expect(row.capabilityKeys).toContain('operations.ci-cd')
  })

  it('re-stamps the hash and counts it mapped when the answer set is unchanged but the hash moved', async (): Promise<void> => {
    const id = await structured('Restamp', ['x'])
    await mapTemplateCapabilities({ decider: scripted({ Restamp: ['qa.exploratory'] }), model: 'm', only: 'stale', dryRun: false })
    const before = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })

    const added = await addCapability({ key: 'custom.restamp-filler', label: 'Restamp Filler', role: 'backend' })
    expect(added.ok).toBe(true)
    const report = await mapTemplateCapabilities({ decider: scripted({ Restamp: ['qa.exploratory'] }), model: 'm', only: 'stale', dryRun: false })

    expect(report).toMatchObject({ mapped: 1, unchanged: 0 })
    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(after.capabilityMappingHash).not.toEqual(before.capabilityMappingHash)
    expect(after.mappedCapabilityKeys).toEqual(['qa.exploratory'])
  })

  it('a template deleted mid-batch fails the whole batch, drops the increments, and never stops later batches (Important 2)', async (): Promise<void> => {
    const firstId = await structured('First', ['x'])
    const secondId = await structured('Second', ['y'])
    const decider: ModelDecider = async () => {
      // The decider runs AFTER `loadCandidates` built the batch and the prompt, so deleting here
      // simulates a concurrent delete landing between the read and the write.
      await prisma.slaveTemplate.delete({ where: { id: secondId } })
      return {
        kind: 'answer',
        text: JSON.stringify({
          personas: [
            { id: firstId, keys: ['qa.exploratory'] },
            { id: secondId, keys: ['qa.exploratory'] },
          ],
        }),
        costUsd: 0.01,
        tokens: null,
        numTurns: 1,
      }
    }
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'stale', dryRun: false })
    expect(report).toMatchObject({ calls: 1, failedBatches: 1, mapped: 0, unchanged: 0 })
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: firstId } })
    expect(row.capabilityMappingHash).toBeNull()
    expect(row.mappedCapabilityKeys).toEqual([])
  })
})
