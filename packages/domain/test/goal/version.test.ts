import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { goalDiff, goalSha256 } from '../../src/goal/version.js'

/** The reference every assertion below is measured against. `packages/domain` may not import
 *  `node:crypto` itself (it is in `apps/web`'s client bundle -- see `goalSha256`'s own comment),
 *  but a TEST may, and cross-checking there is what stops the hand-rolled implementation drifting
 *  from the `createHash('sha256')` one-liners `packages/control` and `apps/orchestrator` keep. */
const reference = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('goalSha256', () => {
  it('matches the published vector for the empty string', () => {
    expect(goalSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('matches the published vector for "abc"', () => {
    expect(goalSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it.each([
    ['empty', ''],
    ['one line', 'Ship the API'],
    // 55, 56 and 64 bytes: the three padding boundaries (the last block that still fits its own
    // length field, the first that does not, and an exact block multiple).
    ['55 bytes', 'a'.repeat(55)],
    ['56 bytes', 'a'.repeat(56)],
    ['64 bytes', 'a'.repeat(64)],
    ['a multi-block goal', 'Ship the API.\n'.repeat(200)],
    ['multi-byte UTF-8', 'Ship the API — with a naïve café ☕ and an emoji 🚢'],
    ['a lone newline', '\n'],
  ])('agrees with node:crypto for %s', (_name, text) => {
    expect(goalSha256(text)).toBe(reference(text))
  })

  it('is stable across calls and sensitive to a one-character change', () => {
    expect(goalSha256('Ship the API')).toBe(goalSha256('Ship the API'))
    expect(goalSha256('Ship the API')).not.toBe(goalSha256('Ship the APi'))
  })

  it('is 64 lowercase hex characters', () => {
    expect(goalSha256('Ship the API')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('goalDiff', () => {
  it('reports added and removed lines, in the order of the text they came from', () => {
    const previous = 'Build the API\nWrite the docs\nShip it'
    const next = 'Build the API\nAdd auth\nShip it\nAnnounce it'
    expect(goalDiff(previous, next)).toEqual({ added: ['Add auth', 'Announce it'], removed: ['Write the docs'] })
  })

  it('reports nothing for two texts whose lines are the same', () => {
    expect(goalDiff('Build the API\nShip it', 'Build the API\nShip it')).toEqual({ added: [], removed: [] })
  })

  it('trims each line before comparing, so re-indentation is not a change', () => {
    expect(goalDiff('  Build the API\nShip it', 'Build the API\n\t Ship it  ')).toEqual({ added: [], removed: [] })
  })

  it('ignores blank lines on both sides', () => {
    expect(goalDiff('Build the API', 'Build the API\n\n\n')).toEqual({ added: [], removed: [] })
  })

  it('reports a reordered line in neither list -- this is a set difference, not a Myers diff', () => {
    expect(goalDiff('one\ntwo', 'two\none')).toEqual({ added: [], removed: [] })
  })

  it('collapses a repeated addition into one entry', () => {
    expect(goalDiff('one', 'one\ntwo\ntwo')).toEqual({ added: ['two'], removed: [] })
  })

  it('treats the first version (from an empty previous) as all additions', () => {
    expect(goalDiff('', 'Build the API\nShip it')).toEqual({ added: ['Build the API', 'Ship it'], removed: [] })
  })
})
