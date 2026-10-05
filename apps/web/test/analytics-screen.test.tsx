// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AnalyticsScreen } from '../src/components/analytics/AnalyticsScreen'
import { evidenceOrigin } from '../src/components/analytics/EvidenceSection'
import { analyticsApi, analyticsHref, dayWord, gapSentence, labelledDays, moneyColumns, moneyWord, niceCeiling, partWord, perStepWord, rateWord, seriesOf } from '../src/components/analytics/words'
import { analyticsFixture, emptyAnalytics } from './fixtures/analytics'
import { stubBrowser, stubFetch } from './fixtures/dom'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/analytics' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

const WHOLE = { unmeasuredSessions: 0, liveSessions: 0 }

describe('the words of Analytics', () => {
  it('keeps the choice of project and period in the address, the default bare', () => {
    expect(analyticsHref(null, 30)).toBe('/analytics')
    expect(analyticsHref(null, 7)).toBe('/analytics?days=7')
    expect(analyticsHref('p 1', null)).toBe('/analytics?project=p+1&days=all')
    expect(analyticsApi('p1', 30)).toBe('/api/analytics?project=p1')
  })

  it('never says a sum is whole when a session is missing from it, and never calls an unknown a zero', () => {
    expect(moneyWord(4.2, WHOLE)).toBe('$4.20')
    expect(moneyWord(0, WHOLE)).toBe('$0')
    expect(moneyWord(4.2, { unmeasuredSessions: 1, liveSessions: 0 })).toBe('at least $4.20')
    expect(moneyWord(0, { unmeasuredSessions: 0, liveSessions: 1 })).toBe('not reported yet')
    expect(moneyWord(0, { unmeasuredSessions: 2, liveSessions: 0 })).toBe('not reported')
    expect(partWord(0)).toBe('—')
    expect(partWord(1.5)).toBe('$1.50')
    expect(gapSentence(WHOLE)).toBeNull()
    expect(gapSentence({ unmeasuredSessions: 2, liveSessions: 1 })).toBe('1 session is still open, and a session reports its cost when it ends; 2 sessions ended without reporting a cost.')
  })

  it('divides a cost by its steps only when there is something to divide', () => {
    expect(perStepWord(10, 0, WHOLE)).toBe('—')
    expect(perStepWord(0, 50, WHOLE)).toBe('—')
    expect(perStepWord(12.5, 500, WHOLE)).toBe('$0.03')
    expect(perStepWord(0.05, 83, WHOLE)).toBe('under $0.01')
    expect(perStepWord(0.05, 83, { unmeasuredSessions: 0, liveSessions: 1 })).toBe('—')
    expect(perStepWord(12.5, 250, { unmeasuredSessions: 1, liveSessions: 0 })).toBe('at least $0.05')
  })

  it('claims a rate only with enough judged', () => {
    expect(rateWord({ pct: 80, judged: 5 })).toBe('80% of 5')
    expect(rateWord({ pct: null, judged: 2 })).toBe('Not enough evidence yet')
    expect(rateWord({ pct: null, judged: 0 })).toBe('Not judged yet')
  })

  it('scales and labels a chart: a round ceiling, every day of a week, a few of a month, the newest always', () => {
    expect([niceCeiling(0), niceCeiling(0.17), niceCeiling(36.3), niceCeiling(83), niceCeiling(2400)]).toEqual([1, 0.2, 50, 100, 5000])
    expect(dayWord('2026-10-05')).toBe('Oct 5')
    expect([...labelledDays(7)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...labelledDays(30)].sort((a, b) => a - b)).toEqual([5, 11, 17, 23, 29])
  })

  it('stacks the four biggest spenders by name and the rest together', () => {
    const projects = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase(), archived: false }))
    const days = [{ day: '2026-10-05', totalUsd: 21, byProject: [6, 5, 4, 3, 2, 1].map((usd, index) => ({ projectId: projects[index]?.id ?? '', usd })) }]
    const series = seriesOf(days, projects)
    expect(series.map((one) => one.name)).toEqual(['A', 'B', 'C', 'D', 'Other projects'])
    expect(moneyColumns(days, series)[0]?.segments.map((segment) => [segment.name, segment.value])).toEqual([['A', 6], ['B', 5], ['C', 4], ['D', 3], ['Other projects', 3]])
  })

  it('says where the evidence came from', () => {
    expect(evidenceOrigin({ profiles: [], models: [], records: 0, leadFlowRecords: 0 })).toBe('No session has ended with a record yet.')
    expect(evidenceOrigin({ profiles: [], models: [], records: 4, leadFlowRecords: 0 })).toContain('All 4 records come from projects built the older way.')
    expect(evidenceOrigin({ profiles: [], models: [], records: 9, leadFlowRecords: 2 })).toContain('2 of 9 records come from projects a lead builds')
  })
})

describe('Analytics', () => {
  it('stands deliberately empty: no chart of nothing, no $0.00 passed off as a figure, each section saying why it is bare', () => {
    stubFetch(() => ({ body: { analytics: emptyAnalytics() } }))
    render(<AnalyticsScreen initial={emptyAnalytics()} />)
    expect(screen.getByTestId('figure-spent').textContent).toContain('$0')
    expect(screen.getByTestId('figure-building').textContent).toContain('—')
    expect(screen.getByTestId('money-chart-empty').textContent).toBe('Nothing was spent in the last 30 days.')
    expect(screen.getByTestId('money-by-project-empty').textContent).toBe('No projects yet.')
    expect(screen.getByTestId('money-by-build').textContent).toContain('No build was worked on in the last 30 days.')
    expect(screen.getByTestId('steps-chart-empty').textContent).toBe('Nobody made a step in the last 30 days.')
    expect(screen.getByTestId('verdicts').textContent).toContain('No check ran in the last 30 days.')
    expect(screen.getByTestId('helpers-empty').textContent).toContain('No lead handed work to a helper')
    expect(screen.getByTestId('evidence-empty').textContent).toContain('Not enough evidence yet.')
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('says a first build with its turn still open as it is: nothing reported yet, never a zero', () => {
    const view = emptyAnalytics({
      projects: [{ id: 'a', name: 'First', archived: false }],
      money: { ...emptyAnalytics().money, liveSessions: 1, byDay: [{ day: '2026-10-05', totalUsd: 0, byProject: [] }], byProject: [{ projectId: 'a', name: 'First', archived: false, flow: 'lead', builds: 1, buildingUsd: 0, checkingUsd: 0, steeringUsd: 0, totalUsd: 0, budgetUsd: null, budgetSpentUsd: 0, unmeasuredSessions: 0, liveSessions: 1 }] },
    })
    stubFetch(() => ({ body: { analytics: view } }))
    render(<AnalyticsScreen initial={view} />)
    expect(screen.getByTestId('figure-spent').textContent).toContain('not reported yet')
    expect(screen.getByTestId('money-gaps').textContent).toBe('1 session is still open, and a session reports its cost when it ends.')
    expect(screen.getByTestId('money-chart-empty').textContent).toContain('No session has reported a cost yet.')
    expect(screen.getByTestId('project-money-row').textContent).toContain('not reported yet')
    expect(screen.getByTestId('project-money-row').textContent).toContain('1 open')
  })

  it('shows the money: the total as "at least", a column per day stacked by project, a row per project and per build', () => {
    const view = analyticsFixture()
    stubFetch(() => ({ body: { analytics: view } }))
    render(<AnalyticsScreen initial={view} />)
    expect(screen.getByTestId('figure-spent').textContent).toContain('at least $14.75')
    const columns = within(screen.getByTestId('money-chart')).getAllByTestId('money-chart-column')
    expect(columns).toHaveLength(7)
    expect(columns[5]?.getAttribute('data-value')).toBe('10.25')
    expect(columns[5]?.querySelectorAll('[data-series]')).toHaveLength(2)
    expect(columns[0]?.querySelectorAll('[data-series]')).toHaveLength(0)
    expect(within(screen.getByTestId('chart-legend')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Invoice service', 'Todo app'])

    const projects = screen.getAllByTestId('project-money-row')
    expect(projects[0]?.textContent).toContain('Invoice service')
    expect(projects[0]?.textContent).toContain('$12.50')
    expect(projects[0]?.textContent).toContain('25%')
    expect(projects[1]?.textContent).toContain('at least $2.25')
    expect(projects[1]?.textContent).toContain('none set')
    expect(projects[1]?.textContent).toContain('1 open · 1 without a cost')
    expect(within(projects[0] as HTMLElement).getByRole('link', { name: 'Invoice service' }).getAttribute('href')).toBe('/w/a')

    const builds = screen.getAllByTestId('build-money-row')
    expect(builds.map((row) => row.getAttribute('data-group'))).toEqual(['running', 'delivered'])
    expect(builds[1]?.textContent).toContain('Delivered')
    expect(builds[1]?.textContent).toContain('1 h 15 min')
    expect(builds[1]?.textContent).toContain('$0.03')
    expect(within(builds[1] as HTMLElement).getByRole('link', { name: /its report/u }).getAttribute('href')).toBe('/w/a/goals/1')
  })

  it('shows the work, who was called on with a link to a roster person, and the evidence with no rate it cannot claim', () => {
    const view = analyticsFixture()
    stubFetch(() => ({ body: { analytics: view } }))
    render(<AnalyticsScreen initial={view} />)
    expect(screen.getByTestId('figure-steps').textContent).toContain('620')
    expect(screen.getByTestId('figure-helper-sessions').textContent).toContain('11')
    expect(screen.getByTestId('verdicts-works').textContent).toBe('9work')
    expect(screen.getByTestId('verdicts-fails').textContent).toBe("2don't work")
    expect(screen.getByTestId('work-builds').textContent).toContain('A delivered build took 1 h 15 min of working time on average.')

    const helpers = screen.getAllByTestId('helper-row')
    expect(within(helpers[0] as HTMLElement).getByRole('link', { name: 'Bea Backend' }).getAttribute('href')).toBe('/people?person=person-bea')
    expect(within(helpers[1] as HTMLElement).queryByRole('link')).toBeNull()
    expect(helpers[1]?.textContent).toContain('no roster person')

    const profiles = screen.getAllByTestId('evidence-profile-row')
    expect(profiles[0]?.textContent).toContain('80% of 5')
    expect(profiles[0]?.textContent).toContain('Not enough evidence yet')
    expect(profiles[0]?.textContent).toContain('Not judged yet')
    expect(profiles[0]?.textContent).toContain('$6.50 reported')
    expect(profiles[0]?.textContent).toContain('$1.25 estimated')
    expect(profiles[0]?.textContent).toContain('1 session not measured')
    expect(profiles[1]?.getAttribute('data-thin')).toBe('true')
    expect(profiles[1]?.textContent).not.toMatch(/%/u)
    expect(screen.getByTestId('evidence-origin').textContent).toContain('2 of 9 records come from projects a lead builds')
  })

  it('offers the three periods as links that keep the project, the chosen one marked', () => {
    const view = analyticsFixture({ projectId: 'a' })
    stubFetch(() => ({ body: { analytics: view } }))
    render(<AnalyticsScreen initial={view} />)
    const period = screen.getByTestId('analytics-period')
    expect(within(period).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['7 days', '/analytics?project=a&days=7', 'page'],
      ['30 days', '/analytics?project=a', null],
      ['All time', '/analytics?project=a&days=all', null],
    ])
    expect(screen.getByTestId('analytics-project').textContent).toContain('Invoice service')
    // One project: its days are one tone, with no legend to read.
    expect(screen.queryByTestId('chart-legend')).toBeNull()
  })

  it('keeps the figures it has when a refresh answers without them', () => {
    stubFetch(() => ({ body: { projects: [] } }))
    render(<AnalyticsScreen initial={analyticsFixture()} />)
    expect(screen.getByTestId('figure-spent').textContent).toContain('at least $14.75')
  })
})
