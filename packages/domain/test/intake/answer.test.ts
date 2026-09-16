import { describe, expect, it } from 'vitest'
import { parseIntakeAnswer, type IntakeDraft, type IntakeFacts } from '../../src/index.js'

const facts: IntakeFacts = {
  paths: [
    {
      path: '/home/x/api',
      exists: true,
      isRepository: true,
      isEmptyDir: false,
      branches: ['main'],
      defaultBranch: 'main',
      verify: [{ command: 'npm test', source: 'package.json scripts.test' }],
    },
  ],
  reposRoot: '/home/x/projects',
  existingCompanies: [],
  catalogue: [],
}

const draft: IntakeDraft = {
  name: 'Public API',
  goal: 'Add rate limiting',
  repo: { mode: 'existing', path: '/home/x/api' },
  baseBranch: 'main',
  verifyCommands: [{ command: 'npm test', source: 'detected' }],
  setupCommands: [],
  budgetUsd: 20,
  provider: null,
  team: [],
}

const wrap = (answer: unknown): string => `Sure! ${JSON.stringify({ intakeAnswer: answer })}`

describe('parseIntakeAnswer', () => {
  it('reads an ask', () => {
    const parsed = parseIntakeAnswer(wrap({ kind: 'ask', text: 'Where is the repository?' }), facts)
    expect(parsed).toEqual({ answer: { kind: 'ask', text: 'Where is the repository?' }, downgraded: null })
  })

  it('reads a draft whose every command was really detected', () => {
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'Here is what I would create.', draft }), facts)
    expect(parsed?.answer.kind).toBe('draft')
    expect(parsed?.downgraded).toBeNull()
  })

  it('completes a proposed non-empty team with the roles planning and review require', () => {
    const staffedFacts = {
      ...facts,
      catalogue: [{ templateId: 'backend', name: 'Backend Engineer', division: 'engineering', role: 'engineer' }],
    }
    const staffedDraft = { ...draft, team: [{ templateId: 'backend', runtimeRoles: ['backend'] }] }
    const parsed = parseIntakeAnswer(
      wrap({ kind: 'draft', text: 'Here is what I would create.', draft: staffedDraft }),
      staffedFacts,
    )
    expect(parsed?.answer.kind === 'draft' ? parsed.answer.draft.team[0]?.runtimeRoles : []).toEqual([
      'backend',
      'manager',
      'reviewer',
    ])
  })

  it('reads only the FIRST object, so a bad answer gets no second go', () => {
    const two = `${JSON.stringify({ intakeAnswer: { kind: 'ask', text: 'first' } })} ${JSON.stringify({ intakeAnswer: { kind: 'ask', text: 'second' } })}`
    expect(parseIntakeAnswer(two, facts)?.answer).toEqual({ kind: 'ask', text: 'first' })
  })

  it('answers null for prose with no JSON in it at all', () => {
    expect(parseIntakeAnswer('I think we should start with the database.', facts)).toBeNull()
  })

  it('answers null when the marker key is missing, so the fake and the parser agree on one word', () => {
    expect(parseIntakeAnswer(JSON.stringify({ kind: 'ask', text: 'hi' }), facts)).toBeNull()
  })

  it('DOWNGRADES a draft carrying a verify command nobody detected, keeping the model text', () => {
    const invented = { ...draft, verifyCommands: [{ command: 'npm run e2e', source: 'detected' as const }] }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'Shall I use npm run e2e?', draft: invented }), facts)
    expect(parsed?.answer).toEqual({ kind: 'ask', text: 'Shall I use npm run e2e?' })
    expect(parsed?.downgraded).toContain('npm run e2e')
  })

  it('DOWNGRADES a draft that marks its own command as the operator s (R9)', () => {
    const forged = { ...draft, verifyCommands: [{ command: 'npm test', source: 'operator' as const }] }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft: forged }), facts)
    expect(parsed?.answer.kind).toBe('ask')
    expect(parsed?.downgraded).toContain('operator')
  })

  it('DOWNGRADES a proposed command on an EXISTING repository -- there was something to detect', () => {
    const proposed = { ...draft, verifyCommands: [{ command: 'npm test', source: 'draft' as const }] }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft: proposed }), facts)
    expect(parsed?.answer.kind).toBe('ask')
  })

  it('ACCEPTS a proposed command on a NEW repository -- there is nothing to detect yet', () => {
    const fresh: IntakeDraft = {
      ...draft,
      repo: { mode: 'new', path: null },
      verifyCommands: [{ command: 'npm test', source: 'draft' }],
    }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft: fresh }), facts)
    expect(parsed?.answer.kind).toBe('draft')
    expect(parsed?.downgraded).toBeNull()
  })

  it('downgrades every detected command when there are no facts at all', () => {
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft }), null)
    expect(parsed?.answer.kind).toBe('ask')
  })
})

const twoPathFacts: IntakeFacts = {
  paths: [
    {
      path: '/home/x/api',
      exists: true,
      isRepository: true,
      isEmptyDir: false,
      branches: ['main'],
      defaultBranch: 'main',
      verify: [{ command: 'npm test', source: 'package.json scripts.test' }],
    },
    {
      path: '/home/x/worker',
      exists: true,
      isRepository: true,
      isEmptyDir: false,
      branches: ['main'],
      defaultBranch: 'main',
      verify: [{ command: 'pytest', source: 'pyproject.toml' }],
    },
  ],
  reposRoot: '/home/x/projects',
  existingCompanies: [],
  catalogue: [],
}

describe('parseIntakeAnswer -- the detected check is per repository', () => {
  it('DOWNGRADES a command detected on a path OTHER than the one the draft chose', () => {
    const wrongRepo = {
      ...draft,
      repo: { mode: 'existing' as const, path: '/home/x/api' },
      verifyCommands: [{ command: 'pytest', source: 'detected' as const }],
    }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft: wrongRepo }), twoPathFacts)
    expect(parsed?.answer.kind).toBe('ask')
    expect(parsed?.downgraded).toContain('pytest')
  })

  it('ACCEPTS a command detected on the SAME path the draft chose, with another path also in facts', () => {
    const rightRepo = {
      ...draft,
      repo: { mode: 'existing' as const, path: '/home/x/api' },
      verifyCommands: [{ command: 'npm test', source: 'detected' as const }],
    }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft: rightRepo }), twoPathFacts)
    expect(parsed?.answer.kind).toBe('draft')
    expect(parsed?.downgraded).toBeNull()
  })

  it('DOWNGRADES a detected command on a NEW repository -- nothing has been detected there yet', () => {
    const newRepo = {
      ...draft,
      repo: { mode: 'new' as const, path: null },
      verifyCommands: [{ command: 'npm test', source: 'detected' as const }],
    }
    const parsed = parseIntakeAnswer(wrap({ kind: 'draft', text: 'ok', draft: newRepo }), twoPathFacts)
    expect(parsed?.answer.kind).toBe('ask')
  })
})
