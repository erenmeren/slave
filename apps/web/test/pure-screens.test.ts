import { describe, expect, it } from 'vitest'
import { titleWithCount, waitingTotal } from '../src/components/app/AppSidebar'
import { waitingReason } from '../src/components/home/HomeView'
import { capFields } from '../src/components/new/NewProject'
import { skillMatches } from '../src/components/people/SkillsTab'
import { EMPTY_PEOPLE_QUERY, activeFilterCount, deleteConsequences, divisionWord, fieldPatch, linesOf, peopleHref, peopleQueryString, personaQueryString, plainLine, roleLine, rosterLine, skillSourceWord, stepText, tabOf } from '../src/components/people/words'
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

describe('People', () => {
  it('says a division, a role and where a skill comes from in words', () => {
    expect(divisionWord('project-management')).toBe('Project management')
    expect(divisionWord('gis')).toBe('GIS')
    expect(divisionWord(null)).toBe('No division')
    expect(roleLine('design', 'design')).toBeNull()
    expect(roleLine('Tester', null)).toBe('Tester')
    expect(roleLine('backend-engineer', 'engineering')).toBe('Backend engineer')
    expect(skillSourceWord('library:ecc')).toBe('ecc')
    expect(skillSourceWord('personal')).toBe('personal')
  })

  it('builds the list\'s query from the filters, and nothing from no filter', () => {
    expect(peopleQueryString(EMPTY_PEOPLE_QUERY)).toBe('')
    expect(peopleQueryString({ q: '  api design ', division: 'none', skillId: 's1', templateId: 't1', onRoster: true, noSkills: true })).toBe('q=api+design&division=none&skill=s1&persona=t1&roster=1&noSkills=1')
    expect(activeFilterCount(EMPTY_PEOPLE_QUERY)).toBe(0)
    expect(activeFilterCount({ ...EMPTY_PEOPLE_QUERY, q: 'x', onRoster: true })).toBe(2)
    expect(personaQueryString({ q: '', division: null, active: null })).toBe('')
    expect(personaQueryString({ q: 'ux', division: 'design', active: false })).toBe('q=ux&division=design&active=0')
  })

  it('keeps what is open in the address', () => {
    expect(peopleHref({ tab: 'people', personId: null, personaId: null, skillId: null, templateId: null })).toBe('/people')
    expect(peopleHref({ tab: 'personas', personId: null, personaId: 't1', skillId: null, templateId: null })).toBe('/people?tab=personas&persona=t1')
    expect(peopleHref({ tab: 'people', personId: 'p1', personaId: null, skillId: 's1', templateId: 't1' })).toBe('/people?person=p1&skill=s1&from=t1')
    expect(tabOf('skills')).toBe('skills')
    expect(tabOf('nonsense')).toBe('people')
    expect(tabOf(undefined)).toBe('people')
  })

  it('turns an editor\'s text into the field it saves, or says why it cannot', () => {
    expect(linesOf('1. Ask\n\n- Build\n  * Prove it  \n2) Ship')).toEqual(['Ask', 'Build', 'Prove it', 'Ship'])
    expect(fieldPatch('workflow', 'Ask\nBuild')).toEqual({ value: ['Ask', 'Build'] })
    expect(fieldPatch('mission', '  Ship it.  ')).toEqual({ value: 'Ship it.' })
    expect(fieldPatch('mission', 'x'.repeat(241))).toEqual({ problem: 'Keep this to 240 characters (it has 241).' })
    expect(fieldPatch('body', 'x'.repeat(5000))).toEqual({ value: 'x'.repeat(5000) })
    expect(fieldPatch('workflow', `ok\n${'y'.repeat(241)}`)).toEqual({ problem: 'Line 2 is longer than 240 characters.' })
    expect(fieldPatch('capabilities', Array.from({ length: 41 }, (_, n) => `c${String(n)}`).join('\n'))).toEqual({ problem: 'At most 40 lines (there are 41).' })
  })

  it('draws a step and a line without the catalogue\'s own marks', () => {
    expect(stepText('Step 1: Read the request')).toBe('Read the request')
    expect(stepText('2. Build')).toBe('Build')
    expect(stepText('Build 3 things')).toBe('Build 3 things')
    expect(plainLine('**Handoff**: see `notes.md`')).toBe('Handoff: see notes.md')
  })

  it('says which rosters list somebody in a few words', () => {
    expect(rosterLine([])).toBeNull()
    expect(rosterLine([{ name: 'Todo' }])).toBe('On Todo')
    expect(rosterLine([{ name: 'Todo' }, { name: 'Shop' }])).toBe('On Todo and Shop')
    expect(rosterLine([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toBe('On 3 projects')
  })

  it('lists what a delete takes, and says so when it takes nothing else', () => {
    const skill = { skillId: 's', name: 'sql', providerName: 'local', description: '', fromPersona: false, missing: false }
    expect(deleteConsequences({ name: 'Bea', ownInstructions: null, skills: [{ ...skill, state: 'persona' }], projects: [{ name: 'Todo', listed: false }], footprint: { projects: [], runs: 0 }, persona: null })).toEqual([
      'Nothing else: they have no instructions, skill changes, projects or runs of their own.',
    ])
    expect(
      deleteConsequences({ name: 'Bea', ownInstructions: 'Be brief.', skills: [{ ...skill, state: 'granted' }, { ...skill, skillId: 't', state: 'revoked' }], projects: [{ name: 'Todo', listed: true }, { name: 'Shop', listed: false }], footprint: { projects: ['Older'], runs: 1 }, persona: { name: 'Backend' } }),
    ).toEqual(['Their own instructions.', '2 skill changes made for them.', 'Their place on the helper list of Todo.', 'Their seat in Older.', '1 past run of theirs, with what each recorded.'])
  })

  it('finds a skill by any word of its name, source or description', () => {
    const skill = { name: 'api-design', providerName: 'library:ecc', description: 'REST API design patterns' }
    expect(skillMatches(skill, 'rest ecc')).toBe(true)
    expect(skillMatches(skill, 'graphql')).toBe(false)
    expect(skillMatches(skill, ' ')).toBe(true)
  })
})
