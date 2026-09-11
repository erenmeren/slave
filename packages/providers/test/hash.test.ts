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
    // the breaker constrained a working slave. A per-STRING cap cannot do that -- the cap is on
    // each string, not on the whole serialisation.
    const preamble = `cd ${'/deep/nested/path'.repeat(20)} && `
    expect(hashToolInput({ command: `${preamble}npm test` })).not.toBe(
      hashToolInput({ command: `${preamble}npm run build` }),
    )
  })

  it('caps each string at HASH_STRING_CAP CODE POINTS without losing what came after it', () => {
    // Fix round 1 (review Minor 2). The cap bounds the WORK and the canonical form's length; it no
    // longer collides, because a digest of the WHOLE string is appended after the cut. Two strings
    // that share their first 512 characters and differ after are two different calls, and a
    // by-design collision in the one function whose job is telling calls apart was a liability
    // rather than a feature.
    const head = 'x'.repeat(HASH_STRING_CAP)
    expect(hashToolInput({ content: `${head}aaa` })).not.toBe(hashToolInput({ content: `${head}bbb` }))
    // Identical long strings still hash identically -- the point of the cap was never randomness.
    expect(hashToolInput({ content: `${head}aaa` })).toBe(hashToolInput({ content: `${head}aaa` }))
    // And the cap counts code points, not UTF-16 units: an emoji is one character.
    expect(() => hashToolInput({ content: '🙂'.repeat(HASH_STRING_CAP + 10) })).not.toThrow()
  })

  it('separates two Bash commands whose shared preamble is LONGER than the cap', () => {
    // The #377 FAMILY, not just its recorded instance (review Minor 2, measured): a 687-character
    // `cd … &&` preamble puts the difference between `npm test` and `npm run build` past
    // HASH_STRING_CAP, and before the full-string digest was appended these two hashed the same --
    // which is the original bug, reached by a longer path.
    const preamble = `cd ${'/deep/nested/path'.repeat(40)} && `
    expect(preamble.length).toBeGreaterThan(HASH_STRING_CAP)
    expect(hashToolInput({ command: `${preamble}npm test` })).not.toBe(
      hashToolInput({ command: `${preamble}npm run build` }),
    )
  })

  it('cannot be spoofed by a value that looks like the canonical form’s own delimiters', () => {
    // Review Minor 1, measured on the original: `{a:'x', b:1}` and `{a:'x,b=n:1'}` both canonicalised
    // to `o:{a=s:x,b=n:1}` and hashed the same. Keys and string values are JSON-encoded now, so a
    // `,`, `=` or `:` inside a value cannot impersonate the structure around it.
    expect(hashToolInput({ a: 'x', b: 1 })).not.toBe(hashToolInput({ a: 'x,b=n:1' }))
    expect(hashToolInput({ a: 'x' })).not.toBe(hashToolInput({ 'a=s:x': '' }))
    expect(hashToolInput({ xs: ['a', 'b'] })).not.toBe(hashToolInput({ xs: ['a,s:b'] }))
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
