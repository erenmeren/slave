import { describe, expect, it } from 'vitest'
import {
  MEMORIES_LOADED_MAX,
  MEMORY_BODY_MAX,
  MEMORY_CAPABILITIES_MAX,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_SOURCE_KIND_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TITLE_MAX,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  capCodePoints,
} from '../../src/memory/types.js'
import { memoryStamp, parseMemoryDraft, provenanceLine } from '../../src/memory/provenance.js'
import type { MemoryView } from '../../src/memory/provenance.js'

const FACT: MemoryView = {
  id: 'm1',
  type: 'fact',
  scope: 'workspace',
  companyId: null,
  workspaceId: 'w1',
  slaveId: null,
  title: 'Task: Ship the checkout API',
  body: 'Every orders route requires a signed session.',
  status: 'verified',
  confidence: 'sourced',
  capabilities: ['backend.api-design'],
  verifiedAt: '2026-09-12T10:00:00.000Z',
  verifiedBy: 'verification',
  supersededById: null,
  removedReason: null,
  sourceIds: [],
  createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  provenance: {
    sourceKind: 'verification',
    sourceRef: '412',
    createdBy: 'system',
    createdByUserId: null,
    taskId: 't1',
    runId: 'r3f2a0000',
    goalVersion: 2,
  },
}

describe('the memory vocabulary', () => {
  it('is four closed lists, each with a label for every member (docs/ia.md rule 3)', () => {
    expect(MEMORY_TYPES).toEqual(['fact', 'decision', 'procedure', 'lesson', 'observation', 'hypothesis'])
    expect(MEMORY_SCOPES).toEqual(['company', 'workspace', 'worker'])
    expect(MEMORY_STATUSES).toEqual(['candidate', 'verified', 'superseded', 'removed'])
    expect(MEMORY_SOURCE_KINDS).toEqual([
      'run_output',
      'verification',
      'review',
      'decision',
      'goal',
      'human',
      'condensation',
    ])
    for (const type of MEMORY_TYPES) expect(MEMORY_TYPE_LABEL[type].length).toBeGreaterThan(0)
    for (const status of MEMORY_STATUSES) expect(MEMORY_STATUS_LABEL[status].length).toBeGreaterThan(0)
    // The one member with an underscore -- and therefore the one that would reach a page as an
    // identifier if anything printed the key (plan erratum E10).
    expect(MEMORY_SOURCE_KIND_LABEL.run_output).toBe('a worker’s own report')
  })

  // Fix round 1, item 4: Task 2's loader reads this bound, so it lives beside the caps it belongs
  // with rather than being spelled again where the rows are fetched.
  it('names how many rows one retrieval may load', () => {
    expect(MEMORIES_LOADED_MAX).toBe(500)
    expect(MEMORIES_LOADED_MAX).toBeGreaterThan(MEMORY_CAPABILITIES_MAX)
  })
})

describe('capCodePoints', () => {
  it('counts code points, not UTF-16 units, so a cap never splits a character', () => {
    expect(capCodePoints('abc', 10)).toBe('abc')
    expect(capCodePoints('abcdef', 3)).toBe('abc')
    // Four astral code points: `slice(0, 3)` on the raw string would cut one in half.
    expect(capCodePoints('👩‍💻𝒜𝒷𝒸', 3)).toBe([...'👩‍💻𝒜𝒷𝒸'].slice(0, 3).join(''))
    expect([...capCodePoints('x'.repeat(MEMORY_BODY_MAX + 50), MEMORY_BODY_MAX)].length).toBe(MEMORY_BODY_MAX)
  })
})

describe('parseMemoryDraft', () => {
  const draft = {
    type: 'fact',
    scope: 'workspace',
    companyId: null,
    workspaceId: 'w1',
    slaveId: null,
    title: 'A thing that is true',
    body: 'It is true because the commands said so.',
    status: 'verified',
    confidence: 'sourced',
    capabilities: [],
    verifiedBy: 'verification',
    supersedesTaskCandidates: false,
    provenance: {
      sourceKind: 'verification',
      sourceRef: null,
      createdBy: 'system',
      createdByUserId: null,
      taskId: 't1',
      runId: null,
      goalVersion: null,
    },
  }

  it('accepts the full shape', () => {
    expect(parseMemoryDraft(draft).ok).toBe(true)
  })

  it('refuses a seventh field, so nothing can be smuggled past the column', () => {
    expect(parseMemoryDraft({ ...draft, importance: 9 }).ok).toBe(false)
  })

  it('refuses a title or a body over the cap, and a blank one', () => {
    expect(parseMemoryDraft({ ...draft, title: 'x'.repeat(MEMORY_TITLE_MAX + 1) }).ok).toBe(false)
    expect(parseMemoryDraft({ ...draft, body: 'x'.repeat(MEMORY_BODY_MAX + 1) }).ok).toBe(false)
    expect(parseMemoryDraft({ ...draft, title: '' }).ok).toBe(false)
    expect(parseMemoryDraft({ ...draft, body: '   ' }).ok).toBe(false)
  })

  // Plan decision D1: the database keeps three nullable columns and no CHECK, so THIS is the
  // invariant. A draft with two targets or none is refused before anything is written.
  it('refuses a draft that names no target, or more than one', () => {
    expect(parseMemoryDraft({ ...draft, workspaceId: null }).ok).toBe(false)
    expect(parseMemoryDraft({ ...draft, slaveId: 'ag-1' }).ok).toBe(false)
  })

  it('refuses a target that does not match the scope', () => {
    expect(parseMemoryDraft({ ...draft, scope: 'worker' }).ok).toBe(false)
    expect(parseMemoryDraft({ ...draft, scope: 'company' }).ok).toBe(false)
  })

  /**
   * Fix round 1, item 1. The cap is stated in CODE POINTS -- that is what `capCodePoints` counts
   * and what the constants' own comments say -- so the schema has to count them too. Zod's `.max()`
   * counts UTF-16 units, which made a body `capCodePoints` had just produced one unit too long
   * whenever the cap landed on an astral character: `promotionFor` returned a draft
   * `parseMemoryDraft` then refused.
   */
  it('measures the caps in code points, so a body the capper produced always parses', () => {
    const atCap = 'a'.repeat(MEMORY_BODY_MAX - 1) + '🎉'
    expect([...atCap].length).toBe(MEMORY_BODY_MAX)
    expect(atCap.length).toBe(MEMORY_BODY_MAX + 1)
    expect(parseMemoryDraft({ ...draft, body: atCap }).ok).toBe(true)
    expect(parseMemoryDraft({ ...draft, body: 'a'.repeat(MEMORY_BODY_MAX) + '🎉' }).ok).toBe(false)

    const titleAtCap = 'a'.repeat(MEMORY_TITLE_MAX - 1) + '🎉'
    expect(parseMemoryDraft({ ...draft, title: titleAtCap }).ok).toBe(true)
    expect(parseMemoryDraft({ ...draft, title: 'a'.repeat(MEMORY_TITLE_MAX) + '🎉' }).ok).toBe(false)
  })

  it('caps the capability list too, and the same rule reads a stored row back', () => {
    expect(parseMemoryDraft({ ...draft, capabilities: Array.from({ length: MEMORY_CAPABILITIES_MAX }, (_, i) => `k${String(i)}`) }).ok).toBe(true)
    expect(parseMemoryDraft({ ...draft, capabilities: Array.from({ length: MEMORY_CAPABILITIES_MAX + 1 }, (_, i) => `k${String(i)}`) }).ok).toBe(false)
  })
})

describe('the provenance sentences', () => {
  it('stamps a memory for a prompt in labels, never in keys', () => {
    expect(memoryStamp(FACT, 'Ship the checkout API')).toBe(
      'Fact · verified by verification · task Ship the checkout API',
    )
    expect(memoryStamp({ ...FACT, provenance: { ...FACT.provenance, taskId: null } }, null)).toBe(
      'Fact · verified by verification',
    )
  })

  it('says where a memory came from, in words, with the run short and the goal version named', () => {
    expect(provenanceLine(FACT, 'Ship the checkout API')).toBe(
      'from a passed verification of “Ship the checkout API” · run r3f2a00 · goal v2 · verified by verification',
    )
  })

  it('names only what it has, for a memory a person wrote out of nothing', () => {
    expect(
      provenanceLine(
        {
          ...FACT,
          confidence: 'interpretation',
          verifiedBy: 'human',
          provenance: {
            sourceKind: 'human',
            sourceRef: null,
            createdBy: 'human',
            createdByUserId: 'u1',
            taskId: null,
            runId: null,
            goalVersion: null,
          },
        },
        null,
      ),
    ).toBe('from a person · verified by a person')
  })
})
