import { describe, expect, it } from 'vitest'
import { CONDENSE_THRESHOLD, condenseMemories } from '../../src/memory/condense.js'
import { retrieveMemories } from '../../src/memory/retrieve.js'
import { MEMORY_BODY_MAX, MEMORY_CAPABILITIES_MAX } from '../../src/memory/types.js'
import type { MemoryView } from '../../src/memory/provenance.js'

function fact(index: number, overrides: Partial<MemoryView> = {}): MemoryView {
  const day = String(index + 1).padStart(2, '0')
  return {
    id: `m${String(index).padStart(2, '0')}`,
    type: 'fact',
    scope: 'workspace',
    companyId: null,
    workspaceId: 'w1',
    slaveId: null,
    title: `Fact number ${String(index)}`,
    body: `body ${String(index)}`,
    status: 'verified',
    confidence: 'sourced',
    capabilities: index % 2 === 0 ? ['backend.api-design'] : ['security.application'],
    verifiedAt: `2026-09-${day}T10:00:00.000Z`,
    verifiedBy: 'verification',
    supersededById: null,
    removedReason: null,
    sourceIds: [],
    createdAt: `2026-09-${day}T10:00:00.000Z`,
    updatedAt: `2026-09-${day}T10:00:00.000Z`,
    provenance: {
      sourceKind: 'verification',
      sourceRef: null,
      createdBy: 'system',
      createdByUserId: null,
      taskId: null,
      runId: null,
      goalVersion: null,
    },
    ...overrides,
  }
}

const twenty = Array.from({ length: CONDENSE_THRESHOLD }, (_, index) => fact(index))

describe('condenseMemories', () => {
  it('says nothing below the threshold', () => {
    expect(
      condenseMemories({
        memories: twenty.slice(0, CONDENSE_THRESHOLD - 1),
        scope: 'workspace',
        targetId: 'w1',
        type: 'fact',
      }),
    ).toBeNull()
    expect(CONDENSE_THRESHOLD).toBe(20)
  })

  it('summarises twenty facts into one memory that points back at every one of them', () => {
    const got = condenseMemories({ memories: twenty, scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(got).not.toBeNull()
    if (got === null) return
    expect(got.sourceIds).toEqual(twenty.map((one) => one.id))
    expect(got.draft.type).toBe('fact')
    expect(got.draft.status).toBe('verified')
    expect(got.draft.confidence).toBe('sourced')
    expect(got.draft.verifiedBy).toBe('human')
    expect(got.draft.provenance.sourceKind).toBe('condensation')
    expect(got.draft.provenance.createdBy).toBe('system')
    expect(got.draft.title).toBe('Fact summary (20 sources, 2026-09-01 to 2026-09-20)')
    expect(got.draft.body.split('\n')[0]).toBe('- Fact number 0')
    // The union of what the sources are about, sorted, so two runs produce the same row.
    expect(got.draft.capabilities).toEqual(['backend.api-design', 'security.application'])
  })

  it('is byte-identical whatever order the sources arrive in', () => {
    const forwards = condenseMemories({ memories: twenty, scope: 'workspace', targetId: 'w1', type: 'fact' })
    const backwards = condenseMemories({
      memories: [...twenty].reverse(),
      scope: 'workspace',
      targetId: 'w1',
      type: 'fact',
    })
    expect(backwards).toEqual(forwards)
  })

  it('counts only what is eligible: verified, of this type, in this scope, and not already summarised', () => {
    // Twenty-five, not twenty: five of them are already indexed by `already`, and what is left has
    // to still BE twenty or there is nothing to summarise and the case would prove only that.
    const twentyFive = Array.from({ length: CONDENSE_THRESHOLD + 5 }, (_, index) => fact(index))
    const already = fact(0, { id: 'summary', sourceIds: twentyFive.slice(0, 5).map((one) => one.id) })
    expect(
      condenseMemories({ memories: [...twentyFive, already], scope: 'workspace', targetId: 'w1', type: 'fact' })
        ?.sourceIds,
    ).toEqual(twentyFive.slice(5).map((one) => one.id))
    expect(
      condenseMemories({
        memories: [...twenty.slice(0, 19), fact(19, { status: 'candidate' })],
        scope: 'workspace',
        targetId: 'w1',
        type: 'fact',
      }),
    ).toBeNull()
    expect(
      condenseMemories({
        memories: [...twenty.slice(0, 19), fact(19, { type: 'lesson', scope: 'worker', workspaceId: null, slaveId: 'ag-1' })],
        scope: 'workspace',
        targetId: 'w1',
        type: 'fact',
      }),
    ).toBeNull()
    expect(condenseMemories({ memories: twenty, scope: 'workspace', targetId: 'w2', type: 'fact' })).toBeNull()
  })

  it('caps the bullet list and says how many it did not print', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      fact(index % 28, { id: `x${String(index).padStart(3, '0')}`, title: 'y'.repeat(110) }),
    )
    const got = condenseMemories({ memories: many, scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(got).not.toBeNull()
    if (got === null) return
    expect([...got.draft.body].length).toBeLessThanOrEqual(MEMORY_BODY_MAX)
    expect(got.draft.body).toMatch(/… and \d+ more$/)
    // The tail is TRUE: printed plus unprinted is every source.
    const printed = got.draft.body.split('\n').filter((line) => line.startsWith('- ')).length
    const dropped = Number(/… and (\d+) more$/.exec(got.draft.body)?.[1] ?? '0')
    expect(printed + dropped).toBe(200)
    // Every source is still LINKED even when its title did not fit -- a summary is an index.
    expect(got.sourceIds).toHaveLength(200)
  })

  it('keeps the twenty capability keys the sources name MOST, ties by key (fix round 1)', () => {
    // Twenty-five keys, every one named once: nothing is more frequent than anything else, so the
    // tie-break alone decides and the answer is the alphabetical first twenty.
    const wide = Array.from({ length: CONDENSE_THRESHOLD + 5 }, (_, index) =>
      fact(index, { capabilities: [`area.${String(index).padStart(2, '0')}`] }),
    )
    const got = condenseMemories({ memories: wide, scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(got?.draft.capabilities).toHaveLength(MEMORY_CAPABILITIES_MAX)
    expect(got?.draft.capabilities[0]).toBe('area.00')
    expect(got?.draft.capabilities.at(-1)).toBe('area.19')

    // The alphabetically LAST key, named by every source, must still survive the cut: what the
    // sources are mostly about is the useful thing to index a summary by, not what sorts first.
    const common = Array.from({ length: CONDENSE_THRESHOLD + 5 }, (_, index) =>
      fact(index, { capabilities: [`area.${String(index).padStart(2, '0')}`, 'zz.everywhere'] }),
    )
    const alsoGot = condenseMemories({ memories: common, scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(alsoGot?.draft.capabilities).toHaveLength(MEMORY_CAPABILITIES_MAX)
    expect(alsoGot?.draft.capabilities[0]).toBe('zz.everywhere')
    expect(alsoGot?.draft.capabilities.slice(1)).toEqual(
      Array.from({ length: MEMORY_CAPABILITIES_MAX - 1 }, (_, index) => `area.${String(index).padStart(2, '0')}`),
    )
  })

  /**
   * Fix round 1, minor 5: the list is a PREFIX and not a greedy fill. A short title further down
   * must not jump the queue over the long one that stopped the list, because `… and N more` names
   * a TAIL -- a reader who follows the summary to its sources expects the ones it printed to be
   * the ones it got to.
   */
  it('prints a prefix of the sources, never a greedy fill with holes', () => {
    const long = Array.from({ length: CONDENSE_THRESHOLD }, (_, index) =>
      fact(index, { id: `a${String(index).padStart(2, '0')}`, title: 'y'.repeat(110) }),
    )
    const short = Array.from({ length: 10 }, (_, index) =>
      fact(20 + index, { id: `b${String(index).padStart(2, '0')}`, title: 'short' }),
    )
    const got = condenseMemories({ memories: [...long, ...short], scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(got).not.toBeNull()
    if (got === null) return
    expect(got.draft.body).not.toContain('- short')
    const printed = got.draft.body.split('\n').filter((line) => line.startsWith('- ')).length
    expect(got.draft.body).toContain(`… and ${String(30 - printed)} more`)
    expect(got.sourceIds).toHaveLength(30)
  })

  /**
   * Fix round 1, important 2: a WITHDRAWN summary frees its sources again. `retrieveMemories`
   * already stopped hiding them (it only drops the sources of a summary it is itself showing), and
   * condensation that went on hiding them would leave that knowledge indexed by nothing forever.
   */
  it('re-condenses the sources of a summary somebody withdrew', () => {
    const dead = fact(20, {
      id: 'withdrawn-summary',
      status: 'removed',
      removedReason: 'it summarised the wrong project',
      sourceIds: twenty.map((one) => one.id),
    })
    const got = condenseMemories({ memories: [...twenty, dead], scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(got?.sourceIds).toEqual(twenty.map((one) => one.id))

    // A SUPERSEDED one frees them too, and a verified one still holds them.
    const replaced = fact(20, { id: 'old-summary', status: 'superseded', supersededById: 'x', sourceIds: twenty.map((one) => one.id) })
    expect(condenseMemories({ memories: [...twenty, replaced], scope: 'workspace', targetId: 'w1', type: 'fact' })).not.toBeNull()
    const live = fact(20, { id: 'live-summary', sourceIds: twenty.map((one) => one.id) })
    expect(condenseMemories({ memories: [...twenty, live], scope: 'workspace', targetId: 'w1', type: 'fact' })).toBeNull()
  })

  /**
   * Fix round 1, critical 1: the caller may know about coverage its own row window cannot show it
   * -- a summary written long ago sits outside the oldest-`MEMORIES_LOADED_MAX` page -- so it says
   * so explicitly rather than leaving the rule to infer it from rows that are not there.
   */
  it('takes the caller’s word for what is already covered', () => {
    expect(
      condenseMemories({
        memories: twenty,
        scope: 'workspace',
        targetId: 'w1',
        type: 'fact',
        alreadyCovered: new Set([twenty[0]!.id]),
      }),
    ).toBeNull()
    const got = condenseMemories({
      memories: twenty,
      scope: 'workspace',
      targetId: 'w1',
      type: 'fact',
      alreadyCovered: new Set(['some-other-memory']),
    })
    expect(got?.sourceIds).toHaveLength(CONDENSE_THRESHOLD)
  })

  // R5's one special case.
  it('turns a worker’s twenty lessons into a PROCEDURE -- what this worker has learned to do', () => {
    const lessons = twenty.map((one, index) =>
      fact(index, { id: one.id, type: 'lesson', scope: 'worker', workspaceId: null, slaveId: 'ag-1' }),
    )
    const got = condenseMemories({ memories: lessons, scope: 'worker', targetId: 'ag-1', type: 'lesson' })
    expect(got?.draft.type).toBe('procedure')
    expect(got?.draft.scope).toBe('worker')
    expect(got?.draft.slaveId).toBe('ag-1')
    expect(got?.draft.title).toBe('What this worker has learned to do (20 sources, 2026-09-01 to 2026-09-20)')
  })

  /**
   * Plan erratum E4, end to end and at the size R5 actually produces: `retrieveMemories` already
   * knows how to drop the sources of an included summary, and this is the proof that the thing
   * `condenseMemories` builds is the thing that rule reads.
   */
  it('leaves a run the summary ALONE once its twenty sources are linked to it (E4)', () => {
    const got = condenseMemories({ memories: twenty, scope: 'workspace', targetId: 'w1', type: 'fact' })
    expect(got).not.toBeNull()
    if (got === null) return
    const summary: MemoryView = {
      ...fact(20, { id: 'summary' }),
      title: got.draft.title,
      body: got.draft.body,
      capabilities: got.draft.capabilities,
      sourceIds: got.sourceIds,
      provenance: got.draft.provenance,
    }
    const given = retrieveMemories({
      memories: [...twenty, summary],
      scopes: { companyId: null, workspaceId: 'w1', slaveId: 'ag-1' },
      refs: { taskId: null, requiredCapabilities: [], goalVersion: null },
      kind: 'implementation',
    })
    expect(given.map((one) => one.id)).toEqual(['summary'])
  })
})
