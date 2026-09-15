import { describe, expect, it } from 'vitest'
import { intakeDraftSchema, intakeStepLogSchema, type IntakeDraft } from '../../src/index.js'

const draft: IntakeDraft = {
  name: 'Public API',
  goal: 'Add rate limiting to the public API',
  repo: { mode: 'existing', path: '/home/x/api' },
  baseBranch: 'main',
  verifyCommands: [{ command: 'npm test', source: 'detected' }],
  setupCommands: [],
  budgetUsd: 20,
  provider: null,
  team: [{ templateId: 't1', runtimeRoles: ['backend', 'manager'] }],
}

describe('IntakeDraft', () => {
  it('accepts what the model is asked for', () => {
    expect(intakeDraftSchema.safeParse(draft).success).toBe(true)
  })

  it('refuses a draft with no verify command at all -- createWorkspace would refuse it anyway', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, verifyCommands: [] }).success).toBe(false)
  })

  it('refuses a name past 80 characters and a goal past 8000', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, name: 'x'.repeat(81) }).success).toBe(false)
    expect(intakeDraftSchema.safeParse({ ...draft, goal: 'x'.repeat(8001) }).success).toBe(false)
  })

  it('accepts a new repository with no path -- accept resolves <root>/<slug> (R8)', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, repo: { mode: 'new', path: null } }).success).toBe(true)
  })

  it('refuses an existing repository with no path: there is nothing to attach', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, repo: { mode: 'existing', path: null } }).success).toBe(false)
  })

  it('refuses a verify source that is not one of the three', () => {
    const bad = { ...draft, verifyCommands: [{ command: 'npm test', source: 'guessed' }] }
    expect(intakeDraftSchema.safeParse(bad).success).toBe(false)
  })

  it('refuses a provider that is not a ProviderKind, and accepts none at all', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, provider: 'gpt' }).success).toBe(false)
    expect(intakeDraftSchema.safeParse({ ...draft, provider: 'claude_code' }).success).toBe(true)
    expect(intakeDraftSchema.safeParse({ ...draft, provider: null }).success).toBe(true)
  })

  it('refuses a negative or infinite budget, and accepts "not budgeted"', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, budgetUsd: -1 }).success).toBe(false)
    expect(intakeDraftSchema.safeParse({ ...draft, budgetUsd: Number.POSITIVE_INFINITY }).success).toBe(false)
    expect(intakeDraftSchema.safeParse({ ...draft, budgetUsd: null }).success).toBe(true)
  })

  it('accepts an empty team -- "I will staff it myself" is a real answer (R13)', () => {
    expect(intakeDraftSchema.safeParse({ ...draft, team: [] }).success).toBe(true)
  })
})

describe('the accept step log', () => {
  it('parses the shape acceptIntake writes', () => {
    const log = [
      { step: 'create_workspace', status: 'done', at: '2026-09-15T09:00:00.000Z', detail: null },
      { step: 'staff', status: 'skipped', at: '2026-09-15T09:00:01.000Z', detail: 'M58 not merged' },
    ]
    expect(intakeStepLogSchema.safeParse(log).success).toBe(true)
  })

  it('refuses a step nobody runs and a status nobody writes', () => {
    expect(intakeStepLogSchema.safeParse([{ step: 'deploy', status: 'done', at: '2026-09-15T09:00:00.000Z', detail: null }]).success).toBe(false)
    expect(intakeStepLogSchema.safeParse([{ step: 'staff', status: 'maybe', at: '2026-09-15T09:00:00.000Z', detail: null }]).success).toBe(false)
  })
})
