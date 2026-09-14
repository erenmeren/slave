// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanelProvider, useRightPanel } from '../src/components/shell/RightPanelProvider.js'
import { RightPanel } from '../src/components/shell/RightPanel.js'
import { RightPanelDock } from '../src/components/shell/RightPanelDock.js'

let pathname = '/w/w1'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const closed = vi.fn()

/** A stand-in owner: the page client that will call `open` from its `useSelectedId` effect. */
function Opener(): React.JSX.Element {
  const { open, close, collapse } = useRightPanel()
  return (
    <>
      <button data-testid="open-task" type="button" onClick={() => open('task', <div data-testid="task-body" />, closed)} />
      <button data-testid="close" type="button" onClick={close} />
      <button data-testid="collapse" type="button" onClick={collapse} />
    </>
  )
}

beforeEach((): void => {
  pathname = '/w/w1'
  closed.mockClear()
})

afterEach((): void => {
  vi.clearAllMocks()
})

describe('the right panel', () => {
  it('says which mode it is in, and shows the Supervisor by default inside a project', () => {
    render(
      <RightPanelProvider>
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    const panel = screen.getByTestId('right-panel')
    expect(panel.getAttribute('data-mode')).toBe('supervisor')
    expect(panel.className).toContain('w-[372px]')
    expect(screen.getByTestId('sup')).toBeTruthy()
  })

  it('shows an opened mode s content instead, and says so on the node', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-task').click() })
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('task')
    expect(screen.getByTestId('task-body')).toBeTruthy()
    expect(screen.queryByTestId('sup')).toBeNull()
  })

  it('hands the slot back on close, and calls the OWNER s clearer so the URL goes too (E5)', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-task').click() })
    act((): void => { screen.getByTestId('close').click() })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('supervisor')
    expect(screen.getByTestId('sup')).toBeTruthy()
  })

  it('collapses from its own » -- the same call the page s close makes', () => {
    render(
      <RightPanelProvider>
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    expect(screen.getByTestId('panel-collapse')).toBeTruthy()
  })
})

/** The slot as the shell actually assembles it (`RightPanelHost`): the 372px panel, or the 52px
 *  dock once somebody has collapsed it. */
function Slot(): React.JSX.Element {
  const { collapsed } = useRightPanel()
  return collapsed ? (
    <RightPanelDock workspaceId="w1" pendingDecisions={0} />
  ) : (
    <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
  )
}

describe('the dock', () => {
  it('is 52px, carries S and A, and badges the pending decisions', () => {
    render(
      <RightPanelProvider>
        <RightPanelDock workspaceId="w1" pendingDecisions={3} />
      </RightPanelProvider>,
    )
    const dock = screen.getByTestId('right-dock')
    expect(dock.className).toContain('w-[52px]')
    expect(screen.getByTestId('dock-supervisor')).toBeTruthy()
    expect(screen.getByTestId('dock-activity').getAttribute('href')).toBe('/w/w1/activity')
    expect(screen.getByTestId('dock-badge').textContent).toBe('3')
  })

  it('shows no badge when nothing is pending -- a zero badge is a false alarm', () => {
    render(
      <RightPanelProvider>
        <RightPanelDock workspaceId="w1" pendingDecisions={0} />
      </RightPanelProvider>,
    )
    expect(screen.queryByTestId('dock-badge')).toBeNull()
  })

  // Ruling T5-2. The button says "Supervisor"; a bare `expand()` gave back whatever mode was in
  // the slot when it was collapsed -- a task panel under a label that promised something else.
  it('brings the SUPERVISOR back, not the task that was in the slot when it collapsed', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <Slot />
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-task').click() })
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('task')

    act((): void => { screen.getByTestId('collapse').click() })
    expect(screen.getByTestId('right-dock')).toBeTruthy()

    act((): void => { screen.getByTestId('dock-supervisor').click() })
    expect(screen.queryByTestId('right-dock')).toBeNull()
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('supervisor')
    expect(screen.getByTestId('sup')).toBeTruthy()
    expect(screen.queryByTestId('task-body')).toBeNull()
    // And the owning page was told, so the `?task=` this button walked away from went with it.
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
