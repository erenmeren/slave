import { describe, expect, it } from 'vitest'
import { LEAD_RULES, renderLeadBrief, renderLeadContinuation, renderLeadTurnNote } from '../../src/lead/index.js'

const ROUTING = ['"verdict"', '"task graph"', '"candidateIndex"', '"sources"', '"replan"', '"personas"', '"intakeAnswer"', '"supervisorReply"', '<slave-verification>', '<slave-ask>', '<slave-report>']

const brief = renderLeadBrief({
  goalVersion: 2,
  goal: 'Build the status page. It must say "verdict" nowhere.',
  requirements: [{ key: 'R1', text: 'GET /health answers 200' }, { key: 'RUN', text: 'The product starts as its README says' }],
  decisions: [{ title: 'Database', decision: 'SQLite, one file' }],
  budget: { totalUsd: 30, shareUsd: 24, spentUsd: 1.5 },
  timeLeftMs: 90 * 60_000,
  roster: [{ slug: 'backend-developer', description: 'builds APIs' }],
})

describe('the lead\'s brief (lead-flow spec B3)', () => {
  it('carries the goal, every requirement, the decisions, the share and the time left, and the roster', () => {
    expect(brief).toContain('THE GOAL (v2)')
    expect(brief).toContain('R1: GET /health answers 200')
    expect(brief).toContain('RUN: The product starts as its README says')
    expect(brief).toContain('- Database: SQLite, one file')
    expect(brief).toContain('Your share is $24.00; $6.00 is kept for proving the result. Spent of your share so far: $1.50.')
    expect(brief).toContain('about 90 minutes')
    expect(brief).toContain('- backend-developer: builds APIs')
  })

  it('treats the goal as data: a routing literal in it is defused', () => {
    expect(brief).not.toContain('"verdict"')
  })

  it('says so when there is no budget, no time limit and no roster', () => {
    const bare = renderLeadBrief({ goalVersion: 1, goal: 'g', requirements: [], decisions: [], budget: null, timeLeftMs: null, roster: [] })
    expect(bare).toContain('No budget is set for this goal.')
    expect(bare).toContain('No time limit is set.')
    expect(bare).not.toContain('YOUR ROSTER')
    expect(bare).not.toContain('DECISIONS ALREADY MADE')
  })

  it('states the rules of the flow and offers no way to ask', () => {
    expect(LEAD_RULES).toContain('docs/DECISIONS.md')
    expect(LEAD_RULES).toContain('Nobody answers questions')
    expect(LEAD_RULES).toContain('closing report')
    for (const literal of ROUTING) expect(LEAD_RULES).not.toContain(literal)
  })
})

describe('a later turn\'s note', () => {
  const base = { baseBranch: 'main', budgetLeftUsd: 4.8, timeLeftMs: 20 * 60_000 }

  it('hands a rework its evidence', () => {
    const note = renderLeadTurnNote({ ...base, kind: 'rework', note: 'R1: GET /health answers 200\ncheck: curl localhost:8080/health\noutput: 404' })
    expect(note).toContain('independent verification')
    expect(note).toContain('output: 404')
    expect(note).toContain('Left of your share: $4.80.')
    expect(note).toContain('about 20 minutes')
  })

  it('tells a wrap-up to commit and report, and an answer turn to decide and record', () => {
    expect(renderLeadTurnNote({ ...base, kind: 'wrap_up', note: null })).toContain('Wrap up now')
    expect(renderLeadTurnNote({ ...base, kind: 'answer', note: null })).toContain('Decide it yourself, record the decision and its reason in docs/DECISIONS.md')
  })

  it('names the base branch in a base turn and says a continued session was interrupted', () => {
    expect(renderLeadTurnNote({ ...base, kind: 'base', note: null })).toContain('git merge main')
    expect(renderLeadTurnNote({ ...base, kind: 'continue', note: 'the daemon restarted' })).toContain('the daemon restarted')
  })

  it('never carries a routing literal of its own', () => {
    for (const kind of ['rework', 'wrap_up', 'continue', 'answer', 'base'] as const) {
      const note = renderLeadTurnNote({ ...base, kind, note: null })
      for (const literal of ROUTING) expect(note).not.toContain(literal)
    }
  })

  it('tells a new session where the lost one stood', () => {
    const block = renderLeadContinuation({ lastCommits: 'abc1234 add the health route', then: 'carry on' })
    expect(block).toContain('its transcript is gone')
    expect(block).toContain('abc1234 add the health route')
    expect(block).toContain('carry on')
  })
})
