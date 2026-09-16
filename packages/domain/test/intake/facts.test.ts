import { describe, expect, it } from 'vitest'
import { factsSummary, intakeFactsSchema, type IntakeFacts } from '../../src/index.js'

const facts: IntakeFacts = {
  paths: [
    {
      path: '/home/x/api',
      exists: true,
      isRepository: true,
      isEmptyDir: false,
      branches: ['main', 'develop'],
      defaultBranch: 'main',
      verify: [
        { command: 'npm test', source: 'package.json scripts.test' },
        { command: 'npm run typecheck', source: 'package.json scripts.typecheck' },
      ],
    },
  ],
  reposRoot: '/home/x/projects',
  existingCompanies: [{ id: 'c1', name: 'Atlas Software' }],
  catalogue: [{ templateId: 't1', name: 'Backend Developer', division: 'engineering', role: 'backend' }],
}

describe('IntakeFacts', () => {
  it('parses what detection produces', () => {
    expect(intakeFactsSchema.safeParse(facts).success).toBe(true)
  })

  it('refuses a path fact with no path', () => {
    const broken = { ...facts, paths: [{ ...facts.paths[0], path: '' }] }
    expect(intakeFactsSchema.safeParse(broken).success).toBe(false)
  })

  it('summarises a repository the way the conversation shows it (R6)', () => {
    expect(factsSummary(facts)).toBe(
      '/home/x/api is a git repository on main (also develop); found npm test, npm run typecheck',
    )
  })

  it('says a folder is not a repository, and whether it is empty', () => {
    const blank: IntakeFacts = {
      ...facts,
      paths: [{ path: '/home/x/new', exists: true, isRepository: false, isEmptyDir: true, branches: [], defaultBranch: null, verify: [] }],
    }
    expect(factsSummary(blank)).toBe('/home/x/new is an empty folder, not a git repository yet')
  })

  it('says a path does not exist rather than guessing', () => {
    const missing: IntakeFacts = {
      ...facts,
      paths: [{ path: '/home/x/nope', exists: false, isRepository: false, isEmptyDir: false, branches: [], defaultBranch: null, verify: [] }],
    }
    expect(factsSummary(missing)).toBe('/home/x/nope does not exist yet')
  })

  it('is empty when nothing was found, so the caller can skip the fact row entirely', () => {
    expect(factsSummary({ ...facts, paths: [] })).toBe('')
  })
})
