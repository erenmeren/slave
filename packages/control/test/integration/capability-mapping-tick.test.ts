import { prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { syncCapabilityTaxonomy } from '../../src/capability.js'
import { tickCapabilityMapping } from '../../src/capabilityMappingTick.js'
import type { ModelDecider } from '../../src/simulation/llm.js'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Person", "SlaveTemplate" RESTART IDENTITY CASCADE')
  await syncCapabilityTaxonomy()
})

const structured = (name: string) =>
  prisma.slaveTemplate.create({
    data: { name, role: 'engineering', description: 'x', active: true, profileSpec: { ...emptyProfileSpec(), summary: 's', identity: 'i', capabilities: ['hand testing'] } as unknown as object },
  })

const everyone: ModelDecider = async (input) => {
  const ids = [...input.prompt.matchAll(/^persona id: (.+)$/gmu)].map((m) => m[1] as string)
  return { kind: 'answer', text: JSON.stringify({ personas: ids.map((id) => ({ id, keys: ['qa.exploratory'] })) }), costUsd: 0.03, tokens: null, numTurns: 1 }
}

describe('tickCapabilityMapping', () => {
  it('maps ONE batch per pass and leaves the rest for the next pass', async (): Promise<void> => {
    for (let i = 0; i < 7; i += 1) await structured(`P${String(i)}`)
    const first = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(first).toMatchObject({ skippedNoDecider: false, stale: 7, calls: 1, mapped: 5 })
    const second = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(second).toMatchObject({ stale: 2, calls: 1, mapped: 2 })
    const third = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(third).toMatchObject({ stale: 0, calls: 0, mapped: 0 })
  })

  it('reports skippedNoDecider and calls nothing without a decider', async (): Promise<void> => {
    await structured('Alone')
    const report = await tickCapabilityMapping({ model: 'm' })
    expect(report).toMatchObject({ skippedNoDecider: true, stale: 1, calls: 0, mapped: 0 })
  })
})
