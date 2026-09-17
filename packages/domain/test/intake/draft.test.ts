import { describe, expect, it } from 'vitest'
import { intakeDraftSchema, intakeRepositoryPath, intakeRepositorySlug, intakeStepLogSchema, type IntakeDraft } from '../../src/index.js'

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

  /**
   * FINAL REVIEW, IMPORTANT 8. A persona has exactly three managed people (`poolSlot` 1, 2, 3), so
   * a draft asking for four seats from one persona is asking for somebody who does not exist. The
   * fourth seat was never filled: `staffIntakeTeam` ran out of candidates and either skipped the
   * seat or minted an unmanaged person, so the draft the operator APPROVED and the team they got
   * were different teams -- and nothing told them which.
   *
   * Rejected at the schema, which is the boundary every path crosses: the model's own answer, an
   * operator's edit in the card, and `acceptIntake`'s re-parse of the stored draft.
   */
  it('refuses a fourth seat from one persona: only three of anybody exist', () => {
    const team = [
      { templateId: 'backend', runtimeRoles: ['backend'] },
      { templateId: 'backend', runtimeRoles: ['backend'] },
      { templateId: 'backend', runtimeRoles: ['backend'] },
      { templateId: 'backend', runtimeRoles: ['backend'] },
    ]
    const parsed = intakeDraftSchema.safeParse({ ...draft, team })

    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issue = parsed.error.issues.find((candidate) => candidate.path[0] === 'team')
    // The PATH names the offending seat, so a form can mark the row the person has to remove, and
    // the message names the persona and the limit rather than saying "invalid".
    expect(issue?.path).toEqual(['team', 3, 'templateId'])
    expect(issue?.message).toContain('backend')
    expect(issue?.message).toContain('three')
  })

  it('accepts exactly three seats from one persona -- three is the whole pool, not one too many', () => {
    const team = [
      { templateId: 'backend', runtimeRoles: ['backend'] },
      { templateId: 'backend', runtimeRoles: ['backend'] },
      { templateId: 'backend', runtimeRoles: ['backend'] },
      { templateId: 'reviewer', runtimeRoles: ['reviewer'] },
    ]
    expect(intakeDraftSchema.safeParse({ ...draft, team }).success).toBe(true)
  })

  it('counts per persona, not across the team: three each of four personas is twelve legal seats', () => {
    const team = ['a', 'b', 'c', 'd'].flatMap((templateId) =>
      [1, 2, 3].map(() => ({ templateId, runtimeRoles: ['backend'] })),
    )
    expect(team).toHaveLength(12)
    expect(intakeDraftSchema.safeParse({ ...draft, team }).success).toBe(true)
  })

  it('reports EVERY persona that is over the limit, and the first seat past three for each', () => {
    const team = [
      ...[1, 2, 3, 4].map(() => ({ templateId: 'backend', runtimeRoles: ['backend'] })),
      ...[1, 2, 3, 4, 5].map(() => ({ templateId: 'qa', runtimeRoles: ['qa'] })),
    ]
    const parsed = intakeDraftSchema.safeParse({ ...draft, team })

    expect(parsed.success).toBe(false)
    if (parsed.success) return
    // One issue per offending persona, at its FOURTH seat -- not one per surplus seat, which would
    // put two identical complaints on one persona and read as two separate problems.
    expect(parsed.error.issues.map((issue) => issue.path)).toEqual([
      ['team', 3, 'templateId'],
      ['team', 7, 'templateId'],
    ])
  })

  // The total cap is unchanged and still enforced on its own: thirteen seats is too many however
  // they are spread, and a team of thirteen distinct personas breaks no per-persona limit at all.
  it('keeps the twelve-seat team cap beside the per-persona one', () => {
    const team = Array.from({ length: 13 }, (_unused, index) => ({
      templateId: `persona-${String(index)}`,
      runtimeRoles: ['backend'],
    }))
    expect(intakeDraftSchema.safeParse({ ...draft, team }).success).toBe(false)
  })
})

describe('intakeRepositorySlug', () => {
  it('matches the accept-time directory slug, including unicode and punctuation-only names', () => {
    expect(intakeRepositorySlug('Public API')).toBe('public-api')
    expect(intakeRepositorySlug('  Checkout   Platform!! ')).toBe('checkout-platform')
    expect(intakeRepositorySlug('Ödeme Sistemi')).toBe('odeme-sistemi')
    expect(intakeRepositorySlug('***')).toBe('project')
    expect(intakeRepositorySlug('../etc')).toBe('etc')
    expect(intakeRepositorySlug('x'.repeat(100))).toBe('x'.repeat(80))
  })
})

describe('intakeRepositoryPath', () => {
  it('joins a POSIX absolute root and slug with the same separator shape as accept-time path join', () => {
    expect(intakeRepositoryPath('/home/me/projects', 'public-api')).toBe('/home/me/projects/public-api')
    expect(intakeRepositoryPath('/home/me/projects/', 'public-api')).toBe('/home/me/projects/public-api')
    expect(intakeRepositoryPath('/', 'public-api')).toBe('/public-api')
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
