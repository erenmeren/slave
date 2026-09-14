// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/components/shell/AppShell.js'
import {
  RightPanelProvider,
  useRightPanel,
  type RightPanelState,
} from '../src/components/shell/RightPanelProvider.js'

describe('the app shell', () => {
  it('is a three-column grid with the README widths, and says which third column it has', () => {
    render(
      <AppShell
        sidebar={<nav aria-label="Primary" />}
        header={<div data-testid="h" />}
        right={<aside data-testid="r" />}
        rightWidth="panel"
      >
        <div data-testid="page" />
      </AppShell>,
    )
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('panel')
    expect(shell.className).toContain('min-w-[1280px]')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr) 372px')
  })

  it('narrows the third column to the dock', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={<aside />} rightWidth="dock"><div /></AppShell>)
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('dock')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr) 52px')
  })

  it('has no third column at all on a global route', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={null} rightWidth="none"><div /></AppShell>)
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('none')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr)')
  })

  it('puts the page inside the one main landmark, which is #main and focusable', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={null} rightWidth="none"><div data-testid="page" /></AppShell>)
    const main = screen.getByRole('main')
    expect(main.getAttribute('id')).toBe('main')
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(main.contains(screen.getByTestId('page'))).toBe(true)
  })
})

describe('the right panel provider', () => {
  /** The provider's own API, reached the way a page reaches it, as a READER rather than a value:
   *  the context object is rebuilt on every commit, so a reference captured at mount would report
   *  the collapse state of the first render forever. `render` returns nothing useful here -- the
   *  panel is state, not markup, until Task 5 gives it a wall. */
  function mountPanel(): () => RightPanelState {
    let panel: RightPanelState | null = null
    function Probe(): null {
      panel = useRightPanel()
      return null
    }
    render(
      <RightPanelProvider>
        <Probe />
      </RightPanelProvider>,
    )
    return (): RightPanelState => {
      if (panel === null) throw new Error('the provider rendered no state')
      return panel
    }
  }

  it('tells the previous owner when something else takes the slot', () => {
    const panel = mountPanel()
    const closeSlave = vi.fn()
    const closeTask = vi.fn()
    act(() => panel().open('slave', null, closeSlave, 'A'))
    act(() => panel().open('task', null, closeTask, 'B'))
    // The slave page's `?slave=` clearer ran when the task took the slot -- otherwise the param
    // survives and its mirror effect re-opens the panel on the next frame.
    expect(closeSlave).toHaveBeenCalledTimes(1)
    expect(closeTask).not.toHaveBeenCalled()
    act(() => panel().close())
    expect(closeTask).toHaveBeenCalledTimes(1)
    expect(closeSlave).toHaveBeenCalledTimes(1)
  })

  it('does not clear the owner when the SAME subject is re-asserted (ruling P14)', () => {
    const panel = mountPanel()
    const first = vi.fn()
    const second = vi.fn()
    act(() => panel().open('task', null, first, 'A'))
    // What a page does on every SSE frame: mirror the URL back into the slot, same subject.
    act(() => panel().open('task', null, second, 'A'))
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('un-collapses for a new subject and leaves a re-assertion collapsed', () => {
    const panel = mountPanel()
    act(() => panel().open('task', null, vi.fn(), 'A'))
    act(() => panel().collapse())
    act(() => panel().open('task', null, vi.fn(), 'A'))
    expect(panel().collapsed).toBe(true)
    act(() => panel().open('task', null, vi.fn(), 'B'))
    expect(panel().collapsed).toBe(false)
  })
})
