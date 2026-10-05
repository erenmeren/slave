// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../src/components/home/HomeView'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { listItemFixture } from './fixtures/project'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

describe('Home (lead UX design section 6.1)', () => {
  it('says there is nothing yet, and offers New project', () => {
    stubFetch(() => ({ body: { projects: [] } }))
    render(<HomeView initial={[]} />)
    const empty = screen.getByTestId('home-empty')
    expect(empty.textContent).toContain('No projects yet.')
    expect(within(empty).getByRole('link', { name: /New project/u }).getAttribute('href')).toBe('/new')
  })

  it('lists the waiting builds first, under Waiting for you, each opening its project', () => {
    const projects = [
      listItemFixture({ id: 'a', name: 'Invoice service', phase: 'needs_decision', waiting: 1, stopReason: 'no_progress', waitingSince: new Date().toISOString() }),
      listItemFixture({ id: 'b', name: 'Todo app', phase: 'building' }),
    ]
    stubFetch(() => ({ body: { projects } }))
    render(<HomeView initial={projects} />)
    const waiting = screen.getByTestId('waiting')
    const items = within(waiting).getAllByTestId('waiting-item')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('Invoice service')
    expect(items[0]?.textContent).toContain('The same problems came back two checks in a row.')
    expect(within(items[0] as HTMLElement).getByRole('link', { name: /Open/u }).getAttribute('href')).toBe('/w/a')
  })

  it('draws one card per project with its word, its sentence and its spend, and no raw state', () => {
    const projects = [listItemFixture({ phase: 'delivered', spentUsd: 4.2, budgetUsd: 20 }), listItemFixture({ id: 'b', name: 'Bot', phase: 'paused', budgetUsd: null, spentUsd: 1 })]
    stubFetch(() => ({ body: { projects } }))
    render(<HomeView initial={projects} />)
    const cards = screen.getAllByTestId('project-card')
    expect(cards.map((card) => card.getAttribute('data-phase'))).toEqual(['delivered', 'paused'])
    expect(cards[0]?.textContent).toContain('Delivered')
    expect(cards[0]?.textContent).toContain('Merged into main.')
    expect(cards[0]?.textContent).toContain('Spent $4.20 of $20')
    expect(cards[1]?.textContent).toContain('Spent $1, no budget')
    expect(document.body.textContent).not.toMatch(/needs_decision|awaiting_decision|goal version/u)
  })

  it('says how many are working, what waits, and what was spent in all, and each card who works on it', () => {
    const projects = [
      listItemFixture({ id: 'a', name: 'Invoice service', workingNow: 3, doing: 'Editing src/api.ts', totalSpentUsd: 10 }),
      listItemFixture({ id: 'b', name: 'Todo app', phase: 'delivered', workingNow: 0, doing: null, totalSpentUsd: 2.5 }),
    ]
    stubFetch(() => ({ body: { projects } }))
    render(<HomeView initial={projects} />)
    expect(screen.getByTestId('home-working').textContent).toContain('3 people')
    expect(screen.getByTestId('home-working').textContent).toContain('Invoice service')
    expect(screen.getByTestId('home-spent').textContent).toContain('$12.50')
    expect(screen.getByTestId('home-waiting').textContent).toContain('Nothing needs you')
    const working = screen.getAllByTestId('card-working')
    expect(working).toHaveLength(1)
    expect(working[0]?.textContent).toBe('3 people working · Editing src/api.ts')
  })

  it('folds the archived projects away with Restore and Delete', () => {
    const projects = [listItemFixture({ archived: true, name: 'Old one' })]
    stubFetch(() => ({ body: { projects } }))
    render(<HomeView initial={projects} />)
    expect(screen.getByTestId('archived').textContent).toContain('Archived (1)')
    expect(screen.queryByTestId('project-card')).toBeNull()
  })
})
