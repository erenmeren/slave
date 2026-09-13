// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const buildAnalytics = vi.fn(async () => ({ workspaceId: null, seeded: false, series: [], kpis: [] }))
const listProjects = vi.fn(async () => [{ id: 'w1', name: 'Checkout' }, { id: 'w2', name: 'Old', archived: true }])
vi.mock('../src/server/analytics', () => ({ buildAnalytics: (...args: unknown[]) => buildAnalytics(...(args as [])) }))
vi.mock('../src/server/org', () => ({ listProjects: (...args: unknown[]) => listProjects(...(args as [])) }))
vi.mock('../src/components/AnalyticsClient', () => ({
  AnalyticsClient: ({ workspaces }: { workspaces: readonly { id: string }[] }) => <div data-testid="scope">{workspaces.map((w) => w.id).join(',')}</div>,
}))

// M27 final review, parked: `/analytics` is GLOBAL spend, and an archived project's runs still
// cost what they cost -- the scope list (and the totals behind it) must include archived projects.
describe('the analytics page route', () => {
  it('lists archived projects too, so global totals keep their spend', async () => {
    const { default: AnalyticsPage } = await import('../src/app/analytics/page.js')
    const element = await AnalyticsPage({ searchParams: Promise.resolve({}) })
    const { getByTestId } = render(element)
    expect(listProjects).toHaveBeenCalledWith({ includeArchived: true })
    expect(getByTestId('scope').textContent).toBe('w1,w2')
  })
})
