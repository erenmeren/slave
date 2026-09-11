import { describe, expect, it } from 'vitest'
import { MEMORIES_IN_PROMPT, retrieveMemories } from '../../src/memory/retrieve.js'
import type { MemoryView } from '../../src/memory/provenance.js'

function memory(overrides: Partial<MemoryView> & { readonly id: string }): MemoryView {
  return {
    type: 'fact',
    scope: 'workspace',
    companyId: null,
    workspaceId: 'w1',
    slaveId: null,
    title: `title ${overrides.id}`,
    body: `body ${overrides.id}`,
    status: 'verified',
    confidence: 'sourced',
    capabilities: [],
    verifiedAt: '2026-09-12T10:00:00.000Z',
    verifiedBy: 'verification',
    supersededById: null,
    removedReason: null,
    sourceIds: [],
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
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

const SCOPES = { companyId: 'c1', workspaceId: 'w1', slaveId: 'ag-1' }
const REFS = { taskId: 't1', requiredCapabilities: ['backend.api-design'], goalVersion: 2 }
const ids = (memories: readonly MemoryView[]): readonly string[] => memories.map((one) => one.id)

describe('retrieveMemories', () => {
  it('gives a run only VERIFIED knowledge -- never a candidate, a superseded row or a removed one', () => {
    const got = retrieveMemories({
      memories: [
        memory({ id: 'verified' }),
        memory({ id: 'candidate', status: 'candidate' }),
        memory({ id: 'superseded', status: 'superseded', supersededById: 'verified' }),
        memory({ id: 'removed', status: 'removed', removedReason: 'wrong' }),
      ],
      scopes: SCOPES,
      refs: REFS,
      kind: 'implementation',
    })
    expect(ids(got)).toEqual(['verified'])
  })

  it('gives it nothing from another project, another company or another worker', () => {
    const got = retrieveMemories({
      memories: [
        memory({ id: 'mine' }),
        memory({ id: 'other-project', workspaceId: 'w2' }),
        memory({ id: 'my-company', scope: 'company', workspaceId: null, companyId: 'c1' }),
        memory({ id: 'other-company', scope: 'company', workspaceId: null, companyId: 'c2' }),
        memory({ id: 'mine-worker', scope: 'worker', workspaceId: null, slaveId: 'ag-1' }),
        memory({ id: 'other-worker', scope: 'worker', workspaceId: null, slaveId: 'ag-2' }),
      ],
      scopes: SCOPES,
      refs: REFS,
      kind: 'implementation',
    })
    expect([...ids(got)].sort()).toEqual(['mine', 'mine-worker', 'my-company'])
  })

  it('keeps a LESSON only for the worker whose lesson it is -- including when scopes name nobody', () => {
    const lessons = [
      memory({ id: 'mine', type: 'lesson', scope: 'worker', workspaceId: null, slaveId: 'ag-1' }),
      memory({ id: 'theirs', type: 'lesson', scope: 'worker', workspaceId: null, slaveId: 'ag-2' }),
    ]
    expect(ids(retrieveMemories({ memories: lessons, scopes: SCOPES, refs: REFS, kind: 'implementation' }))).toEqual(['mine'])
    expect(
      retrieveMemories({ memories: lessons, scopes: { ...SCOPES, slaveId: null }, refs: REFS, kind: 'planning' }),
    ).toEqual([])
  })

  it('ranks worker before project before company, then by type, then by capability overlap, then by task', () => {
    const got = retrieveMemories({
      memories: [
        memory({ id: 'company-fact', scope: 'company', workspaceId: null, companyId: 'c1' }),
        memory({ id: 'project-observation', type: 'observation' }),
        memory({ id: 'project-decision', type: 'decision' }),
        memory({ id: 'project-fact-capable', capabilities: ['backend.api-design'] }),
        memory({ id: 'project-fact-task', provenance: { ...memory({ id: 'x' }).provenance, taskId: 't1' } }),
        memory({ id: 'project-fact' }),
        memory({ id: 'worker-procedure', type: 'procedure', scope: 'worker', workspaceId: null, slaveId: 'ag-1' }),
      ],
      scopes: SCOPES,
      refs: REFS,
      kind: 'implementation',
    })
    expect(ids(got)).toEqual([
      'worker-procedure',
      'project-decision',
      'project-fact-capable',
      'project-fact-task',
      'project-fact',
      'project-observation',
      'company-fact',
    ])
  })

  // Plan erratum E4: the exclusion is read off the view's own `sourceIds`.
  it('prefers a summary and drops every memory the summary is made of (R3/R5)', () => {
    const got = retrieveMemories({
      memories: [
        memory({ id: 'summary', sourceIds: ['a', 'b'], provenance: { ...memory({ id: 'x' }).provenance, sourceKind: 'condensation' } }),
        memory({ id: 'a' }),
        memory({ id: 'b' }),
        memory({ id: 'c' }),
      ],
      scopes: SCOPES,
      refs: REFS,
      kind: 'implementation',
    })
    expect([...ids(got)].sort()).toEqual(['c', 'summary'])
  })

  it('stops at the limit, and the limit is twelve', () => {
    const many = Array.from({ length: 30 }, (_, index) => memory({ id: `m${String(index).padStart(2, '0')}` }))
    expect(retrieveMemories({ memories: many, scopes: SCOPES, refs: REFS, kind: 'implementation' })).toHaveLength(
      MEMORIES_IN_PROMPT,
    )
    expect(
      retrieveMemories({ memories: many, scopes: SCOPES, refs: REFS, kind: 'implementation', limit: 3 }),
    ).toHaveLength(3)
  })

  it('is deterministic: the same rows in any order rank the same, ties broken by id', () => {
    const rows = [memory({ id: 'b' }), memory({ id: 'a' }), memory({ id: 'c' })]
    const forwards = ids(retrieveMemories({ memories: rows, scopes: SCOPES, refs: REFS, kind: 'implementation' }))
    const backwards = ids(
      retrieveMemories({ memories: [...rows].reverse(), scopes: SCOPES, refs: REFS, kind: 'implementation' }),
    )
    expect(forwards).toEqual(['a', 'b', 'c'])
    expect(backwards).toEqual(forwards)
  })
})
