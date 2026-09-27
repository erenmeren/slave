import { describe, expect, it } from 'vitest'
import { sectionLine } from '../src/lib/runContextSummary.js'

// Final review M3: the run page said which skills' instructions reached the prompt and which were
// cut, but not which were left out -- for length, or because they had nothing to show -- so an
// operator reading "instructions in the prompt: a" could not tell a skill that was dropped from one
// that was never assigned.
describe('sectionLine — skills', () => {
  const base = {
    kind: 'skills' as const,
    copied: ['a', 'b', 'c', 'd'],
    missing: [],
    shadowedByRepo: [],
    provider_unsupported: false,
    no_worktree: false,
  }

  it('names what was inlined, cut, left out for length, and had no instructions to show', () => {
    const line = sectionLine({ ...base, inlined: ['a', 'b'], truncated: ['b'], omitted: ['c'], unreadable: ['d'] })
    expect(line.detail).toContain('instructions in the prompt: a, b')
    expect(line.detail).toContain('cut for length: b')
    expect(line.detail).toContain('left out for length: c')
    expect(line.detail).toContain('no instructions to show: d')
  })

  it('says nothing of the conductor fields on a row written before them', () => {
    expect(sectionLine(base).detail).toBe('copied a, b, c, d')
  })
})
