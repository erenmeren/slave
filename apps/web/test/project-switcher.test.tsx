// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSwitcher } from '../src/components/shell/ProjectSwitcher.js'
import type { SidebarProject } from '../src/server/sidebar.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/a',
  useRouter: () => ({ push: vi.fn() }),
}))

const PROJECTS: readonly SidebarProject[] = [
  { id: 'a', name: 'Alpha', archived: false, status: 'needs_you', statusLabel: 'NEEDS YOU', needsYouCount: 2, tasksActive: 1 },
  { id: 'b', name: 'Beta', archived: false, status: 'idle', statusLabel: 'IDLE', needsYouCount: 0, tasksActive: 0 },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('the project switcher (M61 R5)', () => {
  it('reads the current project on its trigger', () => {
    render(<ProjectSwitcher projects={PROJECTS} currentId="a" currentName="Alpha" />)
    expect(screen.getByTestId('project-switcher').textContent).toContain('Alpha')
  })

  it('opens on click, and lists a row per project plus New project, with the needs-you count on it', () => {
    render(<ProjectSwitcher projects={PROJECTS} currentId="a" currentName="Alpha" />)
    fireEvent.click(screen.getByTestId('project-switcher'))
    const items = screen.getAllByTestId('project-switcher-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.getAttribute('data-needs-you')).toBe('2')
    expect(screen.getByTestId('new-project')).toBeTruthy()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    render(<ProjectSwitcher projects={PROJECTS} currentId="a" currentName="Alpha" />)
    const trigger = screen.getByTestId('project-switcher')
    // jsdom's `fireEvent.click` does not also focus the element the way a real click does
    // (`ui-modals.test.tsx`'s own precedent) -- focused explicitly, so `useModalDismiss` has
    // something real to restore.
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByTestId('project-switcher-menu')).toBeTruthy()
    act((): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(screen.queryByTestId('project-switcher-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
