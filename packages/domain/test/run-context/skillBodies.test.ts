import { describe, expect, it } from 'vitest'
import { SKILL_BODIES_MAX_CHARS, SKILL_BODY_MAX_CHARS, fitSkillBodies } from '../../src/run-context/skillBodies.js'

describe('fitSkillBodies', () => {
  it('puts persona defaults first, then grants, each by name', () => {
    const out = fitSkillBodies([
      { name: 'zeta', origin: 'person', body: 'z' },
      { name: 'beta', origin: 'persona', body: 'b' },
      { name: 'alpha', origin: 'person', body: 'a' },
    ])
    expect(out.blocks.map((b) => b.name)).toEqual(['beta', 'alpha', 'zeta'])
    expect(out.inlined).toEqual(['beta', 'alpha', 'zeta'])
  })

  it('cuts one skill at the per-skill cap and says so', () => {
    const out = fitSkillBodies([{ name: 'long', origin: 'persona', body: 'x'.repeat(SKILL_BODY_MAX_CHARS + 500) }])
    expect(out.truncated).toEqual(['long'])
    expect(out.blocks[0]?.text.length).toBeLessThanOrEqual(SKILL_BODY_MAX_CHARS + 200)
    expect(out.blocks[0]?.text).toContain('[skill text cut at')
  })

  it('omits what no longer fits the total, and never inlines a missing body', () => {
    const big = 'y'.repeat(SKILL_BODY_MAX_CHARS)
    const out = fitSkillBodies([
      { name: 'a', origin: 'persona', body: big },
      { name: 'b', origin: 'persona', body: big },
      { name: 'c', origin: 'persona', body: big },
      { name: 'd', origin: 'persona', body: big },
      { name: 'gone', origin: 'person', body: null },
    ])
    expect(out.inlined).toEqual(['a', 'b', 'c'])
    // Final review M2: a skill with nothing to show is not one left out "for length".
    expect(out.omitted).toEqual(['d'])
    expect(out.unreadable).toEqual(['gone'])
    expect(out.blocks.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(SKILL_BODIES_MAX_CHARS)
  })

  it('keeps an empty or unreadable body apart from one left out for length', () => {
    const out = fitSkillBodies([
      { name: 'blank', origin: 'persona', body: '   \n  ' },
      { name: 'gone', origin: 'person', body: null },
      { name: 'fine', origin: 'person', body: 'Do the thing.' },
    ])
    expect(out.inlined).toEqual(['fine'])
    expect(out.omitted).toEqual([])
    expect(out.unreadable).toEqual(['blank', 'gone'])
  })
})
