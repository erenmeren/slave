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
      { kind: 'task', taskId: 't1', sha256: 'd'.repeat(64) },
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
        { kind: 'task', taskId: 't1', sha256: 'd'.repeat(64) },
        { kind: 'review_diff', base: 'main', head: 'abc123', capped: true },
      ],
    }
    expect(runContextManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('accepts a valid planning-kind manifest carrying a planning_goal source', () => {
    const manifest: Manifest = {
      kind: 'planning',
      sections: [{ kind: 'planning_goal', sha256: 'c'.repeat(64), version: 3 }],
    }
    expect(runContextManifestSchema.safeParse(manifest).success).toBe(true)
  })

  // M40 t1: the re-plan run's own section. Its kind stays `planning` -- the manifest is what tells
  // a re-plan from a first plan, both for the trailer and for `concludePlanning`'s routing.
  it('accepts a planning-kind manifest carrying a replan source', () => {
    const manifest: Manifest = {
      kind: 'planning',
      sections: [
        { kind: 'planning_goal', sha256: 'c'.repeat(64), version: 2 },
        {
          kind: 'replan',
          previousVersion: 1,
          version: 2,
          previousSha256: 'a'.repeat(64),
          sha256: 'c'.repeat(64),
          boardTaskIds: ['t1', 't2'],
        },
      ],
    }
    const parsed = runContextManifestSchema.safeParse(manifest)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(manifest)
  })

  it('accepts a replan source whose board was empty of ids it could name', () => {
    const manifest = {
      kind: 'planning',
      sections: [
        { kind: 'replan', previousVersion: 0, version: 1, previousSha256: '', sha256: 'c'.repeat(64), boardTaskIds: [] },
      ],
    }
    expect(runContextManifestSchema.safeParse(manifest).success).toBe(true)
  })

  /**
   * Fix round 1, Important 1. The two fields M40 added to EXISTING source kinds are optional on
   * read. Every `RunContext` row written before this milestone carries neither, and both readers --
   * `show-context` (`apps/orchestrator/src/cli.ts`) and the web's run-context route -- turn a parse
   * failure into a hard error rather than a degraded render, so requiring them would have made
   * every historical run's context unreadable. The write site stays strict (Task 3 asserts it).
   */
  it('accepts a pre-M40 task source with no sha256', () => {
    const preM40 = { kind: 'implementation', sections: [{ kind: 'task', taskId: 't1' }] }
    const parsed = runContextManifestSchema.safeParse(preM40)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.sections[0]).toEqual({ kind: 'task', taskId: 't1' })
  })

  it('accepts a pre-M40 planning_goal source with no version', () => {
    const preM40 = { kind: 'planning', sections: [{ kind: 'planning_goal', sha256: 'c'.repeat(64) }] }
    const parsed = runContextManifestSchema.safeParse(preM40)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.sections[0]).toEqual({ kind: 'planning_goal', sha256: 'c'.repeat(64) })
  })

  // Absent and WRONG are different states: tolerating a missing field is not tolerating a
  // malformed one, and a hand-edited row must still be refused.
  it('rejects a task source whose sha256 is not a string', () => {
    const malformed = { kind: 'implementation', sections: [{ kind: 'task', taskId: 't1', sha256: 42 }] }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a planning_goal source whose version is negative', () => {
    const malformed = { kind: 'planning', sections: [{ kind: 'planning_goal', sha256: 'c'.repeat(64), version: -1 }] }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a planning_goal source whose version is not a whole number', () => {
    const malformed = { kind: 'planning', sections: [{ kind: 'planning_goal', sha256: 'c'.repeat(64), version: 1.5 }] }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  // The `replan` source is M40's OWN kind: no row predates it, so nothing about it is optional.
  it('still rejects a replan source missing a field -- there is no pre-M40 replan row to tolerate', () => {
    const malformed = {
      kind: 'planning',
      sections: [{ kind: 'replan', previousVersion: 1, version: 2, previousSha256: 'a', boardTaskIds: [] }],
    }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a replan source missing one of its two version ends', () => {
    const malformed = {
      kind: 'planning',
      sections: [{ kind: 'replan', version: 2, previousSha256: 'a', sha256: 'c', boardTaskIds: [] }],
    }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects a replan source whose boardTaskIds is not an array', () => {
    const malformed = {
      kind: 'planning',
      sections: [
        { kind: 'replan', previousVersion: 1, version: 2, previousSha256: 'a', sha256: 'c', boardTaskIds: 't1' },
      ],
    }
    expect(runContextManifestSchema.safeParse(malformed).success).toBe(false)
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
