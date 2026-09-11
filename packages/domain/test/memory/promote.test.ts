import { describe, expect, it } from 'vitest'
import { MEMORY_BODY_MAX, MEMORY_CAPABILITIES_MAX } from '../../src/memory/types.js'
import { promotionFor } from '../../src/memory/promote.js'
import { parseMemoryDraft } from '../../src/memory/provenance.js'

describe('promotionFor: a finished implementation run (R2a)', () => {
  const input = {
    kind: 'run_succeeded' as const,
    workspaceId: 'w1',
    taskId: 't1',
    taskTitle: 'Ship the checkout API',
    runId: 'r1',
    slaveId: 'ag-1',
    finalText: 'Both files are created in the worktree.',
    lastOutputSeq: 412,
    requiredCapabilities: ['backend.api-design'],
    goalVersion: 2,
  }

  it('is an OBSERVATION candidate scoped to the project, with the run and the seq on it', () => {
    const draft = promotionFor(input)
    expect(draft).not.toBeNull()
    expect(draft).toEqual({
      type: 'observation',
      scope: 'workspace',
      companyId: null,
      workspaceId: 'w1',
      slaveId: null,
      title: 'Task: Ship the checkout API',
      body: 'Both files are created in the worktree.',
      status: 'candidate',
      confidence: 'interpretation',
      capabilities: ['backend.api-design'],
      verifiedBy: null,
      supersedesTaskCandidates: false,
      provenance: {
        sourceKind: 'run_output',
        sourceRef: '412',
        createdBy: 'slave',
        createdByUserId: null,
        taskId: 't1',
        runId: 'r1',
        goalVersion: 2,
      },
    })
  })

  it('caps the body and the title rather than refusing them', () => {
    const draft = promotionFor({
      ...input,
      finalText: 'x'.repeat(MEMORY_BODY_MAX + 500),
      taskTitle: 'y'.repeat(400),
    })
    expect(draft).not.toBeNull()
    expect([...(draft?.body ?? '')].length).toBe(MEMORY_BODY_MAX)
    expect([...(draft?.title ?? '')].length).toBe(120)
  })

  it('is nothing at all when the run said nothing', () => {
    expect(promotionFor({ ...input, finalText: '   ' })).toBeNull()
  })
})

describe('promotionFor: a passed verification (R2b)', () => {
  const input = {
    kind: 'verify_passed' as const,
    workspaceId: 'w1',
    taskId: 't1',
    taskTitle: 'Ship the checkout API',
    runId: 'r1',
    expectedOutput: 'Every orders route requires a signed session.',
    commands: ['npm test', 'npm run lint'],
    requiredCapabilities: ['backend.api-design'],
    goalVersion: 2,
  }

  it('is a verified FACT that retires the task’s candidate, with the contract as its body', () => {
    const draft = promotionFor(input)
    expect(draft?.type).toBe('fact')
    expect(draft?.status).toBe('verified')
    expect(draft?.confidence).toBe('sourced')
    expect(draft?.verifiedBy).toBe('verification')
    expect(draft?.body).toBe('Every orders route requires a signed session.')
    expect(draft?.supersedesTaskCandidates).toBe(true)
    expect(draft?.provenance.sourceKind).toBe('verification')
  })

  it('says what the commands proved when the task carried no contract', () => {
    const draft = promotionFor({ ...input, expectedOutput: null })
    expect(draft?.body).toBe('Ship the checkout API — verified by npm test, npm run lint')
  })

  it('is nothing when there is neither a contract nor a command to name', () => {
    expect(promotionFor({ ...input, expectedOutput: null, commands: [] })).toBeNull()
  })
})

describe('promotionFor: a person resolving a decision, and a goal that moved (R2c)', () => {
  it('records an approval as a verified DECISION a person made', () => {
    const draft = promotionFor({
      kind: 'decision_resolved',
      workspaceId: 'w1',
      decisionId: 'sd-1',
      outcome: 'approved',
      rationale: 'Adopting the feature-delivery runbook fits this goal.',
      reason: null,
      userId: 'u1',
      taskId: null,
      goalVersion: 2,
    })
    expect(draft?.type).toBe('decision')
    expect(draft?.status).toBe('verified')
    expect(draft?.verifiedBy).toBe('human')
    expect(draft?.confidence).toBe('sourced')
    expect(draft?.provenance).toEqual({
      sourceKind: 'decision',
      sourceRef: 'sd-1',
      createdBy: 'human',
      createdByUserId: 'u1',
      taskId: null,
      runId: null,
      goalVersion: 2,
    })
    expect(draft?.body).toBe('Approved: Adopting the feature-delivery runbook fits this goal.')
  })

  it('keeps the rejecting person’s own words when there are any', () => {
    const draft = promotionFor({
      kind: 'decision_resolved',
      workspaceId: 'w1',
      decisionId: 'sd-2',
      outcome: 'rejected',
      rationale: 'Hire a security specialist from the catalog.',
      reason: 'We already have one on another project.',
      userId: null,
      taskId: null,
      goalVersion: null,
    })
    expect(draft?.body).toBe(
      'Rejected: Hire a security specialist from the catalog. — We already have one on another project.',
    )
  })

  it('records a goal change from v2 on, and never v1 (there was nothing to change)', () => {
    expect(
      promotionFor({ kind: 'goal_changed', workspaceId: 'w1', version: 1, request: null, goal: 'Ship it', userId: 'u1' }),
    ).toBeNull()
    const draft = promotionFor({
      kind: 'goal_changed',
      workspaceId: 'w1',
      version: 3,
      request: 'Add an authentication path.',
      goal: 'Ship the checkout flow.\n\nAdd an authentication path.',
      userId: 'u1',
    })
    expect(draft?.type).toBe('decision')
    expect(draft?.title).toBe('Goal v3')
    expect(draft?.body).toBe('Add an authentication path.')
    expect(draft?.provenance.sourceKind).toBe('goal')
    expect(draft?.provenance.sourceRef).toBe('3')
  })
})

describe('promotionFor: work that came back (R2d)', () => {
  const input = {
    kind: 'work_rejected' as const,
    workspaceId: 'w1',
    taskId: 't1',
    taskTitle: 'Ship the checkout API',
    slaveId: 'ag-1',
    runId: 'r1',
    reason: 'The diff does not handle the empty-input case the task requires.',
    by: 'review' as const,
    sourceRef: 'r-review-9',
    requiredCapabilities: ['backend.api-design'],
    goalVersion: 2,
  }

  it('is a verified LESSON scoped to the worker that did the work', () => {
    const draft = promotionFor(input)
    expect(draft?.type).toBe('lesson')
    expect(draft?.scope).toBe('worker')
    expect(draft?.slaveId).toBe('ag-1')
    expect(draft?.workspaceId).toBeNull()
    expect(draft?.status).toBe('verified')
    expect(draft?.confidence).toBe('sourced')
    expect(draft?.verifiedBy).toBe('review')
    expect(draft?.body).toBe('The diff does not handle the empty-input case the task requires.')
    expect(draft?.provenance.sourceKind).toBe('review')
  })

  it('reads a verify failure as the commands’ verdict instead', () => {
    const draft = promotionFor({ ...input, by: 'verification', sourceRef: '77' })
    expect(draft?.verifiedBy).toBe('verification')
    expect(draft?.provenance.sourceKind).toBe('verification')
  })

  // Plan erratum E2: there is nobody to teach.
  it('is nothing when no worker can be named, and nothing when nothing was said', () => {
    expect(promotionFor({ ...input, slaveId: null })).toBeNull()
    expect(promotionFor({ ...input, reason: '' })).toBeNull()
  })
})

/**
 * Fix round 1. Every draft this rule produces is written through `recordMemory`, which parses it
 * first -- so a draft the schema refuses is a promotion that silently never happens. These two
 * cases are the ways the rule could build one: a cap measured in different units on either side,
 * and a list the schema bounds that the rule copied whole.
 */
describe('promotionFor produces drafts the schema accepts', () => {
  const input = {
    kind: 'run_succeeded' as const,
    workspaceId: 'w1',
    taskId: 't1',
    taskTitle: 'Ship the checkout API',
    runId: 'r1',
    slaveId: 'ag-1',
    finalText: 'Both files are created in the worktree.',
    lastOutputSeq: 412,
    requiredCapabilities: ['backend.api-design'],
    goalVersion: 2,
  }

  it('caps a final text whose cap lands on an astral character, and the draft still parses', () => {
    // The cap falls exactly on the emoji, so the capped body is `MEMORY_BODY_MAX` code points and
    // `MEMORY_BODY_MAX + 1` UTF-16 units -- the case a `.max()` check refused.
    const draft = promotionFor({
      ...input,
      finalText: 'a'.repeat(MEMORY_BODY_MAX - 1) + '🎉' + 'b'.repeat(500),
    })
    expect(draft).not.toBeNull()
    expect([...(draft?.body ?? '')].length).toBe(MEMORY_BODY_MAX)
    expect(draft?.body.endsWith('🎉')).toBe(true)
    expect(parseMemoryDraft(draft).ok).toBe(true)
  })

  it('keeps the first twenty capabilities of a task that asks for more', () => {
    const many = Array.from({ length: 25 }, (_, index) => `cap.${String(index).padStart(2, '0')}`)
    const draft = promotionFor({ ...input, requiredCapabilities: many })
    expect(draft?.capabilities).toEqual(many.slice(0, MEMORY_CAPABILITIES_MAX))
    expect(parseMemoryDraft(draft).ok).toBe(true)
    // The same rule on the other two arms that carry a task's capabilities.
    expect(
      promotionFor({
        kind: 'verify_passed',
        workspaceId: 'w1',
        taskId: 't1',
        taskTitle: 'Ship the checkout API',
        runId: 'r1',
        expectedOutput: 'Every orders route requires a signed session.',
        commands: [],
        requiredCapabilities: many,
        goalVersion: 2,
      })?.capabilities,
    ).toHaveLength(MEMORY_CAPABILITIES_MAX)
    expect(
      promotionFor({
        kind: 'work_rejected',
        workspaceId: 'w1',
        taskId: 't1',
        taskTitle: 'Ship the checkout API',
        slaveId: 'ag-1',
        runId: 'r1',
        reason: 'The diff does not handle the empty-input case.',
        by: 'review',
        sourceRef: 'r-review-9',
        requiredCapabilities: many,
        goalVersion: 2,
      })?.capabilities,
    ).toHaveLength(MEMORY_CAPABILITIES_MAX)
  })
})
