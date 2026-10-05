// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HappeningFeed, dotOf } from '../src/components/home/HappeningFeed'
import { HomeView } from '../src/components/home/HomeView'
import { happeningFixture } from './fixtures/analytics'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { listItemFixture } from './fixtures/project'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

describe('Home: Happening now', () => {
  it('marks a line by how its step ended, and a change of state with a mark of its own', () => {
    expect(dotOf({ step: true, outcome: 'ok' })).toBe('ok')
    expect(dotOf({ step: true, outcome: 'error' })).toBe('error')
    expect(dotOf({ step: true, outcome: 'running' })).toBe('running')
    expect(dotOf({ step: true, outcome: null })).toBe('none')
    expect(dotOf({ step: false, outcome: null })).toBe('state')
  })

  it('says there is nothing yet', () => {
    stubFetch(() => ({ body: { lines: [] } }))
    render(<HappeningFeed initial={[]} />)
    expect(screen.getByTestId('happening').textContent).toContain('Nothing has happened yet.')
    expect(screen.getByTestId('happening-empty')).toBeTruthy()
  })

  it('lists who did what on which project, each line opening its project', () => {
    const lines = [
      happeningFixture({ id: '3', kind: 'helper', who: 'Bea Backend', text: 'Editing src/api.ts', outcome: 'running' }),
      happeningFixture({ id: '2', projectId: 'b', projectName: 'Todo app', kind: 'project', who: 'Slave', text: 'Build 2 is waiting for a decision. The budget ran out.', step: false, outcome: null }),
      happeningFixture({ id: '1', outcome: 'error' }),
    ]
    stubFetch(() => ({ body: { lines } }))
    render(<HappeningFeed initial={lines} />)
    const items = screen.getAllByTestId('happening-line')
    expect(items.map((item) => [item.getAttribute('data-kind'), item.getAttribute('data-outcome')])).toEqual([['helper', 'running'], ['project', 'state'], ['lead', 'error']])
    expect(items[0]?.textContent).toContain('Bea Backend')
    expect(items[0]?.textContent).toContain('Editing src/api.ts')
    expect(items[0]?.textContent).toContain('Invoice service')
    expect(within(items[1] as HTMLElement).getByRole('link').getAttribute('href')).toBe('/w/b')
    expect(items[1]?.textContent).toContain('The budget ran out.')
  })

  it('sits on Home under the figures, with the lines the page was given, whatever the projects read answers', () => {
    const projects = [listItemFixture({ id: 'a', name: 'Invoice service' })]
    // Home's stub answers every address with the projects: the feed keeps what it has.
    stubFetch(() => ({ body: { projects } }))
    render(<HomeView initial={projects} happening={[happeningFixture()]} />)
    expect(screen.getAllByTestId('happening-line')).toHaveLength(1)
    expect(screen.getByTestId('home-figures').compareDocumentPosition(screen.getByTestId('happening')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is left off a Home with no project', () => {
    stubFetch(() => ({ body: { projects: [] } }))
    render(<HomeView initial={[]} />)
    expect(screen.queryByTestId('happening')).toBeNull()
  })
})
