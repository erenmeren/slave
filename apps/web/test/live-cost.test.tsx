// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BuildView } from '@slave-of-ai/control'
import { AnalyticsScreen } from '../src/components/analytics/AnalyticsScreen'
import { costOf, costTitleOf, diagramShape } from '../src/components/diagram/shape'
import { HomeView } from '../src/components/home/HomeView'
import { turnCostWord } from '../src/components/project/CostSection'
import { costNote, costWord } from '../src/components/project/PeopleTable'
import { ProjectScreen } from '../src/components/project/ProjectScreen'
import { ESTIMATE_TITLE, aboutUsd, runningEstimateLine, unpricedWord } from '../src/lib/estimate'
import { analyticsFixture } from './fixtures/analytics'
import { diagramFixture } from './fixtures/diagram'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { buildFixture, listItemFixture, projectFixture } from './fixtures/project'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/w/ws-1' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

const base = buildFixture()
const [lead, helper, checker] = base.people as [BuildView['people'][number], BuildView['people'][number], BuildView['people'][number]]
const [ended, open] = base.turns as [BuildView['turns'][number], BuildView['turns'][number]]

/** The fixture build with its open turn at about $3.20 so far, $1.10 of it its helper's. */
const running = (): BuildView =>
  buildFixture({
    people: [
      { ...lead, estimatedUsd: 5.9, estimatedRunningUsd: 2.1 },
      { ...helper, estimatedUsd: 1.1, estimatedRunningUsd: 1.1 },
      checker,
    ],
    turns: [{ ...ended, estimatedUsd: 3.7 }, { ...open, estimatedUsd: 3.2 }],
    spend: { ...base.spend, estimatedRunningUsd: 3.2, estimatedRunningLeadUsd: 3.2 },
  })

describe('how an estimate is said (live cost estimate)', () => {
  it('always says "about", and names what it is', () => {
    expect(aboutUsd(3.2)).toBe('about $3.20')
    expect(runningEstimateLine(3.2, [])).toBe('+ about $3.20 running (estimate)')
    expect(ESTIMATE_TITLE).toContain('estimate')
  })

  it('says a model has no price instead of a number', () => {
    expect(unpricedWord(['claude-new-9'])).toBe('no price known for claude-new-9')
    expect(runningEstimateLine(0, ['claude-new-9'])).toBe('Running: no price known for claude-new-9')
    expect(runningEstimateLine(0, [])).toBeNull()
  })

  it('a person’s cost: reported as it is, an estimate as "about", each with its small print', () => {
    // Reported, nothing running: the figure and no note.
    expect(costWord(checker)).toBe('$0.25')
    expect(costNote(checker)).toBeNull()
    // A helper has no reported figure: its estimate, marked as inside the lead's.
    expect(costWord({ ...helper, estimatedUsd: 1.1 })).toBe('about $1.10')
    expect(costNote({ ...helper, estimatedUsd: 1.1 })).toBe("estimate · in the lead's cost")
    expect(costWord(helper)).toBe("in the lead's")
    // A lead with ended turns and one running: the reported sum, then the estimate, never one figure.
    expect(costWord({ ...lead, estimatedRunningUsd: 2.1 })).toBe('$3.90 + about $2.10 so far')
    expect(costWord({ ...lead, costUsd: null, estimatedRunningUsd: 2.1 })).toBe('about $2.10 so far')
    expect(costNote({ ...lead, estimatedRunningUsd: 2.1 })).toBe('estimate')
    // No estimate yet, or a model nobody priced.
    expect(costWord({ ...lead, costUsd: null })).toBe('when it ends')
    expect(costWord({ ...lead, costUsd: null, unpricedModels: ['claude-new-9'] })).toBe('no price known for claude-new-9')
  })

  it('a turn’s cost: the estimate while it runs, the reported figure once there is one', () => {
    expect(turnCostWord(open)).toBe('when it ends')
    expect(turnCostWord({ ...open, estimatedUsd: 2.1 })).toBe('about $2.10 so far')
    expect(turnCostWord({ ...open, unpricedModels: ['claude-new-9'] })).toBe('no price known for claude-new-9')
    // A reported figure is never replaced by the estimate kept beside it.
    expect(turnCostWord({ ...ended, estimatedUsd: 3.7 })).toBe('$3.90')
    expect(turnCostWord({ ...ended, costUsd: null })).toBe('not reported')
    expect(turnCostWord({ ...ended, costUsd: null, estimatedUsd: 3.7 })).toBe('not reported · about $3.70 (estimate)')
  })

  it('the diagram’s cost words: a helper’s estimate, an open session’s so far', () => {
    expect(costOf('helper', null, true, 1.1)).toBe('about $1.10')
    expect(costTitleOf('helper', null, true, 1.1)).toContain('estimate')
    expect(costOf('lead', null, true, 2.1)).toBe('about $2.10 so far')
    expect(costTitleOf('lead', null, true, 2.1)).toContain('estimate')
    // A reported figure stays the figure, and carries no estimate's title.
    expect(costOf('lead', 3.9, false, 3.7)).toBe('$3.90')
    expect(costTitleOf('lead', 3.9, false, 3.7)).toBeNull()
    expect(costOf('checker', null, false, 0.3)).toBe('cost not reported')
  })

  it('draws a helper session’s estimate on its card', () => {
    const fixture = diagramFixture()
    const shape = diagramShape({ ...fixture, sessions: fixture.sessions.map((one) => (one.id === 'call-a' ? { ...one, estimatedUsd: 0.4 } : one)) })
    const card = shape.cards.find((one) => one.data.sessionId === 'call-a')
    expect(card?.data.cost).toBe('about $0.40')
    expect(card?.data.costTitle).toContain('estimate')
  })
})

describe('the Project screen while a turn runs (live cost estimate)', () => {
  it('keeps the reported spend as it is and says the estimate on a line of its own', () => {
    const project = projectFixture({ build: running() })
    stubFetch(() => ({ body: { project } }))
    render(<ProjectScreen initial={project} />)

    const spent = screen.getByTestId('stat-spent')
    expect(spent.textContent).toContain('$4.20 of $20')
    expect(screen.getByTestId('stat-spent-detail').textContent).toBe('+ about $3.20 running (estimate)')
    expect(screen.getByTestId('stat-spent-detail').getAttribute('title')).toBe(ESTIMATE_TITLE)
    // The bar's own value is the reported spend; the estimate is a piece of its own after it.
    const pieces = screen.getAllByTestId('limit-bar-estimate')
    expect(Number.parseFloat(pieces[0]?.style.left ?? '')).toBeCloseTo(21, 6)
    expect(Number.parseFloat(pieces[0]?.style.width ?? '')).toBeCloseTo(16, 6)

    expect(screen.getByTestId('cost-lead').textContent).toContain('$3.90')
    expect(screen.getByTestId('cost-lead-running').textContent).toBe('+ about $3.20 running (estimate)')
    expect(screen.getByTestId('cost-running').textContent).toContain('about $3.20 running (estimate)')
    expect(screen.getByTestId('limits-spent').textContent).toContain('$4.20 of $20')
    expect(screen.getByTestId('limits-running').textContent).toBe('+ about $3.20 running (estimate)')

    const costs = screen.getAllByTestId('person-cost').map((cell) => cell.textContent)
    expect(costs[0]).toBe('$3.90 + about $2.10 so farestimate')
    expect(costs[1]).toBe("about $1.10estimate · in the lead's cost")
    expect(costs[2]).toBe('$0.25')
    const turns = screen.getAllByTestId('turn-cost').map((cell) => cell.textContent)
    expect(turns).toEqual(['$3.90', 'about $3.20 so far'])
  })

  it('shows no estimate where there is none: the screen reads as it did', () => {
    const project = projectFixture()
    stubFetch(() => ({ body: { project } }))
    render(<ProjectScreen initial={project} />)
    expect(screen.getByTestId('stat-spent-detail').textContent).toBe('The running turn is added when it ends')
    expect(screen.queryByTestId('limit-bar-estimate')).toBeNull()
    expect(screen.queryByTestId('cost-lead-running')).toBeNull()
    expect(screen.queryByTestId('limits-running')).toBeNull()
    expect(screen.getAllByTestId('turn-cost').map((cell) => cell.textContent)).toEqual(['$3.90', 'when it ends'])
  })

  it('says a running model has no price instead of a number', () => {
    const project = projectFixture({ build: buildFixture({ spend: { ...base.spend, unpricedModels: ['claude-new-9'] }, turns: [ended, { ...open, unpricedModels: ['claude-new-9'] }] }) })
    stubFetch(() => ({ body: { project } }))
    render(<ProjectScreen initial={project} />)
    expect(screen.getByTestId('stat-spent-detail').textContent).toBe('Running: no price known for claude-new-9')
    expect(screen.getAllByTestId('turn-cost')[1]?.textContent).toBe('no price known for claude-new-9')
  })
})

describe('Home and Analytics while something runs (live cost estimate)', () => {
  it('Home: the estimate beside each reported sum, never in it', () => {
    const projects = [listItemFixture({ estimatedRunningUsd: 3.2 }), listItemFixture({ id: 'b', name: 'Other', totalSpentUsd: 1, estimatedRunningUsd: 0 })]
    stubFetch(() => ({ body: { projects, happening: [] } }))
    render(<HomeView initial={projects} />)
    expect(screen.getByTestId('home-spent').textContent).toContain('$7.20')
    expect(screen.getByTestId('home-spent-detail').textContent).toBe('+ about $3.20 running (estimate)')
    const lines = screen.getAllByTestId('card-running')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.textContent).toBe('+ about $3.20 running (estimate)')
  })

  it('Analytics: the open sessions’ estimate under the sum and on its build', () => {
    const fixture = analyticsFixture()
    const view = analyticsFixture({
      money: {
        ...fixture.money,
        estimatedRunningUsd: 3.2,
        byProject: fixture.money.byProject.map((row) => (row.projectId === 'b' ? { ...row, estimatedRunningUsd: 3.2 } : row)),
        byBuild: fixture.money.byBuild.map((row) => (row.projectId === 'b' ? { ...row, estimatedRunningUsd: 3.2 } : row)),
      },
    })
    stubFetch(() => ({ body: { analytics: view } }))
    render(<AnalyticsScreen initial={view} />)
    expect(screen.getByTestId('figure-spent').textContent).toContain('at least $14.75')
    expect(screen.getByTestId('figure-spent').textContent).toContain('+ about $3.20 running (estimate)')
    expect(screen.getByTestId('money-running').textContent).toContain('about $3.20 so far: an estimate')
    expect(screen.getAllByTestId('build-running').map((line) => line.textContent)).toEqual(['+ about $3.20 running (estimate)'])
  })
})
