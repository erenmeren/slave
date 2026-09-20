import { prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { syncCapabilityTaxonomy } from '../../src/capability.js'
import { drainCapabilityMappingCalls, resetCapabilityMappingTickForTests, tickCapabilityMapping } from '../../src/capabilityMappingTick.js'
import type { ModelDecider } from '../../src/simulation/llm.js'

beforeEach(async (): Promise<void> => {
  // The tick's module state is process-wide: a previous test's quiet window would silence this
  // one's stale row, and a call still out would write into a table this hook is about to empty.
  await resetCapabilityMappingTickForTests()
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Person", "SlaveTemplate" RESTART IDENTITY CASCADE')
  await syncCapabilityTaxonomy()
})

// A detached call that outlives its test needs the drain here too: nothing else in this file waits
// for a call started by the last test before the process moves on to the next file.
afterAll(drainCapabilityMappingCalls)

const structured = (name: string) =>
  prisma.slaveTemplate.create({
    data: { name, role: 'engineering', description: 'x', active: true, profileSpec: { ...emptyProfileSpec(), summary: 's', identity: 'i', capabilities: ['hand testing'] } as unknown as object },
  })

const everyone: ModelDecider = async (input) => {
  const ids = [...input.prompt.matchAll(/^persona id: (.+)$/gmu)].map((m) => m[1] as string)
  return { kind: 'answer', text: JSON.stringify({ personas: ids.map((id) => ({ id, keys: ['qa.exploratory'] })) }), costUsd: 0.03, tokens: null, numTurns: 1 }
}

const mappedCount = async (): Promise<number> => prisma.slaveTemplate.count({ where: { capabilityMappingHash: { not: null } } })

describe('tickCapabilityMapping', () => {
  it('maps ONE batch per pass and leaves the rest for the next pass', async (): Promise<void> => {
    for (let i = 0; i < 7; i += 1) await structured(`P${String(i)}`)

    const first = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(first).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: true, stale: 7 })
    await drainCapabilityMappingCalls()
    expect(await mappedCount()).toBe(5)

    const second = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(second).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: true, stale: 2 })
    await drainCapabilityMappingCalls()
    expect(await mappedCount()).toBe(7)

    const third = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(third).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: false, stale: 0 })
  })

  it('does not start a second call while the first is still out, and the row is written once released', async (): Promise<void> => {
    await structured('Blocked')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: ModelDecider = async (input) => {
      await gate
      return everyone(input)
    }

    const first = await tickCapabilityMapping({ model: 'm', modelDecider: slow })
    expect(first).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: true, stale: 1 })

    const second = await tickCapabilityMapping({ model: 'm', modelDecider: slow })
    expect(second).toMatchObject({ skippedNoDecider: false, skippedInFlight: true, started: false, stale: 1 })

    release()
    await drainCapabilityMappingCalls()
    expect(await mappedCount()).toBe(1)
  })

  // Final review, I2: the pass used to count -- a full read, a zod parse and a SHA-256 per active
  // persona -- once a second forever, including for a catalogue that has nothing left to map.
  it('asks nothing at all for a minute after a pass finds nothing stale', async (): Promise<void> => {
    const empty = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(empty).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: false, stale: 0 })

    // A persona that arrives INSIDE the window waits it out: the tick reads nothing, so it cannot
    // know this row exists, and says so with the `stale: 0` of the count it stood in for.
    await structured('Arrived During The Quiet Window')
    const inside = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(inside).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: false, stale: 0 })
    expect(await mappedCount()).toBe(0)

    // Closing the window by hand is what a minute of real time would do.
    await resetCapabilityMappingTickForTests()
    const after = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(after).toMatchObject({ skippedNoDecider: false, skippedInFlight: false, started: true, stale: 1 })
    await drainCapabilityMappingCalls()
    expect(await mappedCount()).toBe(1)
  })

  it('reports skippedNoDecider and starts nothing without a decider', async (): Promise<void> => {
    await structured('Alone')
    const report = await tickCapabilityMapping({ model: 'm' })
    expect(report).toMatchObject({ skippedNoDecider: true, skippedInFlight: false, started: false, stale: 1 })
  })
})
