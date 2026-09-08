import { describe, expect, it } from 'vitest'
import { runContextManifestSchema, type Manifest } from '../../src/run-context/sections.js'

function validManifest(): Manifest {
  return {
    kind: 'implementation',
    sections: [
      { kind: 'profile', origin: 'slave', sha256: 'a'.repeat(64) },
      { kind: 'roster', slaveIds: ['s1', 's2'] },
      {
        kind: 'skills',
        copied: ['code-review'],
        missing: ['ghost-skill'],
        shadowedByRepo: [],
        provider_unsupported: false,
        no_worktree: false,
      },
      { kind: 'inbox', messageIds: ['m1'] },
      { kind: 'ask_protocol' },
      { kind: 'task', taskId: 't1' },
      { kind: 'rejection', taskId: 't1' },
    ],
  }
}

describe('runContextManifestSchema', () => {
  it('accepts a valid manifest for every section source kind', () => {
    const manifest = validManifest()
    const parsed = runContextManifestSchema.safeParse(manifest)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(manifest)
  })

  it('accepts a valid review-kind manifest carrying a review_diff source', () => {
    const manifest: Manifest = {
      kind: 'review',
      sections: [
        { kind: 'profile', origin: 'template', sha256: 'b'.repeat(64) },
        { kind: 'review_diff', base: 'main', head: 'abc123', capped: true },
      ],
    }
    expect(runContextManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('accepts a valid planning-kind manifest carrying a planning_goal source', () => {
    const manifest: Manifest = {
      kind: 'planning',
      sections: [{ kind: 'planning_goal', sha256: 'c'.repeat(64) }],
    }
    expect(runContextManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('rejects a manifest whose kind is not one of the three run kinds', () => {
    const malformed = { kind: 'bogus', sections: [] }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a manifest whose section source carries an unknown kind', () => {
    const malformed = { kind: 'implementation', sections: [{ kind: 'mystery' }] }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a profile source missing its sha256', () => {
    const malformed = { kind: 'implementation', sections: [{ kind: 'profile', origin: 'slave' }] }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a hand-edited row where sections is not an array', () => {
    const malformed = { kind: 'implementation', sections: 'not-an-array' }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })
})
