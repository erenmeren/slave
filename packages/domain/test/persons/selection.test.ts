import { describe, expect, it } from 'vitest'
import { rankPoolCandidates, type PoolCandidate } from '../../src/persons/selection.js'

const candidate = (overrides: Partial<PoolCandidate> & { readonly personId: string }): PoolCandidate => ({
  name: 'Alice Adams',
  poolSlot: 1,
  openSeatCount: 0,
  ...overrides,
})

describe('rankPoolCandidates (Catalog Person Pool Task 2)', () => {
  it('orders by open-seat count ascending first', () => {
    const busiest = candidate({ personId: 'a', openSeatCount: 3, poolSlot: 1 })
    const idlest = candidate({ personId: 'b', openSeatCount: 0, poolSlot: 2 })
    const middle = candidate({ personId: 'c', openSeatCount: 1, poolSlot: 3 })

    const ranked = rankPoolCandidates([busiest, idlest, middle])

    expect(ranked.map((row) => row.personId)).toEqual(['b', 'c', 'a'])
  })

  it('breaks an open-seat-count tie by poolSlot ascending', () => {
    const slotThree = candidate({ personId: 'a', poolSlot: 3, openSeatCount: 1 })
    const slotOne = candidate({ personId: 'b', poolSlot: 1, openSeatCount: 1 })
    const slotTwo = candidate({ personId: 'c', poolSlot: 2, openSeatCount: 1 })

    const ranked = rankPoolCandidates([slotThree, slotOne, slotTwo])

    expect(ranked.map((row) => row.personId)).toEqual(['b', 'c', 'a'])
  })

  it('breaks an open-seat-count AND poolSlot tie by id, deterministically', () => {
    const z = candidate({ personId: 'zzz', poolSlot: 1, openSeatCount: 1 })
    const a = candidate({ personId: 'aaa', poolSlot: 1, openSeatCount: 1 })
    const m = candidate({ personId: 'mmm', poolSlot: 1, openSeatCount: 1 })

    const ranked = rankPoolCandidates([z, a, m])

    expect(ranked.map((row) => row.personId)).toEqual(['aaa', 'mmm', 'zzz'])
  })

  it('does not mutate its input array', () => {
    const input = [
      candidate({ personId: 'b', openSeatCount: 1 }),
      candidate({ personId: 'a', openSeatCount: 0 }),
    ]
    const original = [...input]

    rankPoolCandidates(input)

    expect(input).toEqual(original)
  })

  it('returns an empty array for no candidates', () => {
    expect(rankPoolCandidates([])).toEqual([])
  })

  it('is stable and total across all three keys together', () => {
    const rows: PoolCandidate[] = [
      candidate({ personId: 'p3', poolSlot: 2, openSeatCount: 1 }),
      candidate({ personId: 'p1', poolSlot: 1, openSeatCount: 0 }),
      candidate({ personId: 'p4', poolSlot: 1, openSeatCount: 1 }),
      candidate({ personId: 'p2', poolSlot: 3, openSeatCount: 0 }),
    ]

    const ranked = rankPoolCandidates(rows)

    // openSeatCount 0 first (p1, p2 by poolSlot 1 < 3), then openSeatCount 1 (p4, p3 by poolSlot 1 < 2)
    expect(ranked.map((row) => row.personId)).toEqual(['p1', 'p2', 'p4', 'p3'])
  })
})
