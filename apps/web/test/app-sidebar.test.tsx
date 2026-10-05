// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppSidebar } from '../src/components/app/AppSidebar'
import { ThemeProvider } from '../src/components/theme/ThemeProvider'
import { SidebarProvider } from '../src/components/ui/sidebar'
import { notifyProjectsChanged } from '../src/lib/api'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { listItemFixture } from './fixtures/project'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/w/b' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

function show(username: string | null = null): void {
  render(
    <ThemeProvider>
      <SidebarProvider>
        <AppSidebar initial={[listItemFixture({ id: 'a', name: 'Invoice service', phase: 'needs_decision', waiting: 1 }), listItemFixture({ id: 'b', name: 'Todo app' }), listItemFixture({ id: 'c', name: 'Old', archived: true })]} username={username} />
      </SidebarProvider>
    </ThemeProvider>,
  )
}

describe('the sidebar (lead UX design U-2, U-3)', () => {
  it('lists the projects that are not archived, an amber count on the one waiting, and puts the count in the title', () => {
    stubFetch(() => ({ body: { projects: [] } }))
    document.title = 'Todo app · Slave of AI'
    show()
    const rows = screen.getAllByTestId('sidebar-project')
    expect(rows.map((row) => row.textContent)).toEqual(['Invoice service1', 'Todo app'])
    expect(screen.getByTestId('sidebar-waiting').getAttribute('aria-label')).toBe('1 waiting for you')
    expect(document.title).toBe('(1) Todo app · Slave of AI')
    expect(screen.getByTestId('new-project').getAttribute('href')).toBe('/new')
    expect(screen.queryByTestId('sign-out')).toBeNull()
  })

  it('re-reads at once when a screen says the projects changed', async () => {
    const fetchMock = stubFetch(() => ({ body: { projects: [] } }))
    show()
    await act(async () => notifyProjectsChanged())
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.anything())
  })

  it('shows who is signed in, with accounts on', () => {
    stubFetch(() => ({ body: { projects: [] } }))
    show('meren')
    expect(screen.getByTestId('signed-in-as').textContent).toBe('Signed in as meren')
  })
})
