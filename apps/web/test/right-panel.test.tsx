// @vitest-environment jsdom
import { render, screen, within, act } from '@testing-library/react'
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

/** A stand-in owner: the page client that will call `open` from its `useSelectedId` effect. Task
 *  and slave content are each wrapped in their OWN labelled `<aside>`, the way the real
 *  `TaskDetailPanel`/`SlavePanel` are (I2/I3) -- a plain unlabelled `<div>` here would prove
 *  nothing about the outer slot no longer duplicating that landmark. */
function Opener(): React.JSX.Element {
  const { open, close, collapse } = useRightPanel()
  return (
    <>
      <button
        data-testid="open-task"
        type="button"
        onClick={() => open('task', <aside aria-label="Task detail" data-testid="task-body" />, closed)}
      />
      <button
        data-testid="open-slave"
        type="button"
        onClick={() => open('slave', <aside aria-label="Slave detail" data-testid="slave-body" />, closed)}
      />
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
        <RightPanel><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    const panel = screen.getByTestId('right-panel')
    expect(panel.getAttribute('data-mode')).toBe('supervisor')
    expect(panel.className).toContain('w-[372px]')
    // I2/I3: the visible title and the landmark name are both DERIVED from the mode, not from a
    // caller-supplied `title` prop (none is even passed above) -- Supervisor mode is the only one
    // where this outer `<aside>` carries its own `aria-label` and is itself the named landmark.
    expect(panel.getAttribute('aria-label')).toBe('Supervisor')
    expect(panel.hasAttribute('role')).toBe(false)
    expect(within(panel).getByText('Supervisor')).toBeTruthy()
    // `panel` itself is the named landmark here (Supervisor mode only) -- `within(panel)` searches
    // its DESCENDANTS, not the node itself, so this reads off `screen` and asserts it is `panel`.
    const landmarks = screen.getAllByRole('complementary', { name: 'Supervisor' })
    expect(landmarks).toHaveLength(1)
    expect(landmarks[0]).toBe(panel)
    expect(screen.getByTestId('sup')).toBeTruthy()
  })

  it('shows an opened mode s content instead, and says so on the node', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-task').click() })
    const panel = screen.getByTestId('right-panel')
    expect(panel.getAttribute('data-mode')).toBe('task')
    expect(screen.getByTestId('task-body')).toBeTruthy()
    expect(screen.queryByTestId('sup')).toBeNull()
    // I2/I3: the header still reads "Task detail" (derived from mode, not the old fixed
    // "Supervisor" title), and the outer slot gives up its OWN landmark -- `role="presentation"`,
    // no `aria-label` -- so `TaskDetailPanel`'s own labelled `<aside>` (stood in for here) is the
    // SOLE "Task detail" landmark inside `right-panel`, not a second one alongside it.
    expect(within(panel).getByText('Task detail')).toBeTruthy()
    expect(panel.getAttribute('role')).toBe('presentation')
    expect(panel.hasAttribute('aria-label')).toBe(false)
    expect(within(panel).getAllByRole('complementary', { name: 'Task detail' })).toHaveLength(1)
  })

  it('names the slave landmark once too, when a slave is open instead of a task', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-slave').click() })
    const panel = screen.getByTestId('right-panel')
    expect(panel.getAttribute('data-mode')).toBe('slave')
    expect(within(panel).getByText('Slave detail')).toBeTruthy()
    expect(panel.getAttribute('role')).toBe('presentation')
    expect(panel.hasAttribute('aria-label')).toBe(false)
    expect(within(panel).getAllByRole('complementary', { name: 'Slave detail' })).toHaveLength(1)
  })

  it('hands the slot back on close, and calls the OWNER s clearer so the URL goes too (E5)', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel><div data-testid="sup" /></RightPanel>
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
        <RightPanel><div data-testid="sup" /></RightPanel>
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
    <RightPanel><div data-testid="sup" /></RightPanel>
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
