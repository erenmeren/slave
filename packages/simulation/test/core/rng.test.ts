import { describe, expect, it } from 'vitest'
import { nextRandom, seedState } from '../../src/core/rng.js'

describe('nextRandom', () => {
  it('is a pure function of its state: the same state yields the same value and next state', () => {
    const a = nextRandom(seedState(42))
    const b = nextRandom(seedState(42))
    expect(a).toEqual(b)
    expect(a.value).toBeGreaterThanOrEqual(0)
    expect(a.value).toBeLessThan(1)
  })
  it('two seeds diverge and a sequence does not repeat within 1000 draws', () => {
    expect(nextRandom(seedState(1)).value).not.toBe(nextRandom(seedState(2)).value)
    const seen = new Set<number>()
    let state = seedState(7)
    for (let i = 0; i < 1000; i++) {
      const out = nextRandom(state)
      seen.add(out.value)
      state = out.state
    }
    expect(seen.size).toBe(1000)
  })
})
