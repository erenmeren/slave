import { describe, expect, it } from 'vitest'
import { titleWithCount, waitingTotal } from '../src/components/app/AppSidebar'
import { waitingReason } from '../src/components/home/HomeView'
import { matches, specialitiesOf, specialityWord } from '../src/components/helpers/HelpersView'
import { capFields } from '../src/components/new/NewProject'
import { unprovenLines } from '../src/components/project/DecisionCard'
import { taskCounts } from '../src/components/project/OlderTasks'
import { headerAction, projectPollMs } from '../src/components/project/ProjectScreen'
import { proofSummary } from '../src/components/project/ProofSection'
import { resultSentence } from '../src/components/project/ResultSection'
import { buildWord } from '../src/components/project/SideColumn'
import { initialsOf, toneOf } from '../src/components/project/WhoIsWorking'
import { buildFixture, listItemFixture, projectFixture } from './fixtures/project'

/** The decisions each screen makes about what to show, as plain functions (lead UX design section 6). */
describe('the frame', () => {
  it('counts what waits across projects, archived ones left out, and leads the tab title with it', () => {
    expect(waitingTotal([listItemFixture({ waiting: 1 }), listItemFixture({ id: 'b', waiting: 2 }), listItemFixture({ id: 'c', waiting: 5, archived: true })])).toBe(3)
    expect(titleWithCount('Todo app · Slave of AI', 3)).toBe('(3) Todo app · Slave of AI')
    expect(titleWithCount('(3) Todo app · Slave of AI', 1)).toBe('(1) Todo app · Slave of AI')
    expect(titleWithCount('(3) Todo app · Slave of AI', 0)).toBe('Todo app · Slave of AI')
  })
})

describe('Home', () => {
  it('says why a project waits, in words', () => {
    expect(waitingReason(listItemFixture({ phase: 'needs_decision', stopReason: 'budget_spent' }))).toBe('The budget ran out.')
    expect(waitingReason(listItemFixture({ phase: 'needs_decision' }))).toBe('The build stopped before everything was proven.')
    expect(waitingReason(listItemFixture({ phase: 'ready_to_merge' }))).toBe('Ready to merge.')
    expect(waitingReason(listItemFixture({ flow: 'packages', phase: 'older' }))).toContain('supervisor-decisions')
  })
})

describe('New project', () => {
  it('turns the cap the card was given into the draft\'s budget and time limit', () => {
    expect(capFields('both', '20', '90')).toEqual({ budgetUsd: 20, timeLimitMs: 5_400_000 })
    expect(capFields('budget', '20', 'x')).toEqual({ budgetUsd: 20, timeLimitMs: null })
    expect(capFields('time', '', '90')).toEqual({ budgetUsd: null, timeLimitMs: 5_400_000 })
    expect(capFields('none', '', '')).toEqual({ budgetUsd: null, timeLimitMs: null })
  })

  it('is not ready with a cap it was asked for and not given', () => {
    expect(capFields('budget', '', '90')).toBeNull()
    expect(capFields('budget', '0', '90')).toBeNull()
    expect(capFields('both', '20', '5')).toBeNull()
    expect(capFields('time', '', '1441')).toBeNull()
    expect(capFields('time', '', '30.5')).toBeNull()
  })
})

describe('Project', () => {
  it('offers Stop while something runs, Continue while stopped, and neither otherwise', () => {
    expect(headerAction(projectFixture({ phase: 'building' }))).toBe('stop')
    expect(headerAction(projectFixture({ phase: 'starting' }))).toBe('stop')
    expect(headerAction(projectFixture({ phase: 'paused' }))).toBe('continue')
    expect(headerAction(projectFixture({ phase: 'failed' }))).toBe('continue')
    expect(headerAction(projectFixture({ phase: 'delivered' }))).toBeNull()
    expect(headerAction(projectFixture({ phase: 'building', archived: true }))).toBeNull()
    expect(headerAction(projectFixture({ flow: 'packages', phase: 'older' }))).toBeNull()
  })

  it('re-reads every 3 seconds while something runs and every 15 otherwise', () => {
    expect(projectPollMs(projectFixture({ phase: 'checking' }))).toBe(3_000)
    expect(projectPollMs(projectFixture({ phase: 'needs_decision' }))).toBe(15_000)
  })

  it('lists what is not proven, the smoke check first, and nothing for a pass or an unchecked row', () => {
    const build = buildFixture({
      failing: ['SMOKE'],
      proof: [
        { key: 'R1', text: 'a', result: 'pass', reason: 'ok', check: 'x', output: '', checks: 1 },
        { key: 'R2', text: 'b', result: 'disputed', reason: 'one said 500', check: 'x', output: '', checks: 2 },
        { key: 'R3', text: 'c', result: 'unverifiable', reason: null, check: null, output: null, checks: 1 },
        { key: 'R4', text: 'd', result: 'unchecked', reason: null, check: null, output: null, checks: 0 },
      ],
    })
    expect(unprovenLines(build)).toEqual([
      "The product's own smoke check failed: it did not start, or its script failed.",
      'Requirement 2: Checkers disagree — one said 500',
      "Requirement 3: Couldn't check",
    ])
  })

  it('sums the proof up in one line', () => {
    expect(proofSummary(buildFixture().proof ?? [], 2)).toBe("1 of 2 work · 1 doesn't work · checked 2 times")
  })

  it('says the result of a delivered, a waiting and a left build, and nothing while building', () => {
    expect(resultSentence(projectFixture({ phase: 'delivered', build: buildFixture({ mergedAt: '2026-10-05T10:00:00.000Z', mergeCommit: '1234567890' }) }))).toMatch(/^Merged into main at 1234567 on /u)
    expect(resultSentence(projectFixture({ phase: 'ready_to_merge' }))).toBe('Waiting for your merge.')
    expect(resultSentence(projectFixture({ phase: 'closed' }))).toBe('Left unmerged. The branch slaveofai/goal-v2 is kept.')
    expect(resultSentence(projectFixture({ phase: 'building' }))).toBeNull()
  })

  it('names each build\'s state in the Builds list', () => {
    expect(buildWord({ version: 1, leadState: 'delivered', stopReason: 'accepted_as_is', at: '' })).toBe('Delivered as it was')
    expect(buildWord({ version: 1, leadState: 'awaiting_decision', stopReason: 'no_progress', at: '' })).toBe('Waiting for you')
    expect(buildWord({ version: 1, leadState: null, stopReason: null, at: '' })).toBe('Older way')
  })

  it('draws a face with steady initials and colour', () => {
    expect(initialsOf('Lead')).toBe('LE')
    expect(initialsOf('backend-architect')).toBe('BA')
    expect(initialsOf('Riley Chen')).toBe('RC')
    expect(toneOf('Bea')).toBe(toneOf('Bea'))
  })

  it('counts an older project\'s tasks in words', () => {
    expect(taskCounts([{ id: '1', title: 'a', state: 'done', status: 'done' }, { id: '2', title: 'b', state: 'done', status: 'done' }, { id: '3', title: 'c', state: 'blocked', status: 'blocked' }])).toBe('2 Done · 1 Blocked')
  })
})

describe('Helpers', () => {
  const helper = { id: 'p', name: 'Bea', role: 'Backend Architect', description: 'Builds APIs.', speciality: 'engineering', skills: ['api-design', 'sql'], projects: [] }

  it('finds a specialist by any word of their name, role, line or skills', () => {
    expect(matches(helper, 'backend sql')).toBe(true)
    expect(matches(helper, 'design')).toBe(true)
    expect(matches(helper, 'frontend')).toBe(false)
    expect(matches(helper, '  ')).toBe(true)
  })

  it('orders the specialities busiest first and says them in words', () => {
    expect(specialitiesOf([helper, { ...helper, id: 'q', speciality: 'design' }, { ...helper, id: 'r' }, { ...helper, id: 's', speciality: null }])).toEqual([
      { key: 'engineering', count: 2 },
      { key: 'design', count: 1 },
    ])
    expect(specialityWord('project-management')).toBe('Project management')
  })
})
