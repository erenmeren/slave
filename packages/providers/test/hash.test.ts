import { describe, expect, it } from 'vitest'
import { HASH_ARRAY_MAX, HASH_DEPTH_MAX, HASH_STRING_CAP, hashToolInput } from '../src/hash.js'

describe('hashToolInput', () => {
  it('is a sha256 hex digest', () => {
    expect(hashToolInput({ a: 1 })).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('is stable across key order -- two calls that differ only in JSON layout are ONE call', () => {
    expect(hashToolInput({ a: 1, b: 2 })).toBe(hashToolInput({ b: 2, a: 1 }))
  })

  it('separates two Bash commands that share a long path preamble', () => {
    // THE bug this function exists to avoid: a prefix slice (`JSON.stringify(input).slice(0, 200)`)
    // collided nine different commands that shared a long `cd /very/long/path && ...` preamble, and
    // the breaker constrained a working agent. A per-STRING cap cannot do that -- the cap is on
    // each string, not on the whole serialisation.
    const preamble = `cd ${'/deep/nested/path'.repeat(20)} && `
    expect(hashToolInput({ command: `${preamble}npm test` })).not.toBe(
      hashToolInput({ command: `${preamble}npm run build` }),
    )
  })

  it('caps each string at HASH_STRING_CAP CODE POINTS, so two long tails collide deliberately', () => {
    const head = 'x'.repeat(HASH_STRING_CAP)
    expect(hashToolInput({ content: `${head}aaa` })).toBe(hashToolInput({ content: `${head}bbb` }))
    // And the cap counts code points, not UTF-16 units: an emoji is one character.
    expect(() => hashToolInput({ content: '🙂'.repeat(HASH_STRING_CAP + 10) })).not.toThrow()
  })

  it('caps arrays and depth, and says how many it dropped rather than dropping them silently', () => {
    const long = Array.from({ length: HASH_ARRAY_MAX + 5 }, (_, i) => i)
    const longer = Array.from({ length: HASH_ARRAY_MAX + 6 }, (_, i) => i)
    // Different LENGTHS still differ -- the count is part of the canonical form.
    expect(hashToolInput({ xs: long })).not.toBe(hashToolInput({ xs: longer }))
    let deep: unknown = 'leaf'
    for (let i = 0; i < HASH_DEPTH_MAX + 4; i += 1) deep = { deep }
    expect(hashToolInput(deep)).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('drops what cannot be canonicalised instead of throwing', () => {
    expect(hashToolInput({ n: Number.NaN, i: Infinity, f: () => 1, u: undefined })).toBe(hashToolInput({}))
  })

  it('never throws on a cyclic input -- a parser must not die on a shape the CLI sent', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(() => hashToolInput(cyclic)).not.toThrow()
  })

  it('distinguishes the empty cases from each other', () => {
    const hashes = new Set([hashToolInput(undefined), hashToolInput(null), hashToolInput({}), hashToolInput([])])
    expect(hashes.size).toBe(4)
  })
})
